import { createHash } from "node:crypto";
import { z } from "zod";
import { webAuditFileSchema, webAuditRequestSchema, type WebAuditRequest, type WebAuditResult } from "@/domain/web-audits";
import { webBundleDigest, webBundleSchema } from "@/domain/web-exhibition";
import { digest, DomainError } from "@/domain/primitives";
import { WebAuditAttemptError, type WebAuditGateway } from "./audit-gateway";
import { validateWebEvidence } from "./audit-evidence";
import { readWebAuditCase, type WebAuditRow } from "./audit-store";
import { installedWebRuntime, type WebRuntimeAccess } from "./capability";
import { verifyHostedWebConfiguration, hostedWebPaths } from "./hosted-config";
import { hostedBrowserCommand, hostedCasePaths, hostedLaunchIdentity, hostedReadonlyIndexCommand, hostedUploadCommand, hostedVerifyCommand } from "./hosted-commands";
import { assertHostedSnapshot, assertOriginalHostedSession, hostedCommandDigest, VercelHostedSandboxDriver, type HostedCommandIdentity, type HostedCommandOutput, type HostedCommandSpec, type HostedSandboxDriver, type HostedSessionAccess } from "./hosted-session";
import { hostedFilesManifest, PostgresHostedAttemptStore, validateHostedAttempt, type HostedAttemptRecord, type HostedAttemptStore, type HostedCommandRecord } from "./hosted-store";

const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const json = (bytes: Buffer | string): unknown => JSON.parse(typeof bytes === "string" ? bytes : new TextDecoder("utf-8", { fatal: true }).decode(bytes));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const launchIdentitySchema = z.object({ bindingDigest: hash, requestHash: hash, sessionId: z.string().min(1).max(128), programHash: hash }).strict();
const launchSchema = launchIdentitySchema.extend({ version: z.literal("guild.web-hosted-launch.v1"), startedAt: z.string().datetime(), pid: z.number().int().positive() }).strict();
const indexSchema = launchIdentitySchema.extend({ version: z.literal("guild.web-hosted-output-index.v1"), source: z.enum(["original_browser_command", "readonly_original_result_read"]), files: z.array(webAuditFileSchema).max(202) }).strict();
const dispatchSchema = z.object({ version: z.literal("guild.local-browser-dispatch.v1"), pid: z.number().int().positive(), requestDigest: hash, startedAt: z.string().datetime() }).strict();
const uploadProofSchema = z.object({ version: z.literal("guild.web-hosted-upload-proof.v1"), requestHash: hash, bundleDigest: hash, browserLaunched: z.literal(false) }).strict();
const runtimeProofSchema = z.object({ capability: webAuditRequestSchema.shape.capability, browserLaunched: z.literal(false) }).strict();
function fail(code: string, message: string, files = new Map<string, Buffer>()): never { throw new WebAuditAttemptError(code, message, files); }
function nativeOnly(files: Map<string, Buffer>) { return new Map([...files].filter(([path]) => !path.startsWith("hosted-") && !["result.json", "dispatch.json"].includes(path))); }
function commandIdentity(value: HostedCommandIdentity, spec: HostedCommandSpec): HostedCommandRecord {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value.id) || value.cwd !== spec.cwd || !Number.isSafeInteger(value.startedAt) || value.startedAt <= 0)
    fail("WEB_HOSTED_COMMAND_CHANGED", "The hosted command returned a different original identity or working directory.");
  return { id: value.id, startedAt: value.startedAt, descriptorHash: hostedCommandDigest(spec), exitCode: value.exitCode };
}
function sameCommand(expected: HostedCommandRecord | null, value: HostedCommandIdentity, spec: HostedCommandSpec) {
  const checked = commandIdentity(value, spec);
  if (!expected || expected.id !== checked.id || expected.startedAt !== checked.startedAt || expected.descriptorHash !== checked.descriptorHash
    || expected.exitCode !== null && expected.exitCode !== checked.exitCode)
    fail("WEB_HOSTED_COMMAND_CHANGED", "The original hosted command ID, start time, descriptor or terminal status changed. No replacement command was launched.");
  return checked;
}
function checkedIndex(raw: unknown, record: HostedAttemptRecord) {
  const index = indexSchema.parse(raw), { version: _version, files, source: _source, ...identity } = index;
  const native = files.filter(file => !["dispatch.json", "result.json"].includes(file.path));
  if (digest(identity) !== digest(hostedLaunchIdentity(record)) || new Set(files.map(file => file.path)).size !== files.length
    || files.reduce((sum, file) => sum + file.byteLength, 0) > 66 * 1024 * 1024
    || files.some(file => file.path.startsWith("hosted-")) || native.length > 200 || native.reduce((sum, file) => sum + file.byteLength, 0) > 64 * 1024 * 1024
    || digest(files.map(file => file.path)) !== digest(files.map(file => file.path).sort()))
    fail("WEB_HOSTED_EVIDENCE_CHANGED", "The original output index changed its session, case, bounded paths or complete file register.");
  return index;
}
/** A hosted result also preserves the native process dispatch and the complete
 * original result/index bytes, which are not part of the native report array. */
