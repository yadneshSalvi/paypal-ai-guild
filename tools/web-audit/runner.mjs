import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import lighthouse from 'lighthouse';
import { Launcher } from 'chrome-launcher';
import { digest, toolRoot, verifyRuntime } from './identity.mjs';
import { bundleServer, readExactBundle } from './server.mjs';
import { evidenceWriter } from './evidence.mjs';
import { measureInteractions } from './interactions.mjs';
import { checkRequest, requiredAxeStates, requiredInteractions } from './contract.mjs';
import { createPaletteMeasurement, palettePolicy, paletteProperties } from './contrast.mjs';

const policy = JSON.parse(await readFile(resolve(toolRoot, 'policy.json'), 'utf8'));

/** One case, one fresh owned process/profile, no shared browser or silent rerun. */
export async function runCase({ configPath, request, inputDirectory, outputDirectory }) {
  checkRequest(request, policy);
  if (digest(policy.paletteContrast) !== digest(palettePolicy)) throw new Error('The exact declared contrast policy differs from the measuring code.');
  const config = await verifyRuntime(configPath, request.mode !== 'qualification');
  if (digest(config.capability) !== digest(request.capability)) throw new Error('This request belongs to a different qualified audit runtime.');
  await mkdir(outputDirectory, { recursive: false, mode: 0o700 });
  const startedAt = new Date().toISOString();
  await writeFile(resolve(outputDirectory, 'dispatch.json'), JSON.stringify({ version: 'guild.local-browser-dispatch.v1', pid: process.pid, requestDigest: digest(request), startedAt }), { flag: 'wx', mode: 0o600 });
  const writer = evidenceWriter(outputDirectory, policy.maximumEvidenceCaseBytes);
  const result = { version: 'guild.web-audit-result.v2', requestDigest: digest(request), caseId: request.caseId, locale: request.locale, viewport: request.viewport, mode: request.mode,
    sourceDigest: request.sourceDigest, designDigest: request.designDigest, bundleDigest: request.bundle.filesDigest, capabilityDigest: digest(request.capability), rendererDigest: request.rendererDigest,
    startedAt, finishedAt: startedAt, complete: false, axe: [], lighthouse: null, interactions: [], files: writer.files, errors: [] };
  let server, chrome, browser, profile, timer, workPromise, rejectInterruption, expired = false;
  const ensureActive = () => { if (expired) throw new Error('The original audit case was interrupted; no further measurement is authorized.'); };
  const interruption = new Promise((_, reject) => { rejectInterruption = reject; });
  void interruption.catch(() => {});
  const interrupt = signal => { expired = true; rejectInterruption(new Error('The original owned browser case received ' + signal + '; partial evidence is retained and no automatic rerun is permitted.')); };
  const onTerm = () => interrupt('SIGTERM'), onInt = () => interrupt('SIGINT');
  process.on('SIGTERM', onTerm); process.on('SIGINT', onInt);
  async function closeChrome() {
    const child = chrome?.chromeProcess;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise(resolve => child.once('close', resolve));
    chrome.kill();
    await closed;
  }
  async function bounded(action, ms) {
    let clock;
    try { return await Promise.race([Promise.resolve().then(action).then(() => true, () => false), new Promise(resolve => { clock = setTimeout(() => resolve(false), ms); })]); }
    finally { if (clock) clearTimeout(clock); }
  }
  try {
    const { values, record } = await readExactBundle(inputDirectory, request.bundle);
    if (record.renderer.digest !== request.rendererDigest) throw new Error('The portable renderer differs from its frozen authored source.');
    server = await bundleServer(values);
    profile = await mkdtemp(resolve(tmpdir(), 'guild-owned-web-audit-'));
    const work = async () => {
      ensureActive();
      chrome = new Launcher({ chromePath: config.browserExecutable, userDataDir: profile, port: 0, handleSIGINT: false, logLevel: 'silent', maxConnectionRetries: 40, connectionPollInterval: 250,
        envVars: { PATH: process.env.PATH ?? '', TMPDIR: tmpdir(), LANG: 'en_US.UTF-8' },
        chromeFlags: ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--mute-audio', '--disable-features=Translate,MediaRouter', '--window-size=' + request.viewport.width + ',' + request.viewport.height] });
      await chrome.launch();
      if (expired) { await closeChrome(); ensureActive(); }
      browser = await chromium.connectOverCDP('http://127.0.0.1:' + chrome.port, { timeout: 15000 });
      ensureActive();
      if (browser.version() !== config.capability.browserVersion) throw new Error('The actual launched browser version differs from its recorded capability.');
      const context = browser.contexts()[0], externalRequests = [], pageErrors = [];
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== server.origin && !['data:', 'about:', 'blob:'].includes(url.protocol)) { externalRequests.push({ url: url.href, type: route.request().resourceType() }); await route.abort('blockedbyclient'); }
        else await route.continue();
      });
      const page = await context.newPage(); await page.setViewportSize(request.viewport); page.setDefaultTimeout(15000);
      page.on('pageerror', error => pageErrors.push(String(error.message).slice(0, 5000)));
      const url = server.url + '?lang=' + request.locale + '#cover';
      await page.goto(url, { waitUntil: 'load', timeout: 45000 });
      await page.waitForFunction(() => document.body.dataset.readerReady === 'true'); await page.evaluate(() => document.fonts.ready);
      if (await page.locator('html').getAttribute('lang') !== request.locale) throw new Error('The requested locale did not become the actual document language.');
      async function captureAxe(state) {
        if (expired) throw new Error('The bounded case expired.');
        const native = await new AxeBuilder({ page }).analyze();
        const file = await writer.json('axe-' + state + '.json', native);
        result.axe.push({ state, file, violations: native.violations.length, seriousCritical: native.violations.filter(item => ['serious', 'critical'].includes(item.impact)).length, incomplete: native.incomplete.length });
      }
      async function capturePalette() {
        ensureActive();
        const observed = await page.evaluate(properties => ({ css: Object.fromEntries(Object.entries(properties).map(([key, name]) => [key, getComputedStyle(document.body).getPropertyValue(name).trim()])), readerContrast: document.body.getAttribute('data-contrast') }), paletteProperties);
        const measurement = createPaletteMeasurement(request, record, observed);
        const file = await writer.json('palette-contrast.json', measurement);
        return { file, ...measurement };
      }
      await captureAxe('default');
      // Lighthouse gets the same original theme and fresh profile before any
      // reader preference or interaction changes. Its complete LHR is retained.
      const measured = await lighthouse(url, { port: chrome.port, output: 'json', logLevel: 'error' }, { extends: 'lighthouse:default', settings: {
        onlyCategories: ['accessibility'], formFactor: 'desktop', screenEmulation: { mobile: false, width: request.viewport.width, height: request.viewport.height, deviceScaleFactor: 1, disabled: false },
        emulatedUserAgent: false, throttlingMethod: 'provided', disableStorageReset: false, maxWaitForFcp: 45000, maxWaitForLoad: 60000,
      } });
      if (!measured?.lhr) throw new Error('Lighthouse returned no original report.');
      result.lighthouse = { file: await writer.json('lighthouse.json', measured.lhr), accessibilityScore: typeof measured.lhr.categories?.accessibility?.score === 'number' ? measured.lhr.categories.accessibility.score : null, warnings: measured.lhr.runWarnings ?? [] };
      if (measured.lhr.runtimeError) result.errors.push({ code: 'LIGHTHOUSE_RUNTIME', message: JSON.stringify(measured.lhr.runtimeError) });
      await page.bringToFront();
      result.interactions = await measureInteractions(page, record, captureAxe, externalRequests, pageErrors, ensureActive, capturePalette);
      await writer.json('network-and-page-errors.json', { sourceDigest: request.sourceDigest, externalRequests, pageErrors, exactLocalRequests: server.requests });
      if (expired) throw new Error('The exact case exceeded its fixed limit.');
      const missingAxe = requiredAxeStates.filter(state => !result.axe.some(item => item.state === state));
      const missingInteractions = requiredInteractions.filter(id => !result.interactions.some(item => item.id === id));
      const missingPalette = !result.files.some(file => file.path === 'palette-contrast.json');
      result.complete = !missingAxe.length && !missingInteractions.length && !missingPalette;
      if (!result.complete) result.errors.push({ code: 'MEASUREMENT_REGISTER_INCOMPLETE', message: JSON.stringify({ missingAxe, missingInteractions, missingPalette }) });
    };
    workPromise = work();
    timer = setTimeout(() => interrupt('its fixed ' + policy.caseTimeoutMs + ' ms measurement limit'), policy.caseTimeoutMs);
    await Promise.race([workPromise, interruption]);
  } catch (error) { result.complete = false; result.errors.push({ code: 'BROWSER_CASE_INCOMPLETE', message: String(error?.message ?? error).slice(0, 10000) }); }
  finally {
    if (timer) clearTimeout(timer);
    expired = true;
    const browserClosed = !browser || await bounded(() => browser.close(), 10000);
    let chromeClosed = !chrome || await bounded(closeChrome, 10000);
    const workSettled = !workPromise || await bounded(() => workPromise.catch(() => {}), 15000);
    // A launch resolving during interruption checks expiry immediately. Recheck
    // its owned handle; no shared browser/profile is ever targeted.
    if (chrome && !chromeClosed) chromeClosed = await bounded(closeChrome, 5000);
    const serverClosed = !server || await bounded(() => server.close(), 5000);
    if (!browserClosed || !chromeClosed || !workSettled || !serverClosed) {
      result.complete = false;
      result.errors.push({ code: 'OWNED_BROWSER_CLEANUP_UNCONFIRMED', message: 'The original case could not confirm complete bounded cleanup. Its owned profile and evidence are retained for inspection; no replay is permitted.' });
    } else if (profile) await rm(profile, { recursive: true, force: true });
    process.off('SIGTERM', onTerm); process.off('SIGINT', onInt);
    result.finishedAt = new Date().toISOString();
    await writeFile(resolve(outputDirectory, 'result.json'), JSON.stringify(result), { flag: 'wx', mode: 0o600 });
  }
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [configPath, requestPath, inputDirectory, outputDirectory] = process.argv.slice(2);
  if (!configPath || !requestPath || !inputDirectory || !outputDirectory) throw new Error('Use runner.mjs PRIVATE_RUNTIME REQUEST_JSON EXACT_BUNDLE_DIRECTORY NEW_EVIDENCE_DIRECTORY.');
  const result = await runCase({ configPath: resolve(configPath), request: JSON.parse(await readFile(requestPath, 'utf8')), inputDirectory: resolve(inputDirectory), outputDirectory: resolve(outputDirectory) });
  process.stdout.write(JSON.stringify({ caseId: result.caseId, complete: result.complete, files: result.files.length, errors: result.errors.map(item => item.code) }) + '\n');
  if (!result.complete) process.exitCode = 2;
}
