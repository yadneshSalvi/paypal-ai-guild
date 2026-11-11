import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { DomainError } from "@/domain/primitives";

export interface AudioEngine { package: "ffmpeg-static"; packageVersion: "5.3.0"; version: string; binaryHash: string; platform: string }
export interface AudioMeasurement {
  contentHash: string; byteLength: number; format: "mp3"; sampleRate: 24000; channels: 1; bitRate: 96000;
  durationSeconds: number; integratedLufs: number; truePeakDbtp: number; loudnessRangeLu: number;
  clippedSamples: number; samplePeak: number; decodedFrames: number; engine: AudioEngine;
}
let enginePromise: Promise<AudioEngine> | undefined;
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function runAudio(args: string[], input?: Buffer, maximum = 32 * 1024 * 1024): Promise<{ stdout: Buffer; stderr: string }> {
  if (!ffmpegPath) throw new DomainError("AUDIO_ENGINE_MISSING", "The agreed audio measurement engine is not installed.", 503, false);
  const executable = ffmpegPath;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = []; let size = 0, stderr = "", settled = false;
    const fail = (code: string) => { if (!settled) { settled = true; clearTimeout(timer); child.kill("SIGKILL"); reject(new DomainError(code, "The audio bytes could not be decoded or measured by the agreed engine.", 422, false)); } };
    const timer = setTimeout(() => fail("AUDIO_ENGINE_DEADLINE"), 60000);
    child.on("error", () => fail("AUDIO_ENGINE_UNAVAILABLE"));
    child.stdout.on("data", (bytes: Buffer) => { size += bytes.length; if (size > maximum) fail("AUDIO_DECODE_SIZE"); else chunks.push(bytes); });
    child.stderr.on("data", (bytes: Buffer) => { stderr += bytes.toString("utf8"); if (stderr.length > 1024 * 1024) fail("AUDIO_ENGINE_OUTPUT_SIZE"); });
    child.on("close", code => { if (settled) return; if (code !== 0) { fail("AUDIO_DECODE_FAILED"); return; } settled = true; clearTimeout(timer); resolve({ stdout: Buffer.concat(chunks), stderr }); });
    child.stdin.on("error", () => { /* A decoder rejection is handled by its exit status. */ });
    child.stdin.end(input);
  });
}

export async function audioEngine(): Promise<AudioEngine> {
  return enginePromise ??= (async () => {
    const version = (await runAudio(["-version"], undefined, 16384)).stdout.toString("utf8").match(/^ffmpeg version ([^\s]+)/)?.[1];
    if (!version || !/^6\./.test(version) || !ffmpegPath) throw new DomainError("AUDIO_ENGINE_VERSION", "This runtime does not match the qualified FFmpeg package. Review its engine before production.", 422, false);
    return { package: "ffmpeg-static", packageVersion: "5.3.0", version, binaryHash: sha256(await readFile(ffmpegPath)), platform: `${process.platform}/${process.arch}` };
  })();
}

