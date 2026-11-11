import { createHash } from "node:crypto";
import { z } from "zod";
import type { Locale } from "@/contracts/guild";
import { digest } from "@/domain/primitives";
import { deepgramTimestampCapability, deepgramLocaleModels, deepgramQueryPolicy, deepgramResponseSchema, deepgramModelMatches, type DeepgramResponse } from "@/domain/deepgram-caption-alignment";

const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const maximumBodyBytes = 512 * 1024;
export interface DeepgramTimestampInput { requestId: string; bytes: Buffer; mimeType: "audio/wav" | "audio/mpeg"; locale: Locale }
export interface DeepgramTimestampReceipt {
  schemaVersion: "guild.deepgram-http-receipt.v1"; capabilityVersion: typeof deepgramTimestampCapability.version;
  requestId: string; locale: Locale; audioHash: string; requestHash: string;
  statusCode: number; providerRequestId: string | null; rawBodyBase64: string; bodyHash: string;
  byteLength: number; bodyComplete: boolean; observedAt: string; latencyMs: number;
  parsed: DeepgramResponse | null; parseFailure: "INCOMPLETE" | "HTTP_STATUS" | "UTF8" | "JSON_SCHEMA" | "MODEL_BINDING" | "REQUEST_ID_BINDING" | null;
}
export class DeepgramGatewayError extends Error {
  constructor(readonly code: string, readonly definitive: boolean, readonly receipt: DeepgramTimestampReceipt | null = null) {
    super("The original Deepgram request did not yield a confirmed timestamp observation.");
  }
}

const receiptSchema = z.object({
  schemaVersion: z.literal("guild.deepgram-http-receipt.v1"), capabilityVersion: z.literal(deepgramTimestampCapability.version),
  requestId: z.string().uuid(), locale: z.enum(["en", "pt", "es", "fr", "ar", "ja"]),
  audioHash: z.string().regex(/^[a-f0-9]{64}$/), requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  statusCode: z.number().int().min(100).max(599), providerRequestId: z.string().uuid().nullable(),
  rawBodyBase64: z.string().max(Math.ceil(maximumBodyBytes / 3) * 4), bodyHash: z.string().regex(/^[a-f0-9]{64}$/),
  byteLength: z.number().int().nonnegative().max(maximumBodyBytes), bodyComplete: z.boolean(),
  observedAt: z.string().datetime(), latencyMs: z.number().finite().nonnegative().max(600000), parsed: deepgramResponseSchema.nullable(),
  parseFailure: z.enum(["INCOMPLETE", "HTTP_STATUS", "UTF8", "JSON_SCHEMA", "MODEL_BINDING", "REQUEST_ID_BINDING"]).nullable(),
}).strict();

function decode(raw: Buffer, receipt: Pick<DeepgramTimestampReceipt, "bodyComplete" | "statusCode" | "locale" | "providerRequestId">): Pick<DeepgramTimestampReceipt, "parsed" | "parseFailure"> {
  if (!receipt.bodyComplete) return { parsed: null, parseFailure: "INCOMPLETE" };
  if (receipt.statusCode !== 200) return { parsed: null, parseFailure: "HTTP_STATUS" };
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(raw); } catch { return { parsed: null, parseFailure: "UTF8" }; }
  let parsed: DeepgramResponse;
  try { parsed = deepgramResponseSchema.parse(JSON.parse(text)); } catch { return { parsed: null, parseFailure: "JSON_SCHEMA" }; }
  if (!deepgramModelMatches(parsed, receipt.locale)) return { parsed: null, parseFailure: "MODEL_BINDING" };
  if (receipt.providerRequestId !== null && receipt.providerRequestId !== parsed.metadata.request_id) return { parsed: null, parseFailure: "REQUEST_ID_BINDING" };
  return { parsed, parseFailure: null };
}

/** Rebuilds parsed evidence from the actual response bytes, never from a producer success flag. */
export function checkedDeepgramReceipt(receipt: DeepgramTimestampReceipt, expected: ReturnType<typeof deepgramRequestDescriptor>): DeepgramTimestampReceipt {
  if (!receiptSchema.safeParse(receipt).success) throw new DeepgramGatewayError("DEEPGRAM_RECEIPT_CHANGED", true);
  if (receipt.requestHash !== digest(expected) || receipt.audioHash !== expected.audioHash || receipt.requestId !== expected.requestId || receipt.locale !== expected.locale) throw new DeepgramGatewayError("DEEPGRAM_REQUEST_CHANGED", true);
  const raw = Buffer.from(receipt.rawBodyBase64, "base64");
  if (raw.toString("base64") !== receipt.rawBodyBase64 || hash(raw) !== receipt.bodyHash || raw.length !== receipt.byteLength) throw new DeepgramGatewayError("DEEPGRAM_RECEIPT_CHANGED", true);
  const checked = decode(raw, receipt);
  if (checked.parseFailure !== receipt.parseFailure || digest(checked.parsed) !== digest(receipt.parsed)) throw new DeepgramGatewayError("DEEPGRAM_RECEIPT_CHANGED", true);
  return receipt;
}

