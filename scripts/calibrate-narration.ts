import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { exhibitionCopy, exhibitionLocaleOrder } from "../src/exhibition/locales";
import { canonical, digest } from "../src/domain/primitives";
import { narrationEstimate, speechErrorRate, speechInstructions } from "../src/domain/speech";
import { audioEngine, renderNarration } from "../src/server/media/audio-processing";
import { OpenAIRealtimeSpeechGateway, SpeechGatewayError, type SpeechRequest, type SpeechReceipt } from "../src/server/media/speech-gateway";
import { OpenAITranscriptionGateway, TranscriptionGatewayError, type TranscriptionResult } from "../src/server/media/transcription-gateway";
import type { Locale } from "../src/contracts/guild";

try { process.loadEnvFile(".env"); } catch { /* Hosting supplies its environment. */ }
const directory = ".setup-evidence/narration-calibration-v1";
interface Case { id: string; locale: Locale; request: SpeechRequest; requestHash: string }
interface Manifest { schemaVersion: string; registeredAt: string; scope: string; methods: string[]; inputs: Case[]; engine: Awaited<ReturnType<typeof audioEngine>> }
interface State { caseId: string; requestHash: string; state: string; startedAt: string; sessionId?: string; responseId?: string; resolvedModel?: string; chunks?: number; bytes?: number; receipt?: SpeechReceipt; failureCode?: string; definitive?: boolean; transcription?: TranscriptionResult; transcriptionState?: string; measurement?: unknown; comparison?: unknown; providerTranscriptComparison?: unknown }
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
await mkdir(directory, { recursive: true, mode: 0o700 });
if (process.argv.includes("--prepare")) {
  const inputs: Case[] = exhibitionLocaleOrder.flatMap(locale => (["gpt-realtime-2.1-mini", "gpt-realtime-2.1"] as const).map(model => {
    const id = randomUUID(), request: SpeechRequest = { operationId: id, locale, model, voice: "marin", text: exhibitionCopy[locale].chapters.arrival.body, instructions: speechInstructions(locale), safetyIdentifier: digest("guild-disclosed-system-narration-calibration-v1") };
    return { id, locale, request, requestHash: digest(request) };
  }));
  const manifest: Manifest = { schemaVersion: "guild.narration-calibration.v1", registeredAt: new Date().toISOString(), scope: "Twelve genuine synthesis cases: two current Realtime speech models × six whole sample introduction texts, followed by independent ASR. Sample calibration only, no commissioned production, human review, acceptance or financial action.", methods: ["Every case stays in the denominator, including failures and ambiguous writes; no automatic resubmission.", "One complete source paragraph per locale; identical text, voice and instructions across model candidates.", "Measure native decode, duration, integrated LUFS, true peak and clipping after the same normalization.", "gpt-transcribe independently recognizes each final MP3 without the expected words in a prompt; per-language normalized WER/CER is advisory.", "Human listening, accent/naturalness and fluent-language quality are not established by this experiment."], inputs, engine: await audioEngine() };
  await writeFile(`${directory}/manifest.json`, json(manifest), { flag: "wx", mode: 0o600 });
  await writeFile(`${directory}/manifest.sha256`, `${createHash("sha256").update(canonical(manifest)).digest("hex")}\n`, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ registered: true, cases: inputs.length, models: ["gpt-realtime-2.1-mini", "gpt-realtime-2.1"], humanReviewed: false }));
} else if (process.argv.includes("--run")) {
  const manifest = JSON.parse(await readFile(`${directory}/manifest.json`, "utf8")) as Manifest;
  const registeredHash = (await readFile(`${directory}/manifest.sha256`, "utf8")).trim();
  if (digest(manifest) !== registeredHash || digest(await audioEngine()) !== digest(manifest.engine)) throw new Error("The registered calibration or engine changed. No request was sent.");
  const gateway = new OpenAIRealtimeSpeechGateway(), transcription = new OpenAITranscriptionGateway();
  for (const item of manifest.inputs) {
    const path = `${directory}/${item.id}`; let state: State;
    try { state = JSON.parse(await readFile(`${path}.json`, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; state = { caseId: item.id, requestHash: item.requestHash, state: "reserved", startedAt: new Date().toISOString() }; }
    if (state.requestHash !== digest(item.request)) throw new Error("A registered input changed. No request was sent.");
    const save = async () => writeFile(`${path}.json`, json(state), { mode: 0o600 });
    if (state.state === "reserved") {
      await save(); state.state = "connecting"; await save();
      try {
        await gateway.generate(item.request, {
          session: async (id, model) => { state.sessionId = id; state.resolvedModel = model; await save(); },
          dispatch: async () => { state.state = "dispatching"; await save(); },
          response: async id => { state.responseId = id; state.state = "streaming"; await save(); },
          chunk: async (sequence, _eventId, bytes) => { await appendFile(`${path}.pcm`, bytes, { mode: 0o600 }); state.chunks = sequence + 1; state.bytes = (state.bytes ?? 0) + bytes.length; await save(); },
          complete: async receipt => { state.receipt = receipt; state.state = "received"; await save(); },
        });
      } catch (error) { state.state = "needs_review"; state.failureCode = error instanceof SpeechGatewayError ? error.code : "SPEECH_OBSERVATION_UNAVAILABLE"; state.definitive = error instanceof SpeechGatewayError && error.definitive; await save(); }
    }
    if (state.state === "received" || state.state === "completed") {
      const pcm = await readFile(`${path}.pcm`);
      if (!state.receipt || createHash("sha256").update(pcm).digest("hex") !== state.receipt.contentHash) throw new Error("Saved speech bytes failed their independent receipt hash.");
      const rendered = await renderNarration(pcm); await writeFile(`${path}.mp3`, rendered.bytes, { mode: 0o600 });
      state.measurement = { ...rendered.measurement, originalDurationSeconds: rendered.rawDurationSeconds, provisionalEstimateSeconds: narrationEstimate(item.request.text, item.locale) };
      state.providerTranscriptComparison = speechErrorRate(item.request.text, state.receipt.transcript, item.locale);
      if (!state.transcriptionState) {
        state.transcriptionState = "dispatching"; await save();
        try { state.transcription = await transcription.transcribe(rendered.bytes, item.locale); state.transcriptionState = "completed"; await save(); }
        catch (error) { state.transcriptionState = "needs_review"; state.failureCode = error instanceof TranscriptionGatewayError ? error.code : "TRANSCRIPTION_OBSERVATION_UNAVAILABLE"; state.definitive = error instanceof TranscriptionGatewayError && error.definitive; await save(); }
      }
      if (state.transcription) state.comparison = speechErrorRate(item.request.text, state.transcription.text, item.locale);
      state.state = "completed"; await save();
    }
    console.log(JSON.stringify({ locale: item.locale, model: item.request.model, state: state.state, transcriptionState: state.transcriptionState, failureCode: state.failureCode, comparison: state.comparison }));
  }
} else throw new Error("Use --prepare to preregister the exact twelve cases, then --run. Existing dispatched cases are never resubmitted.");
