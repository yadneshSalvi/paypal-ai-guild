import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { locales } from "@/contracts/guild";
import { digest, DomainError } from "@/domain/primitives";
import { webAuditPolicy, type WebAuditCapability } from "@/domain/web-exhibition";
import type { WebAuditGateway } from "@/server/web/audit-gateway";
import type { WebAuditRow } from "@/server/web/audit-store";
import type { WebRuntimeAccess } from "@/server/web/capability";
import { hostedWebPaths, sealHostedWebRuntime, verifyHostedWebConfiguration, type HostedWebConfiguration, type HostedWebMetadata } from "@/server/web/hosted-config";
import { hostedAttemptRecordSchema, hostedCreationDescriptor, hostedFilesManifest, hostedRemoteName, validateHostedAttempt, type HostedAttemptPatch, type HostedAttemptRecord, type HostedAttemptStart, type HostedAttemptStore } from "@/server/web/hosted-store";
import type { HostedCommandIdentity, HostedCommandOutput, HostedCommandSpec, HostedSandboxDriver, HostedSessionAccess, HostedSessionIdentity } from "@/server/web/hosted-session";
import { webAuditFixture } from "../helpers/web-audit-fixture";
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const clone = <T>(value: T): T => structuredClone(value);

/** All metadata, native reports and remote operations here are deliberately
 * synthetic. No browser, provider or actual qualified snapshot is accessed. */