export function pcmToWav(pcm: Buffer): Buffer {
  if (!pcm.length || pcm.length % 2 || pcm.length > 8 * 1024 * 1024) throw new DomainError("AUDIO_PCM_FORMAT", "The original speech is not bounded 24 kHz PCM16 audio.", 422, false);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(pcm.length + 36, 4); header.write("WAVEfmt ", 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Read every Layer III frame header; resampling a decoder is not a format check. */
export function measureMp3Profile(bytes: Buffer): { sampleRate: 24000; channels: 1; bitRate: 96000; frameCount: number; frames: number } {
  let offset = 0, frameCount = 0, frames = 0;
  const fail = () => new DomainError("AUDIO_ENCODED_PROFILE", "The original MP3 frames do not match the agreed mono, 24 kHz, 96 kb/s encoding.", 422, false);
  if (bytes.length >= 10 && bytes.subarray(0, 3).toString() === "ID3") {
    if (![2, 3, 4].includes(bytes[3]!) || bytes.subarray(6, 10).some(value => value > 127)) throw fail();
    const size = (bytes[6]! << 21) | (bytes[7]! << 14) | (bytes[8]! << 7) | bytes[9]!;
    if (size > 65536) throw fail();
    offset = 10 + size + (bytes[3] === 4 && (bytes[5]! & 16) ? 10 : 0);
  }
  while (offset < bytes.length) {
    if (bytes.length - offset < 4) throw fail();
    const header = bytes.readUInt32BE(offset), version = (header >>> 19) & 3, layer = (header >>> 17) & 3;
    const rateIndex = (header >>> 10) & 3, bitIndex = (header >>> 12) & 15;
    if ((header & 0xffe00000) >>> 0 !== 0xffe00000 || version === 1 || layer !== 1 || rateIndex === 3 || bitIndex === 0 || bitIndex === 15) throw fail();
    const rates = version === 3 ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
    const sampleRate = [44100, 48000, 32000][rateIndex]! / (version === 3 ? 1 : version === 2 ? 2 : 4), bitRate = rates[bitIndex]! * 1000;
    const channels = ((header >>> 6) & 3) === 3 ? 1 : 2;
    if (sampleRate !== 24000 || bitRate !== 96000 || channels !== 1) throw fail();
    const frameLength = Math.floor((version === 3 ? 144 : 72) * bitRate / sampleRate) + ((header >>> 9) & 1);
    if (offset + frameLength > bytes.length || ++frameCount > 7600) throw fail();
    frames += version === 3 ? 1152 : 576; offset += frameLength;
  }
  if (!frameCount) throw fail();
  return { sampleRate: 24000, channels: 1, bitRate: 96000, frameCount, frames };
}

export async function renderNarration(pcm: Buffer, targetDurationSeconds?: number): Promise<{ bytes: Buffer; rawDurationSeconds: number; tempo: number; measurement: AudioMeasurement }> {
  pcmToWav(pcm);
  const rawDurationSeconds = pcm.length / 48000;
  if (targetDurationSeconds !== undefined && (!Number.isFinite(targetDurationSeconds) || targetDurationSeconds < 1 || targetDurationSeconds > 180)) throw new DomainError("AUDIO_DURATION_ESTIMATE", "The agreed duration estimate is outside the audio contract.", 422, false);
  const tempo = targetDurationSeconds ? Math.max(0.85, Math.min(1.2, rawDurationSeconds / targetDurationSeconds)) : 1;
  const args = ["-hide_banner", "-nostdin", "-loglevel", "error", "-threads", "1", "-protocol_whitelist", "pipe", "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", "pipe:0", "-map_metadata", "-1", "-vn", "-af", `atempo=${tempo.toFixed(8)},loudnorm=I=-16:TP=-1.5:LRA=11:dual_mono=true,aresample=24000`, "-ar", "24000", "-ac", "1", "-c:a", "libmp3lame", "-b:a", "96k", "-write_xing", "0", "-fflags", "+bitexact", "-flags:a", "+bitexact", "-f", "mp3", "pipe:1"];
  const { stdout: bytes } = await runAudio(args, pcm, 3 * 1024 * 1024);
  const measurement = await measureNarration(bytes);
  return { bytes, rawDurationSeconds, tempo, measurement };
}

/** Decode the submitted file independently; no manifest loudness value is trusted. */
export async function measureNarration(bytes: Buffer): Promise<AudioMeasurement> {
  if (!bytes.length || bytes.length > 3 * 1024 * 1024) throw new DomainError("AUDIO_FILE_SIZE", "The submitted recording exceeds its agreed file limit.", 422, false);
  const encoded = measureMp3Profile(bytes);
  const base = ["-hide_banner", "-nostdin", "-threads", "1", "-protocol_whitelist", "pipe", "-f", "mp3", "-i", "pipe:0", "-map", "0:a:0", "-vn"];
  const [decoded, scan, engine] = await Promise.all([
    runAudio([...base, "-loglevel", "error", "-ar", "24000", "-ac", "1", "-c:a", "pcm_f32le", "-f", "f32le", "pipe:1"], bytes),
    runAudio([...base, "-loglevel", "info", "-nostats", "-af", "ebur128=peak=sample+true:dualmono=true:framelog=verbose", "-f", "null", "pipe:1"], bytes, 1024),
    audioEngine(),
  ]);
  if (!decoded.stdout.length || decoded.stdout.length % 4) throw new DomainError("AUDIO_DECODE_FORMAT", "The submitted recording did not decode into complete samples.", 422, false);
  const summary = scan.stderr.slice(scan.stderr.lastIndexOf("Summary:"));
  const integratedLufs = Number(summary.match(/Integrated loudness:\s*I:\s*(-?\d+(?:\.\d+)?) LUFS/)?.[1]);
  const truePeakDbtp = Number(summary.match(/True peak:\s*Peak:\s*(-?\d+(?:\.\d+)?) dBFS/)?.[1]);
  const loudnessRangeLu = Number(summary.match(/Loudness range:\s*LRA:\s*(-?\d+(?:\.\d+)?) LU/)?.[1]);
  if (![integratedLufs, truePeakDbtp, loudnessRangeLu].every(Number.isFinite)) throw new DomainError("AUDIO_MEASUREMENT_MISSING", "The independent loudness report was incomplete. No pass was inferred.", 422, false);
  let clippedSamples = 0, samplePeak = 0;
  for (let offset = 0; offset < decoded.stdout.length; offset += 4) {
    const sample = Math.abs(decoded.stdout.readFloatLE(offset));
    if (!Number.isFinite(sample)) throw new DomainError("AUDIO_SAMPLE_INVALID", "The recording contains invalid decoded samples.", 422, false);
    samplePeak = Math.max(samplePeak, sample); if (sample >= 1) clippedSamples++;
  }
  const decodedFrames = decoded.stdout.length / 4;
  if (decodedFrames !== encoded.frames) throw new DomainError("AUDIO_DECODE_COVERAGE", "The recording did not decode every complete encoded frame.", 422, false);
  return { contentHash: sha256(bytes), byteLength: bytes.length, format: "mp3", sampleRate: encoded.sampleRate, channels: encoded.channels, bitRate: encoded.bitRate, durationSeconds: decodedFrames / 24000, integratedLufs, truePeakDbtp, loudnessRangeLu, clippedSamples, samplePeak, decodedFrames, engine };
}
