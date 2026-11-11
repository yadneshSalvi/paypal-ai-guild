import { readFile, readdir } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { digest, engineIdentity, sha } from './identity.mjs';
import { readExactBundle } from './server.mjs';
import { readEvidenceJson, validEvidenceFile } from './evidence.mjs';

export const requiredInteractions = ['source_text', 'original_media_register', 'images_decoded', 'no_autoplay', 'document_overflow', 'rtl', 'keyboard_register', 'dialog_focus', 'locale_keyboard', 'original_audio', 'captions_seek', 'reader_preferences', 'chapter_navigation', 'reduced_motion', 'no_external_resources', 'no_page_errors'];
export const requiredAxeStates = ['default', 'expanded', 'map', 'settings', 'source', 'share'];
const hash = /^[a-f0-9]{64}$/, object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => object(value) && Object.keys(value).sort().join() === [...keys].sort().join();
const equal = (a, b) => digest(a) === digest(b);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const date = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
function fail(message) { throw new Error('AUDIT_CONTRACT: ' + message); }
export function checkRequest(request, policy) {
  if (!exactKeys(request, ['version', 'mode', 'locale', 'viewport', 'caseId', 'authorityDigest', 'rendererDigest', 'capability', 'sourceDigest', 'designDigest', 'bundle'])
    || request.version !== 'guild.web-audit-request.v1' || !['producer', 'independent', 'qualification'].includes(request.mode)
    || !policy.locales.includes(request.locale) || !policy.viewports.some(item => equal(item, request.viewport))
    || !object(request.bundle) || request.bundle.sourceDigest !== request.sourceDigest || request.bundle.designDigest !== request.designDigest
    || typeof request.caseId !== 'string' || !/^[a-z0-9:_-]{1,150}$/.test(request.caseId)
    || !['authorityDigest', 'rendererDigest', 'sourceDigest', 'designDigest'].every(key => typeof request[key] === 'string' && hash.test(request[key]))) fail('The immutable audit request is incomplete.');
}
function localUrl(value, request) {
  try { const url = new URL(value); return url.protocol === 'http:' && url.hostname === '127.0.0.1' && !!url.port && /^\/[a-f0-9]{48}\/index\.html$/.test(url.pathname) && url.search === '?lang=' + request.locale && ['cover', 'full_bleed', 'split', 'comparison', 'audio', 'collection_grid', 'timeline', 'credits'].includes(url.hash.slice(1)) && !url.username && !url.password; } catch { return false; }
}
export async function inspectResult(request, result, directory, policy) {
  checkRequest(request, policy);
  if (!exactKeys(result, ['version', 'requestDigest', 'caseId', 'locale', 'viewport', 'mode', 'sourceDigest', 'designDigest', 'bundleDigest', 'capabilityDigest', 'rendererDigest', 'startedAt', 'finishedAt', 'complete', 'axe', 'lighthouse', 'interactions', 'files', 'errors'])
    || result.version !== 'guild.web-audit-result.v1' || result.requestDigest !== digest(request) || result.caseId !== request.caseId || result.locale !== request.locale || !equal(result.viewport, request.viewport)
    || result.mode !== request.mode || result.sourceDigest !== request.sourceDigest || result.designDigest !== request.designDigest || result.bundleDigest !== request.bundle.filesDigest
    || result.capabilityDigest !== digest(request.capability) || result.rendererDigest !== request.rendererDigest || !date(result.startedAt) || !date(result.finishedAt) || Date.parse(result.finishedAt) < Date.parse(result.startedAt)
    || typeof result.complete !== 'boolean' || !Array.isArray(result.files) || result.files.length > 200 || !result.files.every(validEvidenceFile)
    || new Set(result.files.map(file => file.path)).size !== result.files.length || result.files.reduce((sum, file) => sum + file.byteLength, 0) > policy.maximumEvidenceCaseBytes
    || !Array.isArray(result.axe) || result.axe.length > requiredAxeStates.length || new Set(result.axe.map(item => item.state)).size !== result.axe.length
    || !Array.isArray(result.interactions) || result.interactions.length > requiredInteractions.length || new Set(result.interactions.map(item => item.id)).size !== result.interactions.length
    || !Array.isArray(result.errors) || result.errors.length > 100 || !result.errors.every(item => exactKeys(item, ['code', 'message']) && typeof item.code === 'string' && item.code.length > 0 && item.code.length <= 150 && typeof item.message === 'string' && item.message.length <= 10000)) fail('The complete original result differs from its case, engine, identity or fixed limits.');
  const onDisk = (await readdir(directory)).sort(), expectedDisk = ['dispatch.json', 'result.json', ...result.files.map(file => file.path)].sort();
  if (!equal(onDisk, expectedDisk)) fail('The original evidence directory contains missing or omitted files.');
  for (const file of result.files) {
    const bytes = await readFile(resolve(directory, file.path));
    if (bytes.length !== file.byteLength || sha(bytes) !== file.contentHash) fail('A retained original report byte count or hash changed.');
  }
  const dispatch = JSON.parse(await readFile(resolve(directory, 'dispatch.json'), 'utf8'));
  if (!exactKeys(dispatch, ['version', 'pid', 'requestDigest', 'startedAt']) || dispatch.version !== 'guild.local-browser-dispatch.v1' || !Number.isSafeInteger(dispatch.pid) || dispatch.pid <= 0 || dispatch.requestDigest !== digest(request) || dispatch.startedAt !== result.startedAt) fail('The original local dispatch receipt changed.');
  const violationIds = [];
  for (const state of result.axe) {
    if (!exactKeys(state, ['state', 'file', 'violations', 'seriousCritical', 'incomplete']) || !requiredAxeStates.includes(state.state) || !integer(state.violations) || !integer(state.seriousCritical) || !integer(state.incomplete)) fail('An axe state is missing or duplicated.');
    const native = await readEvidenceJson(directory, state.file, result.files);
    if (native.testEngine?.name !== 'axe-core' || native.testEngine.version !== request.capability.axe || !localUrl(native.url, request)
      || !Array.isArray(native.violations) || !Array.isArray(native.incomplete) || native.violations.length !== state.violations || native.incomplete.length !== state.incomplete
      || native.violations.filter(item => ['serious', 'critical'].includes(item.impact)).length !== state.seriousCritical) fail('The original native axe report differs from its measured state or engine.');
    violationIds.push(...native.violations.map(item => item.id));
  }
  let score = null;
  if (result.lighthouse !== null) {
    if (!exactKeys(result.lighthouse, ['file', 'accessibilityScore', 'warnings']) || result.lighthouse.accessibilityScore !== null && (typeof result.lighthouse.accessibilityScore !== 'number' || !Number.isFinite(result.lighthouse.accessibilityScore) || result.lighthouse.accessibilityScore < 0 || result.lighthouse.accessibilityScore > 1)
      || !Array.isArray(result.lighthouse.warnings) || result.lighthouse.warnings.some(item => typeof item !== 'string')) fail('The Lighthouse summary is invalid.');
    const native = await readEvidenceJson(directory, result.lighthouse.file, result.files);
    score = native.categories?.accessibility?.score ?? null;
    if (native.lighthouseVersion !== request.capability.lighthouse || score !== result.lighthouse.accessibilityScore || !localUrl(native.requestedUrl, request)
      || native.configSettings?.screenEmulation?.width !== request.viewport.width || native.configSettings?.screenEmulation?.height !== request.viewport.height
      || !equal(native.runWarnings ?? [], result.lighthouse.warnings) || native.runtimeError && !result.errors.some(item => item.code === 'LIGHTHOUSE_RUNTIME' && item.message === JSON.stringify(native.runtimeError))) fail('The native Lighthouse score, viewport, warnings or engine differs from its original result.');
  }
  for (const item of result.interactions) if (!exactKeys(item, ['id', 'passed', 'detail', 'observed']) || !requiredInteractions.includes(item.id) || typeof item.passed !== 'boolean' || typeof item.detail !== 'string' || item.detail.length > 8000) fail('The original interaction register is invalid.');
  if (result.complete) {
    if (result.axe.length !== requiredAxeStates.length || result.interactions.length !== requiredInteractions.length || result.lighthouse === null) fail('A complete case omitted a required original observation.');
    const reference = result.files.find(file => file.path === 'network-and-page-errors.json');
    if (!reference) fail('A complete case omitted the original network/page-error record.');
    const native = await readEvidenceJson(directory, reference, result.files);
    if (native.sourceDigest !== request.sourceDigest || !Array.isArray(native.externalRequests) || !Array.isArray(native.pageErrors) || !Array.isArray(native.exactLocalRequests)
      || native.exactLocalRequests.some(item => !request.bundle.files.some(file => file.path === item.path) || !['GET', 'HEAD'].includes(item.method))
      || result.interactions.find(item => item.id === 'no_external_resources').passed !== (native.externalRequests.length === 0)
      || result.interactions.find(item => item.id === 'no_page_errors').passed !== (native.pageErrors.length === 0)) fail('The complete case changed or omitted its observed requests and page errors.');
  } else if (!result.errors.length) fail('An incomplete case must retain its explicit failure.');
  const passes = result.complete && !result.errors.length && result.axe.every(item => item.seriousCritical === 0)
    && typeof score === 'number' && score >= policy.minimumLighthouseAccessibilityScore && result.interactions.every(item => item.passed);
  return { passes, score, violationIds: [...new Set(violationIds)] };
}