export function validateHostedCollectedEvidence(record: HostedAttemptRecord, request: WebAuditRequest, all: Map<string, Buffer>) {
  const required = ["hosted-launch.json", "hosted-output-index.json", "dispatch.json", "result.json", "hosted-runtime.json", "hosted-qualification.json", "hosted-runtime-verification.json", "hosted-upload-verification.json", "hosted-request.json"];
  if (required.some(path => !all.has(path))) fail("WEB_HOSTED_OUTCOME_UNKNOWN", "The original hosted attempt has incomplete retained files. Read the same original attempt; a replacement browser is not permitted.", nativeOnly(all));
  const index = checkedIndex(json(all.get("hosted-output-index.json")!), record), launch = launchSchema.parse(json(all.get("hosted-launch.json")!));
  const { version: _version, startedAt: _started, pid: _pid, ...identity } = launch;
  const dispatch = dispatchSchema.parse(json(all.get("dispatch.json")!));
  const result = validateWebEvidence(request, json(all.get("result.json")!), nativeOnly(all));
  const expectedNames = ["dispatch.json", "result.json", ...result.files.map(file => file.path)].sort();
  const command = record.commands.browser;
  if (!record.session || !command || command.exitCode === null || !record.runtimeProof || !record.uploadProof
    || command.descriptorHash !== hostedCommandDigest(hostedBrowserCommand(record))
    || digest(identity) !== digest(hostedLaunchIdentity(record)) || dispatch.pid !== launch.pid || dispatch.requestDigest !== record.binding.requestHash || dispatch.startedAt !== result.startedAt
    || Date.parse(launch.startedAt) < command.startedAt - 30000 || Date.parse(result.startedAt) < Date.parse(launch.startedAt)
    || Date.parse(launch.startedAt) < Date.parse(record.binding.originalDispatchedAt) - 30000 || digest(index.files.map(file => file.path)) !== digest(expectedNames))
    fail("WEB_HOSTED_EVIDENCE_CHANGED", "The original native files do not bind this exact original process, session and terminal browser command.", nativeOnly(all));
  for (const file of index.files) {
    const bytes = all.get(file.path);
    if (!bytes || bytes.length !== file.byteLength || sha(bytes) !== file.contentHash) fail("WEB_HOSTED_EVIDENCE_CHANGED", "An original hosted report changed its exact bytes.", nativeOnly(all));
  }
  const metadata = record.configuration.metadata;
  const runtime = json(all.get("hosted-runtime.json")!), qualification = json(all.get("hosted-qualification.json")!);
  const verified = runtimeProofSchema.parse(json(all.get("hosted-runtime-verification.json")!)), uploaded = uploadProofSchema.parse(json(all.get("hosted-upload-verification.json")!));
  if (digest(runtime) !== digest(metadata.originalRuntime) || digest(qualification) !== digest(metadata.qualification)
    || digest(runtime) !== record.runtimeProof.originalRuntimeDigest || digest(qualification) !== record.runtimeProof.originalQualificationDigest
    || sha(all.get("hosted-runtime-verification.json")!) !== record.runtimeProof.stdoutHash || digest(verified.capability) !== record.runtimeProof.capabilityDigest
    || record.runtimeProof.capabilityDigest !== digest(request.capability) || sha(all.get("hosted-upload-verification.json")!) !== record.uploadProof.stdoutHash
    || uploaded.requestHash !== record.binding.requestHash || uploaded.bundleDigest !== request.bundle.filesDigest
    || record.uploadProof.requestHash !== uploaded.requestHash || record.uploadProof.bundleDigest !== uploaded.bundleDigest || digest(json(all.get("hosted-request.json")!)) !== digest(request))
    fail("WEB_HOSTED_EVIDENCE_CHANGED", "The original remote qualification or post-upload byte proof changed. A command exit alone is not a browser measurement.", nativeOnly(all));
  const allManifest = hostedFilesManifest(all);
  if (record.evidence && (record.evidence.resultHash !== digest(result) || record.evidence.nativeFilesDigest !== digest(result.files) || record.evidence.allFilesDigest !== digest(allManifest)))
    fail("WEB_HOSTED_EVIDENCE_CHANGED", "The original retained hosted evidence differs from its signed complete manifest.", nativeOnly(all));
  return { result, files: nativeOnly(all), allManifest };
}