export async function hostedWebFixture() {
  const base = await webAuditFixture();
  const code = [];
  for (const path of ["identity.mjs", "server.mjs", "evidence.mjs", "contract.mjs", "contrast.mjs", "interactions.mjs", "runner.mjs", "qualify.mjs", "policy.json", "package.json"])
    code.push({ path, sha256: sha(await readFile("tools/web-audit/" + path)) });
  const capability: WebAuditCapability = { ...base.capability, runnerHash: digest(code), packageLockHash: sha(await readFile("tools/web-audit/package-lock.json")),
    platform: "linux", architecture: "x64", operatingSystem: "linux synthetic transport fixture; no actual browser observation", qualifiedAt: "2026-11-11T21:00:00.000Z" };
  const { qualifiedAt: _at, qualificationDigest: _proof, qualifiedRendererDigest: _renderer, ...engine } = capability;
  const caseIds = [...locales.flatMap(locale => webAuditPolicy.viewports.map(viewport => `baseline-${locale}-${viewport.width}`)), "mutation-contrast", "mutation-missing-alt"];
  const qualification: HostedWebMetadata["qualification"] = {
    version: "guild.web-audit-qualification.v2", engineDigest: digest(engine), rendererDigest: capability.qualifiedRendererDigest, inputDigest: digest("synthetic qualification inputs"),
    policyDigest: digest(webAuditPolicy), baselineCases: 18, detectedMutations: 2, passed: true, completedAt: capability.qualifiedAt,
    cases: caseIds.map(id => ({ id, requestDigest: digest({ id, synthetic: "request" }), resultHash: digest({ id, synthetic: "result" }), fileManifestHash: digest({ id, synthetic: "files" }),
      baseline: id.startsWith("baseline-"), passes: id.startsWith("baseline-"), score: 1, violationIds: id === "mutation-missing-alt" ? ["image-alt"] : [],
      paletteContrast: id !== "mutation-contrast", paletteSourceBound: true, paletteRatios: id === "mutation-contrast" ? [1, 7, 7, 7] : [7, 7, 7, 7], detectedMutation: id.startsWith("mutation-") })),
    productionApproval: false, humanReview: false, acceptance: false, payment: false,
  };
  capability.qualificationDigest = digest(qualification);
  const metadata: HostedWebMetadata = {
    version: "guild.web-hosted-snapshot.v1", snapshot: { id: "snap_synthetic", sourceSessionId: "synthetic-source-session", createdAt: "2026-11-11T21:01:00.000Z", expiresAt: "2031-11-18T21:01:00.000Z", region: "iad1" },
    controlPlane: { teamId: "team_synthetic", projectId: "prj_synthetic" },
    originalRuntime: { version: "guild.web-audit-runtime.v2", state: "qualified", browserRoot: hostedWebPaths.browserRoot, browserExecutable: hostedWebPaths.browser,
      workspace: hostedWebPaths.workspace, inputDigest: qualification.inputDigest, capability, qualificationPath: hostedWebPaths.workspace + "/qualification.json" },
    qualification, originalEvidenceArchive: { sha256: digest("synthetic evidence archive identity only"), byteLength: 1 }, networkPolicy: "deny-all", ports: [], vcpus: 2, timeoutMs: 600000,
  };
  const configuration = sealHostedWebRuntime(metadata), request = { ...base.request, mode: "producer" as const, caseId: "producer:1:en:390", capability };
  const runtime: WebRuntimeAccess = { async read() { return { configPath: "server:synthetic-hosted-fixture", capability, authored: base.assets, execution: "hosted", hosted: configuration }; },
    async verify(expected) { assert.equal(digest(expected ?? capability), digest(capability)); return this.read(); } };
  const row: WebAuditRow = { id: randomUUID(), tenant_id: randomUUID(), commission_id: randomUUID(), package_id: "web", contract_version: 1, job_id: randomUUID(), case_key: request.caseId,
    mode: "producer", request_hash: digest(request), request, state: "dispatching", failure_code: null, dispatched_at: new Date(Date.now() - 10) };
  const workerId = randomUUID(), bundleId = randomUUID(), originalDeadline = new Date(Date.now() + 3600000).toISOString();
  let claimed = false, checks = 0;
  const input: Parameters<WebAuditGateway["run"]>[0] = { id: row.id, tenantId: row.tenant_id, jobId: row.job_id, bundleId, request, manifest: base.rendered.bundle,
    async read(file) { const bytes = base.rendered.authored.get(file.path) ?? (file.mediaId ? base.bytes.get(file.mediaId) : undefined); assert.ok(bytes); return bytes; },
    async beforeLaunch() { if (claimed) throw new DomainError("WEB_AUDIT_OUTCOME_UNKNOWN", "Synthetic original claim already owned", 422, false); claimed = true; return { workerId, originalDeadline }; },
    async beforeBrowser() { checks++; } };
  return { ...base, configuration, request, capability, runtime, row, workerId, originalDeadline, input, browserChecks: () => checks };
}
export type HostedFixture = Awaited<ReturnType<typeof hostedWebFixture>>;
export class MemoryHostedStore implements HostedAttemptStore {
  record: HostedAttemptRecord | null = null;
  events: string[] = [];
  retained = new Map<string, Buffer>();
  constructor(readonly row: WebAuditRow) {}
  async begin(input: HostedAttemptStart) {
    if (this.record) throw new DomainError("WEB_HOSTED_ALREADY_ATTEMPTED", "Synthetic duplicate held", 409, false);
    const configuration = verifyHostedWebConfiguration(input.configuration), configurationDigest = digest(configuration), requestHash = digest(input.request);
    const remoteName = hostedRemoteName({ tenantId: input.tenantId, jobId: input.jobId, caseId: input.caseId, requestHash, configurationDigest });
    this.record = validateHostedAttempt(hostedAttemptRecordSchema.parse({ version: "guild.web-hosted-attempt.v1", binding: { caseId: input.caseId, tenantId: input.tenantId, jobId: input.jobId,
      bundleId: input.bundleId, commissionId: this.row.commission_id, packageId: this.row.package_id, contractVersion: this.row.contract_version, requestHash, authorityDigest: input.request.authorityDigest,
      workerId: input.workerId, originalDeadline: input.originalDeadline, originalDispatchedAt: this.row.dispatched_at!.toISOString(), configurationDigest, snapshotId: configuration.metadata.snapshot.id,
      remoteName }, configuration,
      phase: "create_intent", revision: 0, session: null, commands: { verify: null, upload: null, browser: null }, recoveryReads: [], runtimeProof: null, uploadProof: null, evidence: null,
      creationDescriptor: hostedCreationDescriptor(remoteName, configuration.metadata.snapshot.id), snapshotProof: null, sessionReceipt: null, commandSpecs: { verify: null, upload: null, browser: null }, launchIdentity: null,
      observationHash: null, errors: [], firstUnknownAt: null, lastUnknownAt: null, updatedAt: new Date().toISOString() }), this.row);
    this.events.push("create_intent"); return clone(this.record);
  }
  async read(tenantId: string, caseId: string) { assert.equal(tenantId, this.row.tenant_id); assert.equal(caseId, this.row.id); assert.ok(this.record); return clone(this.record); }
  async change(previous: HostedAttemptRecord, patch: HostedAttemptPatch, event: string) {
    assert.equal(digest(previous), digest(this.record));
    this.record = validateHostedAttempt({ ...clone(previous), ...clone(patch), revision: previous.revision + 1, updatedAt: new Date().toISOString() }, this.row);
    this.events.push(event); return clone(this.record);
  }
  async unknown(previous: HostedAttemptRecord, code: string) {
    assert.equal(digest(previous), digest(this.record));
    const at = new Date().toISOString(); this.record = { ...clone(previous), revision: previous.revision + 1, updatedAt: at,
      errors: [...previous.errors, { phase: previous.phase, code, at }], firstUnknownAt: previous.firstUnknownAt ?? at, lastUnknownAt: at };
    this.events.push(code); return clone(this.record);
  }
  async retain(_previous: HostedAttemptRecord, files: Map<string, Buffer>) {
    for (const [path, bytes] of files) { const saved = this.retained.get(path); if (saved && !saved.equals(bytes)) throw new DomainError("WEB_HOSTED_IDENTITY_CHANGED", "Synthetic different original bytes held", 422, false); this.retained.set(path, Buffer.from(bytes)); }
    hostedFilesManifest(this.retained);
  }
  async files(_previous: HostedAttemptRecord) { return new Map([...this.retained].map(([path, bytes]) => [path, Buffer.from(bytes)])); }
}
export interface FakeHostedOptions {
  lostCreate?: boolean; lostUpload?: boolean; lostBrowserBeforeStart?: boolean; lostBrowserAfterStart?: boolean;
  failReadPath?: string; missingIndex?: boolean; missingResult?: boolean; incomplete?: boolean; failing?: boolean; lostStop?: boolean;
  changedRuntime?: boolean; changedSnapshot?: boolean;
  afterUploadVerified?: () => Promise<void>;
}
export class SyntheticHostedDriver implements HostedSandboxDriver {
  counts = { create: 0, get: 0, verify: 0, upload: 0, uploadVerify: 0, browser: 0, readonly: 0, read: 0, stop: 0 };
  events: string[] = [];
  remote = new Map<string, Buffer>();
  commands = new Map<string, HostedCommandIdentity>();
  status: HostedSessionIdentity["status"] = "running"; sessionId = "synthetic-original-session"; createdAt = new Date().toISOString(); name = "";
  readLost = false;
  constructor(readonly fixture: HostedFixture, readonly options: FakeHostedOptions = {}) {
    this.remote.set(hostedWebPaths.runtime, Buffer.from(JSON.stringify(fixture.configuration.metadata.originalRuntime)));
    this.remote.set(fixture.configuration.metadata.originalRuntime.qualificationPath, Buffer.from(JSON.stringify(fixture.configuration.metadata.qualification)));
  }
  async snapshot(configuration: HostedWebConfiguration) {
    const snapshot = configuration.metadata.snapshot; this.events.push("snapshot_read");
    return { id: snapshot.id, sourceSessionId: this.options.changedSnapshot ? "synthetic-foreign-session" : snapshot.sourceSessionId, createdAt: snapshot.createdAt, expiresAt: snapshot.expiresAt, regions: [snapshot.region], status: "created" };
  }
  async create(name: string, _configuration: HostedWebConfiguration) {
    this.counts.create++; this.events.push("create"); this.name = name; this.createdAt = new Date().toISOString();
    if (this.options.lostCreate) throw new TypeError("synthetic private lost create response");
    return this.handle();
  }
  async get(name: string, _configuration: HostedWebConfiguration) { this.counts.get++; this.events.push("original_session_read"); assert.equal(name, this.name); return this.handle(); }
  private handle(): HostedSessionAccess {
    const driver = this;
    const identity: HostedSessionIdentity = { name: this.name, persistent: false, sessionId: this.sessionId, createdAt: this.createdAt, status: this.status,
      snapshotId: this.fixture.configuration.metadata.snapshot.id, networkPolicy: "deny-all", ports: [], vcpus: 2, timeoutMs: 600000, region: "iad1" };
    return { identity,
      async upload(files) { driver.counts.upload++; driver.events.push("upload"); for (const file of files) { assert.equal(file.mode, 0o600); driver.remote.set(file.path, Buffer.from(file.content)); } if (driver.options.lostUpload) throw new TypeError("synthetic lost upload"); },
      async read(path, maximumBytes) { driver.counts.read++; driver.events.push("read:" + path.split("/").at(-1)); if (driver.status !== "running") throw new TypeError("synthetic stopped session refuses filesystem access");
        if (!driver.readLost && driver.options.failReadPath && path.endsWith("/" + driver.options.failReadPath)) { driver.readLost = true; throw new TypeError("synthetic lost read"); }
        const bytes = driver.remote.get(path); if (bytes && bytes.length > maximumBytes) throw new Error("synthetic bounded read exceeded"); return bytes ? Buffer.from(bytes) : null; },
      async command(id) { const command = driver.commands.get(id); assert.ok(command); return clone(command); },
      async run(spec, onStart) { return driver.run(spec, onStart); },
      async stop() { driver.counts.stop++; driver.events.push("stop"); driver.status = "stopped"; if (driver.options.lostStop) throw new TypeError("synthetic lost stop"); },
    };
  }
  private async run(spec: HostedCommandSpec, onStart: (command: HostedCommandIdentity) => Promise<void>): Promise<HostedCommandOutput> {
    assert.equal(spec.cmd, "/usr/bin/env"); assert.deepEqual(spec.env, {}); assert.equal(spec.args[0], "-i");
    const script = spec.args.find(value => value.includes("guild.web-hosted-")) ?? "";
    const stage = spec.args.includes(hostedWebPaths.tools + "/qualify.mjs") ? "verify" : script.includes("guild.web-hosted-launch.v1") ? "browser" : script.includes("guild.web-hosted-upload-proof.v1") ? "uploadVerify" : "readonly";
    this.counts[stage]++; this.events.push(stage); assert.equal(this.status, "running");
    if (stage === "browser") assert.equal(spec.timeoutMs, 330000);
    const command = { id: `synthetic-${stage}-${this.counts[stage]}`, startedAt: Date.now(), cwd: spec.cwd, exitCode: null as number | null };
    this.commands.set(command.id, command);
    if (!(stage === "browser" && this.options.lostBrowserBeforeStart)) await onStart(clone(command));
    let stdout = "", exitCode = 0;
    if (stage === "verify") stdout = JSON.stringify({ capability: this.options.changedRuntime ? { ...this.fixture.capability, dependenciesDigest: digest("changed synthetic dependency") } : this.fixture.capability, browserLaunched: false }) + "\n";
    else if (stage === "uploadVerify") stdout = JSON.stringify({ version: "guild.web-hosted-upload-proof.v1", requestHash: digest(this.fixture.request), bundleDigest: this.fixture.request.bundle.filesDigest, browserLaunched: false }) + "\n";
    else if (stage === "readonly") {
      const directory = spec.args.at(-2)!, identity = JSON.parse(spec.args.at(-1)!);
      stdout = JSON.stringify(this.outputIndex(directory, identity, "readonly_original_result_read")) + "\n";
    } else {
      const directory = spec.args.at(-3)!, identity = JSON.parse(spec.args.at(-1)!);
      const startedAt = new Date(command.startedAt + 1).toISOString(), finishedAt = new Date(command.startedAt + 2).toISOString();
      const values = new Map([...this.fixture.values].map(([path, bytes]) => [path, Buffer.from(bytes)]));
      const palette = JSON.parse(values.get("palette-contrast.json")!.toString()); palette.observedAt = startedAt; values.set("palette-contrast.json", Buffer.from(JSON.stringify(palette)));
      const result = clone(this.fixture.result); Object.assign(result, { requestDigest: digest(this.fixture.request), mode: this.fixture.request.mode, caseId: this.fixture.request.caseId,
        capabilityDigest: digest(this.fixture.capability), startedAt, finishedAt });
      if (this.options.failing) { const raw = JSON.parse(values.get("axe-default.json")!.toString()); raw.violations = [{ id: "synthetic-serious-finding", impact: "serious", synthetic: true }];
        values.set("axe-default.json", Buffer.from(JSON.stringify(raw))); result.axe[0]!.violations = 1; result.axe[0]!.seriousCritical = 1; }
      if (this.options.incomplete) { result.complete = false; result.errors = [{ code: "SYNTHETIC_INCOMPLETE", message: "Synthetic incomplete original; no measured browser is represented." }]; exitCode = 2; }
      result.files = hostedFilesManifest(values);
      result.axe = result.axe.map(state => ({ ...state, file: result.files.find(file => file.path === state.file.path)! }));
      if (result.lighthouse) result.lighthouse.file = result.files.find(file => file.path === result.lighthouse!.file.path)!;
      const launch = { version: "guild.web-hosted-launch.v1", ...identity, startedAt: new Date(command.startedAt).toISOString(), pid: 4321 };
      this.remote.set(directory + "/hosted-launch.json", Buffer.from(JSON.stringify(launch)));
      this.remote.set(directory + "/evidence/dispatch.json", Buffer.from(JSON.stringify({ version: "guild.local-browser-dispatch.v1", pid: 4321, requestDigest: digest(this.fixture.request), startedAt })));
      for (const [path, bytes] of values) this.remote.set(directory + "/evidence/" + path, bytes);
      if (!this.options.missingResult) this.remote.set(directory + "/evidence/result.json", Buffer.from(JSON.stringify(result)));
      if (!this.options.missingIndex) this.remote.set(directory + "/hosted-output-index.json", Buffer.from(JSON.stringify(this.outputIndex(directory + "/evidence", identity, "original_browser_command"))));
      stdout = JSON.stringify({ caseId: result.caseId, complete: result.complete }) + "\n";
    }
    command.exitCode = exitCode;
    if (stage === "uploadVerify") await this.options.afterUploadVerified?.();
    if (stage === "browser" && (this.options.lostBrowserAfterStart || this.options.lostBrowserBeforeStart)) throw new TypeError("synthetic lost original browser response");
    return { ...command, stdout };
  }
  private outputIndex(directory: string, identity: unknown, source: string) {
    const files = new Map([...this.remote].filter(([path]) => path.startsWith(directory + "/")).map(([path, bytes]) => [path.slice(directory.length + 1), bytes]));
    return { version: "guild.web-hosted-output-index.v1", ...identity as object, source, files: hostedFilesManifest(files) };
  }
}