export function qualificationCases(set, policy) {
  return [...policy.locales.flatMap(locale => policy.viewports.map(viewport => ({ id: `baseline-${locale}-${viewport.width}`, locale, viewport, entry: set.baseline, baseline: true }))),
    ...set.mutations.map(item => ({ id: 'mutation-' + item.id, locale: 'en', viewport: policy.viewports[0], entry: item, baseline: false }))];
}
export async function readQualificationSet(path, rendererDigest) {
  const set = JSON.parse(await readFile(path, 'utf8'));
  if (!exactKeys(set, ['version', 'baseline', 'mutations']) || set.version !== 'guild.web-qualification-set.v1' || !set.baseline || set.mutations?.length !== 2 || set.mutations.map(item => item.id).sort().join() !== 'contrast,missing-alt') fail('Supply the complete labeled baseline and two explicit verifier mutations.');
  for (const item of [set.baseline, ...set.mutations]) {
    if (!isAbsolute(item.directory)) fail('Qualification input directories must be explicit and absolute.');
    const { record } = await readExactBundle(item.directory, item.bundle);
    if (record.sources.provenance.mode !== 'sample' || record.acceptanceClaimed !== false || record.paymentClaimed !== false || rendererDigest && record.renderer.digest !== rendererDigest) fail('Browser qualification must retain its exact disclosed sample and authored renderer.');
  }
  return set;
}
export function qualificationRequest(config, test) {
  return { version: 'guild.web-audit-request.v1', mode: 'qualification', locale: test.locale, viewport: test.viewport, caseId: test.id,
    authorityDigest: digest({ scope: 'independent-browser-diagnostic-only', inputs: config.inputDigest, engine: engineIdentity(config.capability), productionApproval: false }),
    rendererDigest: config.capability.qualifiedRendererDigest, capability: config.capability,
    sourceDigest: test.entry.bundle.sourceDigest, designDigest: test.entry.bundle.designDigest, bundle: test.entry.bundle };
}
export async function inspectQualification(config, policy) {
  const set = await readQualificationSet(resolve(config.workspace, 'qualification-input.json'), config.capability.qualifiedRendererDigest);
  if (digest(set) !== config.inputDigest) fail('The original qualification input set changed.');
  const cases = [];
  for (const test of qualificationCases(set, policy)) {
    const directory = resolve(config.workspace, test.id), evidence = resolve(directory, 'evidence');
    const request = JSON.parse(await readFile(resolve(directory, 'request.json'), 'utf8')), expected = qualificationRequest(config, test);
    if (!equal(request, expected)) fail('The complete original qualification request differs from its declared case.');
    const result = JSON.parse(await readFile(resolve(evidence, 'result.json'), 'utf8'));
    const inspected = await inspectResult(request, result, evidence, policy);
    const detectedMutation = !test.baseline && result.complete && !result.errors.length && inspected.violationIds.includes(test.entry.id === 'contrast' ? 'color-contrast' : 'image-alt');
    cases.push({ id: test.id, requestDigest: digest(request), resultHash: digest(result), fileManifestHash: digest(result.files), baseline: test.baseline, ...inspected, detectedMutation });
  }
  return cases;
}
