import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, readlink, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { arch, platform, release, version } from 'node:os';
import { fileURLToPath } from 'node:url';

export const toolRoot = dirname(fileURLToPath(import.meta.url));
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : '{' + Object.entries(value).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => JSON.stringify(key) + ':' + canonical(value)).join(',') + '}';
export const digest = value => sha(canonical(value));
export const auditCodeFiles = ['identity.mjs', 'server.mjs', 'evidence.mjs', 'contract.mjs', 'contrast.mjs', 'interactions.mjs', 'runner.mjs', 'qualify.mjs', 'policy.json', 'package.json'];
export const expectedTools = { playwright: '1.65.0', axe: '4.14.0', lighthouse: '13.6.0', browserRevision: '1254', browserVersion: '158.0.8127.18', node: 'v22.22.3' };
export function inside(root, path) { const part = relative(root, path); return part !== '' && part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part); }
export async function treeIdentity(root) {
  const entries = [];
  async function visit(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const path = resolve(directory, name), stat = await lstat(path), entry = relative(root, path).split(sep).join('/');
      if (stat.isSymbolicLink()) {
        const target = await readlink(path), resolved = await realpath(path);
        if (!inside(root, resolved)) throw new Error('A pinned runtime link leaves its own distribution: ' + entry);
        entries.push({ path: entry, type: 'link', target });
      } else if (stat.isDirectory()) await visit(path);
      else if (stat.isFile()) entries.push({ path: entry, type: 'file', size: stat.size, sha256: sha(await readFile(path)) });
      else throw new Error('Unsupported runtime entry: ' + entry);
    }
  }
  await visit(root);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { digest: digest(entries), entries };
}
export async function currentIdentity(browserRoot, executable) {
  if (process.version !== expectedTools.node) throw new Error('Use the qualified Node ' + expectedTools.node + '; no runtime substitution is allowed.');
  const distribution = await realpath(browserRoot), binary = await realpath(executable);
  if (!inside(distribution, binary)) throw new Error('The browser executable must be inside its dedicated pinned distribution.');
  const packageJson = name => readFile(resolve(toolRoot, 'node_modules', name, 'package.json'), 'utf8').then(JSON.parse);
  const [playwright, axe, lighthouse] = await Promise.all([packageJson('playwright'), packageJson('@axe-core/playwright'), packageJson('lighthouse')]);
  if (playwright.version !== expectedTools.playwright || axe.version !== expectedTools.axe || lighthouse.version !== expectedTools.lighthouse) throw new Error('The installed audit packages differ from the pinned versions.');
  const browser = JSON.parse(await readFile(resolve(toolRoot, 'node_modules/playwright-core/browsers.json'), 'utf8')).browsers.find(item => item.name === 'chromium');
  if (browser.revision !== expectedTools.browserRevision || browser.browserVersion !== expectedTools.browserVersion) throw new Error('The expected Chromium revision changed.');
  const code = [];
  for (const path of auditCodeFiles) code.push({ path, sha256: sha(await readFile(resolve(toolRoot, path))) });
  const [dependencies, distributionTree] = await Promise.all([treeIdentity(resolve(toolRoot, 'node_modules')), treeIdentity(distribution)]);
  return {
    version: 'guild.chromium-web-audit.v2', runnerHash: digest(code), packageLockHash: sha(await readFile(resolve(toolRoot, 'package-lock.json'))),
    dependenciesDigest: dependencies.digest, browserDistributionDigest: distributionTree.digest, nodeExecutableHash: sha(await readFile(process.execPath)),
    browserRevision: expectedTools.browserRevision, operatingSystem: `${platform()} ${release()} ${version()}`,
    playwright: playwright.version, axe: axe.version, lighthouse: lighthouse.version, browserVersion: expectedTools.browserVersion,
    browserExecutableHash: sha(await readFile(binary)), platform: platform(), architecture: arch(), node: process.version,
  };
}
export function engineIdentity(capability) { const { qualifiedAt: _at, qualificationDigest: _proof, qualifiedRendererDigest: _renderer, ...identity } = capability; return identity; }
export async function verifyRuntime(path, requireQualified = true) {
  const config = JSON.parse(await readFile(path, 'utf8'));
  if (config.version !== 'guild.web-audit-runtime.v2' || !isAbsolute(config.browserRoot) || !isAbsolute(config.browserExecutable) || !isAbsolute(config.workspace)) throw new Error('An explicit private audit runtime is required. System/browser-cache fallback is disabled.');
  const identity = await currentIdentity(config.browserRoot, config.browserExecutable);
  if (digest(identity) !== digest(engineIdentity(config.capability))) throw new Error('The browser, audit code, dependencies or platform changed after qualification.');
  if (requireQualified) {
    if (config.state !== 'qualified' || !config.qualificationPath) throw new Error('This browser runner has not completed its independent qualification.');
    const qualification = JSON.parse(await readFile(config.qualificationPath, 'utf8'));
    if (digest(qualification) !== config.capability.qualificationDigest || qualification.passed !== true || qualification.engineDigest !== digest(identity)
      || qualification.baselineCases !== 18 || qualification.detectedMutations !== 2 || qualification.rendererDigest !== config.capability.qualifiedRendererDigest) throw new Error('The complete retained qualification no longer matches this engine.');
    const policy = JSON.parse(await readFile(resolve(toolRoot, 'policy.json'), 'utf8'));
    const original = JSON.parse(await readFile(resolve(config.workspace, 'unqualified-runtime.json'), 'utf8'));
    const expected = { ...original, state: 'qualified', qualificationPath: resolve(config.workspace, 'qualification.json'), capability: { ...original.capability, qualifiedAt: qualification.completedAt, qualificationDigest: digest(qualification) } };
    if (original.state !== 'unqualified' || digest(expected) !== digest(config) || qualification.policyDigest !== digest(policy) || qualification.inputDigest !== config.inputDigest
      || qualification.productionApproval !== false || qualification.humanReview !== false || qualification.acceptance !== false || qualification.payment !== false) throw new Error('The retained diagnostic changed its original authority boundary or policy.');
    const { inspectQualification } = await import('./contract.mjs');
    const cases = await inspectQualification(original, policy);
    if (cases.length !== 20 || digest(cases) !== digest(qualification.cases) || !cases.filter(item => item.baseline).every(item => item.passes) || !cases.filter(item => !item.baseline).every(item => item.detectedMutation)) throw new Error('The exact retained qualification evidence no longer supports this engine.');
  }
  return config;
}
