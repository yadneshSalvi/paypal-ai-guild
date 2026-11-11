import { z } from "zod";
import type { Locale } from "@/contracts/guild";
import { digest } from "@/domain/primitives";

/** Separately versioned candidate. This does not replace the commissioned Whisper contract. */
export const deepgramTimestampCapability = Object.freeze({
  version: "guild.deepgram-word-timestamps.v1",
  endpoint: "https://api.deepgram.com/v1/listen",
  model: "nova-3",
  purpose: "Blind recognition with original word timestamps; not supplied-text forced alignment",
  sourceTextSupplied: false,
  automaticRetries: 0,
  qualification: "development-only",
  documentation: "https://developers.deepgram.com/reference/speech-to-text/listen-pre-recorded",
} as const);

export const deepgramLocaleModels = Object.freeze({
  en: Object.freeze({ uuid: "2187e11a-3532-4498-b076-81fa530bdd49", version: "2025-07-31.0" }),
  pt: Object.freeze({ uuid: "51f3cbe4-e9f6-4683-ba80-f863e35a60ed", version: "2026-09-22.22375" }),
  es: Object.freeze({ uuid: "9f79f67e-5728-46cb-abd1-54e76de17e83", version: "2026-08-03.26592" }),
  fr: Object.freeze({ uuid: "3a734c85-0f8e-4fa0-a4af-da047fce2398", version: "2026-05-31.28995" }),
  ar: Object.freeze({ uuid: "c15d8236-8fe6-4789-95f6-35f8037a2e4f", version: "2026-01-27.33458" }),
  ja: Object.freeze({ uuid: "6cee5cd0-ddc2-4f7e-a63c-37524f6e79e8", version: "2026-08-03.6336" }),
} satisfies Record<Locale, { uuid: string; version: string }>);

export const deepgramQueryPolicy = Object.freeze({
  punctuate: "true", smart_format: "false", numerals: "false", utterances: "false",
  mip_opt_out: "true", redact_usage: "true",
} as const);

const seconds = z.number().finite().nonnegative().max(180);
export const deepgramResponseSchema = z.object({
  metadata: z.object({
    request_id: z.string().uuid(), duration: z.number().finite().positive().max(180),
    channels: z.literal(1), models: z.array(z.string().uuid()).length(1),
    model_info: z.record(z.string().uuid(), z.object({ name: z.string().min(1).max(100), version: z.string().min(1).max(100), arch: z.literal("nova-3") }).passthrough()),
  }).passthrough(),
  results: z.object({ channels: z.array(z.object({ alternatives: z.array(z.object({
    transcript: z.string().max(16000), confidence: z.number().finite().min(0).max(1),
    words: z.array(z.object({ word: z.string().min(1).max(800), start: seconds, end: seconds,
      confidence: z.number().finite().min(0).max(1), punctuated_word: z.string().max(800).optional(),
    }).passthrough()).max(1500),
  }).passthrough()).length(1) }).passthrough()).length(1) }).passthrough(),
}).passthrough();
export type DeepgramResponse = z.infer<typeof deepgramResponseSchema>;

export function deepgramModelMatches(response: DeepgramResponse, locale: Locale): boolean {
  const model = deepgramLocaleModels[locale];
  return !!model && response.metadata.models.length === 1 && response.metadata.models[0] === model.uuid
    && Object.keys(response.metadata.model_info).length === 1
    && response.metadata.model_info[model.uuid]?.version === model.version
    && response.metadata.model_info[model.uuid]?.arch === "nova-3";
}

export const deepgramTimingPolicy = Object.freeze({
  version: "guild.deepgram-timing-inspection.v1",
  rawOrder: "Require positive, ordered, nonoverlapping intervals within independently measured audio before quantization",
  quantization: "Nearest millisecond with at most 0.5ms displacement; retain raw boundaries and recheck positivity, order and bounds",
  repair: "No clipping, stretching, interpolation, dropped words or substituted recording",
  durationToleranceSeconds: 0.1,
  humanGroundTruth: false,
} as const);