interface Dependencies {
  runtime?: WebRuntimeAccess; driver?: HostedSandboxDriver; store?: HostedAttemptStore;
  confirmObservation?: typeof readWebAuditCase;
}
export class HostedWebAuditGateway implements WebAuditGateway {
  private readonly runtime: WebRuntimeAccess;
  private readonly driver: HostedSandboxDriver;
  private readonly store: HostedAttemptStore;
  private readonly confirmObservation: typeof readWebAuditCase;
  constructor(dependencies: Dependencies = {}) {
    this.runtime = dependencies.runtime ?? installedWebRuntime; this.driver = dependencies.driver ?? new VercelHostedSandboxDriver();
    this.store = dependencies.store ?? new PostgresHostedAttemptStore(); this.confirmObservation = dependencies.confirmObservation ?? readWebAuditCase;
  }
  private async session(record: HostedAttemptRecord, readOnly = false) {
    return assertOriginalHostedSession(await this.driver.get(record.binding.remoteName, record.configuration), record, { readOnly });
  }
  private async noteUnknown(record: HostedAttemptRecord, code: string) {
    try { return await this.store.unknown(record, code); } catch { return record; }
  }
  private async execute(record: HostedAttemptRecord, stage: "verify" | "upload" | "browser", session: HostedSessionAccess, spec: HostedCommandSpec) {
    let current = record;
    try {
      const output = await session.run(spec, async value => {
        if (current.commands[stage]) fail("WEB_HOSTED_COMMAND_CHANGED", "A command already owns this original hosted phase. It cannot be dispatched again.");
        current = await this.store.change(current, { commands: { ...current.commands, [stage]: commandIdentity(value, spec) }, ...(stage === "browser" ? { phase: "browser_started" as const } : {}) }, stage + "_started");
      });
      const command = sameCommand(current.commands[stage], output, spec);
      current = await this.store.change(current, { commands: { ...current.commands, [stage]: command }, ...(stage === "browser" ? { phase: "browser_finished" as const } : {}) }, stage + "_finished");
      return { record: current, output };
    } catch (error) {
      const code = error instanceof WebAuditAttemptError || error instanceof DomainError ? error.code : "WEB_HOSTED_TRANSPORT_UNKNOWN";
      await this.noteUnknown(current, code);
      throw error;
    }
  }
  async run(input: Parameters<WebAuditGateway["run"]>[0]) {
    const request = webAuditRequestSchema.parse(input.request), manifest = webBundleSchema.parse(input.manifest);
    const runtime = await this.runtime.verify(request.capability);
    if (runtime.execution !== "hosted" || !runtime.hosted) fail("WEB_HOSTED_CONFIG_REQUIRED", "This case requires the server-selected sealed hosted runtime.");
    const configuration = verifyHostedWebConfiguration(runtime.hosted);
    if (request.mode === "qualification" || digest(request.capability) !== digest(configuration.metadata.originalRuntime.capability)
      || request.rendererDigest !== runtime.authored.capability.digest || request.rendererDigest !== request.capability.qualifiedRendererDigest
      || digest(request.bundle) !== digest(manifest) || manifest.filesDigest !== webBundleDigest(manifest.files) || manifest.totalBytes !== manifest.files.reduce((sum, file) => sum + file.byteLength, 0))
      fail("WEB_HOSTED_REQUEST_CHANGED", "The hosted case differs from the exact agreed job, renderer, capability or original file manifest.");
    if (!input.beforeBrowser) fail("WEB_HOSTED_AUTHORITY_REQUIRED", "The hosted browser requires a current-authority check after provisioning and uploads.");
    const originals: { path: string; content: Buffer; mode: number }[] = [];
    for (const file of manifest.files) {
      const bytes = await input.read(file);
      if (bytes.length !== file.byteLength || sha(bytes) !== file.contentHash) fail("WEB_ORIGINAL_BYTES_CHANGED", "An original exhibition file failed its exact byte binding before any hosted creation.");
      originals.push({ path: file.path, content: bytes, mode: 0o600 });
    }
    let record: HostedAttemptRecord | undefined;
    try {
      // The existing atomic prepared→dispatching claim precedes every create.
      const authority = await input.beforeLaunch();
      if (!authority?.workerId || !authority.originalDeadline) fail("WEB_HOSTED_AUTHORITY_REQUIRED", "The original hosted creation needs its exact current worker claim and unchanged work deadline.");
      record = await this.store.begin({ caseId: input.id, tenantId: input.tenantId, jobId: input.jobId, bundleId: input.bundleId, request, ...authority, configuration });
      const snapshot = await this.driver.snapshot(configuration); assertHostedSnapshot(snapshot, configuration);
      record = await this.store.change(record, { snapshotProof: { ...snapshot, status: "created", expiresAt: snapshot.expiresAt!, observedAt: new Date().toISOString() } }, "original_qualified_snapshot_read");
      const created = assertOriginalHostedSession(await this.driver.create(record.binding.remoteName, configuration), record, { unbound: true });
      record = await this.store.change(record, { phase: "session_bound", session: { id: created.identity.sessionId, createdAt: created.identity.createdAt }, sessionReceipt: { ...created.identity, snapshotId: created.identity.snapshotId!, persistent: false, status: "running", networkPolicy: "deny-all", ports: [], vcpus: 2, timeoutMs: 600000, region: "iad1", observedBy: "create_response", observedAt: new Date().toISOString() } }, "session_bound");
      record = await this.store.change(record, { phase: "verify_intent", commandSpecs: { ...record.commandSpecs, verify: hostedVerifyCommand(record) } }, "verify_intent");
      const verified = await this.execute(record, "verify", await this.session(record), hostedVerifyCommand(record)); record = verified.record;
      const proof = runtimeProofSchema.parse(json(verified.output.stdout));
      if (verified.output.exitCode !== 0 || digest(proof.capability) !== digest(request.capability)) fail("WEB_HOSTED_RUNTIME_CHANGED", "The unchanged full remote original-evidence verifier did not validate this exact qualified Linux runtime.");
      const remoteRuntime = await (await this.session(record)).read(hostedWebPaths.runtime, 64 * 1024), remoteQualification = await (await this.session(record)).read(configuration.metadata.originalRuntime.qualificationPath, 1024 * 1024);
      if (!remoteRuntime || !remoteQualification || digest(json(remoteRuntime)) !== digest(configuration.metadata.originalRuntime) || digest(json(remoteQualification)) !== digest(configuration.metadata.qualification))
        fail("WEB_HOSTED_RUNTIME_CHANGED", "The original remote runtime and complete qualification metadata differ from their trusted local seal.");
      await this.store.retain(record, new Map([["hosted-runtime.json", remoteRuntime], ["hosted-qualification.json", remoteQualification], ["hosted-runtime-verification.json", Buffer.from(verified.output.stdout)]]));
      record = await this.store.change(record, { phase: "runtime_verified", runtimeProof: { stdoutHash: sha(verified.output.stdout), capabilityDigest: digest(proof.capability), originalRuntimeDigest: digest(json(remoteRuntime)), originalQualificationDigest: digest(json(remoteQualification)) } }, "runtime_verified");
      const paths = hostedCasePaths(record), requestBytes = Buffer.from(JSON.stringify(request));
      record = await this.store.change(record, { phase: "upload_intent", commandSpecs: { ...record.commandSpecs, upload: hostedUploadCommand(record) } }, "upload_intent");
      await (await this.session(record)).upload([...originals.map(file => ({ ...file, path: paths.bundle + "/" + file.path })), { path: paths.request, content: requestBytes, mode: 0o600 }]);
      const uploaded = await this.execute(record, "upload", await this.session(record), hostedUploadCommand(record)); record = uploaded.record;
      const upload = uploadProofSchema.parse(json(uploaded.output.stdout));
      if (uploaded.output.exitCode !== 0 || upload.requestHash !== record.binding.requestHash || upload.bundleDigest !== manifest.filesDigest)
        fail("WEB_HOSTED_UPLOAD_CHANGED", "The uploaded request and every original bundle byte did not match their exact server-bound manifest. No browser was sent.");
      await this.store.retain(record, new Map([["hosted-request.json", requestBytes], ["hosted-upload-verification.json", Buffer.from(uploaded.output.stdout)]]));
      record = await this.store.change(record, { phase: "uploads_verified", uploadProof: { stdoutHash: sha(uploaded.output.stdout), requestHash: upload.requestHash, bundleDigest: upload.bundleDigest } }, "uploads_verified");
      // Read session status before the last authority transaction; no slow
      // provisioning, uploads or control-plane GET intervenes after that check.
      const session = await this.session(record);
      record = await this.store.change(record, { phase: "browser_intent", commandSpecs: { ...record.commandSpecs, browser: hostedBrowserCommand(record) }, launchIdentity: hostedLaunchIdentity(record) }, "browser_intent");
      await input.beforeBrowser();
      const browser = await this.execute(record, "browser", session, hostedBrowserCommand(record)); record = browser.record;
      // A complete failing or incomplete measurement is retained as its actual
      // native result. A zero exit status is never used as a pass criterion.
      const collected = await this.collect(record, request); record = collected.record;
      return { result: collected.result, files: collected.files, afterSave: () => this.finish(record!) };
    } catch (error) {
      let partial = new Map<string, Buffer>();
      if (record) {
        // execute() may have saved onStart before its response was lost.
        try { record = await this.store.read(input.tenantId, input.id); partial = nativeOnly(await this.store.files(record)); } catch { /* Preserve the prior committed intent even if storage is unavailable. */ }
        if (record.session && !record.commands.browser && record.phase === "browser_intent") {
          // A lost stream header can hide the command ID even when the remote
          // exclusive wrapper completed. Retain closed original files where
          // possible, but a missing command ID still cannot earn an observation.
          try { partial = await this.retainUnidentifiedOriginal(record); } catch { /* Any previously retained partial files remain immutable. */ }
          try { partial = nativeOnly(await this.store.files(record)); } catch { /* Keep the last readable original partial set. */ }
        }
        const code = error instanceof WebAuditAttemptError || error instanceof DomainError ? error.code : "WEB_HOSTED_TRANSPORT_UNKNOWN";
        await this.noteUnknown(record, code);
      }
      if (error instanceof WebAuditAttemptError) throw new WebAuditAttemptError(error.code, error.message, new Map([...partial, ...error.files]));
      if (error instanceof DomainError) throw new WebAuditAttemptError(error.code, error.message, partial);
      fail("WEB_HOSTED_OUTCOME_UNKNOWN", "The original hosted operation has an uncertain result. Its durable name, session and known command remain saved; recover that exact attempt without another creation, upload or browser launch.", partial);
    }
  }
  private async retainUnidentifiedOriginal(record: HostedAttemptRecord) {
    const all = await this.store.files(record), paths = hostedCasePaths(record);
    if (!record.session || record.phase !== "browser_intent") return nativeOnly(all);
    const launchBytes = all.get("hosted-launch.json") ?? await (await this.session(record, true)).read(paths.launch, 64 * 1024);
    const indexBytes = all.get("hosted-output-index.json") ?? await (await this.session(record, true)).read(paths.index, 1024 * 1024);
    if (!launchBytes || !indexBytes) return nativeOnly(all);
    const launch = launchSchema.parse(json(launchBytes)), { version: _version, startedAt: _at, pid: _pid, ...identity } = launch;
    const index = checkedIndex(json(indexBytes), record);
    if (digest(identity) !== digest(hostedLaunchIdentity(record)) || index.source !== "original_browser_command")
      fail("WEB_HOSTED_EVIDENCE_CHANGED", "The closed original output changed its case/session identity. No missing browser command ID was inferred.", nativeOnly(all));
    // Only the original wrapper's completed index may close files when no
    // command ID exists. No new listing/verification/browser command is allowed.
    await this.store.retain(record, new Map([["hosted-launch.json", launchBytes], ["hosted-output-index.json", indexBytes]]));
    all.set("hosted-launch.json", launchBytes); all.set("hosted-output-index.json", indexBytes);
    const until = Date.now() + 120000;
    for (const file of index.files) {
      if (Date.now() >= until) break;
      const bytes = all.get(file.path) ?? await (await this.session(record, true)).read(paths.evidence + "/" + file.path, file.byteLength);
      if (!bytes || bytes.length !== file.byteLength || sha(bytes) !== file.contentHash) fail("WEB_HOSTED_EVIDENCE_CHANGED", "An unidentified original command left a missing or changed native file. Its earlier evidence remains saved.", nativeOnly(all));
      await this.store.retain(record, new Map([[file.path, bytes]])); all.set(file.path, bytes);
    }
    return nativeOnly(all);
  }
  private async collect(original: HostedAttemptRecord, request: WebAuditRequest) {
    let record = await this.store.read(original.binding.tenantId, original.binding.caseId), all = await this.store.files(record);
    const retainedIndex = all.has("hosted-output-index.json") ? checkedIndex(json(all.get("hosted-output-index.json")!), record) : null;
    const completeRetained = !!retainedIndex && all.has("hosted-launch.json") && retainedIndex.files.some(file => file.path === "result.json")
      && retainedIndex.files.every(file => all.has(file.path));
    if (!completeRetained) {
      const session = await this.session(record, true), spec = hostedBrowserCommand(record), originalCommand = record.commands.browser;
      if (!originalCommand) fail("WEB_HOSTED_COMMAND_UNKNOWN", "The original browser command ID was never durably observed. Retain its original session without launching or inferring another command.", nativeOnly(all));
      const command = sameCommand(originalCommand, await session.command(originalCommand.id), spec);
      if (command.exitCode === null) fail("WEB_HOSTED_BROWSER_PENDING", "The same original browser command is still running. Read it again later; no new browser is authorized.", nativeOnly(all));
      if (record.phase === "browser_started") record = await this.store.change(record, { phase: "browser_finished", commands: { ...record.commands, browser: command } }, "original_browser_finished_read");
      else if (record.commands.browser!.exitCode === null) record = await this.store.change(record, { commands: { ...record.commands, browser: command } }, "original_browser_terminal_read");
      const paths = hostedCasePaths(record);
      let indexBytes = all.get("hosted-output-index.json") ?? await (await this.session(record, true)).read(paths.index, 1024 * 1024);
      if (!indexBytes) {
        // A SIGKILL can prevent the original wrapper's finally block. This
        // bounded command only lists/hashes the original directory; it imports
        // no audit tools and never creates, resumes, uploads or launches a case.
        const reader = await this.session(record), readSpec = hostedReadonlyIndexCommand(record);
        const output = await reader.run(readSpec, async value => {
          record = await this.store.change(record, { recoveryReads: [...record.recoveryReads, { ...commandIdentity(value, readSpec), spec: readSpec }] }, "readonly_original_output_read");
        });
        const saved = record.recoveryReads.at(-1);
        sameCommand(saved ?? null, output, readSpec);
        record = await this.store.change(record, { recoveryReads: [...record.recoveryReads.slice(0, -1), { ...saved!, exitCode: output.exitCode }] }, "readonly_original_output_received");
        if (output.exitCode !== 0) fail("WEB_HOSTED_OUTCOME_UNKNOWN", "The bounded read of the original output directory could not complete. No replacement browser was launched.", nativeOnly(all));
        indexBytes = Buffer.from(output.stdout);
      }
      const index = checkedIndex(json(indexBytes), record);
      all.set("hosted-output-index.json", indexBytes); await this.store.retain(record, new Map([["hosted-output-index.json", indexBytes]]));
      const launch = all.get("hosted-launch.json") ?? await (await this.session(record, true)).read(paths.launch, 64 * 1024);
      if (launch) { all.set("hosted-launch.json", launch); await this.store.retain(record, new Map([["hosted-launch.json", launch]])); }
      const until = Date.now() + 120000;
      for (const file of index.files) {
        if (Date.now() >= until) fail("WEB_HOSTED_READ_PENDING", "The original bounded evidence read reached its continuation limit. Already saved bytes remain immutable; read the same remaining files again.", nativeOnly(all));
        const bytes = all.get(file.path) ?? await (await this.session(record, true)).read(paths.evidence + "/" + file.path, file.byteLength);
        if (!bytes || bytes.length !== file.byteLength || sha(bytes) !== file.contentHash) fail("WEB_HOSTED_EVIDENCE_CHANGED", "The original hosted native file is missing or differs from its recorded exact hash. Earlier bytes remain saved.", nativeOnly(all));
        all.set(file.path, bytes); await this.store.retain(record, new Map([[file.path, bytes]]));
      }
    }
    const checked = validateHostedCollectedEvidence(record, request, all);
    if (!record.evidence) record = await this.store.change(record, { phase: "evidence_retained", evidence: { resultHash: digest(checked.result), nativeFilesDigest: digest(checked.result.files), allFilesDigest: digest(checked.allManifest), retainedAt: new Date().toISOString() } }, "original_evidence_retained");
    return { record, result: checked.result, files: checked.files };
  }
  /** No current contract, actor, model, renderer, snapshot lifetime or worker
   * lease is renewed here. The saved HMAC-bound original intent is the scope. */
  async recover(row: WebAuditRow) {
    let record = validateHostedAttempt(await this.store.read(row.tenant_id, row.id), row);
    try {
      if (!record.session) {
        if (!record.snapshotProof) fail("WEB_HOSTED_CREATE_NOT_CONFIRMED", "The original snapshot validation/creation phase has no confirmed identity. Read-only recovery cannot submit a creation or manufacture its receipt.");
        const original = assertOriginalHostedSession(await this.driver.get(record.binding.remoteName, record.configuration), record, { unbound: true, readOnly: true });
        record = await this.store.change(record, { phase: "session_bound", session: { id: original.identity.sessionId, createdAt: original.identity.createdAt }, sessionReceipt: { ...original.identity, snapshotId: original.identity.snapshotId!, persistent: false, networkPolicy: "deny-all", ports: [], vcpus: 2, timeoutMs: 600000, region: "iad1", observedBy: "original_name_read", observedAt: new Date().toISOString() } }, "original_create_response_read");
      }
      if (!record.commands.browser) {
        const partial = await this.retainUnidentifiedOriginal(record);
        fail("WEB_HOSTED_COMMAND_UNKNOWN", "The original creation/session may be known, but no original browser command ID is retained. Closed original files remain partial evidence; read-only recovery cannot launch work or infer the missing command identity.", partial);
      }
      const collected = await this.collect(record, row.request); record = collected.record;
      return { result: collected.result, files: collected.files, recovery: { bindingDigest: digest(record.binding), sessionId: record.session!.id, commandId: record.commands.browser!.id, originalDispatchedAt: record.binding.originalDispatchedAt }, afterSave: () => this.finish(record) };
    } catch (error) {
      try { record = await this.store.read(row.tenant_id, row.id); } catch { /* Keep the earlier signed identity. */ }
      let partial = new Map<string, Buffer>();
      try { partial = nativeOnly(await this.store.files(record)); } catch { /* The existing durable originals are never overwritten on a failed read. */ }
      const code = error instanceof WebAuditAttemptError || error instanceof DomainError ? error.code : "WEB_HOSTED_READ_UNKNOWN";
      await this.noteUnknown(record, code);
      if (error instanceof WebAuditAttemptError) throw new WebAuditAttemptError(error.code, error.message, new Map([...partial, ...error.files]));
      if (error instanceof DomainError) fail(error.code, error.message, partial);
      fail(code, "The original hosted evidence could not be read completely. The same original name, session and command remain held without resume or redelivery.", partial);
    }
  }
  private async finish(original: HostedAttemptRecord) {
    let record = await this.store.read(original.binding.tenantId, original.binding.caseId);
    if (record.phase === "cleaned") return;
    try {
      const receipt = await this.confirmObservation(record.binding.tenantId, record.binding.caseId);
      if (!record.evidence || receipt.resultHash !== record.evidence.resultHash) fail("WEB_HOSTED_CLEANUP_HELD", "Cleanup requires the exact signed native observation to be durably saved first.");
      const session = await this.session(record, true), alreadyIntended = record.phase === "cleanup_intent";
      if (record.phase !== "evidence_retained" && !alreadyIntended) fail("WEB_HOSTED_CLEANUP_HELD", "The original evidence must be completely retained before hosted cleanup.");
      if (!alreadyIntended) record = await this.store.change(record, { phase: "cleanup_intent", observationHash: receipt.resultHash }, "cleanup_intent");
      if (session.identity.status === "running") {
        if (alreadyIntended) fail("WEB_HOSTED_CLEANUP_UNKNOWN", "The original stop request is uncertain. Read its exact session status without issuing another stop.");
        await session.stop();
      }
      const stopped = await this.session(record, true);
      if (!["stopped", "aborted", "failed"].includes(stopped.identity.status)) fail("WEB_HOSTED_CLEANUP_UNKNOWN", "The exact original hosted session has no confirmed terminal status after cleanup.");
      await this.store.change(record, { phase: "cleaned" }, "original_session_stopped");
    } catch (error) { await this.noteUnknown(record, error instanceof WebAuditAttemptError || error instanceof DomainError ? error.code : "WEB_HOSTED_CLEANUP_UNKNOWN"); }
  }
}
