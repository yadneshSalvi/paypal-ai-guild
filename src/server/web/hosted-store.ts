import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { webAuditFileSchema, type WebAuditRequest } from "@/domain/web-audits";
import { canonical, digest, DomainError } from "@/domain/primitives";
import { getPool, transaction } from "../db";
import type { WebAuditRow } from "./audit-store";
import { hostedWebConfigurationSchema, hostedWebPaths, verifyHostedWebConfiguration } from "./hosted-config";

const hash = z.string().regex(/^[a-f0-9]{64}$/), date = z.string().datetime(), id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
export const hostedPhases = ["create_intent", "session_bound", "verify_intent", "runtime_verified", "upload_intent", "uploads_verified", "browser_intent", "browser_started", "browser_finished", "evidence_retained", "cleanup_intent", "cleaned"] as const;
const bindingSchema = z.object({
  caseId: z.string().uuid(), tenantId: z.string().uuid(), commissionId: z.string().uuid(), jobId: z.string().uuid(), bundleId: z.string().uuid(),
  packageId: z.string().min(1).max(100), contractVersion: z.number().int().positive(), requestHash: hash, authorityDigest: hash,
  originalDeadline: date, originalDispatchedAt: date, workerId: z.string().uuid(), configurationDigest: hash, snapshotId: id,
  remoteName: z.string().regex(/^guild-web-[a-f0-9]{40}$/),
}).strict();
const commandSchema = z.object({ id, startedAt: z.number().int().positive(), descriptorHash: hash, exitCode: z.number().int().nullable() }).strict();
const commandSpecSchema = z.object({ cmd: z.literal("/usr/bin/env"), args: z.array(z.string().max(100000)).min(1).max(30), cwd: z.literal(hostedWebPaths.tools), env: z.object({}).strict(), timeoutMs: z.union([z.literal(120000), z.literal(60000), z.literal(330000), z.literal(30000)]) }).strict();
const launchIdentitySchema = z.object({ bindingDigest: hash, requestHash: hash, sessionId: id, programHash: hash }).strict();
const creationDescriptorSchema = z.object({ name: z.string(), persistent: z.literal(false), source: z.object({ type: z.literal("snapshot"), snapshotId: id }).strict(), resources: z.object({ vcpus: z.literal(2) }).strict(), timeout: z.literal(600000), region: z.literal("iad1"), networkPolicy: z.literal("deny-all"), ports: z.array(z.never()).length(0), env: z.object({}).strict() }).strict();
export type HostedCommandRecord = z.infer<typeof commandSchema>;
export const hostedAttemptRecordSchema = z.object({
  version: z.literal("guild.web-hosted-attempt.v1"), binding: bindingSchema, configuration: hostedWebConfigurationSchema,
  phase: z.enum(hostedPhases), revision: z.number().int().nonnegative(),
  session: z.object({ id, createdAt: date }).strict().nullable(),
  creationDescriptor: creationDescriptorSchema,
  snapshotProof: z.object({ id, sourceSessionId: id, status: z.literal("created"), createdAt: date, expiresAt: date, regions: z.array(z.string()).min(1).max(20), observedAt: date }).strict().nullable(),
  sessionReceipt: z.object({ observedBy: z.enum(["create_response", "original_name_read"]), observedAt: date, name: z.string(), persistent: z.literal(false), sessionId: id, createdAt: date,
    status: z.enum(["pending", "running", "stopping", "stopped", "failed", "aborted", "snapshotting"]), snapshotId: id, networkPolicy: z.literal("deny-all"), ports: z.array(z.never()).length(0), vcpus: z.literal(2), timeoutMs: z.literal(600000), region: z.literal("iad1") }).strict().nullable(),
  commandSpecs: z.object({ verify: commandSpecSchema.nullable(), upload: commandSpecSchema.nullable(), browser: commandSpecSchema.nullable() }).strict(),
  launchIdentity: launchIdentitySchema.nullable(),
  commands: z.object({ verify: commandSchema.nullable(), upload: commandSchema.nullable(), browser: commandSchema.nullable() }).strict(),
  recoveryReads: z.array(commandSchema.extend({ spec: commandSpecSchema }).strict()).max(20),
  runtimeProof: z.object({ stdoutHash: hash, capabilityDigest: hash, originalRuntimeDigest: hash, originalQualificationDigest: hash }).strict().nullable(),
  uploadProof: z.object({ stdoutHash: hash, requestHash: hash, bundleDigest: hash }).strict().nullable(),
  evidence: z.object({ resultHash: hash, nativeFilesDigest: hash, allFilesDigest: hash, retainedAt: date }).strict().nullable(),
  observationHash: hash.nullable(),
  errors: z.array(z.object({ phase: z.enum(hostedPhases), code: z.string().regex(/^[A-Z0-9_]{1,100}$/), at: date }).strict()).max(100),
  firstUnknownAt: date.nullable(), lastUnknownAt: date.nullable(), updatedAt: date,
}).strict();
export type HostedAttemptRecord = z.infer<typeof hostedAttemptRecordSchema>;
export type HostedAttemptBinding = HostedAttemptRecord["binding"];
export interface HostedAttemptStart {
  caseId: string; tenantId: string; jobId: string; bundleId: string; request: WebAuditRequest;
  workerId: string; originalDeadline: string; configuration: HostedAttemptRecord["configuration"];
}
export type HostedAttemptPatch = Partial<Pick<HostedAttemptRecord, "phase" | "session" | "snapshotProof" | "sessionReceipt" | "commandSpecs" | "launchIdentity" | "commands" | "recoveryReads" | "runtimeProof" | "uploadProof" | "evidence" | "observationHash">>;
export interface HostedAttemptStore {
  begin(input: HostedAttemptStart): Promise<HostedAttemptRecord>;
  read(tenantId: string, caseId: string): Promise<HostedAttemptRecord>;
  change(previous: HostedAttemptRecord, patch: HostedAttemptPatch, event: string): Promise<HostedAttemptRecord>;
  unknown(previous: HostedAttemptRecord, code: string): Promise<HostedAttemptRecord>;
  retain(previous: HostedAttemptRecord, files: Map<string, Buffer>): Promise<void>;
  files(previous: HostedAttemptRecord): Promise<Map<string, Buffer>>;
}
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function sign(kind: string, value: unknown) { if (!process.env.AUTH_SECRET) throw new Error("AUTH_SECRET required"); return createHmac("sha256", process.env.AUTH_SECRET).update(canonical({ kind, value })).digest("hex"); }
function fail(message = "The retained hosted attempt differs from its original dispatch, request, session or command identity."): never { throw new DomainError("WEB_HOSTED_IDENTITY_CHANGED", message, 422, false); }
export function hostedRemoteName(input: { tenantId: string; caseId: string; jobId: string; requestHash: string; configurationDigest: string }) {
  return "guild-web-" + digest(input).slice(0, 40);
}
export function hostedCreationDescriptor(name: string, snapshotId: string): HostedAttemptRecord["creationDescriptor"] {
  return { name, persistent: false, source: { type: "snapshot", snapshotId }, resources: { vcpus: 2 }, timeout: 600000, region: "iad1", networkPolicy: "deny-all", ports: [], env: {} };
}
export function hostedFilesManifest(files: Map<string, Buffer>) {
  if (files.size > 210 || [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0) > 70 * 1024 * 1024) fail("The original hosted evidence exceeded its bounded file register.");
  return [...files].map(([path, bytes]) => webAuditFileSchema.parse({ path, byteLength: bytes.length, contentHash: sha(bytes) })).sort((a, b) => a.path.localeCompare(b.path));
}
export function validateHostedAttempt(record: HostedAttemptRecord, row: WebAuditRow) {
  const value = hostedAttemptRecordSchema.parse(record), b = value.binding, config = verifyHostedWebConfiguration(value.configuration, { historical: true });
  if (b.caseId !== row.id || b.tenantId !== row.tenant_id || b.jobId !== row.job_id || b.commissionId !== row.commission_id || b.packageId !== row.package_id || b.contractVersion !== row.contract_version
    || b.requestHash !== row.request_hash || digest(row.request) !== row.request_hash || b.authorityDigest !== row.request.authorityDigest || !row.dispatched_at
    || b.originalDispatchedAt !== row.dispatched_at.toISOString() || b.configurationDigest !== digest(config) || b.snapshotId !== config.metadata.snapshot.id
    || Date.parse(b.originalDeadline) <= Date.parse(b.originalDispatchedAt)
    || digest(config.metadata.originalRuntime.capability) !== digest(row.request.capability)
    || digest(value.creationDescriptor) !== digest(hostedCreationDescriptor(b.remoteName, b.snapshotId))
    || value.snapshotProof && (value.snapshotProof.id !== b.snapshotId || value.snapshotProof.sourceSessionId !== config.metadata.snapshot.sourceSessionId || value.snapshotProof.createdAt !== config.metadata.snapshot.createdAt || value.snapshotProof.expiresAt !== config.metadata.snapshot.expiresAt || !value.snapshotProof.regions.includes(config.metadata.snapshot.region))
    || value.session && (!value.snapshotProof || !value.sessionReceipt || value.sessionReceipt.sessionId !== value.session.id || value.sessionReceipt.createdAt !== value.session.createdAt
      || value.sessionReceipt.name !== b.remoteName || value.sessionReceipt.snapshotId !== b.snapshotId || value.session.id === config.metadata.snapshot.sourceSessionId)
    || value.launchIdentity && (value.launchIdentity.bindingDigest !== digest(b) || value.launchIdentity.requestHash !== b.requestHash || value.launchIdentity.sessionId !== value.session?.id)
    || b.remoteName !== hostedRemoteName({ tenantId: b.tenantId, caseId: b.caseId, jobId: b.jobId, requestHash: b.requestHash, configurationDigest: b.configurationDigest })
    || value.commands.browser && !value.session || value.evidence && (!value.commands.browser || !value.runtimeProof || !value.uploadProof)
    || value.errors.length && (!value.firstUnknownAt || !value.lastUnknownAt) || value.firstUnknownAt !== (value.errors[0]?.at ?? null)) fail();
  const prefix = ["-i", "PATH=/tmp/guild-node/node-v22.22.3-linux-x64/bin:/usr/bin:/bin", "TMPDIR=/tmp", "LANG=en_US.UTF-8", hostedWebPaths.node];
  for (const stage of ["verify", "upload", "browser"] as const) {
    const spec = value.commandSpecs[stage];
    if (spec && (digest(spec.args.slice(0, prefix.length)) !== digest(prefix) || spec.timeoutMs !== ({ verify: 120000, upload: 60000, browser: 330000 } as const)[stage])) fail();
    if (value.commands[stage] && (!spec || value.commands[stage]!.descriptorHash !== digest(spec))) fail();
  }
  if (value.commandSpecs.browser && !value.launchIdentity) fail();
  if (value.commandSpecs.browser) {
    const args = value.commandSpecs.browser.args, programIndex = args.indexOf("--eval");
    try { if (programIndex < 0 || sha(Buffer.from(args[programIndex + 1]!)) !== value.launchIdentity!.programHash || digest(JSON.parse(args.at(-1)!)) !== digest(value.launchIdentity)) fail(); }
    catch { fail(); }
  }
  for (const read of value.recoveryReads) if (read.descriptorHash !== digest(read.spec) || read.spec.timeoutMs !== 30000 || digest(read.spec.args.slice(0, prefix.length)) !== digest(prefix)) fail();
  return value;
}
interface SavedAttempt { record: HostedAttemptRecord; record_hash: string; signature: string; phase: string; revision: number; original_session_id: string | null; original_command_id: string | null }
function checked(saved: SavedAttempt | undefined, row: WebAuditRow | undefined) {
  if (!saved || !row || !/^[a-f0-9]{64}$/.test(saved.signature) || digest(saved.record) !== saved.record_hash
    || !timingSafeEqual(Buffer.from(saved.signature), Buffer.from(sign("guild.web-hosted-attempt-record.v1", saved.record)))
    || saved.phase !== saved.record.phase || saved.revision !== saved.record.revision || saved.original_session_id !== (saved.record.session?.id ?? null)
    || saved.original_command_id !== (saved.record.commands.browser?.id ?? null)) fail();
  return validateHostedAttempt(saved.record, row);
}
async function readLocked(db: PoolClient, tenantId: string, caseId: string) {
  const row = (await db.query<WebAuditRow>("SELECT * FROM guild_web_audit_cases WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [tenantId, caseId])).rows[0];
  const saved = (await db.query<SavedAttempt>("SELECT * FROM guild_web_hosted_attempts WHERE tenant_id=$1 AND case_id=$2 FOR UPDATE", [tenantId, caseId])).rows[0];
  return { row, record: checked(saved, row) };
}
/** Used inside the existing observation transaction, so historical recovery
 * cannot manufacture a fresh dispatch or race a replacement command. */
export async function originalHostedObservation(db: PoolClient, row: WebAuditRow) {
  const saved = (await db.query<SavedAttempt>("SELECT * FROM guild_web_hosted_attempts WHERE tenant_id=$1 AND case_id=$2 FOR UPDATE", [row.tenant_id, row.id])).rows[0];
  return saved ? checked(saved, row) : null;
}
function assertPatch(previous: HostedAttemptRecord, patch: HostedAttemptPatch) {
  if (patch.session && previous.session && digest(patch.session) !== digest(previous.session)) fail();
  if (patch.commands) for (const key of ["verify", "upload", "browser"] as const) {
    const original = previous.commands[key], next = patch.commands[key];
    if (original && (!next || original.id !== next.id || original.startedAt !== next.startedAt || original.descriptorHash !== next.descriptorHash || original.exitCode !== null && original.exitCode !== next.exitCode)) fail();
  }
  if (patch.recoveryReads) {
    if (patch.recoveryReads.length < previous.recoveryReads.length) fail();
    for (const [index, item] of previous.recoveryReads.entries()) {
      const next = patch.recoveryReads[index];
      if (!next || item.id !== next.id || item.startedAt !== next.startedAt || item.descriptorHash !== next.descriptorHash || digest(item.spec) !== digest(next.spec) || item.exitCode !== null && item.exitCode !== next.exitCode) fail();
    }
  }
  if (patch.commandSpecs) for (const stage of ["verify", "upload", "browser"] as const)
    if (previous.commandSpecs[stage] && digest(previous.commandSpecs[stage]) !== digest(patch.commandSpecs[stage])) fail();
  for (const key of ["snapshotProof", "sessionReceipt", "launchIdentity", "runtimeProof", "uploadProof", "evidence", "observationHash"] as const)
    if (previous[key] !== null && patch[key] !== undefined && digest(previous[key]) !== digest(patch[key])) fail();
  if (patch.phase && patch.phase !== previous.phase) {
    const next = hostedPhases.indexOf(patch.phase), current = hostedPhases.indexOf(previous.phase);
    const originalRecovery = patch.phase === "evidence_retained" && ["browser_intent", "browser_started", "browser_finished"].includes(previous.phase);
    if (next !== current + 1 && !originalRecovery) fail("A hosted attempt cannot move backwards or manufacture another dispatch phase.");
  }
}
async function write(db: PoolClient, record: HostedAttemptRecord, event: string) {
  const signature = sign("guild.web-hosted-attempt-record.v1", record), recordHash = digest(record);
  await db.query("UPDATE guild_web_hosted_attempts SET record=$1,record_hash=$2,signature=$3,phase=$4,revision=$5,original_session_id=$6,original_command_id=$7,first_unknown_at=$8,last_unknown_at=$9,updated_at=now() WHERE case_id=$10 AND tenant_id=$11", [record, recordHash, signature, record.phase, record.revision, record.session?.id ?? null, record.commands.browser?.id ?? null, record.firstUnknownAt, record.lastUnknownAt, record.binding.caseId, record.binding.tenantId]);
  await db.query("INSERT INTO guild_web_hosted_events(case_id,tenant_id,revision,event_type,record,record_hash,signature) VALUES($1,$2,$3,$4,$5,$6,$7)", [record.binding.caseId, record.binding.tenantId, record.revision, event, record, recordHash, signature]);
}
export class PostgresHostedAttemptStore implements HostedAttemptStore {
  async begin(input: HostedAttemptStart) {
    const configuration = verifyHostedWebConfiguration(input.configuration), configurationDigest = digest(configuration), requestHash = digest(input.request);
    return transaction(async db => {
      const row = (await db.query<WebAuditRow>("SELECT * FROM guild_web_audit_cases WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [input.tenantId, input.caseId])).rows[0];
      const job = (await db.query("SELECT id FROM guild_jobs WHERE tenant_id=$1 AND id=$2 AND state='running' AND lease_token=$3 AND lease_until>now()", [input.tenantId, input.jobId, input.workerId])).rows[0];
      if (!row || !job || row.state !== "dispatching" || !row.dispatched_at || row.job_id !== input.jobId || row.request_hash !== requestHash || digest(row.request) !== requestHash) fail();
      if (!Number.isFinite(Date.parse(input.originalDeadline)) || Date.parse(input.originalDeadline) <= Date.now())
        throw new DomainError("WEB_HOSTED_AUTHORITY_EXPIRED", "The original work deadline expired before the original hosted creation intent. No deadline was renewed and no VM was created.", 422, false);
      if ((await db.query("SELECT case_id FROM guild_web_hosted_attempts WHERE tenant_id=$1 AND case_id=$2", [input.tenantId, input.caseId])).rowCount)
        throw new DomainError("WEB_HOSTED_ALREADY_ATTEMPTED", "This original hosted attempt already has a creation intent. Read its saved identity; it cannot be submitted again.", 409, false);
      const binding: HostedAttemptBinding = { caseId: row.id, tenantId: row.tenant_id, commissionId: row.commission_id, jobId: row.job_id, packageId: row.package_id, contractVersion: row.contract_version,
        bundleId: input.bundleId, requestHash, authorityDigest: row.request.authorityDigest, originalDeadline: input.originalDeadline, originalDispatchedAt: row.dispatched_at.toISOString(), workerId: input.workerId,
        configurationDigest, snapshotId: configuration.metadata.snapshot.id, remoteName: hostedRemoteName({ tenantId: row.tenant_id, caseId: row.id, jobId: row.job_id, requestHash, configurationDigest }) };
      const record = validateHostedAttempt(hostedAttemptRecordSchema.parse({ version: "guild.web-hosted-attempt.v1", binding, configuration, phase: "create_intent", revision: 0, session: null,
        creationDescriptor: hostedCreationDescriptor(binding.remoteName, binding.snapshotId), snapshotProof: null, sessionReceipt: null, commandSpecs: { verify: null, upload: null, browser: null }, launchIdentity: null,
        commands: { verify: null, upload: null, browser: null }, recoveryReads: [], runtimeProof: null, uploadProof: null, evidence: null, observationHash: null, errors: [], firstUnknownAt: null, lastUnknownAt: null, updatedAt: new Date().toISOString() }), row);
      await db.query("INSERT INTO guild_web_hosted_attempts(case_id,tenant_id,job_id,request_hash,configuration_digest,snapshot_id,remote_name,original_dispatched_at,original_worker_id,phase,revision,record,record_hash,signature) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$11,$12,$13)", [row.id, row.tenant_id, row.job_id, requestHash, configurationDigest, binding.snapshotId, binding.remoteName, binding.originalDispatchedAt, binding.workerId, record.phase, record, digest(record), sign("guild.web-hosted-attempt-record.v1", record)]);
      await db.query("INSERT INTO guild_web_hosted_events(case_id,tenant_id,revision,event_type,record,record_hash,signature) VALUES($1,$2,0,'create_intent',$3,$4,$5)", [row.id, row.tenant_id, record, digest(record), sign("guild.web-hosted-attempt-record.v1", record)]);
      return record;
    });
  }
  async read(tenantId: string, caseId: string) { return transaction(async db => (await readLocked(db, tenantId, caseId)).record); }
  async change(previous: HostedAttemptRecord, patch: HostedAttemptPatch, event: string) {
    return this.mutate(previous, patch, event);
  }
  private async mutate(previous: HostedAttemptRecord, patch: HostedAttemptPatch, event: string, failure?: string) {
    return transaction(async db => {
      const { row, record } = await readLocked(db, previous.binding.tenantId, previous.binding.caseId);
      if (digest(previous) !== digest(record)) throw new DomainError("WEB_HOSTED_ATTEMPT_BUSY", "Another reader advanced this original hosted attempt. Read its saved state again without dispatching new work.", 409, false);
      assertPatch(record, patch);
      const at = new Date().toISOString(), errors = failure ? [...record.errors, { phase: record.phase, code: failure, at }] : record.errors;
      const next = validateHostedAttempt(hostedAttemptRecordSchema.parse({ ...record, ...patch, errors, firstUnknownAt: record.firstUnknownAt ?? (failure ? at : null), lastUnknownAt: failure ? at : record.lastUnknownAt, updatedAt: at, revision: record.revision + 1 }), row!);
      await write(db, next, event); return next;
    });
  }
  async unknown(previous: HostedAttemptRecord, code: string) { return this.mutate(previous, {}, "unknown", code); }
  async retain(previous: HostedAttemptRecord, files: Map<string, Buffer>) {
    const manifest = hostedFilesManifest(files);
    await transaction(async db => {
      const { record } = await readLocked(db, previous.binding.tenantId, previous.binding.caseId);
      if (digest(record.binding) !== digest(previous.binding) || !record.session || record.session.id !== previous.session?.id) fail();
      for (const file of manifest) {
        const signature = sign("guild.web-hosted-original-file.v1", { binding: record.binding, sessionId: record.session.id, file });
        await db.query("INSERT INTO guild_web_hosted_files(case_id,tenant_id,path,byte_length,content_hash,bytes,signature) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(case_id,path) DO NOTHING", [record.binding.caseId, record.binding.tenantId, file.path, file.byteLength, file.contentHash, files.get(file.path), signature]);
        const saved = (await db.query<{ bytes: Buffer; signature: string }>("SELECT bytes,signature FROM guild_web_hosted_files WHERE tenant_id=$1 AND case_id=$2 AND path=$3", [record.binding.tenantId, record.binding.caseId, file.path])).rows[0];
        if (!saved || saved.signature !== signature || !saved.bytes.equals(files.get(file.path)!)) fail("Different original hosted bytes already own this evidence path. Earlier evidence was preserved.");
      }
      const totals = (await db.query<{ count: string; bytes: string }>("SELECT count(*)::text AS count,coalesce(sum(byte_length),0)::text AS bytes FROM guild_web_hosted_files WHERE tenant_id=$1 AND case_id=$2", [record.binding.tenantId, record.binding.caseId])).rows[0]!;
      if (Number(totals.count) > 210 || Number(totals.bytes) > 70 * 1024 * 1024) fail();
    });
  }
  async files(previous: HostedAttemptRecord) {
    const record = await this.read(previous.binding.tenantId, previous.binding.caseId), files = new Map<string, Buffer>();
    if (digest(record.binding) !== digest(previous.binding) || !record.session) fail();
    const rows = (await getPool().query<{ path: string; byte_length: number; content_hash: string; bytes: Buffer; signature: string }>("SELECT path,byte_length,content_hash,bytes,signature FROM guild_web_hosted_files WHERE tenant_id=$1 AND case_id=$2 ORDER BY path", [record.binding.tenantId, record.binding.caseId])).rows;
    for (const row of rows) {
      const file = webAuditFileSchema.parse({ path: row.path, byteLength: row.byte_length, contentHash: row.content_hash });
      if (row.bytes.length !== file.byteLength || sha(row.bytes) !== file.contentHash || row.signature !== sign("guild.web-hosted-original-file.v1", { binding: record.binding, sessionId: record.session.id, file })) fail();
      files.set(row.path, row.bytes);
    }
    hostedFilesManifest(files); return files;
  }
}
