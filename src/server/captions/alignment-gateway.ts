import { createHash } from "node:crypto";
import { z } from "zod";
import type { Locale } from "@/contracts/guild";
import { digest } from "@/domain/primitives";
import { timestampCapability, timestampResponseSchema, type TimestampResponse } from "@/domain/caption-alignment";
import { whisperPromptPolicy, type createWhisperTokenizer, type WhisperPromptExcerpt } from "./whisper-prompt";

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const maximumBodyBytes = 512 * 1024;
type Tokenizer = ReturnType<typeof createWhisperTokenizer>;
export interface AlignmentInput { requestId: string; bytes: Buffer; locale: Locale; prompt: WhisperPromptExcerpt }
export interface AlignmentHttpReceipt {
  schemaVersion: "guild.timestamp-http-receipt.v1";
  capabilityVersion: typeof timestampCapability.version;
  model: typeof timestampCapability.model;
  requestId: string;
  locale: Locale;
  audioHash: string;
  promptHash: string;
  statusCode: number;
  providerRequestId: string | null;
  rawBodyBase64: string;
  bodyHash: string;
  byteLength: number;
  bodyComplete: boolean;
  observedAt: string;
  latencyMs: number;
  parsed: TimestampResponse | null;
  parseFailure: "HTTP_STATUS" | "UTF8" | "JSON_SCHEMA" | "INCOMPLETE" | null;
}
export class AlignmentGatewayError extends Error {
  constructor(readonly code: string, readonly definitive: boolean, readonly receipt: AlignmentHttpReceipt | null = null) {
    super("The original timestamp request did not yield a confirmed usable alignment response.");
  }
}
export interface AlignmentGateway {
  preflight(input: AlignmentInput): void;
  align(input: AlignmentInput, beforeDispatch?: () => Promise<void>): Promise<AlignmentHttpReceipt>;
}
const receiptSchema = z.object({
  schemaVersion: z.literal("guild.timestamp-http-receipt.v1"), capabilityVersion: z.literal(timestampCapability.version), model: z.literal(timestampCapability.model),
  requestId: z.string().uuid(), locale: z.enum(["en", "pt", "es", "fr", "ja", "ar"]), audioHash: z.string().regex(/^[a-f0-9]{64}$/), promptHash: z.string().regex(/^[a-f0-9]{64}$/),
  statusCode: z.number().int().min(100).max(599), providerRequestId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/).nullable(),
  rawBodyBase64: z.string().max(Math.ceil(maximumBodyBytes / 3) * 4), bodyHash: z.string().regex(/^[a-f0-9]{64}$/), byteLength: z.number().int().nonnegative().max(maximumBodyBytes),
  bodyComplete: z.boolean(), observedAt: z.string().datetime(), latencyMs: z.number().finite().nonnegative().max(600000),
  parsed: timestampResponseSchema.nullable(), parseFailure: z.enum(["HTTP_STATUS", "UTF8", "JSON_SCHEMA", "INCOMPLETE"]).nullable(),
}).strict();
export function requireTimestampCapability(now: Date, available = true) {
  if (!Number.isFinite(now.getTime()) || now.getTime() >= Date.parse(timestampCapability.unavailableFrom)) throw new AlignmentGatewayError("ALIGNMENT_CAPABILITY_SUNSET", true);
  if (!available) throw new AlignmentGatewayError("ALIGNMENT_CAPABILITY_UNAVAILABLE", true);
}
export function checkedAlignmentReceipt(value: AlignmentHttpReceipt): AlignmentHttpReceipt {
  if (!receiptSchema.safeParse(value).success) throw new AlignmentGatewayError("ALIGNMENT_RESPONSE_CHANGED", true);
  const raw = Buffer.from(value.rawBodyBase64, "base64");
  if (raw.toString("base64") !== value.rawBodyBase64 || hash(raw) !== value.bodyHash || raw.length !== value.byteLength || raw.length > maximumBodyBytes
    || value.schemaVersion !== "guild.timestamp-http-receipt.v1" || value.capabilityVersion !== timestampCapability.version || value.model !== timestampCapability.model) throw new AlignmentGatewayError("ALIGNMENT_RESPONSE_CHANGED", true);
  let parsed: TimestampResponse | null = null, parseFailure: AlignmentHttpReceipt["parseFailure"] = null;
  if (!value.bodyComplete) parseFailure = "INCOMPLETE";
  else if (value.statusCode !== 200) parseFailure = "HTTP_STATUS";
  else {
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(raw); }
    catch { parseFailure = "UTF8"; text = ""; }
    if (!parseFailure) {
      try { parsed = timestampResponseSchema.parse(JSON.parse(text)); }
      catch { parseFailure = "JSON_SCHEMA"; }
    }
  }
  if (digest(parsed) !== digest(value.parsed) || parseFailure !== value.parseFailure) throw new AlignmentGatewayError("ALIGNMENT_RESPONSE_CHANGED", true);
  return value;
}

