import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { currentIdentity, digest, engineIdentity, toolRoot, verifyRuntime } from './identity.mjs';
import { readExactBundle } from './server.mjs';
import { inspectQualification, qualificationCases, qualificationRequest, readQualificationSet } from './contract.mjs';
import { runCase } from './runner.mjs';

const policy = JSON.parse(await readFile(resolve(toolRoot, 'policy.json'), 'utf8'));
const exists = async path => { try { await readFile(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const writeNew = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
export async function prepareRuntime(browserRoot, executable, setPath, workspace) {
  const set = await readQualificationSet(setPath), { record } = await readExactBundle(set.baseline.directory, set.baseline.bundle);
  const identity = await currentIdentity(resolve(browserRoot), resolve(executable));
  await mkdir(workspace, { recursive: false, mode: 0o700 });
  const at = new Date().toISOString();
  const config = { version: 'guild.web-audit-runtime.v2', state: 'unqualified', browserRoot: resolve(browserRoot), browserExecutable: resolve(executable), workspace: resolve(workspace), inputDigest: digest(set),
    capability: { ...identity, qualifiedAt: at, qualificationDigest: digest({ unqualified: true, engine: identity }), qualifiedRendererDigest: record.renderer.digest } };
  await writeNew(resolve(workspace, 'qualification-input.json'), set);
  await writeNew(resolve(workspace, 'runtime.json'), config);
  return { state: 'unqualified', expectedCases: 20, rendererDigest: record.renderer.digest, runtime: resolve(workspace, 'runtime.json'), browserLaunched: false };
}
export async function qualificationStep(configPath) {
  const config = await verifyRuntime(configPath, false);
  if (config.state !== 'unqualified') throw new Error('This completed qualification is immutable. A new source/runtime needs its own independent qualification.');
  const set = await readQualificationSet(resolve(config.workspace, 'qualification-input.json'), config.capability.qualifiedRendererDigest);
  if (digest(set) !== config.inputDigest) throw new Error('The original qualification set changed.');
  const cases = qualificationCases(set, policy);
  for (const [index, test] of cases.entries()) {
    const directory = resolve(config.workspace, test.id), requestPath = resolve(directory, 'request.json'), outputDirectory = resolve(directory, 'evidence');
    if (await exists(resolve(outputDirectory, 'result.json'))) continue;
    if (await exists(requestPath)) throw new Error('The original browser attempt has no complete result. Preserve its partial evidence; this tool will not rerun it.');
    const request = qualificationRequest(config, test);
    await mkdir(directory, { recursive: false, mode: 0o700 }); await writeNew(requestPath, request);
    const result = await runCase({ configPath, request, inputDirectory: test.entry.directory, outputDirectory });
    return { id: test.id, complete: result.complete, errors: result.errors.map(item => item.code), remaining: cases.length - index - 1 };
  }
  return { allCasesRetained: true, next: 'Inspect the complete original evidence, then use seal diagnostic-browser-only.' };
}
export async function sealQualification(configPath, acknowledgment) {
  if (acknowledgment !== 'diagnostic-browser-only') throw new Error('This local engine qualification is not a production approval, new Passport, acceptance or payment.');
  const config = await verifyRuntime(configPath, false);
  if (config.state !== 'unqualified') throw new Error('A completed qualification is immutable.');
  const set = await readQualificationSet(resolve(config.workspace, 'qualification-input.json'), config.capability.qualifiedRendererDigest);
  if (digest(set) !== config.inputDigest) throw new Error('The qualification input changed.');
  const cases = await inspectQualification(config, policy);
  const qualification = { version: 'guild.web-audit-qualification.v2', engineDigest: digest(engineIdentity(config.capability)), rendererDigest: config.capability.qualifiedRendererDigest, inputDigest: config.inputDigest,
    policyDigest: digest(policy), baselineCases: cases.filter(item => item.baseline).length, detectedMutations: cases.filter(item => !item.baseline && item.detectedMutation).length,
    passed: cases.filter(item => item.baseline).every(item => item.passes) && cases.filter(item => !item.baseline).every(item => item.detectedMutation), cases,
    completedAt: new Date().toISOString(), productionApproval: false, humanReview: false, acceptance: false, payment: false };
  const qualificationPath = resolve(config.workspace, 'qualification.json'); await writeNew(qualificationPath, qualification);
  if (qualification.passed) {
    const qualified = { ...config, state: 'qualified', qualificationPath, capability: { ...config.capability, qualifiedAt: qualification.completedAt, qualificationDigest: digest(qualification) } };
    await writeNew(resolve(config.workspace, 'unqualified-runtime.json'), config);
    const next = resolve(config.workspace, 'qualified-runtime.json'); await writeNew(next, qualified); await rename(next, configPath);
  }
  return { passed: qualification.passed, baselineCases: qualification.baselineCases, detectedMutations: qualification.detectedMutations, qualificationDigest: digest(qualification), productionApproval: false };
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [command, ...args] = process.argv.slice(2);
  const result = command === 'prepare' ? await prepareRuntime(args[0], args[1], args[2], args[3]) : command === 'step' ? await qualificationStep(resolve(args[0])) : command === 'seal' ? await sealQualification(resolve(args[0]), args[1]) : command === 'verify' ? { capability: (await verifyRuntime(resolve(args[0]))).capability, browserLaunched: false } : null;
  if (!result) throw new Error('Use prepare BROWSER_ROOT EXACT_EXECUTABLE SAMPLE_SET NEW_WORKSPACE; step RUNTIME; seal RUNTIME diagnostic-browser-only; or verify RUNTIME.');
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