export interface DeepgramTimingIssue { code: string; wordIndex?: number }
export interface DeepgramMeasuredWord { word: string; rawStart: number; rawEnd: number; startMs: number; endMs: number; confidence: number }
export interface DeepgramTimingInspection {
  policyDigest: string; responseDigest: string | null; locale: Locale; audioDurationSeconds: number;
  status: "measured" | "withheld"; issues: DeepgramTimingIssue[]; words: DeepgramMeasuredWord[];
  maximumDisplacementSeconds: number; sourceCoverage: "not-established"; productionAccepted: false;
}

/** Keeps usable measurements separate from transcript coverage and acceptance. */
export function inspectDeepgramTimings(input: { response: unknown; locale: Locale; audioDurationSeconds: number }): DeepgramTimingInspection {
  const issues: DeepgramTimingIssue[] = [], words: DeepgramMeasuredWord[] = [];
  let responseDigest: string | null = null;
  try { responseDigest = digest(input.response); } catch { /* Non-JSON inputs cannot become retained provider evidence. */ }
  const result: DeepgramTimingInspection = { policyDigest: digest(deepgramTimingPolicy), responseDigest,
    locale: input.locale, audioDurationSeconds: input.audioDurationSeconds, status: "withheld", issues, words,
    maximumDisplacementSeconds: 0, sourceCoverage: "not-established", productionAccepted: false };
  const parsed = deepgramResponseSchema.safeParse(input.response);
  if (!parsed.success) { issues.push({ code: "DEEPGRAM_SCHEMA" }); return result; }
  if (!deepgramModelMatches(parsed.data, input.locale)) issues.push({ code: "DEEPGRAM_MODEL_BINDING" });
  if (!Number.isFinite(input.audioDurationSeconds) || input.audioDurationSeconds <= 0 || input.audioDurationSeconds > 180) {
    issues.push({ code: "AUDIO_DURATION" }); return result;
  }
  if (Math.abs(parsed.data.metadata.duration - input.audioDurationSeconds) > deepgramTimingPolicy.durationToleranceSeconds) issues.push({ code: "DEEPGRAM_DURATION" });
  const alternative = parsed.data.results.channels[0]!.alternatives[0]!;
  if (!alternative.transcript.trim() || !alternative.words.length) issues.push({ code: "DEEPGRAM_NO_SPEECH" });
  let previousEnd = 0, previousEndMs = 0;
  for (const [wordIndex, word] of alternative.words.entries()) {
    if (word.end <= word.start) issues.push({ code: "WORD_NONPOSITIVE", wordIndex });
    if (word.start < previousEnd) issues.push({ code: "WORD_OVERLAP", wordIndex });
    if (word.end > input.audioDurationSeconds) issues.push({ code: "WORD_AFTER_AUDIO", wordIndex });
    const startMs = Math.round(word.start * 1000), endMs = Math.round(word.end * 1000);
    result.maximumDisplacementSeconds = Math.max(result.maximumDisplacementSeconds, Math.abs(startMs / 1000 - word.start), Math.abs(endMs / 1000 - word.end));
    if (endMs <= startMs) issues.push({ code: "QUANTIZED_WORD_NONPOSITIVE", wordIndex });
    if (startMs < previousEndMs) issues.push({ code: "QUANTIZED_WORD_OVERLAP", wordIndex });
    if (endMs / 1000 > input.audioDurationSeconds) issues.push({ code: "QUANTIZED_WORD_AFTER_AUDIO", wordIndex });
    words.push({ word: word.word, rawStart: word.start, rawEnd: word.end, startMs, endMs, confidence: word.confidence });
    previousEnd = word.end; previousEndMs = endMs;
  }
  if (!issues.length) result.status = "measured";
  return result;
}
