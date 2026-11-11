import WebSocket from "ws";
import { createHash } from "node:crypto";
import type { Locale } from "@/contracts/guild";

export type SpeechModel = "gpt-realtime-2.1-mini" | "gpt-realtime-2.1";
export function isSpeechModelVersion(value: string, requested: SpeechModel): boolean {
  return value === requested || new RegExp(`^${requested.replaceAll(".", "\\.")}-(?:20[0-9]{2}-[0-9]{2}-[0-9]{2})$`).test(value);
}
export interface SpeechRequest {
  operationId: string; model: SpeechModel; voice: "marin" | "cedar";
  locale: Locale; text: string; instructions: string; safetyIdentifier: string;
}
export interface SpeechReceipt {
  model: string; voice: string; sessionId: string; responseId: string;
  transcript: string; sampleRate: 24000; byteLength: number; contentHash: string;
  latencyMs: number; usage: Record<string, unknown> | null;
}
export interface SpeechObserver {
  session?(sessionId: string, model: string): Promise<void>;
  /** Commit dispatch and recheck current authority before response.create. */
  dispatch(): Promise<void>;
  response?(responseId: string): Promise<void>;
  chunk?(sequence: number, eventId: string, bytes: Buffer): Promise<void>;
  complete?(receipt: SpeechReceipt): Promise<void>;
}
export interface SpeechGateway {
  generate(request: SpeechRequest, observer: SpeechObserver): Promise<{ pcm: Buffer; receipt: SpeechReceipt }>;
}
export class SpeechGatewayError extends Error {
  constructor(readonly code: string, readonly dispatched: boolean, readonly definitive = false) {
    super("The speech operation did not return a confirmed complete recording.");
  }
}
type SpeechSocket = Pick<WebSocket, "on" | "send" | "close" | "terminate" | "readyState">;
type SocketFactory = (url: string, options: WebSocket.ClientOptions) => SpeechSocket;
const identifier = (value: unknown, prefix: string): value is string => typeof value === "string" && new RegExp(`^${prefix}_[A-Za-z0-9_-]{1,240}$`).test(value);
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Server-only GA transport. A socket is never reopened after response dispatch. */
export class OpenAIRealtimeSpeechGateway implements SpeechGateway {
  constructor(private readonly socketFactory: SocketFactory = (url, options) => new WebSocket(url, options), private readonly deadlineMs = 120000) {}

  async generate(request: SpeechRequest, observer: SpeechObserver): Promise<{ pcm: Buffer; receipt: SpeechReceipt }> {
    if (!process.env.OPENAI_API_KEY) throw new SpeechGatewayError("SPEECH_CONFIGURATION", false, true);
    if (!/^[a-f0-9-]{36}$/.test(request.operationId) || !["gpt-realtime-2.1-mini", "gpt-realtime-2.1"].includes(request.model) || !["marin", "cedar"].includes(request.voice) || !["en", "pt", "es", "fr", "ja", "ar"].includes(request.locale) || !request.text.trim() || request.text.length > 6000 || request.instructions.length > 6000 || !/^[a-f0-9]{64}$/.test(request.safetyIdentifier)) throw new SpeechGatewayError("SPEECH_REQUEST_BINDING", false, true);
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const socket = this.socketFactory(`wss://api.openai.com/v1/realtime?model=${request.model}`, {
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "OpenAI-Safety-Identifier": request.safetyIdentifier },
        handshakeTimeout: 15000, followRedirects: false, maxPayload: 1024 * 1024,
      });
      let settled = false, dispatched = false, sessionUpdated = false, audioDone = false;
      let sessionId = "", responseId = "", resolvedModel = "", transcript = "", itemId = "";
      let totalBytes = 0, queuedBytes = 0, sequence = 0;
      const chunks: Buffer[] = [], eventIds = new Set<string>();
      let handling: Promise<void> = Promise.resolve();
      const finish = (error?: unknown, result?: { pcm: Buffer; receipt: SpeechReceipt }) => {
        if (settled) return;
        settled = true; clearTimeout(deadline);
        if (socket.readyState === WebSocket.OPEN) socket.close(1000); else socket.terminate();
        if (error) reject(error); else resolve(result!);
      };
      const fail = (code: string, definitive = false) => finish(new SpeechGatewayError(code, dispatched, definitive));
      const deadline = setTimeout(() => fail("SPEECH_CONNECTION_DEADLINE"), this.deadlineMs);

