import { z } from "zod";
import { digest } from "@/domain/primitives";

export interface BatchRequestItem { key: string; instruction: string; input: unknown; schema: Record<string, unknown>; schemaFormat?: "json_schema" | "response_schema" }
export interface VerifierBatchRequest { operationId: string; model: "gemini-3.8-flash"; requests: BatchRequestItem[]; temperature?: 0.2 | 1 }
export interface BatchItemResult { key: string; text: string | null; modelVersion: string | null; responseId: string | null; usage: Record<string, unknown> | null; errorCode: string | null }
export interface BatchObservation { name: string; state: "pending" | "running" | "succeeded" | "failed" | "cancelled" | "expired"; done: boolean; items: BatchItemResult[]; raw: Record<string, unknown>; bodyHash: string }
export interface VerifierBatchGateway { create(request: VerifierBatchRequest): Promise<BatchObservation>; get(name: string): Promise<BatchObservation> }
export class VerifierBatchError extends Error {
  constructor(readonly code: string, readonly definitive: boolean, readonly providerName?: string, readonly raw?: Record<string, unknown>) { super("The independent verifier did not return a confirmed batch observation."); }
}
export const isVerifierBatchId = (value: unknown): value is string => typeof value === "string" && /^batches\/[A-Za-z0-9_-]{1,200}$/.test(value);
const object = z.record(z.string(), z.unknown());
const obj = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** The documented GenerateContent Schema subset; Zod still validates the result. */
export function geminiResponseSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "$schema" || key === "additionalProperties" && value === false) continue;
    if (key === "type" && typeof value === "string" && ["object", "array", "string", "number", "integer", "boolean"].includes(value)) result.type = value.toUpperCase();
    else if (key === "properties") { result.properties = Object.fromEntries(Object.entries(obj(value)).map(([name, property]) => [name, geminiResponseSchema(obj(property))])); result.propertyOrdering = Object.keys(obj(value)); }
    else if (key === "items") result.items = geminiResponseSchema(obj(value));
    else if (["minLength", "maxLength", "minItems", "maxItems"].includes(key) && Number.isSafeInteger(value) && Number(value) >= 0) result[key] = String(value);
    else if (["required", "enum", "description", "title", "minimum", "maximum"].includes(key)) result[key] = value;
    else throw new VerifierBatchError("VERIFIER_SCHEMA_UNSUPPORTED", true);
  }
  return result;
}

export function geminiBatchPayload(request: VerifierBatchRequest) {
  if (!/^[a-f0-9-]{36}$/.test(request.operationId) || request.model !== "gemini-3.8-flash" || !request.requests.length || request.requests.length > 12 || new Set(request.requests.map(item => item.key)).size !== request.requests.length || request.requests.some(item => !/^[A-Za-z0-9_.:-]{1,120}$/.test(item.key) || item.instruction.length > 12000)) throw new VerifierBatchError("VERIFIER_REQUEST_BINDING", true);
  const body = { batch: { model: `models/${request.model}`, displayName: `guild-verifier-${request.operationId}`, inputConfig: { requests: { requests: request.requests.map(item => ({ metadata: { key: item.key }, request: { model: `models/${request.model}`, systemInstruction: { parts: [{ text: item.instruction }] }, contents: [{ role: "user", parts: [{ text: JSON.stringify(item.input) }] }], generationConfig: { responseMimeType: "application/json", ...(item.schemaFormat === "response_schema" ? { responseSchema: geminiResponseSchema(item.schema) } : { responseJsonSchema: item.schema }), maxOutputTokens: 16000, temperature: request.temperature ?? 0.2 } } })) } } } };
  if (JSON.stringify(body).length > 1024 * 1024) throw new VerifierBatchError("VERIFIER_REQUEST_SIZE", true);
  return body;
}

