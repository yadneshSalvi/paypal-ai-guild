import { randomUUID } from "node:crypto";
import { z } from "zod";
import { digest } from "@/domain/primitives";
import { getPool, transaction } from "../db";
import { requireVerificationLease, type ProductionLease } from "../production-authority";
import { ProductionContinuation, ProductionReviewRequired } from "../production-continuation";
import { GeminiVerifierBatchGateway, VerifierBatchError, isVerifierBatchId, type BatchObservation, type VerifierBatchGateway, type VerifierBatchRequest } from "./gemini-batch-gateway";

interface BatchRow { id: string; tenant_id: string; job_id: string; artifact_id: string; input_hash: string; request: VerifierBatchRequest; state: string; provider_batch_id: string | null; provider_state: string | null; response_body: unknown; body_hash: string | null; output: unknown; output_hash: string | null; failure_code: string | null; poll_after: Date | null }
export interface VerifierResult<T> { available: true; runId: string; model: string; providerBatchId: string; bodyHash: string; items: { key: string; data: T | null; modelVersion: string | null; responseId: string | null; usage: Record<string, unknown> | null; errorCode: string | null }[] }
export interface UnavailableVerifier { available: false; runId: string; code: string; knownProviderIdentity: boolean }
const unavailable = (row: BatchRow): UnavailableVerifier => ({ available: false, runId: row.id, code: row.failure_code ?? "VERIFIER_UNAVAILABLE", knownProviderIdentity: !!row.provider_batch_id });

async function retain(row: BatchRow, observation: BatchObservation) {
  if (row.provider_batch_id && row.provider_batch_id !== observation.name) {
    await getPool().query("UPDATE guild_verifier_batches SET state='unavailable',failure_code='VERIFIER_IDENTITY_MISMATCH',updated_at=now() WHERE id=$1 AND tenant_id=$2", [row.id, row.tenant_id]);
    return;
  }
  const state = observation.state === "succeeded" ? "received" : observation.done ? "failed" : "running";
  await getPool().query("UPDATE guild_verifier_batches SET state=$1,provider_batch_id=COALESCE(provider_batch_id,$2),provider_state=$3,response_body=$4,body_hash=$5,failure_code=$6,poll_after=CASE WHEN $1='running' THEN now()+interval '30 seconds' ELSE NULL END,updated_at=now() WHERE id=$7 AND tenant_id=$8", [state, observation.name, observation.state, observation.raw, observation.bodyHash, state === "failed" ? `VERIFIER_BATCH_${observation.state.toUpperCase()}` : null, row.id, row.tenant_id]);
}

async function poll(row: BatchRow, context: ProductionLease, gateway: VerifierBatchGateway) {
  if (!isVerifierBatchId(row.provider_batch_id)) throw new ProductionReviewRequired("VERIFIER_SAVED_IDENTITY", "The original independent verifier has no valid saved batch identity. It was not replaced.");
  const delay = row.poll_after ? Math.ceil((row.poll_after.getTime() - Date.now()) / 1000) : 0;
  if (delay > 0 || (context.externalCalls ?? 0) >= 1) throw new ProductionContinuation("The independent back-translator is working on the saved batch", Math.max(1, delay));
  context.externalCalls = (context.externalCalls ?? 0) + 1;
  await getPool().query("UPDATE guild_verifier_batches SET poll_count=poll_count+1,updated_at=now() WHERE id=$1 AND tenant_id=$2", [row.id, row.tenant_id]);
  try { await retain(row, await gateway.get(row.provider_batch_id)); }
  catch (error) {
    const code = error instanceof VerifierBatchError ? error.code : "VERIFIER_READ_UNCONFIRMED";
    const gone = ["VERIFIER_HTTP_404", "VERIFIER_HTTP_410"].includes(code);
    await getPool().query("UPDATE guild_verifier_batches SET state=CASE WHEN $1 THEN 'unavailable' ELSE state END,failure_code=$2,poll_after=now()+interval '30 seconds',updated_at=now() WHERE id=$3 AND tenant_id=$4", [gone, code, row.id, row.tenant_id]);
    if (!gone) throw new ProductionContinuation("The verifier connection is unavailable; the same saved batch will be read", 30);
  }
}

/** Observe already-dispatched batches even when production authority later pauses. */
export async function pollSavedVerifierBatch(context: ProductionLease, gateway: VerifierBatchGateway = new GeminiVerifierBatchGateway()) {
  const row = (await getPool().query<BatchRow>("SELECT * FROM guild_verifier_batches WHERE tenant_id=$1 AND job_id=$2 AND state='running' AND provider_batch_id IS NOT NULL ORDER BY created_at LIMIT 1", [context.tenantId, context.jobId])).rows[0];
  if (row) await poll(row, context, gateway);
}

