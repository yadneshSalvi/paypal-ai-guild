import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { digest, DomainError } from "@/domain/primitives";
import { getPool, transaction } from "../db";
import { requireProductionLease, type ProductionLease } from "../production-authority";
import { ProductionContinuation, ProductionReviewRequired } from "../production-continuation";
import { isSpeechModelVersion, OpenAIRealtimeSpeechGateway, SpeechGatewayError, type SpeechGateway, type SpeechReceipt, type SpeechRequest } from "./speech-gateway";

interface SpeechRow { id: string; tenant_id: string; commission_id: string; job_id: string; package_id: string; input_hash: string; request: SpeechRequest; state: string; provider_session_id: string | null; provider_response_id: string | null; resolved_model: string | null; receipt: SpeechReceipt | null; receipt_hash: string | null; pcm_hash: string | null; byte_length: string | null; chunk_count: number | null; failure_code: string | null; dispatched_at: Date | null }
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const receiptSchema = z.object({ model: z.string(), voice: z.string(), sessionId: z.string().regex(/^sess_[A-Za-z0-9_-]{1,240}$/), responseId: z.string().regex(/^resp_[A-Za-z0-9_-]{1,240}$/), transcript: z.string().min(1).max(16000), sampleRate: z.literal(24000), byteLength: z.number().int().positive().max(8 * 1024 * 1024), contentHash: z.string().regex(/^[a-f0-9]{64}$/), latencyMs: z.number().nonnegative(), usage: z.record(z.string(), z.unknown()).nullable() }).strict();

async function originalPcm(row: SpeechRow): Promise<{ pcm: Buffer; count: number }> {
  const chunks = (await getPool().query<{ sequence: number; bytes: Buffer; byte_length: number; content_hash: string }>("SELECT sequence,bytes,byte_length,content_hash FROM guild_speech_chunks WHERE tenant_id=$1 AND run_id=$2 ORDER BY sequence", [row.tenant_id, row.id])).rows;
  let size = 0;
  if (!chunks.length || chunks.length > 4096 || chunks.some((chunk, index) => { size += chunk.bytes.length; return chunk.sequence !== index || chunk.bytes.length !== chunk.byte_length || chunk.bytes.length % 2 !== 0 || hash(chunk.bytes) !== chunk.content_hash; }) || size > 8 * 1024 * 1024) throw new ProductionReviewRequired("SPEECH_SAVED_BYTES", "The retained recording does not contain a complete ordered stream with matching byte hashes. No replacement recording was generated.");
  return { pcm: Buffer.concat(chunks.map(chunk => chunk.bytes)), count: chunks.length };
}

export async function readCompletedSpeech(tenantId: string, runId: string): Promise<{ row: SpeechRow; pcm: Buffer; receipt: SpeechReceipt; receiptHash: string }> {
  const row = (await getPool().query<SpeechRow>("SELECT * FROM guild_speech_runs WHERE tenant_id=$1 AND id=$2", [tenantId, runId])).rows[0];
  const parsed = receiptSchema.safeParse(row?.receipt);
  if (!row || row.state !== "completed" || !parsed.success || digest(parsed.data) !== row.receipt_hash || row.provider_session_id !== parsed.data.sessionId || row.provider_response_id !== parsed.data.responseId || row.resolved_model !== parsed.data.model || !isSpeechModelVersion(parsed.data.model, row.request.model) || parsed.data.voice !== row.request.voice) throw new ProductionReviewRequired("SPEECH_COMPLETION_BINDING", "The recording has no complete, matching original speech receipt. Partial audio remains evidence, not a substitute submission.");
  const original = await originalPcm(row);
  if (original.count !== row.chunk_count || original.pcm.length !== Number(row.byte_length) || original.pcm.length !== parsed.data.byteLength || hash(original.pcm) !== row.pcm_hash || row.pcm_hash !== parsed.data.contentHash) throw new ProductionReviewRequired("SPEECH_COMPLETION_HASH", "The original recording no longer matches its complete provider receipt and retained stream hashes.");
  return { row, pcm: original.pcm, receipt: parsed.data, receiptHash: row.receipt_hash! };
}

