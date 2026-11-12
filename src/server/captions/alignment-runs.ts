import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { CaptionTrackSource } from "@/domain/captions";
import { captionAuthorityCeilingSchema, captionSourcesFromPack } from "@/domain/captions";
import { timestampCapability } from "@/domain/caption-alignment";
import { digest } from "@/domain/primitives";
import { getPool, transaction } from "../db";
import { requireProductionLease, type ProductionLease } from "../production-authority";
import { ProductionContinuation, ProductionReviewRequired } from "../production-continuation";
import { AlignmentGatewayError, checkedAlignmentReceipt, OpenAIWhisperTimestampGateway, requireTimestampCapability, type AlignmentGateway, type AlignmentHttpReceipt } from "./alignment-gateway";
import { qualifiedWhisperTokenizer } from "./tokenizer";
import type { CaptionJobInput } from "./contracts";
import type { WhisperPromptExcerpt } from "./whisper-prompt";

interface AlignmentRequest {
  schemaVersion: "guild.caption-alignment-request.v1"; requestId: string; capability: typeof timestampCapability;
  sourceDigest: string; sourceTrackDigest: string; contractDigest: string; contractVersion: number;
  attempt: number; correction: { id: string; digest: string } | null; authorityCeiling: string;
  originalAudio: { mediaId: string; producingJobId: string; packageId: string; contentHash: string; byteLength: number; scriptHash: string; locale: CaptionTrackSource["locale"] };
  prompt: WhisperPromptExcerpt;
}
export interface AlignmentRow {
  id: string; tenant_id: string; commission_id: string; package_id: string; job_id: string; media_id: string; capability_version: string;
  operation_key: string; input_hash: string; request: AlignmentRequest; state: "prepared" | "dispatching" | "received" | "failed" | "indeterminate";
  failure_code: string | null; dispatched_at: Date | null;
}
type Db = Pool | PoolClient;
function fail(code: string, message: string): never { throw new ProductionReviewRequired(code, message); }
const bytesHash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function requestDigest(request: AlignmentRequest) { const { requestId: _id, ...binding } = request; return digest(binding); }

async function capabilityAvailable(db: Db, tenantId: string) {
  requireTimestampCapability(new Date(), process.env.GUILD_DISABLE_WHISPER_TIMESTAMPS !== "true");
  if ((await db.query("SELECT run_id FROM guild_caption_capability_holds WHERE tenant_id=$1 AND capability_version=$2", [tenantId, timestampCapability.version])).rowCount)
    fail("ALIGNMENT_CAPABILITY_HELD", "The frozen timestamp service was definitively unavailable. Its original receipt is retained; a different capability requires separate qualification and agreement.");
}

/** Pure binding check shared by production and the independent receipt reader. */
function checkedRow(row: AlignmentRow) {
  const r = row.request;
  if (!r || r.schemaVersion !== "guild.caption-alignment-request.v1" || row.id !== r.requestId || row.input_hash !== requestDigest(r)
    || row.capability_version !== timestampCapability.version || digest(r.capability) !== digest(timestampCapability) || row.media_id !== r.originalAudio?.mediaId
    || row.operation_key !== `caption:${r.originalAudio?.locale}:${r.originalAudio?.mediaId}:alignment`)
    fail("ALIGNMENT_REQUEST_CHANGED", "The saved timestamp request no longer matches its exact original input identity and capability.");
  return row;
}

/** Retained reads require no present production authority and never send a request. */
export async function readAlignmentRecord(tenantId: string, runId: string, db: Pool | PoolClient = getPool()) {
  const row = (await db.query<AlignmentRow>("SELECT * FROM guild_alignment_runs WHERE tenant_id=$1 AND id=$2", [tenantId, runId])).rows[0];
  if (!row) fail("ALIGNMENT_RECORD_MISSING", "The original timestamp request is unavailable in this workspace.");
  checkedRow(row);
  const observed = (await db.query<{ receipt_hash: string; receipt: AlignmentHttpReceipt }>("SELECT receipt_hash,receipt FROM guild_alignment_observations WHERE tenant_id=$1 AND run_id=$2", [tenantId, runId])).rows[0];
  if (!observed || !row.dispatched_at || digest(observed.receipt) !== observed.receipt_hash) fail("ALIGNMENT_OBSERVATION_MISSING", "The original request has no complete matching retained response. No replacement was sent.");
  let receipt: AlignmentHttpReceipt;
  try { receipt = checkedAlignmentReceipt(observed.receipt); } catch { fail("ALIGNMENT_OBSERVATION_CHANGED", "The retained timestamp response differs from its actual raw bytes or parsed content."); }
  if (receipt.requestId !== row.id || receipt.locale !== row.request.originalAudio.locale || receipt.audioHash !== row.request.originalAudio.contentHash || receipt.promptHash !== row.request.prompt.textHash
    || Date.parse(receipt.observedAt) < row.dispatched_at.getTime() - 1000) fail("ALIGNMENT_OBSERVATION_CHANGED", "The response does not identify this exact original audio, script prompt and request.");
  return { row, receipt, receiptHash: observed.receipt_hash };
}

