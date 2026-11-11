import { createHash } from "node:crypto";
import { z } from "zod";
import type { Locale } from "@/contracts/guild";

export interface TranscriptionResult { model: "gpt-transcribe"; text: string; languages: string[]; rawBody: string; bodyHash: string; providerRequestId: string | null; latencyMs: number }
export interface TranscriptionGateway { transcribe(bytes: Buffer, locale: Locale): Promise<TranscriptionResult> }
export class TranscriptionGatewayError extends Error {
  constructor(readonly code: string, readonly definitive: boolean, readonly rawBody?: string, readonly bodyHash?: string) { super("The saved audio did not return a confirmed transcription result."); }
}

/** Expected wording is deliberately not included as a recognition prompt. */
export class OpenAITranscriptionGateway implements TranscriptionGateway {
  async transcribe(bytes: Buffer, locale: Locale): Promise<TranscriptionResult> {
    if (!process.env.OPENAI_API_KEY) throw new TranscriptionGatewayError("TRANSCRIPTION_CONFIGURATION", true);
    if (!bytes.length || bytes.length > 3 * 1024 * 1024 || !["en", "pt", "es", "fr", "ja", "ar"].includes(locale)) throw new TranscriptionGatewayError("TRANSCRIPTION_INPUT", true);
    const form = new FormData(); form.append("model", "gpt-transcribe");
    form.append("file", new Blob([new Uint8Array(bytes)], { type: "audio/mpeg" }), "guild-recording.mp3");
    form.append("languages[]", locale);
    const started = Date.now(); let response: Response;
    try { response = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: form, redirect: "error", signal: AbortSignal.timeout(60000) }); }
    catch { throw new TranscriptionGatewayError("TRANSCRIPTION_UNCONFIRMED", false); }
    if (!response.ok) { await response.body?.cancel(); throw new TranscriptionGatewayError(`TRANSCRIPTION_HTTP_${response.status}`, [400, 401, 403, 404, 422, 429].includes(response.status)); }
    const reader = response.body?.getReader(); if (!reader) throw new TranscriptionGatewayError("TRANSCRIPTION_EMPTY", false);
    const parts: Uint8Array[] = []; let size = 0;
    try {
      for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 256 * 1024) { await reader.cancel(); throw new TranscriptionGatewayError("TRANSCRIPTION_RESPONSE_SIZE", false); } parts.push(part.value); }
    } catch (error) { if (error instanceof TranscriptionGatewayError) throw error; throw new TranscriptionGatewayError("TRANSCRIPTION_UNCONFIRMED", false); }
    finally { reader.releaseLock(); }
    const body = Buffer.concat(parts);
    let result: { text: string; languages: { code: string }[] };
    try { result = z.object({ text: z.string().min(1).max(16000), languages: z.array(z.object({ code: z.string().regex(/^[a-z]{2,3}$/) })).max(12) }).parse(JSON.parse(body.toString("utf8"))); }
    catch { throw new TranscriptionGatewayError("TRANSCRIPTION_RESPONSE_FORMAT", false, body.toString("utf8"), createHash("sha256").update(body).digest("hex")); }
    const requestId = response.headers.get("x-request-id");
    return { model: "gpt-transcribe", text: result.text, languages: result.languages.map(item => item.code), rawBody: body.toString("utf8"), bodyHash: createHash("sha256").update(body).digest("hex"), providerRequestId: requestId && /^[A-Za-z0-9_-]{1,200}$/.test(requestId) ? requestId : null, latencyMs: Date.now() - started };
  }
}