/** One durable response dispatch. Realtime cannot retrieve a lost audio stream by ID. */
export async function runSpeech(context: ProductionLease, packageId: string, operationKey: string, input: Omit<SpeechRequest, "operationId">, gateway: SpeechGateway = new OpenAIRealtimeSpeechGateway()) {
  const authority = await transaction(db => requireProductionLease(db, context, packageId));
  if (authority.package?.kind !== "narration" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(operationKey)) throw new DomainError("SPEECH_PACKAGE_REQUIRED", "Speech production belongs to an approved narration contract.", 422, false);
  const inputHash = digest({ ...input, contractVersion: authority.package.contractVersion, contractDigest: authority.package.acceptancePack.digest, inputBindings: authority.job.input.inputBindings });
  const read = async () => (await getPool().query<SpeechRow>("SELECT * FROM guild_speech_runs WHERE tenant_id=$1 AND job_id=$2 AND operation_key=$3", [context.tenantId, context.jobId, operationKey])).rows[0];
  let row = await read(), inserted = false;
  if (!row) {
    if ((context.externalCalls ?? 0) >= 1) throw new ProductionContinuation("Preparing the next complete recording", 1);
    const found = await transaction(async db => {
      const current = await requireProductionLease(db, context, packageId), id = randomUUID();
      if (!current.package || current.package.contractVersion !== authority.package!.contractVersion || current.package.acceptancePack.digest !== authority.package!.acceptancePack.digest) throw new ProductionReviewRequired("SPEECH_CONTRACT_CHANGED", "The narration agreement changed before the next recording.");
      return db.query<SpeechRow>("INSERT INTO guild_speech_runs(id,tenant_id,commission_id,job_id,package_id,operation_key,input_hash,request,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'connecting') ON CONFLICT(tenant_id,job_id,operation_key) DO NOTHING RETURNING *", [id, context.tenantId, current.commission.id, context.jobId, packageId, operationKey, inputHash, { ...input, operationId: id }]);
    });
    row = found.rows[0] ?? await read(); inserted = !!found.rows[0];
  }
  if (!row || row.package_id !== packageId || row.input_hash !== inputHash || digest(Object.fromEntries(Object.entries(row.request).filter(([key]) => key !== "operationId"))) !== digest(input)) throw new ProductionReviewRequired("SPEECH_INPUT_CHANGED", "This saved recording belongs to different text, voice, language, model or authority. Its original input was not replaced.");
  if (row.state === "completed") return readCompletedSpeech(context.tenantId, row.id);
  if (!inserted) {
    if (["connecting", "dispatching", "streaming"].includes(row.state)) await getPool().query("UPDATE guild_speech_runs SET state='indeterminate',failure_code='SPEECH_STREAM_NOT_RETRIEVABLE',updated_at=now() WHERE id=$1 AND tenant_id=$2 AND state<>'completed'", [row.id, context.tenantId]);
    throw new ProductionReviewRequired("SPEECH_STREAM_REVIEW", "An earlier recording did not retain a confirmed complete result. Its original request, IDs and partial bytes remain saved. Realtime cannot retrieve that lost stream, so no new recording was dispatched.");
  }
  context.externalCalls = (context.externalCalls ?? 0) + 1;
  const runId = row.id, request = row.request;
  try {
    await gateway.generate(request, {
      session: async (sessionId, model) => {
        if (!isSpeechModelVersion(model, request.model)) throw new SpeechGatewayError("SPEECH_SESSION_MODEL", false, true);
        const changed = await getPool().query("UPDATE guild_speech_runs SET provider_session_id=$1,resolved_model=$2,updated_at=now() WHERE id=$3 AND tenant_id=$4 AND state='connecting' AND provider_session_id IS NULL RETURNING id", [sessionId, model, runId, context.tenantId]);
        if (!changed.rowCount) throw new ProductionReviewRequired("SPEECH_SESSION_CHANGED", "The saved speech session already has a different original identity.");
      },
      dispatch: async () => {
        await transaction(async db => {
          await requireProductionLease(db, context, packageId);
          const changed = await db.query("UPDATE guild_speech_runs SET state='dispatching',dispatched_at=now(),updated_at=now() WHERE id=$1 AND tenant_id=$2 AND state='connecting' AND provider_session_id IS NOT NULL AND dispatched_at IS NULL RETURNING id", [runId, context.tenantId]);
          if (!changed.rowCount) throw new ProductionReviewRequired("SPEECH_DISPATCH_CHANGED", "This recording already has a dispatched response. It was not sent again.");
        });
      },
      response: async responseId => {
        const changed = await getPool().query("UPDATE guild_speech_runs SET state='streaming',provider_response_id=$1,updated_at=now() WHERE id=$2 AND tenant_id=$3 AND state='dispatching' AND provider_response_id IS NULL RETURNING id", [responseId, runId, context.tenantId]);
        if (!changed.rowCount) throw new ProductionReviewRequired("SPEECH_RESPONSE_CHANGED", "This recording already has a different original response identity.");
      },
      chunk: async (sequence, eventId, bytes) => {
        const result = await getPool().query("INSERT INTO guild_speech_chunks(run_id,tenant_id,sequence,event_id,content_hash,byte_length,bytes) SELECT id,tenant_id,$3,$4,$5,$6,$7 FROM guild_speech_runs WHERE id=$1 AND tenant_id=$2 AND state='streaming' ON CONFLICT DO NOTHING RETURNING sequence", [runId, context.tenantId, sequence, eventId, hash(bytes), bytes.length, bytes]);
        if (!result.rowCount) throw new ProductionReviewRequired("SPEECH_CHUNK_CONFLICT", "A speech event was repeated or arrived outside its original stream. Existing bytes were not overwritten.");
      },
      complete: async value => {
        const receipt = receiptSchema.parse(value), current = (await read())!;
        const { pcm, count } = await originalPcm(current);
        if (current.provider_session_id !== receipt.sessionId || current.provider_response_id !== receipt.responseId || current.resolved_model !== receipt.model || request.voice !== receipt.voice || pcm.length !== receipt.byteLength || hash(pcm) !== receipt.contentHash) throw new ProductionReviewRequired("SPEECH_RECEIPT_MISMATCH", "The completion receipt does not identify the exact retained recording stream.");
        const changed = await getPool().query("UPDATE guild_speech_runs SET state='completed',receipt=$1,receipt_hash=$2,pcm_hash=$3,byte_length=$4,chunk_count=$5,completed_at=now(),updated_at=now() WHERE id=$6 AND tenant_id=$7 AND state='streaming' AND receipt IS NULL RETURNING id", [receipt, digest(receipt), receipt.contentHash, pcm.length, count, runId, context.tenantId]);
        if (!changed.rowCount) throw new ProductionReviewRequired("SPEECH_COMPLETION_CONFLICT", "A completion already belongs to this recording. It was not overwritten.");
      },
    });
  } catch (error) {
    const current = (await read())!;
    if (current.state !== "completed") {
      const definitive = error instanceof SpeechGatewayError && error.definitive;
      const code = error instanceof SpeechGatewayError || error instanceof DomainError ? error.code : "SPEECH_OBSERVATION_UNAVAILABLE";
      await getPool().query("UPDATE guild_speech_runs SET state=$1,failure_code=$2,updated_at=now() WHERE id=$3 AND tenant_id=$4 AND state<>'completed'", [definitive ? "failed" : "indeterminate", code, runId, context.tenantId]);
      if (error instanceof ProductionContinuation || error instanceof ProductionReviewRequired) throw error;
      if (definitive) throw new DomainError(code, "The speech provider returned a confirmed failure. Its original request and partial output remain in the record; review before requesting a correction.", 422, false);
      throw new ProductionReviewRequired(code, "This speech stream did not retain a confirmed complete recording. Its original request and partial audio remain saved. No replacement was generated.");
    }
  }
  return readCompletedSpeech(context.tenantId, runId);
}