      const consume = async (data: Buffer) => {
        if (settled) return;
        let event: Record<string, any>;
        try { event = JSON.parse(data.toString("utf8")); } catch { throw new SpeechGatewayError("SPEECH_EVENT_FORMAT", dispatched); }
        if (!event || typeof event !== "object" || typeof event.type !== "string") throw new SpeechGatewayError("SPEECH_EVENT_FORMAT", dispatched);
        if (event.type === "error") {
          const code = typeof event.error?.code === "string" && /^[A-Za-z0-9_]{1,100}$/.test(event.error.code) ? event.error.code : "PROVIDER_ERROR";
          throw new SpeechGatewayError(`SPEECH_${code.toUpperCase()}`, dispatched, !responseId && ["invalid_request_error", "authentication_error", "permission_error"].includes(event.error?.type));
        }
        if (event.type === "session.created") {
          if (sessionId || !identifier(event.session?.id, "sess") || typeof event.session?.model !== "string" || !isSpeechModelVersion(event.session.model, request.model)) throw new SpeechGatewayError("SPEECH_SESSION_BINDING", dispatched);
          sessionId = event.session.id; resolvedModel = event.session.model;
          await observer.session?.(sessionId, resolvedModel);
          socket.send(JSON.stringify({ type: "session.update", event_id: `guild_session_${request.operationId}`, session: {
            type: "realtime", output_modalities: ["audio"], tools: [], tool_choice: "none", max_output_tokens: 4096,
            audio: { input: { turn_detection: null }, output: { format: { type: "audio/pcm", rate: 24000 }, voice: request.voice } },
            instructions: request.instructions,
          } }));
          return;
        }
        if (event.type === "session.updated") {
          if (!sessionId || sessionUpdated || event.session?.id !== sessionId || event.session?.audio?.output?.voice !== request.voice || event.session?.audio?.output?.format?.type !== "audio/pcm" || event.session?.audio?.output?.format?.rate !== 24000 || event.session?.tools?.length || event.session?.audio?.input?.turn_detection !== null) throw new SpeechGatewayError("SPEECH_SESSION_CONFIGURATION", dispatched);
          sessionUpdated = true;
          await observer.dispatch();
          // A lost connection after this commit is ambiguous: Realtime has no GET replay.
          dispatched = true;
          socket.send(JSON.stringify({ type: "response.create", event_id: `guild_response_${request.operationId}`, response: {
            conversation: "none", output_modalities: ["audio"], metadata: { guild_operation: request.operationId },
            instructions: request.instructions, max_output_tokens: 4096, tools: [], tool_choice: "none",
            input: [{ type: "message", role: "user", content: [{ type: "input_text", text: JSON.stringify({ language: request.locale, text_to_read_verbatim: request.text }) }] }],
          } }));
          return;
        }
        if (event.type === "response.created") {
          if (!dispatched || responseId || !identifier(event.response?.id, "resp") || event.response?.metadata?.guild_operation !== request.operationId) throw new SpeechGatewayError("SPEECH_RESPONSE_BINDING", dispatched);
          responseId = event.response.id; await observer.response?.(responseId); return;
        }
        if (["response.output_audio.delta", "response.output_audio.done", "response.output_audio_transcript.done"].includes(event.type)) {
          if (!responseId || event.response_id !== responseId || event.output_index !== 0 || event.content_index !== 0 || typeof event.item_id !== "string" || itemId && itemId !== event.item_id) throw new SpeechGatewayError("SPEECH_AUDIO_BINDING", dispatched);
          itemId = event.item_id;
          if (event.type === "response.output_audio.done") { audioDone = true; return; }
          if (event.type === "response.output_audio_transcript.done") {
            if (typeof event.transcript !== "string" || !event.transcript.trim() || event.transcript.length > 16000) throw new SpeechGatewayError("SPEECH_TRANSCRIPT_FORMAT", dispatched);
            transcript = event.transcript; return;
          }
          if (audioDone || typeof event.delta !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(event.delta) || !identifier(event.event_id, "event") || eventIds.has(event.event_id)) throw new SpeechGatewayError("SPEECH_AUDIO_SEQUENCE", dispatched);
          const bytes = Buffer.from(event.delta, "base64");
          if (!bytes.length || bytes.length % 2 || bytes.length > 512 * 1024 || totalBytes + bytes.length > 8 * 1024 * 1024) throw new SpeechGatewayError("SPEECH_AUDIO_SIZE", dispatched);
          eventIds.add(event.event_id); await observer.chunk?.(sequence++, event.event_id, bytes);
          chunks.push(bytes); totalBytes += bytes.length; return;
        }
        if (event.type === "response.done") {
          const result = event.response;
          if (!responseId || result?.id !== responseId || result?.metadata?.guild_operation !== request.operationId) throw new SpeechGatewayError("SPEECH_RESPONSE_BINDING", dispatched);
          if (result.status !== "completed") throw new SpeechGatewayError("SPEECH_RESPONSE_INCOMPLETE", dispatched, true);
          if (!audioDone || !transcript || !totalBytes || !Array.isArray(result.output) || result.output.length !== 1 || result.output[0].type !== "message" || result.output[0].role !== "assistant" || result.output[0].id !== itemId) throw new SpeechGatewayError("SPEECH_RESPONSE_CONTENT", dispatched);
          const content = result.output[0].content;
          if (!Array.isArray(content) || content.length !== 1 || !["audio", "output_audio"].includes(content[0].type) || content[0].transcript !== transcript) throw new SpeechGatewayError("SPEECH_TRANSCRIPT_BINDING", dispatched);
          const pcm = Buffer.concat(chunks), receipt: SpeechReceipt = { model: resolvedModel, voice: request.voice, sessionId, responseId, transcript, sampleRate: 24000, byteLength: pcm.length, contentHash: hash(pcm), latencyMs: Date.now() - started, usage: result.usage && typeof result.usage === "object" ? result.usage : null };
          await observer.complete?.(receipt); finish(undefined, { pcm, receipt });
        }
      };
      socket.on("message", (message: WebSocket.RawData, binary: boolean) => {
        if (settled) return;
        const bytes = Buffer.isBuffer(message) ? message : Buffer.from(message as ArrayBuffer);
        queuedBytes += bytes.length;
        if (binary || queuedBytes > 12 * 1024 * 1024) { fail("SPEECH_EVENT_SIZE"); return; }
        handling = handling.then(() => consume(bytes)).catch(error => finish(error)).finally(() => { queuedBytes -= bytes.length; });
      });
      socket.on("error", () => fail("SPEECH_TRANSPORT"));
      socket.on("close", () => { void handling.then(() => { if (!settled) fail("SPEECH_CONNECTION_LOST"); }); });
    });
  }
}