/** One synchronous original POST. There is no create retry or assumed GET recovery. */
export class OpenAIWhisperTimestampGateway implements AlignmentGateway {
  private readonly fetcher: typeof fetch;
  private readonly clock: () => Date;
  private readonly key: () => string | undefined;
  private readonly available: () => boolean;
  constructor(private readonly tokenizer: Tokenizer, options: { fetch?: typeof fetch; clock?: () => Date; apiKey?: () => string | undefined; available?: () => boolean } = {}) {
    this.fetcher = options.fetch ?? fetch; this.clock = options.clock ?? (() => new Date());
    this.key = options.apiKey ?? (() => process.env.OPENAI_API_KEY);
    this.available = options.available ?? (() => process.env.GUILD_DISABLE_WHISPER_TIMESTAMPS !== "true");
  }
  preflight(input: AlignmentInput) {
    requireTimestampCapability(this.clock(), this.available());
    if (!this.key()) throw new AlignmentGatewayError("ALIGNMENT_CONFIGURATION", true);
    if (!z.string().uuid().safeParse(input.requestId).success || !input.bytes.length || input.bytes.length > 3 * 1024 * 1024
      || !["en", "pt", "es", "fr", "ja", "ar"].includes(input.locale) || input.prompt.locale !== input.locale
      || digest(input.prompt.policy) !== digest(whisperPromptPolicy) || hash(input.prompt.text) !== input.prompt.textHash) throw new AlignmentGatewayError("ALIGNMENT_INPUT", true);
    let tokens: number[], leading: number[];
    try { tokens = this.tokenizer.encode(input.prompt.text); leading = this.tokenizer.encode(` ${input.prompt.text}`); }
    catch { throw new AlignmentGatewayError("ALIGNMENT_PROMPT_UNSUPPORTED", true); }
    const count = Math.max(tokens.length, leading.length);
    if (!tokens.length || count > whisperPromptPolicy.maximumTokens || input.prompt.tokenCount !== tokens.length || input.prompt.leadingSpaceTokenCount !== leading.length
      || input.prompt.boundedTokenCount !== count || input.prompt.tokenIdsHash !== digest(tokens) || input.prompt.leadingSpaceTokenIdsHash !== digest(leading)) throw new AlignmentGatewayError("ALIGNMENT_PROMPT_CHANGED", true);
  }
  async align(input: AlignmentInput, beforeDispatch?: () => Promise<void>): Promise<AlignmentHttpReceipt> {
    this.preflight(input);
    const form = new FormData();
    form.append("model", timestampCapability.model); form.append("response_format", "verbose_json");
    form.append("language", input.locale); form.append("prompt", input.prompt.text); form.append("temperature", "0");
    for (const granularity of timestampCapability.granularities) form.append("timestamp_granularities[]", granularity);
    form.append("file", new Blob([new Uint8Array(input.bytes)], { type: "audio/mpeg" }), "guild-original-recording.mp3");
    await beforeDispatch?.();
    const started = Date.now(); let response: Response;
    try {
      response = await this.fetcher(timestampCapability.endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(60000),
        headers: { Authorization: `Bearer ${this.key()}`, "X-Client-Request-Id": input.requestId }, body: form });
    } catch { throw new AlignmentGatewayError("ALIGNMENT_DISPATCH_UNKNOWN", false); }
    const providerId = response.headers.get("x-request-id"), pieces: Uint8Array[] = [];
    let size = 0, complete = false;
    const receipt = (): AlignmentHttpReceipt => {
      const raw = Buffer.concat(pieces), result: AlignmentHttpReceipt = { schemaVersion: "guild.timestamp-http-receipt.v1", capabilityVersion: timestampCapability.version,
        model: timestampCapability.model, requestId: input.requestId, locale: input.locale, audioHash: hash(input.bytes), promptHash: input.prompt.textHash,
        statusCode: response.status, providerRequestId: providerId && /^[A-Za-z0-9_-]{1,200}$/.test(providerId) ? providerId : null,
        rawBodyBase64: raw.toString("base64"), bodyHash: hash(raw), byteLength: raw.length, bodyComplete: complete, observedAt: this.clock().toISOString(),
        latencyMs: Date.now() - started, parsed: null, parseFailure: !complete ? "INCOMPLETE" : response.status !== 200 ? "HTTP_STATUS" : null };
      if (!result.parseFailure) {
        let text = "";
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(raw); } catch { result.parseFailure = "UTF8"; }
        if (!result.parseFailure) try { result.parsed = timestampResponseSchema.parse(JSON.parse(text)); } catch { result.parseFailure = "JSON_SCHEMA"; }
      }
      return checkedAlignmentReceipt(result);
    };
    const reader = response.body?.getReader();
    if (!reader) throw new AlignmentGatewayError("ALIGNMENT_EMPTY_RESPONSE", false, receipt());
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) { complete = true; break; }
        const available = Math.max(0, maximumBodyBytes - size);
        if (chunk.value.byteLength > available) {
          if (available) { pieces.push(chunk.value.slice(0, available)); size += available; }
          await reader.cancel(); throw new AlignmentGatewayError("ALIGNMENT_RESPONSE_SIZE", false, receipt());
        }
        pieces.push(chunk.value); size += chunk.value.byteLength;
      }
    } catch (error) {
      if (error instanceof AlignmentGatewayError) throw error;
      throw new AlignmentGatewayError("ALIGNMENT_RESPONSE_UNKNOWN", false, receipt());
    } finally { reader.releaseLock(); }
    return receipt();
  }
}