export function deepgramRequestDescriptor(input: DeepgramTimestampInput) {
  const model = deepgramLocaleModels[input.locale];
  if (!model) throw new DeepgramGatewayError("DEEPGRAM_INPUT", true);
  const url = new URL(deepgramTimestampCapability.endpoint);
  url.search = new URLSearchParams({ model: deepgramTimestampCapability.model, version: model.version, language: input.locale, ...deepgramQueryPolicy }).toString();
  return { capabilityVersion: deepgramTimestampCapability.version, endpoint: url.href, modelUuid: model.uuid,
    requestId: input.requestId, locale: input.locale, audioHash: hash(input.bytes), audioBytes: input.bytes.length, mimeType: input.mimeType, sourceTextSupplied: false };
}

/** One original binary POST. Callers must durably claim the operation in beforeDispatch. */
export class DeepgramTimestampGateway {
  private readonly fetcher: typeof fetch;
  private readonly clock: () => Date;
  private readonly key: () => string | undefined;
  constructor(options: { fetch?: typeof fetch; clock?: () => Date; apiKey?: () => string | undefined } = {}) {
    this.fetcher = options.fetch ?? fetch; this.clock = options.clock ?? (() => new Date()); this.key = options.apiKey ?? (() => process.env.DEEPGRAM_API_KEY);
  }
  preflight(input: DeepgramTimestampInput): void {
    if (!this.key() || /[\r\n]/.test(this.key()!)) throw new DeepgramGatewayError("DEEPGRAM_CONFIGURATION", true);
    if (!z.string().uuid().safeParse(input.requestId).success || !Buffer.isBuffer(input.bytes) || !input.bytes.length || input.bytes.length > 20_000_000
      || !Object.hasOwn(deepgramLocaleModels, input.locale) || !["audio/wav", "audio/mpeg"].includes(input.mimeType)) throw new DeepgramGatewayError("DEEPGRAM_INPUT", true);
    if (!Number.isFinite(this.clock().getTime())) throw new DeepgramGatewayError("DEEPGRAM_CLOCK", true);
  }
  async transcribe(input: DeepgramTimestampInput, beforeDispatch: () => Promise<void>): Promise<DeepgramTimestampReceipt> {
    this.preflight(input);
    // Own a byte copy before the durable claim can yield to a caller that mutates its Buffer.
    const frozen = { ...input, bytes: Buffer.from(input.bytes) }, request = deepgramRequestDescriptor(frozen), key = this.key()!;
    await beforeDispatch();
    const started = Date.now(); let response: Response;
    try { response = await this.fetcher(request.endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(240000),
      headers: { Authorization: `Token ${key}`, "Content-Type": frozen.mimeType }, body: new Uint8Array(frozen.bytes) }); }
    catch { throw new DeepgramGatewayError("DEEPGRAM_DISPATCH_UNKNOWN", false); }
    const id = response.headers.get("dg-request-id"), providerRequestId = z.string().uuid().safeParse(id).success ? id : null;
    const pieces: Uint8Array[] = []; let size = 0, complete = false;
    const receipt = (): DeepgramTimestampReceipt => {
      const raw = Buffer.concat(pieces), binding = { bodyComplete: complete, statusCode: response.status, locale: frozen.locale, providerRequestId };
      return checkedDeepgramReceipt({ schemaVersion: "guild.deepgram-http-receipt.v1", capabilityVersion: deepgramTimestampCapability.version,
        requestId: frozen.requestId, audioHash: request.audioHash, requestHash: digest(request), ...binding,
        rawBodyBase64: raw.toString("base64"), bodyHash: hash(raw), byteLength: raw.length, observedAt: this.clock().toISOString(), latencyMs: Date.now() - started,
        ...decode(raw, binding) }, request);
    };
    const reader = response.body?.getReader();
    if (!reader) throw new DeepgramGatewayError("DEEPGRAM_EMPTY_RESPONSE", false, receipt());
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) { complete = true; break; }
        const available = maximumBodyBytes - size;
        if (chunk.value.length > available) {
          if (available) { pieces.push(chunk.value.slice(0, available)); size += available; }
          await reader.cancel().catch(() => {}); throw new DeepgramGatewayError("DEEPGRAM_RESPONSE_SIZE", false, receipt());
        }
        pieces.push(chunk.value); size += chunk.value.length;
      }
    } catch (error) {
      if (error instanceof DeepgramGatewayError) throw error;
      throw new DeepgramGatewayError("DEEPGRAM_RESPONSE_UNKNOWN", false, receipt());
    } finally { reader.releaseLock(); }
    return receipt();
  }
}
