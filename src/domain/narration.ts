import { z } from "zod";
import { locales, type AcceptancePack, type ArtifactManifest, type Locale } from "@/contracts/guild";
import { digest, DomainError } from "./primitives";
import { narrationEstimate, speechLanguages } from "./speech";
import { translationArtifactSchema } from "./translation";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const audioEngineSchema = z.object({ package: z.literal("ffmpeg-static"), packageVersion: z.literal("5.3.0"), version: z.string().regex(/^6\./), binaryHash: hash, platform: z.string().min(3).max(60) }).strict();
export type NarrationEngine = z.infer<typeof audioEngineSchema>;
export const audioMeasurementSchema = z.object({ contentHash: hash, byteLength: z.number().int().positive().max(3 * 1024 * 1024), format: z.literal("mp3"), sampleRate: z.literal(24000), channels: z.literal(1), bitRate: z.literal(96000), durationSeconds: z.number().positive().max(180), integratedLufs: z.number().finite(), truePeakDbtp: z.number().finite(), loudnessRangeLu: z.number().finite(), clippedSamples: z.number().int().nonnegative(), samplePeak: z.number().finite().nonnegative(), decodedFrames: z.number().int().positive(), engine: audioEngineSchema }).strict();

export const narrationStandard = {
  version: "quill.complete-narration.v2", model: "gpt-realtime-2.1", voice: "marin", transport: "OpenAI Realtime WebSocket, one out-of-band response per label",
  script: "Exact title, two line breaks, then complete body from the bound translation artifact; no added introduction, music or closing.",
  originalFormat: { encoding: "pcm16le", sampleRate: 24000, channels: 1 },
  outputFormat: { encoding: "mp3", sampleRate: 24000, channels: 1, bitRate: 96000, maximumBytes: 3 * 1024 * 1024 },
  cadence: speechLanguages, durationTolerance: 0.1,
  processing: { tempoMinimum: 0.85, tempoMaximum: 1.2, tempoFormula: "clamp(original duration / agreed estimate, 0.85, 1.20)", loudnorm: { integratedLufs: -16, truePeakDbtp: -1.5, loudnessRangeLu: 11, dualMono: true } },
  loudness: { minimumIntegratedLufs: -18, maximumIntegratedLufs: -14, maximumTruePeakDbtp: -1, maximumClippedSamples: 0, measurement: "FFmpeg ebur128 with true peak and dualmono; independent PCM decode" },
  providerTranscript: "Every normalized script unit must appear in order in the provider transcript. This checks the reported transcript, not what a listener actually hears.",
  independentAsr: { model: "gpt-transcribe", expectedWordingInPrompt: false, errorRateTarget: 0.1, advisory: true, comparison: "NFKC word error rate; Japanese character error rate; Arabic diacritic-insensitive word error rate" },
  disclosure: "AI-generated narration. Listening, accent, pronunciation and naturalness remain human-review requirements; automated transcripts do not establish fluent review.",
  calibration: { source: "Twelve preregistered sample recordings, two model candidates × six locales, then twelve frozen normalization/ASR cases", selectedModelCases: 6, selectedModelDeterministicPasses: 6, allCandidateCases: 12, allCandidateDeterministicPasses: 10, fluentReviewed: false, humanListeningReviewed: false, manifestHash: "df8294ecb5b42d2c205e834d7e3ae96123421ef3abc89509c3de3212fdb3a624" },
} as const;

export interface NarrationScript { locale: Locale; key: string; title: string; text: string; textHash: string; estimateSeconds: number }
export function narrationScripts(source: ArtifactManifest): NarrationScript[] {
  const parsed = translationArtifactSchema.safeParse(source.content);
  if (!parsed.success || digest(source.content) !== source.contentHash) throw new DomainError("NARRATION_SOURCE_INVALID", "Narration needs the exact complete submission under the full language agreement.", 422, false);
  const keys = Object.keys(parsed.data.translations.en);
  if (!keys.length || keys.length > 31 || !locales.every(locale => Object.keys(parsed.data.translations[locale]).sort().join("|") === [...keys].sort().join("|"))) throw new DomainError("NARRATION_SOURCE_COVERAGE", "All six language files must identify the same complete label set.", 422, false);
  return locales.flatMap(locale => keys.map(key => {
    const label = parsed.data.translations[locale][key]!, text = `${label.title}\n\n${label.body}`;
    const estimateSeconds = narrationEstimate(text, locale);
    if (text.length > 6000 || estimateSeconds < 1 || estimateSeconds > 150) throw new DomainError("NARRATION_SCRIPT_BOUNDS", "A narration script is outside the measured recording and duration limits. Review the contract before production.", 422, false);
    return { locale, key, title: label.title, text, textHash: digest(text), estimateSeconds };
  }));
}