async function retainObservation(row: AlignmentRow, receipt: AlignmentHttpReceipt) {
  checkedAlignmentReceipt(receipt);
  if (receipt.requestId !== row.id || receipt.audioHash !== row.request.originalAudio.contentHash || receipt.locale !== row.request.originalAudio.locale || receipt.promptHash !== row.request.prompt.textHash) fail("ALIGNMENT_OBSERVATION_CHANGED", "A timestamp response belongs to a different original request.");
  return transaction(async db => {
    const current = (await db.query<AlignmentRow>("SELECT * FROM guild_alignment_runs WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [row.id, row.tenant_id])).rows[0];
    if (!current?.dispatched_at || current.input_hash !== row.input_hash || digest(current.request) !== digest(row.request)) fail("ALIGNMENT_DISPATCH_CHANGED", "The timestamp request has no matching original dispatch record.");
    await db.query("INSERT INTO guild_alignment_observations(run_id,tenant_id,receipt_hash,receipt) VALUES($1,$2,$3,$4) ON CONFLICT(run_id) DO NOTHING", [row.id, row.tenant_id, digest(receipt), receipt]);
    const saved = (await db.query<{ receipt_hash: string; receipt: AlignmentHttpReceipt }>("SELECT receipt_hash,receipt FROM guild_alignment_observations WHERE run_id=$1 AND tenant_id=$2", [row.id, row.tenant_id])).rows[0];
    if (!saved || saved.receipt_hash !== digest(receipt) || digest(saved.receipt) !== saved.receipt_hash) fail("ALIGNMENT_OBSERVATION_CONFLICT", "Another original observation is already retained. Its raw response was not overwritten.");
    // Late observations are evidence even after expiry/revocation. They cannot
    // authorize a new request, a replacement job or current artifact publication.
    const complete = receipt.bodyComplete;
    await db.query("UPDATE guild_alignment_runs SET state=$1,failure_code=$2,completed_at=CASE WHEN $3 THEN now() ELSE completed_at END,updated_at=now() WHERE id=$4 AND tenant_id=$5", [complete ? "received" : "indeterminate", complete ? receipt.parseFailure ? `ALIGNMENT_${receipt.parseFailure}` : null : "ALIGNMENT_RESPONSE_UNKNOWN", complete, row.id, row.tenant_id]);
    if ([404, 410].includes(receipt.statusCode)) await db.query("INSERT INTO guild_caption_capability_holds(tenant_id,capability_version,run_id,failure_code) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,capability_version) DO NOTHING", [row.tenant_id, timestampCapability.version, row.id, `ALIGNMENT_HTTP_${receipt.statusCode}`]);
  });
}

export async function runAlignment(context: ProductionLease, packageId: string, track: CaptionTrackSource, bytes: Buffer, injectedGateway?: AlignmentGateway) {
  const authority = await transaction(db => requireProductionLease(db, context, packageId)), pkg = authority.package;
  if (!pkg || pkg.kind !== "captions") fail("ALIGNMENT_CONTRACT_REQUIRED", "Timestamp alignment needs an approved caption contract.");
  const sources = captionSourcesFromPack(pkg.acceptancePack), exact = sources.tracks.find(item => item.locale === track.locale && item.key === track.key), input = authority.job.input as CaptionJobInput;
  if (!exact || digest(track) !== digest(exact) || bytes.length !== track.byteLength || bytesHash(bytes) !== track.audioHash) fail("ALIGNMENT_AUDIO_BINDING", "Only the exact unchanged original recording bytes may be sent for caption alignment.");
  const media = (await getPool().query("SELECT id FROM guild_media_objects WHERE id=$1 AND tenant_id=$2 AND commission_id=$3 AND package_id=$4 AND job_id=$5 AND content_hash=$6 AND byte_length=$7 AND media_type='audio/mpeg' AND state='ready'", [track.mediaId, context.tenantId, authority.commission.id, track.origin.packageId, track.origin.productionJobId, track.audioHash, track.byteLength])).rows[0];
  if (!media) fail("ALIGNMENT_AUDIO_BINDING", "The original audio identity is not available in this exact commission.");
  const binding: Omit<AlignmentRequest, "requestId"> = { schemaVersion: "guild.caption-alignment-request.v1", capability: timestampCapability,
    sourceDigest: digest(sources), sourceTrackDigest: digest(track), contractDigest: pkg.acceptancePack.digest, contractVersion: pkg.contractVersion,
    attempt: input.captionAttempt!, correction: input.captionCorrectionId ? { id: input.captionCorrectionId, digest: input.captionCorrectionDigest! } : null,
    authorityCeiling: captionAuthorityCeilingSchema.parse(pkg.acceptancePack.parameters?.authorityCeiling).expiresAt,
    originalAudio: { mediaId: track.mediaId, producingJobId: track.origin.productionJobId, packageId: track.origin.packageId, contentHash: track.audioHash, byteLength: track.byteLength, scriptHash: track.scriptBytesHash, locale: track.locale }, prompt: track.prompt as WhisperPromptExcerpt };
  const operationKey = `caption:${track.locale}:${track.mediaId}:alignment`, inputHash = digest(binding);
  const read = async () => (await getPool().query<AlignmentRow>("SELECT * FROM guild_alignment_runs WHERE tenant_id=$1 AND job_id=$2 AND operation_key=$3", [context.tenantId, context.jobId, operationKey])).rows[0];
  let row = await read();
  if (row) {
    checkedRow(row);
    if (row.input_hash !== inputHash || row.package_id !== packageId || row.commission_id !== authority.commission.id) fail("ALIGNMENT_INPUT_CHANGED", "This original request belongs to different audio, source, prompt or authority terms.");
    if (row.state === "received") return readAlignmentRecord(context.tenantId, row.id);
    if (row.state !== "prepared") {
      if (row.state === "dispatching") await getPool().query("UPDATE guild_alignment_runs SET state='indeterminate',failure_code='ALIGNMENT_RESPONSE_NOT_RETRIEVABLE',updated_at=now() WHERE id=$1 AND tenant_id=$2 AND state='dispatching'", [row.id, context.tenantId]);
      fail("ALIGNMENT_ORIGINAL_REVIEW", "The original timestamp request has no confirmed complete result. Its identity and partial response remain saved. This API cannot retrieve that lost response, so it was not sent again.");
    }
  }
  if ((context.externalCalls ?? 0) >= 2) throw new ProductionContinuation("Continuing the original caption alignment", 1);
  const gateway = injectedGateway ?? new OpenAIWhisperTimestampGateway(await qualifiedWhisperTokenizer()), requestId = row?.id ?? randomUUID();
  const wire = { requestId, bytes, locale: track.locale, prompt: binding.prompt };
  await capabilityAvailable(getPool(), context.tenantId); gateway.preflight(wire);
  if (!row) row = await transaction(async db => {
    await requireProductionLease(db, context, packageId); await capabilityAvailable(db, context.tenantId);
    const created = (await db.query<AlignmentRow>("INSERT INTO guild_alignment_runs(id,tenant_id,commission_id,package_id,job_id,media_id,capability_version,operation_key,input_hash,request,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'prepared') ON CONFLICT(tenant_id,job_id,operation_key) DO NOTHING RETURNING *", [requestId, context.tenantId, authority.commission.id, packageId, context.jobId, track.mediaId, timestampCapability.version, operationKey, inputHash, { ...binding, requestId }])).rows[0];
    if (!created) fail("ALIGNMENT_CONCURRENT_PREPARATION", "Another worker already prepared this original timestamp request. Resume that saved identity without a second request.");
    return created;
  });
  const original = row;
  try {
    const receipt = await gateway.align(wire, async () => {
      await transaction(async db => {
        await requireProductionLease(db, context, packageId); await capabilityAvailable(db, context.tenantId); gateway.preflight(wire);
        const changed = await db.query("UPDATE guild_alignment_runs SET state='dispatching',dispatched_at=clock_timestamp(),updated_at=now() WHERE id=$1 AND tenant_id=$2 AND job_id=$3 AND state='prepared' AND dispatched_at IS NULL AND input_hash=$4 AND request=$5::jsonb RETURNING id", [original.id, context.tenantId, context.jobId, inputHash, original.request]);
        if (!changed.rowCount) fail("ALIGNMENT_ALREADY_DISPATCHED", "This exact timestamp request already owns its original dispatch. No second POST was sent.");
      });
      context.externalCalls = (context.externalCalls ?? 0) + 1;
    });
    await retainObservation(original, receipt);
    if ([401, 403, 404, 410].includes(receipt.statusCode)) fail("ALIGNMENT_PROVIDER_UNAVAILABLE", "The timestamp provider declined this frozen capability or its credentials. The original response is retained; no further timestamp request was sent.");
    return readAlignmentRecord(context.tenantId, original.id);
  } catch (error) {
    if (error instanceof AlignmentGatewayError && error.receipt) await retainObservation(original, error.receipt);
    const current = await read();
    if (current?.state === "dispatching") await getPool().query("UPDATE guild_alignment_runs SET state='indeterminate',failure_code=$1,updated_at=now() WHERE id=$2 AND tenant_id=$3 AND state='dispatching'", [error instanceof AlignmentGatewayError ? error.code : "ALIGNMENT_OBSERVATION_UNKNOWN", original.id, context.tenantId]);
    if (error instanceof ProductionReviewRequired || error instanceof ProductionContinuation) throw error;
    if (error instanceof AlignmentGatewayError) fail(error.code, current?.dispatched_at ? "The original timestamp response is incomplete or unknown. Its retained request is held for review and will not be resent." : "The frozen timestamp capability could not pass its preflight. No provider request was dispatched.");
    throw error;
  }
}
