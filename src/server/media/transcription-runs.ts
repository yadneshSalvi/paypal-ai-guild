import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Locale } from "@/contracts/guild";
import { digest } from "@/domain/primitives";
import { getPool, transaction } from "../db";
import { requireVerificationLease, type ProductionLease } from "../production-authority";
import { ProductionContinuation, ProductionReviewRequired } from "../production-continuation";
import { OpenAITranscriptionGateway, TranscriptionGatewayError, type TranscriptionGateway, type TranscriptionResult } from "./transcription-gateway";
import type { MediaObjectRow } from "./objects";

interface AsrRow { id: string; state: string; input_hash: string; request: unknown; output: TranscriptionResult | null; output_hash: string | null; failure_code: string | null }
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const resultSchema = z.object({ model: z.literal("gpt-transcribe"), text: z.string().min(1).max(16000), languages: z.array(z.string().regex(/^[a-z]{2,3}$/)).max(12), rawBody: z.string().min(1).max(256 * 1024), bodyHash: z.string().regex(/^[a-f0-9]{64}$/), providerRequestId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/).nullable(), latencyMs: z.number().nonnegative() }).strict();
function checkedResult(value: unknown): TranscriptionResult {
  const result = resultSchema.parse(value), body = z.object({ text: z.string(), languages: z.array(z.object({ code: z.string() })) }).parse(JSON.parse(result.rawBody));
  if (hash(result.rawBody) !== result.bodyHash || body.text !== result.text || digest(body.languages.map(item => item.code)) !== digest(result.languages)) throw new ProductionReviewRequired("TRANSCRIPTION_BODY_CHANGED", "The independent transcript no longer matches its exact original provider response.");
  return result;
}
export type SavedTranscription = { available: true; runId: string; result: TranscriptionResult } | { available: false; runId: string; code: string };

/** Recognition sees final audio plus a language hint, never the expected wording. */
export async function transcribeSavedAudio(context: ProductionLease, media: MediaObjectRow, bytes: Buffer, locale: Locale, gateway: TranscriptionGateway = new OpenAITranscriptionGateway()): Promise<SavedTranscription> {
  const authority = await transaction(db => requireVerificationLease(db, context));
  if (authority.package.kind !== "narration" || media.tenant_id !== context.tenantId || media.commission_id !== authority.commission.id || media.package_id !== authority.package.id || media.media_type !== "audio/mpeg" || media.state !== "ready" || hash(bytes) !== media.content_hash) throw new ProductionReviewRequired("TRANSCRIPTION_INPUT_BINDING", "Independent recognition needs the exact owned, verified narration file.");
  const request = { model: "gpt-transcribe", locale, mediaId: media.id, mediaHash: media.content_hash, byteLength: bytes.length, artifactId: authority.artifact.id, artifactHash: authority.artifact.contentHash, contractVersion: authority.package.contractVersion, contractDigest: authority.package.acceptancePack.digest, expectedWordingInPrompt: false };
  const inputHash = digest(request), operationKey = "narration-independent-asr-v1";
  const read = async () => (await getPool().query<AsrRow>("SELECT * FROM guild_transcription_runs WHERE tenant_id=$1 AND artifact_id=$2 AND media_id=$3 AND operation_key=$4", [context.tenantId, authority.artifact.id, media.id, operationKey])).rows[0];
  let row = await read(), inserted = false;
  if (!row) {
    // A bounded verification step performs one owned file read and one ASR call.
    if ((context.externalCalls ?? 0) >= 2) throw new ProductionContinuation("Preparing the next independent recognition", 1);
    const found = await transaction(async db => {
      const current = await requireVerificationLease(db, context), id = randomUUID();
      if (current.artifact.id !== authority.artifact.id || current.artifact.contentHash !== authority.artifact.contentHash || current.package.acceptancePack.digest !== authority.package.acceptancePack.digest) throw new ProductionReviewRequired("TRANSCRIPTION_CONTRACT_CHANGED", "The recording's verification agreement changed before independent recognition.");
      return db.query<AsrRow>("INSERT INTO guild_transcription_runs(id,tenant_id,commission_id,job_id,package_id,artifact_id,media_id,operation_key,input_hash,request,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'dispatching') ON CONFLICT(tenant_id,artifact_id,media_id,operation_key) DO NOTHING RETURNING *", [id, context.tenantId, current.commission.id, context.jobId, current.package.id, current.artifact.id, media.id, operationKey, inputHash, request]);
    });
    row = found.rows[0] ?? await read(); inserted = !!found.rows[0];
  }
  if (!row || row.input_hash !== inputHash || digest(row.request) !== inputHash) throw new ProductionReviewRequired("TRANSCRIPTION_INPUT_CHANGED", "The retained independent recognition belongs to different original audio or verification terms.");
  if (row.state === "completed") {
    if (digest(row.output) !== row.output_hash) throw new ProductionReviewRequired("TRANSCRIPTION_OUTPUT_CHANGED", "The saved independent transcript changed after completion.");
    return { available: true, runId: row.id, result: checkedResult(row.output) };
  }
  if (!inserted) {
    if (row.state === "dispatching") await getPool().query("UPDATE guild_transcription_runs SET state='indeterminate',failure_code='TRANSCRIPTION_RESULT_UNKNOWN',updated_at=now() WHERE tenant_id=$1 AND id=$2 AND state='dispatching'", [context.tenantId, row.id]);
    return { available: false, runId: row.id, code: row.failure_code ?? "TRANSCRIPTION_RESULT_UNKNOWN" };
  }
  context.externalCalls = (context.externalCalls ?? 0) + 1;
  try {
    const output = checkedResult(await gateway.transcribe(bytes, locale));
    await getPool().query("UPDATE guild_transcription_runs SET state='completed',output=$1,output_hash=$2,response_body=$3,response_body_hash=$4,completed_at=now(),updated_at=now() WHERE id=$5 AND tenant_id=$6 AND state='dispatching'", [output, digest(output), output.rawBody, output.bodyHash, row.id, context.tenantId]);
    return { available: true, runId: row.id, result: output };
  } catch (error) {
    const code = error instanceof TranscriptionGatewayError ? error.code : "TRANSCRIPTION_OBSERVATION_UNAVAILABLE";
    await getPool().query("UPDATE guild_transcription_runs SET state=$1,failure_code=$2,response_body=$3,response_body_hash=$4,updated_at=now() WHERE id=$5 AND tenant_id=$6 AND state='dispatching'", [error instanceof TranscriptionGatewayError && error.definitive ? "failed" : "indeterminate", code, error instanceof TranscriptionGatewayError ? error.rawBody ?? null : null, error instanceof TranscriptionGatewayError ? error.bodyHash ?? null : null, row.id, context.tenantId]);
    return { available: false, runId: row.id, code };
  }
}
