import { createHmac, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { canonical, digest, DomainError } from "@/domain/primitives";
import { deepgramTimestampCapability } from "@/domain/deepgram-caption-alignment";
import { deepgramSourcePolicy } from "@/domain/deepgram-source-mapping";
import { transaction, getPool } from "../db";
import { DeepgramGatewayError, DeepgramTimestampGateway, checkedDeepgramReceipt, deepgramRequestDescriptor, type DeepgramTimestampInput, type DeepgramTimestampReceipt } from "./deepgram-gateway";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const scopeSchema = z.object({
  tenantId: z.string().uuid(), commissionId: z.string().uuid(), jobId: z.string().uuid(), packageId: z.string().min(1).max(100),
  mediaId: z.string().uuid(), producingJobId: z.string().uuid(), sourceArtifactHash: hash, sourceTextHash: hash,
  agreementDigest: hash, authorityExpiresAt: z.string().datetime(), operationKey: z.string().min(1).max(150).regex(/^[A-Za-z0-9:._-]+$/),
}).strict();
export type DeepgramRunScope = z.infer<typeof scopeSchema>;
export interface DeepgramRunAuthorizer {
  /** Required integration boundary: verify the exact current agreement, source,
   * actor and worker lease under these locks. A gateway key is not authority. */
  authorize(db: PoolClient, scope: Readonly<DeepgramRunScope>): Promise<void>;
}
type Wire = ReturnType<typeof deepgramRequestDescriptor>;
interface SavedRequest {
  schemaVersion: "guild.deepgram-ledger-request.v1";
  scope: DeepgramRunScope; wire: Wire; sourcePolicyHash: string;
}
interface Row {
  id: string; tenant_id: string; commission_id: string; package_id: string; job_id: string; media_id: string;
  capability_version: string; operation_key: string; input_hash: string; request: SavedRequest;
  state: "prepared" | "dispatching" | "received" | "failed" | "indeterminate";
  dispatched_at: Date | null; failure_code: string | null;
}
interface Observation { schemaVersion: "guild.deepgram-ledger-evidence.v1"; inputHash: string; receipt: DeepgramTimestampReceipt; signature: string }
function fail(code: string, message: string): never { throw new DomainError(code, message, 422, false); }
function signingKey() { const key = process.env.AUTH_SECRET; if (!key) fail("DEEPGRAM_LEDGER_CONFIGURATION", "Private observation signing is not configured."); return key; }
function signature(value: Omit<Observation, "signature">) { return createHmac("sha256", signingKey()).update(canonical(value)).digest("hex"); }
function requestHash(request: SavedRequest) { return digest(request); }
function checkedRow(row: Row) {
  const r = row.request;
  if (!r || r.schemaVersion !== "guild.deepgram-ledger-request.v1" || !scopeSchema.safeParse(r.scope).success
    || row.input_hash !== requestHash(r) || row.id !== r.wire?.requestId || row.tenant_id !== r.scope.tenantId || row.commission_id !== r.scope.commissionId
    || row.package_id !== r.scope.packageId || row.job_id !== r.scope.jobId || row.media_id !== r.scope.mediaId || row.operation_key !== "deepgram:" + r.scope.operationKey
    || row.capability_version !== deepgramTimestampCapability.version || r.wire.capabilityVersion !== deepgramTimestampCapability.version
    || r.sourcePolicyHash !== digest(deepgramSourcePolicy)) fail("DEEPGRAM_LEDGER_CHANGED", "The retained Deepgram request no longer matches its original source and operation.");
  return row;
}

/** Owner-scoped historical reads never require current provider credentials or
 * production authority. They never create a replacement recognition request. */
export async function readDeepgramRun(tenantId: string, runId: string, db: Pool | PoolClient = getPool()) {
  const row = (await db.query<Row>("SELECT * FROM guild_alignment_runs WHERE tenant_id=$1 AND id=$2", [z.string().uuid().parse(tenantId), z.string().uuid().parse(runId)])).rows[0];
  if (!row) fail("DEEPGRAM_RUN_NOT_FOUND", "That original timestamp request is not in this workspace.");
  checkedRow(row);
  const saved = (await db.query<{ receipt_hash: string; receipt: Observation }>("SELECT receipt_hash,receipt FROM guild_alignment_observations WHERE tenant_id=$1 AND run_id=$2", [tenantId, runId])).rows[0];
  if (!saved) return { row, receipt: null, evidenceHash: null, productionAccepted: false as const };
  const observed = saved.receipt, { signature: signed, ...body } = observed;
  if (!row.dispatched_at || digest(observed) !== saved.receipt_hash || observed.schemaVersion !== "guild.deepgram-ledger-evidence.v1"
    || observed.inputHash !== row.input_hash || !/^[a-f0-9]{64}$/.test(signed) || !timingSafeEqual(Buffer.from(signed), Buffer.from(signature(body))))
    fail("DEEPGRAM_EVIDENCE_CHANGED", "The retained timestamp observation differs from its signed original evidence.");
  checkedDeepgramReceipt(observed.receipt, row.request.wire);
  if (Date.parse(observed.receipt.observedAt) < row.dispatched_at.getTime() - 1000) fail("DEEPGRAM_EVIDENCE_CHANGED", "The response predates its original dispatch.");
  return { row, receipt: observed.receipt, evidenceHash: saved.receipt_hash, productionAccepted: false as const };
}

async function lockSourceAndAuthority(db: PoolClient, scope: DeepgramRunScope, wire: Wire, authorizer: DeepgramRunAuthorizer) {
  // All calls use the same commission→job→media lock order. Recheck inside the
  // exact transaction that claims dispatch, including expiry and source bytes.
  const commission = await db.query("SELECT id FROM guild_commissions WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [scope.tenantId, scope.commissionId]);
  const job = await db.query("SELECT id FROM guild_jobs WHERE tenant_id=$1 AND commission_id=$2 AND id=$3 FOR UPDATE", [scope.tenantId, scope.commissionId, scope.jobId]);
  const media = await db.query("SELECT id FROM guild_media_objects WHERE tenant_id=$1 AND commission_id=$2 AND id=$3 AND job_id=$4 AND state='ready' AND content_hash=$5 AND byte_length=$6 AND media_type=$7 FOR UPDATE", [scope.tenantId, scope.commissionId, scope.mediaId, scope.producingJobId, wire.audioHash, wire.audioBytes, wire.mimeType]);
  if (!commission.rowCount || !job.rowCount || !media.rowCount) fail("DEEPGRAM_SOURCE_BINDING", "Only the exact owned recording and its retained producing identity may enter this operation.");
  if (Date.parse(scope.authorityExpiresAt) <= Date.now()) fail("DEEPGRAM_AUTHORITY_EXPIRED", "This timestamp request needs current, explicitly granted authority. Earlier evidence remains readable.");
  await authorizer.authorize(db, Object.freeze({ ...scope }));
}

async function retain(row: Row, receipt: DeepgramTimestampReceipt) {
  checkedDeepgramReceipt(receipt, row.request.wire);
  const body = { schemaVersion: "guild.deepgram-ledger-evidence.v1" as const, inputHash: row.input_hash, receipt }, observation: Observation = { ...body, signature: signature(body) };
  await transaction(async db => {
    const current = (await db.query<Row>("SELECT * FROM guild_alignment_runs WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [row.id, row.tenant_id])).rows[0];
    if (!current?.dispatched_at || current.input_hash !== row.input_hash || digest(current.request) !== digest(row.request)) fail("DEEPGRAM_DISPATCH_CHANGED", "No matching original dispatch owns this response.");
    const prior = (await db.query<{ receipt_hash: string; receipt: Observation }>("SELECT receipt_hash,receipt FROM guild_alignment_observations WHERE run_id=$1 AND tenant_id=$2", [row.id, row.tenant_id])).rows[0];
    if (prior && (prior.receipt_hash !== digest(observation) || digest(prior.receipt) !== prior.receipt_hash)) fail("DEEPGRAM_OBSERVATION_CONFLICT", "The saved original observation cannot be overwritten.");
    if (!prior) await db.query("INSERT INTO guild_alignment_observations(run_id,tenant_id,receipt_hash,receipt) VALUES($1,$2,$3,$4)", [row.id, row.tenant_id, digest(observation), observation]);
    await db.query("UPDATE guild_alignment_runs SET state=$1,failure_code=$2,completed_at=clock_timestamp(),updated_at=now() WHERE id=$3 AND tenant_id=$4", [receipt.bodyComplete ? "received" : "indeterminate", receipt.parseFailure ? "DEEPGRAM_" + receipt.parseFailure : null, row.id, row.tenant_id]);
  });
}

/** Durable transport primitive. The application must supply its current
 * qualified-capability agreement authorizer; no HTTP route wires this into the
 * old Whisper agreement. Every complete or partial observation stays evidence,
 * never an acceptance, fluent review or payment instruction. */
export async function runDeepgramOnce(scopeInput: DeepgramRunScope, input: DeepgramTimestampInput, authorizer: DeepgramRunAuthorizer, gateway = new DeepgramTimestampGateway()) {
  const scope = scopeSchema.parse(scopeInput), frozen = { ...input, bytes: Buffer.from(input.bytes) };
  const wire = deepgramRequestDescriptor(frozen), request: SavedRequest = { schemaVersion: "guild.deepgram-ledger-request.v1", scope, wire, sourcePolicyHash: digest(deepgramSourcePolicy) };
  const inputHash = requestHash(request), operation = "deepgram:" + scope.operationKey;
  const existing = (await getPool().query<Row>("SELECT * FROM guild_alignment_runs WHERE tenant_id=$1 AND job_id=$2 AND operation_key=$3", [scope.tenantId, scope.jobId, operation])).rows[0];
  if (existing) {
    checkedRow(existing);
    if (existing.input_hash !== inputHash) fail("DEEPGRAM_OPERATION_CHANGED", "This original operation already belongs to different bytes, source or agreement terms.");
    if (existing.state === "received") return readDeepgramRun(scope.tenantId, existing.id);
    if (existing.state !== "prepared") fail("DEEPGRAM_ORIGINAL_PENDING", "The original request has an incomplete or unknown result. Its identity is retained and it was not resent.");
  }
  // Configuration failure does not consume the one permitted dispatch.
  signingKey(); gateway.preflight(frozen);
  const original = existing ?? await transaction(async db => {
    await lockSourceAndAuthority(db, scope, wire, authorizer);
    if ((await db.query("SELECT id FROM guild_alignment_runs WHERE tenant_id=$1 AND job_id=$2 AND media_id=$3 AND capability_version=$4", [scope.tenantId, scope.jobId, scope.mediaId, deepgramTimestampCapability.version])).rowCount)
      fail("DEEPGRAM_MEDIA_ALREADY_PREPARED", "This recording already owns its original request in this job. A new label cannot create another attempt.");
    const count = (await db.query<{ count: number }>("SELECT count(*)::int AS count FROM guild_alignment_runs WHERE tenant_id=$1 AND job_id=$2 AND capability_version=$3", [scope.tenantId, scope.jobId, deepgramTimestampCapability.version])).rows[0]!.count;
    if (count >= 78) fail("DEEPGRAM_CAPACITY", "This job already contains its complete bounded recording register. Earlier attempts remain counted.");
    const inserted = (await db.query<Row>("INSERT INTO guild_alignment_runs(id,tenant_id,commission_id,package_id,job_id,media_id,capability_version,operation_key,input_hash,request,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'prepared') ON CONFLICT DO NOTHING RETURNING *", [wire.requestId, scope.tenantId, scope.commissionId, scope.packageId, scope.jobId, scope.mediaId, deepgramTimestampCapability.version, operation, inputHash, request])).rows[0];
    if (!inserted) fail("DEEPGRAM_CONCURRENT_PREPARATION", "Another worker already prepared this exact operation. Continue its saved identity without another request.");
    return inserted;
  });
  let ownsDispatch = false;
  try {
    const receipt = await gateway.transcribe(frozen, async () => {
      await transaction(async db => {
        await lockSourceAndAuthority(db, scope, wire, authorizer);
        gateway.preflight(frozen);
        const claimed = await db.query("UPDATE guild_alignment_runs SET state='dispatching',dispatched_at=clock_timestamp(),updated_at=now() WHERE id=$1 AND tenant_id=$2 AND state='prepared' AND dispatched_at IS NULL AND input_hash=$3 AND request=$4::jsonb RETURNING id", [original.id, scope.tenantId, inputHash, request]);
        if (!claimed.rowCount) fail("DEEPGRAM_ALREADY_DISPATCHED", "Only the original claimed worker may send this request.");
      });
      ownsDispatch = true;
    });
    await retain(original, receipt);
    return readDeepgramRun(scope.tenantId, original.id);
  } catch (error) {
    if (error instanceof DeepgramGatewayError && error.receipt) await retain(original, error.receipt);
    if (ownsDispatch) await getPool().query("UPDATE guild_alignment_runs SET state='indeterminate',failure_code=$1,updated_at=now() WHERE id=$2 AND tenant_id=$3 AND state='dispatching'", [error instanceof DeepgramGatewayError ? error.code : "DEEPGRAM_OBSERVATION_UNKNOWN", original.id, scope.tenantId]);
    throw error;
  }
}
