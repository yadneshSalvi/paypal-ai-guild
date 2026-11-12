import { createHash } from "node:crypto";
import { digest } from "@/domain/primitives";
import { hostedWebPaths } from "./hosted-config";
import type { HostedAttemptRecord } from "./hosted-store";
import type { HostedCommandSpec } from "./hosted-session";

// These fixed programs never receive provider/application credentials. They are
// passed as argv to the exact vendor Node; no shell interpolation or authored
// runner modification is involved.
const indexProgram = String.raw`
async function outputIndex(directory, identity, source) {
  let names;
  try { names = (await readdir(directory)).sort(); } catch (error) { if (error.code === 'ENOENT') names = []; else throw error; }
  if (names.length > 202) throw new Error('HOSTED_EVIDENCE_FILE_LIMIT');
  const files = []; let total = 0;
  for (const path of names) {
    if (!/^[a-z][a-z0-9-]{0,150}\.json$/.test(path)) throw new Error('HOSTED_EVIDENCE_PATH');
    const absolute = directory + '/' + path, stat = await lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 16777216) throw new Error('HOSTED_EVIDENCE_FILE_LIMIT');
    const bytes = await readFile(absolute); total += bytes.length;
    if (bytes.length !== stat.size || total > 69206016) throw new Error('HOSTED_EVIDENCE_TOTAL_LIMIT');
    files.push({ path, byteLength: bytes.length, contentHash: createHash('sha256').update(bytes).digest('hex') });
  }
  return { version: 'guild.web-hosted-output-index.v1', ...identity, source, files };
}`;
export const hostedBrowserProgram = String.raw`
import { readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
${indexProgram}
const [runtime, requestPath, bundleDirectory, caseDirectory, tools, identityText] = process.argv.slice(1);
const identity = JSON.parse(identityText), output = caseDirectory + '/evidence';
const launch = { version: 'guild.web-hosted-launch.v1', ...identity, startedAt: new Date().toISOString(), pid: process.pid };
// Remote second fence: even an unintended POST redelivery cannot start a
// second browser in this original session and case directory.
await writeFile(caseDirectory + '/hosted-launch.json', JSON.stringify(launch), { flag: 'wx', mode: 0o600 });
let result;
try {
  const { runCase } = await import(tools + '/runner.mjs');
  result = await runCase({ configPath: runtime, request: JSON.parse(await readFile(requestPath, 'utf8')), inputDirectory: bundleDirectory, outputDirectory: output });
} finally {
  const index = await outputIndex(output, identity, 'original_browser_command');
  await writeFile(caseDirectory + '/hosted-output-index.json', JSON.stringify(index), { flag: 'wx', mode: 0o600 });
}
process.stdout.write(JSON.stringify({ caseId: result.caseId, complete: result.complete }) + '\n');
if (!result.complete) process.exitCode = 2;
`;
const uploadProgram = String.raw`
import { readFile } from 'node:fs/promises';
const [tools, requestPath, bundleDirectory, expectedHash] = process.argv.slice(1);
const { digest } = await import(tools + '/identity.mjs');
const { checkRequest } = await import(tools + '/contract.mjs');
const { readExactBundle } = await import(tools + '/server.mjs');
const request = JSON.parse(await readFile(requestPath, 'utf8')), policy = JSON.parse(await readFile(tools + '/policy.json', 'utf8'));
checkRequest(request, policy);
if (digest(request) !== expectedHash) throw new Error('HOSTED_REQUEST_CHANGED');
const { record } = await readExactBundle(bundleDirectory, request.bundle);
if (record.renderer.digest !== request.rendererDigest) throw new Error('HOSTED_RENDERER_CHANGED');
process.stdout.write(JSON.stringify({ version: 'guild.web-hosted-upload-proof.v1', requestHash: digest(request), bundleDigest: request.bundle.filesDigest, browserLaunched: false }) + '\n');
`;
const readonlyIndexProgram = String.raw`
import { readFile, readdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
${indexProgram}
const [directory, identityText] = process.argv.slice(1);
process.stdout.write(JSON.stringify(await outputIndex(directory, JSON.parse(identityText), 'readonly_original_result_read')) + '\n');
`;
function isolated(args: string[], timeoutMs: HostedCommandSpec["timeoutMs"]): HostedCommandSpec {
  return { cmd: "/usr/bin/env", args: ["-i", "PATH=/tmp/guild-node/node-v22.22.3-linux-x64/bin:/usr/bin:/bin", "TMPDIR=/tmp", "LANG=en_US.UTF-8", hostedWebPaths.node, ...args], cwd: hostedWebPaths.tools, env: {}, timeoutMs };
}
export function hostedCasePaths(record: HostedAttemptRecord) {
  const root = hostedWebPaths.cases + "/" + record.binding.caseId;
  return { root, request: root + "/request.json", bundle: root + "/bundle", evidence: root + "/evidence", launch: root + "/hosted-launch.json", index: root + "/hosted-output-index.json" };
}
export function hostedLaunchIdentity(record: HostedAttemptRecord) {
  if (record.launchIdentity) return record.launchIdentity;
  return { bindingDigest: digest(record.binding), requestHash: record.binding.requestHash, sessionId: record.session!.id,
    programHash: createHash("sha256").update(hostedBrowserProgram).digest("hex") };
}
export function hostedVerifyCommand(record?: HostedAttemptRecord) { return record?.commandSpecs.verify ?? isolated([hostedWebPaths.tools + "/qualify.mjs", "verify", hostedWebPaths.runtime], 120000); }
export function hostedUploadCommand(record: HostedAttemptRecord) {
  if (record.commandSpecs.upload) return record.commandSpecs.upload;
  const paths = hostedCasePaths(record);
  return isolated(["--input-type=module", "--eval", uploadProgram, hostedWebPaths.tools, paths.request, paths.bundle, record.binding.requestHash], 60000);
}
export function hostedBrowserCommand(record: HostedAttemptRecord) {
  if (record.commandSpecs.browser) return record.commandSpecs.browser;
  const paths = hostedCasePaths(record);
  return isolated(["--input-type=module", "--eval", hostedBrowserProgram, hostedWebPaths.runtime, paths.request, paths.bundle, paths.root, hostedWebPaths.tools, JSON.stringify(hostedLaunchIdentity(record))], 330000);
}
/** This recovery program imports only Node filesystem/crypto APIs, reads one
 * original directory, and cannot import or launch the audit/browser runner. */
export function hostedReadonlyIndexCommand(record: HostedAttemptRecord) {
  return isolated(["--input-type=module", "--eval", readonlyIndexProgram, hostedCasePaths(record).evidence, JSON.stringify(hostedLaunchIdentity(record))], 30000);
}
