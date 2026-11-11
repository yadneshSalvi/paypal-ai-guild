import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Locale } from "../src/contracts/guild";
import { digest } from "../src/domain/primitives";
import { narrationEstimate, speechErrorRate, speechLanguages } from "../src/domain/speech";
import { audioEngine, renderNarration, type AudioMeasurement } from "../src/server/media/audio-processing";
import { OpenAITranscriptionGateway, TranscriptionGatewayError, type TranscriptionResult } from "../src/server/media/transcription-gateway";

try { process.loadEnvFile(".env"); } catch { /* Hosting supplies its environment. */ }
const originalDirectory = ".setup-evidence/narration-calibration-v1", directory = ".setup-evidence/narration-tempo-calibration-v1";
const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const write = (path: string, value: unknown, exclusive = false) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, ...(exclusive ? { flag: "wx" } : {}) });
interface Input { id: string; locale: Locale; model: string; text: string; pcmHash: string; estimateSeconds: number }
interface Manifest { schemaVersion: string; registeredAt: string; originalManifestHash: string; inputs: Input[]; recipe: unknown; engine: Awaited<ReturnType<typeof audioEngine>>; limits: unknown }
interface State { inputHash: string; measurement: AudioMeasurement; rawDurationSeconds: number; tempo: number; asrState: "dispatching" | "completed" | "needs_review"; asr?: TranscriptionResult; failureCode?: string; comparison?: ReturnType<typeof speechErrorRate> }
await mkdir(directory, { recursive: true, mode: 0o700 });
if (process.argv.includes("--prepare")) {
  const original = JSON.parse(await readFile(`${originalDirectory}/manifest.json`, "utf8"));
  const registeredHash = (await readFile(`${originalDirectory}/manifest.sha256`, "utf8")).trim();
  if (digest(original) !== registeredHash) throw new Error("The original preregistered study changed.");
  const inputs: Input[] = [];
  for (const item of original.inputs) {
    const saved = JSON.parse(await readFile(`${originalDirectory}/${item.id}.json`, "utf8"));
    const pcm = await readFile(`${originalDirectory}/${item.id}.pcm`);
    if (saved.state !== "completed" || hash(pcm) !== saved.receipt?.contentHash) throw new Error("An original recording is incomplete or changed. No calibration input was replaced.");
    inputs.push({ id: item.id, locale: item.locale, model: item.request.model, text: item.request.text, pcmHash: hash(pcm), estimateSeconds: narrationEstimate(item.request.text, item.locale) });
  }
  const manifest: Manifest = { schemaVersion: "guild.narration-tempo-calibration.v1", registeredAt: new Date().toISOString(), originalManifestHash: registeredHash, inputs, recipe: { cadence: speechLanguages, tempo: "clamp(raw-duration / agreed-estimate, 0.85, 1.20)", filter: "atempo, loudnorm I=-16 TP=-1.5 LRA=11 dual_mono, 24 kHz mono 96 kb/s MP3", originalSpeechCalls: 0, asr: "gpt-transcribe; language hint only; expected wording withheld" }, engine: await audioEngine(), limits: { durationRelativeError: 0.1, integratedLufs: [-18, -14], truePeakDbtp: -1, clippedSamples: 0, asrErrorRateAdvisory: 0.1, humanReviewed: false, fluentReviewed: false, commissionAcceptance: false } };
  await write(`${directory}/manifest.json`, manifest, true); await write(`${directory}/manifest.hash.json`, { hash: digest(manifest) }, true);
  console.log(JSON.stringify({ registered: true, cases: inputs.length, originalSpeechCalls: 0, humanReviewed: false }));
} else if (process.argv.includes("--run")) {
  const manifest = JSON.parse(await readFile(`${directory}/manifest.json`, "utf8")) as Manifest;
  const registered = JSON.parse(await readFile(`${directory}/manifest.hash.json`, "utf8"));
  if (digest(manifest) !== registered.hash || digest(manifest.engine) !== digest(await audioEngine())) throw new Error("The normalization study or engine changed.");
  const gateway = new OpenAITranscriptionGateway(), results: unknown[] = [];
  for (const item of manifest.inputs) {
    const path = `${directory}/${item.id}`, inputHash = digest({ item, recipe: manifest.recipe, engine: manifest.engine });
    let saved: State | null = null;
    try { saved = JSON.parse(await readFile(`${path}.json`, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!saved) {
      const pcm = await readFile(`${originalDirectory}/${item.id}.pcm`); if (hash(pcm) !== item.pcmHash) throw new Error("Original PCM bytes changed.");
      const rendered = await renderNarration(pcm, item.estimateSeconds);
      await writeFile(`${path}.mp3`, rendered.bytes, { mode: 0o600, flag: "wx" });
      saved = { inputHash, measurement: rendered.measurement, rawDurationSeconds: rendered.rawDurationSeconds, tempo: rendered.tempo, asrState: "dispatching" };
      await write(`${path}.json`, saved, true);
      try { saved.asr = await gateway.transcribe(rendered.bytes, item.locale); saved.asrState = "completed"; }
      catch (error) { saved.asrState = "needs_review"; saved.failureCode = error instanceof TranscriptionGatewayError ? error.code : "TRANSCRIPTION_OBSERVATION_UNAVAILABLE"; }
      await write(`${path}.json`, saved);
    }
    if (saved.inputHash !== inputHash || hash(await readFile(`${path}.mp3`)) !== saved.measurement.contentHash) throw new Error("A retained case changed. No new request was sent.");
    if (saved.asr) saved.comparison = speechErrorRate(item.text, saved.asr.text, item.locale);
    await write(`${path}.json`, saved);
    const durationError = Math.abs(saved.measurement.durationSeconds - item.estimateSeconds) / item.estimateSeconds;
    const result = { locale: item.locale, model: item.model, caseId: item.id, byteHash: saved.measurement.contentHash, durationSeconds: saved.measurement.durationSeconds, estimateSeconds: item.estimateSeconds, durationError, tempo: saved.tempo, integratedLufs: saved.measurement.integratedLufs, truePeakDbtp: saved.measurement.truePeakDbtp, clippedSamples: saved.measurement.clippedSamples, deterministicPassed: durationError <= 0.1 && saved.measurement.integratedLufs >= -18 && saved.measurement.integratedLufs <= -14 && saved.measurement.truePeakDbtp <= -1 && saved.measurement.clippedSamples === 0, asrState: saved.asrState, errorRate: saved.comparison?.errorRate ?? null, humanReviewed: false };
    results.push(result); console.log(JSON.stringify(result));
  }
  await write(`${directory}/summary.json`, { schemaVersion: "guild.narration-tempo-results.v1", manifestHash: registered.hash, generatedAt: new Date().toISOString(), denominator: manifest.inputs.length, results, originalSpeechCalls: 0, humanReviewed: false, accepted: false, financialWrites: 0 });
} else throw new Error("Use --prepare to register normalization of all twelve original recordings, then --run. An ambiguous ASR create is never repeated.");