export function narrationAcceptancePack(source: ArtifactManifest, rawEngine: NarrationEngine): AcceptancePack {
  const engine = audioEngineSchema.parse(rawEngine), scripts = narrationScripts(source);
  const criteria: AcceptancePack["criteria"] = [
    { id: "source", label: "Every recording binds the exact translated script", description: "Freeze the complete source artifact, title/body text, locale, script hash, duration estimate and producing contract. No substitute wording or upstream acceptance is inferred.", blocking: true, kind: "deterministic", status: "pending", evidence: null },
    { id: "coverage", label: "Every label has a distinct complete recording in all six languages", description: "Exactly one immutable audio file and completed speech receipt for every agreed locale/label pair. Partial streams are retained as evidence and cannot become a complete recording.", blocking: true, kind: "deterministic", status: "pending", evidence: null },
    { id: "audio", label: "Original file bytes decode in the agreed audio format", description: "Independently read every MP3, inspect every frame and decode all samples: mono, 24 kHz, 96 kb/s, at most 3 MiB, matching its immutable hash and measured engine.", blocking: true, kind: "deterministic", status: "pending", evidence: null },
    { id: "loudness", label: "Loudness and peaks stay within the measured limits", description: "Independent ebur128 measurement: −18 to −14 LUFS, true peak at most −1 dBTP, and zero clipped decoded samples. The disclosed bounded tempo and normalization recipe is frozen before synthesis.", blocking: true, kind: "deterministic", status: "pending", evidence: null },
    { id: "duration", label: "Every recording fits its language-specific duration estimate", description: "Measured decoded duration must be within ±10% of the exact frozen script estimate. No added silence or truncated text is used to manufacture a pass.", blocking: true, kind: "deterministic", status: "pending", evidence: null },
    { id: "transcript", label: "The provider transcript covers every normalized script unit", description: narrationStandard.providerTranscript, blocking: true, kind: "deterministic", status: "pending", evidence: null },
    { id: "asr", label: "Independent recognition supports listening review", description: "Recognize each final MP3 without the expected words in a prompt. Compare normalized word/character errors against the proposed ≤10% advisory target and retain every result, including unknown calls. A low error rate does not prove pronunciation or naturalness.", blocking: false, kind: "advisory", status: "pending", evidence: null },
    { id: "listening", label: "A reviewer listens for meaning, pronunciation and naturalness", description: "Listen to every recording with its complete script, including names, uncertainty and pronunciation. Record the actual listening and language-review scope before acceptance.", blocking: true, kind: "human", status: "pending", evidence: null },
  ];
  const parameters = { standard: narrationStandard, engine, sourceArtifactId: source.id, sourceArtifactHash: source.contentHash, scripts: scripts.map(({ text: _text, ...script }) => script) };
  const definition = { id: "pack-narration-v2", version: "2.0.0", title: "Measured six-language narration", criteria, correctionAllowance: 1, parameters };
  return { ...definition, digest: digest(definition) };
}

export const narrationSegmentSchema = z.object({
  locale: z.enum(locales), key: z.string().min(1).max(160), title: z.string().min(1).max(600), text: z.string().min(20).max(6000), textHash: hash, estimateSeconds: z.number().min(1).max(150),
  audio: audioMeasurementSchema.extend({ mediaId: z.string().uuid(), url: z.string().regex(/^\/api\/media\/[0-9a-f-]{36}$/) }).strict(),
  rendering: z.object({ rawDurationSeconds: z.number().positive().max(180), tempo: z.number().min(0.85).max(1.2) }).strict(),
  speechRun: z.object({ id: z.string().uuid(), model: z.string().regex(/^gpt-realtime-2\.1(?:-[A-Za-z0-9_.-]+)?$/), voice: z.literal("marin"), receiptHash: hash, pcmHash: hash, transcript: z.string().min(1).max(16000) }).strict(),
}).strict();
export type NarrationSegment = z.infer<typeof narrationSegmentSchema>;
export const narrationArtifactSchema = z.object({
  schemaVersion: z.literal("guild.narration.v2"), contractDigest: hash, sourceArtifactId: z.string().uuid(), sourceArtifactHash: hash, standard: z.unknown(), engine: audioEngineSchema,
  inputBindings: z.array(z.object({ packageId: z.string(), contractVersion: z.number().int().positive(), artifactId: z.string().uuid(), artifactHash: hash, reviewKind: z.enum(["curator_acceptance", "automated_review"]), reviewId: z.string().uuid() }).strict()).min(1).max(6),
  segments: z.array(narrationSegmentSchema).min(6).max(186), aiGeneratedVoice: z.literal(true), humanListeningReviewed: z.literal(false), fluentHumanReviewed: z.literal(false), limitations: z.array(z.string()).max(12),
  correctionAgreement: z.object({ id: z.string().uuid(), digest: hash }).strict().optional(),
}).strict();
export type NarrationArtifact = z.infer<typeof narrationArtifactSchema>;

/** The v2 schema remains frozen. v3 explicitly represents assembly of mixed origins. */
export const narrationLineageSchema = z.object({
  locale: z.enum(locales), key: z.string().min(1).max(160), mode: z.enum(["replacement", "carried"]),
  productionJobId: z.string().uuid(), contractVersion: z.number().int().positive(), contractDigest: hash, inputBindingsDigest: hash,
  mediaId: z.string().uuid(), speechRunId: z.string().uuid(),
  originalArtifactId: z.string().uuid().nullable(), originalArtifactHash: hash.nullable(),
  correctionAgreement: z.object({ id: z.string().uuid(), digest: hash }).strict().optional(),
}).strict();
export type NarrationLineage = z.infer<typeof narrationLineageSchema>;
export const targetedNarrationArtifactSchema = narrationArtifactSchema.omit({ correctionAgreement: true }).extend({
  schemaVersion: z.literal("guild.narration.v3"),
  targetedCorrection: z.object({ agreementId: z.string().uuid(), agreementDigest: hash, registerDigest: hash, assemblyJobId: z.string().uuid(), contractVersion: z.number().int().positive() }).strict(),
  lineage: z.array(narrationLineageSchema).min(6).max(186),
}).strict();
export const completeNarrationArtifactSchema = z.discriminatedUnion("schemaVersion", [narrationArtifactSchema, targetedNarrationArtifactSchema]);
export type CompleteNarrationArtifact = z.infer<typeof completeNarrationArtifactSchema>;