export function parseBatchObservation(value: unknown): BatchObservation {
  const raw = object.parse(value), metadata = obj(raw.metadata), name = raw.name;
  const stateValue = typeof metadata.state === "string" ? metadata.state : raw.state;
  const states: Record<string, BatchObservation["state"]> = { PENDING: "pending", QUEUED: "pending", RUNNING: "running", SUCCEEDED: "succeeded", FAILED: "failed", CANCELLED: "cancelled", EXPIRED: "expired" };
  const state = typeof stateValue === "string" ? states[stateValue.replace(/^(?:BATCH|JOB)_STATE_/, "")] : undefined;
  if (!isVerifierBatchId(name) || !state || raw.done !== undefined && typeof raw.done !== "boolean") throw new VerifierBatchError("VERIFIER_RESPONSE_FORMAT", false);
  const terminal = ["succeeded", "failed", "cancelled", "expired"].includes(state);
  if (raw.done === false && terminal || raw.done === true && !terminal) throw new VerifierBatchError("VERIFIER_STATE_CONFLICT", false);
  const items: BatchItemResult[] = [];
  if (state === "succeeded") {
    const response = obj(raw.response), output = Object.keys(obj(response.output)).length ? obj(response.output) : response;
    const inlined = obj(output.inlinedResponses).inlinedResponses;
    if (!Array.isArray(inlined) || !inlined.length || inlined.length > 12 || raw.error) throw new VerifierBatchError("VERIFIER_INLINE_RESULTS", false);
    for (const rawItem of inlined) {
      const item = obj(rawItem), key = obj(item.metadata).key, result = obj(item.response), error = obj(item.error);
      if (typeof key !== "string" || !/^[A-Za-z0-9_.:-]{1,120}$/.test(key)) throw new VerifierBatchError("VERIFIER_RESULT_IDENTITY", false);
      if (Object.keys(error).length) { items.push({ key, text: null, modelVersion: null, responseId: null, usage: null, errorCode: Number.isSafeInteger(error.code) ? `GOOGLE_${error.code}` : "GOOGLE_ITEM_ERROR" }); continue; }
      const candidates = result.candidates;
      if (!Array.isArray(candidates) || candidates.length !== 1) { items.push({ key, text: null, modelVersion: typeof result.modelVersion === "string" ? result.modelVersion : null, responseId: null, usage: null, errorCode: "VERIFIER_NO_SINGLE_RESULT" }); continue; }
      const candidate = obj(candidates[0]), parts = obj(candidate.content).parts;
      if (candidate.finishReason !== "STOP" || !Array.isArray(parts) || parts.some(part => Object.keys(obj(part)).some(key => !["text", "thought", "thoughtSignature"].includes(key)))) { items.push({ key, text: null, modelVersion: typeof result.modelVersion === "string" ? result.modelVersion : null, responseId: null, usage: null, errorCode: "VERIFIER_INCOMPLETE_RESULT" }); continue; }
      const text = parts.filter(part => obj(part).thought !== true).map(part => typeof obj(part).text === "string" ? obj(part).text : "").join("");
      const version = result.modelVersion, responseId = result.responseId;
      if (!text || text.length > 200000 || typeof version !== "string" || !/^gemini-3\.8-flash(?:-[A-Za-z0-9_.-]+)?$/.test(version) || typeof responseId !== "string" || !/^[A-Za-z0-9_-]{1,240}$/.test(responseId)) throw new VerifierBatchError("VERIFIER_RESULT_FORMAT", false);
      items.push({ key, text, modelVersion: version, responseId, usage: result.usageMetadata ? obj(result.usageMetadata) : null, errorCode: null });
    }
    if (new Set(items.map(item => item.key)).size !== items.length) throw new VerifierBatchError("VERIFIER_DUPLICATE_KEY", false);
  }
  return { name, state, done: terminal, items, raw, bodyHash: digest(raw) };
}

export class GeminiVerifierBatchGateway implements VerifierBatchGateway {
  private async request(path: string, method: "GET" | "POST", payload?: unknown): Promise<BatchObservation> {
    const key = process.env.GEMINI_API_KEY; if (!key) throw new VerifierBatchError("VERIFIER_CONFIGURATION", true);
    let response: Response;
    try { response = await fetch(`https://generativelanguage.googleapis.com/v1beta/${path}`, { method, headers: { "x-goog-api-key": key, "Content-Type": "application/json" }, ...(payload ? { body: JSON.stringify(payload) } : {}), redirect: "error", signal: AbortSignal.timeout(method === "POST" ? 60000 : 30000) }); }
    catch { throw new VerifierBatchError("VERIFIER_TRANSPORT_UNCONFIRMED", false); }
    if (!response.ok) { await response.body?.cancel(); throw new VerifierBatchError(`VERIFIER_HTTP_${response.status}`, [400,401,403,404,410,422,429].includes(response.status)); }
    const reader = response.body?.getReader(); if (!reader) throw new VerifierBatchError("VERIFIER_RESPONSE_EMPTY", false);
    const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new VerifierBatchError("VERIFIER_RESPONSE_SIZE", false); } chunks.push(part.value); } }
    finally { reader.releaseLock(); }
    let value: unknown;
    try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); return parseBatchObservation(value); }
    catch (error) { const raw = obj(value); throw new VerifierBatchError(error instanceof VerifierBatchError ? error.code : "VERIFIER_RESPONSE_FORMAT", false, isVerifierBatchId(raw.name) ? raw.name : undefined, Object.keys(raw).length ? raw : undefined); }
  }
  create(request: VerifierBatchRequest): Promise<BatchObservation> { return this.request(`models/${request.model}:batchGenerateContent`, "POST", geminiBatchPayload(request)); }
  get(name: string): Promise<BatchObservation> { if (!isVerifierBatchId(name)) throw new VerifierBatchError("VERIFIER_SAVED_IDENTITY", true); return this.request(name, "GET"); }
}