export async function runVerifierBatch<T extends z.ZodType>(context: ProductionLease, operationKey: string, input: Omit<VerifierBatchRequest, "operationId">, schema: T, gateway: VerifierBatchGateway = new GeminiVerifierBatchGateway()): Promise<VerifierResult<z.infer<T>> | UnavailableVerifier> {
  const authority = await transaction(db => requireVerificationLease(db, context));
  const inputHash = digest({ ...input, schema: z.toJSONSchema(schema), artifactId: authority.artifact.id, artifactHash: authority.artifact.contentHash, contractVersion: authority.package.contractVersion, packDigest: authority.package.acceptancePack.digest });
  const read = async () => (await getPool().query<BatchRow>("SELECT * FROM guild_verifier_batches WHERE tenant_id=$1 AND artifact_id=$2 AND operation_key=$3", [context.tenantId, authority.artifact.id, operationKey])).rows[0];
  let row = await read(), inserted = false;
  if (!row) {
    if ((context.externalCalls ?? 0) >= 1) throw new ProductionContinuation("Preparing the independent back-translation batch", 1);
    const reserved = await transaction(async db => {
      const current = await requireVerificationLease(db, context), id = randomUUID();
      if (current.artifact.id !== authority.artifact.id || current.artifact.contentHash !== authority.artifact.contentHash || current.package.acceptancePack.digest !== authority.package.acceptancePack.digest) throw new ProductionReviewRequired("VERIFIER_CONTRACT_CHANGED", "The artifact or agreed checks changed before independent verification.");
      return await db.query<BatchRow>("INSERT INTO guild_verifier_batches(id,tenant_id,commission_id,job_id,package_id,artifact_id,operation_key,input_hash,request,provider,model,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'google',$10,'dispatching') ON CONFLICT(tenant_id,artifact_id,operation_key) DO NOTHING RETURNING *", [id, context.tenantId, current.commission.id, context.jobId, current.package.id, current.artifact.id, operationKey, inputHash, { ...input, operationId: id }, input.model]);
    });
    row = reserved.rows[0] ?? await read(); inserted = !!reserved.rows[0];
  }
  const savedInput = row ? Object.fromEntries(Object.entries(row.request).filter(([key]) => key !== "operationId")) : null;
  if (!row || row.input_hash !== inputHash || digest(savedInput) !== digest(input)) throw new ProductionReviewRequired("VERIFIER_INPUT_CHANGED", "The saved independent verifier belongs to different inputs. Its original request and result are retained.");
  if (row.state === "completed") {
    if (!row.output || digest(row.output) !== row.output_hash) throw new ProductionReviewRequired("VERIFIER_OUTPUT_CHANGED", "The saved independent report no longer matches its immutable hash.");
    const saved = row.output as VerifierResult<z.infer<T>>;
    if (!saved.available || saved.runId !== row.id || saved.providerBatchId !== row.provider_batch_id || saved.bodyHash !== row.body_hash || saved.items.length !== input.requests.length || new Set(saved.items.map(item => item.key)).size !== input.requests.length || saved.items.some(item => !input.requests.some(request => request.key === item.key) || item.data !== null && !schema.safeParse(item.data).success)) throw new ProductionReviewRequired("VERIFIER_OUTPUT_BINDING", "The retained report does not cover the exact requested languages and schema.");
    return saved;
  }
  if (["failed", "indeterminate", "unavailable"].includes(row.state)) return unavailable(row);
  if (row.state === "dispatching" && !inserted) {
    await getPool().query("UPDATE guild_verifier_batches SET state='indeterminate',failure_code='VERIFIER_DISPATCH_UNKNOWN',updated_at=now() WHERE id=$1 AND tenant_id=$2", [row.id, context.tenantId]);
    return unavailable({ ...row, failure_code: "VERIFIER_DISPATCH_UNKNOWN" });
  }
  if (inserted) {
    context.externalCalls = (context.externalCalls ?? 0) + 1;
    try { await retain(row, await gateway.create(row.request)); }
    catch (error) {
      const code = error instanceof VerifierBatchError ? error.code : "VERIFIER_DISPATCH_UNCONFIRMED";
      if (error instanceof VerifierBatchError && isVerifierBatchId(error.providerName)) await getPool().query("UPDATE guild_verifier_batches SET state='running',provider_batch_id=$1,response_body=$2,body_hash=$3,failure_code=$4,poll_after=now()+interval '30 seconds',updated_at=now() WHERE id=$5 AND tenant_id=$6", [error.providerName, error.raw ?? null, error.raw ? digest(error.raw) : null, code, row.id, context.tenantId]);
      else await getPool().query("UPDATE guild_verifier_batches SET state=$1,failure_code=$2,updated_at=now() WHERE id=$3 AND tenant_id=$4", [error instanceof VerifierBatchError && error.definitive ? "failed" : "indeterminate", code, row.id, context.tenantId]);
    }
    row = (await read())!;
  }
  if (row.state === "running") { await poll(row, context, gateway); row = (await read())!; }
  if (row.state === "running") throw new ProductionContinuation("The independent back-translator is working on the saved batch", 30);
  if (row.state !== "received") return unavailable(row);
  // The original provider body was committed before any JSON/schema interpretation.
  const { parseBatchObservation } = await import("./gemini-batch-gateway");
  const observation = parseBatchObservation(row.response_body);
  if (observation.bodyHash !== row.body_hash || observation.name !== row.provider_batch_id || observation.items.length !== input.requests.length || !input.requests.every(request => observation.items.some(item => item.key === request.key))) throw new ProductionReviewRequired("VERIFIER_RESULT_COVERAGE", "The independent batch does not match the original language identities and requested coverage.");
  const items = observation.items.map(item => {
    let value: unknown; try { value = item.text ? JSON.parse(item.text) : null; } catch { value = null; }
    const result = schema.safeParse(value);
    return { key: item.key, data: result.success ? result.data : null, modelVersion: item.modelVersion, responseId: item.responseId, usage: item.usage, errorCode: item.errorCode ?? (result.success ? null : "VERIFIER_OUTPUT_SCHEMA") };
  });
  const result: VerifierResult<z.infer<T>> = { available: true, runId: row.id, model: row.request.model, providerBatchId: observation.name, bodyHash: observation.bodyHash, items };
  await getPool().query("UPDATE guild_verifier_batches SET state='completed',output=$1,output_hash=$2,completed_at=now(),updated_at=now() WHERE id=$3 AND tenant_id=$4 AND state='received'", [result, digest(result), row.id, context.tenantId]);
  return result;
}
