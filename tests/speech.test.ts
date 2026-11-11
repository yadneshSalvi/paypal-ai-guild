import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import WebSocket from "ws";
import { isSpeechModelVersion, OpenAIRealtimeSpeechGateway, SpeechGatewayError, type SpeechRequest } from "../src/server/media/speech-gateway";
import { measureNarration, pcmToWav, renderNarration } from "../src/server/media/audio-processing";

function request(): SpeechRequest { return { operationId: randomUUID(), model: "gpt-realtime-2.1-mini", voice: "marin", locale: "en", text: "Welcome to the museum.", instructions: "Read only the supplied text, verbatim.", safetyIdentifier: "a".repeat(64) }; }
class FixtureSocket extends EventEmitter {
  readyState = WebSocket.OPEN as number;
  sent: Record<string, any>[] = [];
  constructor(readonly fixture: SpeechRequest, readonly mode: "success" | "lost" | "wrong_id" | "duplicate" = "success") { super(); queueMicrotask(() => this.event({ type: "session.created", session: { id: "sess_fixture", model: fixture.model } })); }
  event(value: Record<string, unknown>) { this.emit("message", Buffer.from(JSON.stringify(value)), false); }
  send(data: string) {
    const value = JSON.parse(data); this.sent.push(value);
    if (value.type === "session.update") queueMicrotask(() => this.event({ type: "session.updated", session: { id: "sess_fixture", ...value.session } }));
    if (value.type === "response.create") queueMicrotask(() => {
      const response = { id: "resp_fixture", metadata: { guild_operation: this.fixture.operationId } };
      this.event({ type: "response.created", response });
      const binding = { response_id: this.mode === "wrong_id" ? "resp_unowned" : response.id, item_id: "item_fixture", output_index: 0, content_index: 0 };
      const chunk = { type: "response.output_audio.delta", ...binding, event_id: "event_one", delta: Buffer.alloc(4800).toString("base64") };
      this.event(chunk);
      if (this.mode === "lost") { this.close(); return; }
      if (this.mode === "duplicate") this.event(chunk);
      this.event({ type: "response.output_audio.done", ...binding });
      this.event({ type: "response.output_audio_transcript.done", ...binding, transcript: this.fixture.text });
      this.event({ type: "response.done", response: { ...response, status: "completed", output: [{ id: "item_fixture", type: "message", role: "assistant", content: [{ type: "audio", transcript: this.fixture.text }] }], usage: { total_tokens: 50 } } });
    });
  }
  close() { this.readyState = WebSocket.CLOSED; this.emit("close"); }
  terminate() { this.close(); }
}

test("Realtime speech commits authority before one bounded response and persists bytes before completion", async () => {
  const previous = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = "speech-unit-key";
  try {
    const input = request(), socket = new FixtureSocket(input), order: string[] = [];
    const gateway = new OpenAIRealtimeSpeechGateway((url, options) => { assert.equal(url, `wss://api.openai.com/v1/realtime?model=${input.model}`); assert.equal(options.followRedirects, false); return socket as unknown as WebSocket; });
    const result = await gateway.generate(input, { session: async () => { order.push("session"); }, dispatch: async () => { order.push("dispatch"); }, response: async () => { order.push("response"); }, chunk: async () => { order.push("bytes"); }, complete: async () => { order.push("complete"); } });
    assert.deepEqual(order, ["session", "dispatch", "response", "bytes", "complete"]);
    assert.equal(result.pcm.length, 4800); assert.equal(result.receipt.contentHash, createHash("sha256").update(result.pcm).digest("hex"));
    assert.equal(socket.sent.filter(item => item.type === "response.create").length, 1);
    assert.deepEqual(socket.sent[1]!.response.tools, []); assert.equal(socket.sent[1]!.response.conversation, "none");
  } finally { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; }
});

test("lost speech streams retain chunks and never reconnect or infer completion", async () => {
  const previous = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = "speech-unit-key";
  try {
    const input = request(); let connections = 0, chunks = 0, completed = false;
    const gateway = new OpenAIRealtimeSpeechGateway(() => { connections++; return new FixtureSocket(input, "lost") as unknown as WebSocket; });
    await assert.rejects(gateway.generate(input, { dispatch: async () => {}, chunk: async () => { chunks++; }, complete: async () => { completed = true; } }), error => error instanceof SpeechGatewayError && error.dispatched && error.code === "SPEECH_CONNECTION_LOST");
    assert.equal(connections, 1); assert.equal(chunks, 1); assert.equal(completed, false);
  } finally { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; }
});

test("speech rejects mismatched or repeated provider bytes and an authority withdrawal before dispatch", async () => {
  const previous = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = "speech-unit-key";
  try {
    assert.equal(isSpeechModelVersion("gpt-realtime-2.1-mini", "gpt-realtime-2.1"), false);
    assert.equal(isSpeechModelVersion("gpt-realtime-2.1-2026-11-01", "gpt-realtime-2.1"), true);
    for (const mode of ["wrong_id", "duplicate"] as const) {
      const input = request(); const gateway = new OpenAIRealtimeSpeechGateway(() => new FixtureSocket(input, mode) as unknown as WebSocket);
      await assert.rejects(gateway.generate(input, { dispatch: async () => {} }), SpeechGatewayError);
    }
    const input = request(), socket = new FixtureSocket(input);
    await assert.rejects(new OpenAIRealtimeSpeechGateway(() => socket as unknown as WebSocket).generate(input, { dispatch: async () => { throw new Error("authority withdrawn"); } }), /authority withdrawn/);
    assert.equal(socket.sent.filter(item => item.type === "response.create").length, 0);
  } finally { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; }
});

test("actual FFmpeg encoding and ebur128 measurement bind audio bytes and reject invalid files", async () => {
  const pcm = Buffer.alloc(24000 * 2 * 6);
  for (let i = 0; i < pcm.length / 2; i++) {
    const seconds = i / 24000, envelope = 0.3 + 0.5 * Math.sin(seconds * Math.PI) ** 2;
    pcm.writeInt16LE(Math.round(12000 * envelope * (Math.sin(seconds * 2 * Math.PI * 220) + 0.2 * Math.sin(seconds * 2 * Math.PI * 440))), i * 2);
  }
  const wav = pcmToWav(pcm); assert.equal(wav.subarray(0, 4).toString(), "RIFF"); assert.equal(wav.readUInt32LE(40), pcm.length);
  const produced = await renderNarration(pcm), independentlyMeasured = await measureNarration(produced.bytes);
  assert.deepEqual(produced.measurement, independentlyMeasured);
  assert.ok(independentlyMeasured.integratedLufs >= -18 && independentlyMeasured.integratedLufs <= -14);
  assert.ok(independentlyMeasured.truePeakDbtp <= -1); assert.equal(independentlyMeasured.clippedSamples, 0);
  assert.ok(Math.abs(independentlyMeasured.durationSeconds - 6) < 0.15); assert.equal(independentlyMeasured.engine.packageVersion, "5.3.0");
  await assert.rejects(measureNarration(Buffer.from("not an mp3")));
  assert.throws(() => pcmToWav(Buffer.alloc(3)));
});
