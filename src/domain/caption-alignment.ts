import { z } from "zod";
import type { Locale } from "@/contracts/guild";
import { digest } from "@/domain/primitives";

export const timestampCapability = {
  version: "guild.whisper-word-timestamps.v1",
  model: "whisper-1",
  endpoint: "https://api.openai.com/v1/audio/transcriptions",
  responseFormat: "verbose_json",
  granularities: ["word", "segment"],
  scriptPrompt: "Exact bounded source-script excerpt with frozen tokenizer/count/offsets/hashes; prompted production alignment, not independent recognition",
  unavailableFrom: "2027-02-26T00:00:00.000Z",
  replacement: "A replacement requires a separately qualified capability and new contract",
  documentation: "https://developers.openai.com/api/docs/guides/speech-to-text#timestamps",
} as const;

export interface CaptionLimits {
  minimumCueSeconds: number; maximumCueSeconds: number;
  maximumLines: number; maximumGraphemesPerLine: number; maximumGraphemesPerSecond: number;
  lineBreaks: "spaces" | "graphemes";
}
export const captionLimitsSchema = z.object({
  minimumCueSeconds: z.number().finite().positive().max(10), maximumCueSeconds: z.number().finite().positive().max(10),
  maximumLines: z.number().int().min(1).max(3), maximumGraphemesPerLine: z.number().int().min(1).max(80),
  maximumGraphemesPerSecond: z.number().finite().positive().max(40), lineBreaks: z.enum(["spaces", "graphemes"]),
}).strict().refine(value => value.minimumCueSeconds <= value.maximumCueSeconds);
const common = { minimumCueSeconds: 1, maximumCueSeconds: 7, maximumLines: 2 };
export const captionLanguageLimits: Record<Locale, CaptionLimits> = {
  en: { ...common, maximumGraphemesPerLine: 42, maximumGraphemesPerSecond: 20, lineBreaks: "spaces" },
  pt: { ...common, maximumGraphemesPerLine: 42, maximumGraphemesPerSecond: 20, lineBreaks: "spaces" },
  es: { ...common, maximumGraphemesPerLine: 42, maximumGraphemesPerSecond: 20, lineBreaks: "spaces" },
  fr: { ...common, maximumGraphemesPerLine: 42, maximumGraphemesPerSecond: 20, lineBreaks: "spaces" },
  ja: { ...common, maximumGraphemesPerLine: 20, maximumGraphemesPerSecond: 10, lineBreaks: "graphemes" },
  ar: { ...common, maximumGraphemesPerLine: 42, maximumGraphemesPerSecond: 20, lineBreaks: "spaces" },
};
export const captionTimingStandard = {
  version: "northlight.exact-word-alignment.v1",
  normalization: "NFC and locale lowercase; collapse whitespace, ignore only nonlexical punctuation, preserve internal lexical punctuation, word separation, diacritics and numeral scripts. Japanese 。、！？：；「」『』（）【】〈〉《》 are display punctuation, not lexical units; the original characters remain in every rendered cue",
  ambiguousNormalization: "Fail; never split a grapheme across word boundaries",
  wordOrder: "Original response order, positive durations, no overlaps or backwards timestamps",
  timestampPrecision: "Supplied timestamps must be exactly expressible in milliseconds",
  cueBoundaries: "Exact first-word start and last-word end; no interpolation, extension, truncation or padding",
  durationToleranceSeconds: 0.1,
  wordEndToleranceSeconds: 0.05,
  displayWhitespace: "Collapse whitespace and wrap lines; preserve every original non-whitespace character",
  readingSpeed: "Visible Unicode grapheme clusters including spaces, divided by the supplied cue duration",
  humanReview: "Alignment and readability checks do not establish meaning, reading experience, fluent review or acceptance",
} as const;

const timestamp = z.number().finite().nonnegative().max(180);
export const timestampResponseSchema = z.object({
  text: z.string().min(1).max(16000), language: z.string().min(2).max(40), duration: z.number().finite().positive().max(180),
  words: z.array(z.object({ word: z.string().min(1).max(800), start: timestamp, end: timestamp }).strict()).min(1).max(1500),
  segments: z.array(z.object({ start: timestamp, end: timestamp, text: z.string().max(16000) }).passthrough()).min(1).max(1500),
}).passthrough();
export type TimestampResponse = z.infer<typeof timestampResponseSchema>;
export interface CaptionWord { word: string; start: number; end: number; sourceStart: number; sourceEnd: number }
export interface CaptionCue { index: number; start: number; end: number; sourceStart: number; sourceEnd: number; text: string; lines: string[] }
export type CaptionAlignment = { status: "aligned"; words: CaptionWord[]; cues: CaptionCue[]; timingsHash: string; cuesHash: string; normalizedSourceHash: string; diagnostics: string[] }
  | { status: "failed"; codes: string[]; diagnostics: string[] };

const languages: Record<Locale, string[]> = { en: ["en", "english"], pt: ["pt", "portuguese"], es: ["es", "spanish"], fr: ["fr", "french"], ja: ["ja", "japanese"], ar: ["ar", "arabic"] };
const segmenters = new Map<Locale, Intl.Segmenter>();
function segmenter(locale: Locale) { if (!segmenters.has(locale)) segmenters.set(locale, new Intl.Segmenter(locale, { granularity: "grapheme" })); return segmenters.get(locale)!; }
const graphemes = (text: string, locale: Locale) => [...segmenter(locale).segment(text)].map(item => item.segment);
function normalize(text: string, locale: Locale) {
  const units: string[] = [], spans: { start: number; end: number }[] = [];
  const parts = [...segmenter(locale).segment(text)], lexical = (value: string | undefined) => !!value && /[\p{L}\p{N}\p{M}]/u.test(value);
  for (const [index, item] of parts.entries()) {
    const nfc = item.segment.normalize("NFC"), folded = nfc.toLocaleLowerCase(locale);
    if (Array.from(folded).length !== Array.from(nfc).length) return null;
    const japaneseDisplayPunctuation = locale === "ja" && /^[。、！？：；「」『』（）【】〈〉《》]+$/u.test(folded);
    const internalPunctuation = !japaneseDisplayPunctuation && /^[\p{P}]+$/u.test(folded) && lexical(parts[index - 1]?.segment) && lexical(parts[index + 1]?.segment);
    for (const unit of Array.from(folded)) {
      if (/[\p{L}\p{N}\p{M}]/u.test(unit) || internalPunctuation) { units.push(unit); spans.push({ start: item.index, end: item.index + item.segment.length }); }
      else if (/[\p{Z}\s]/u.test(unit)) {
        if (units.length && units.at(-1) !== " ") { units.push(" "); spans.push({ start: item.index, end: item.index + item.segment.length }); }
      } else if (!/\p{P}/u.test(unit)) return null;
    }
  }
  if (units.at(-1) === " ") { units.pop(); spans.pop(); }
  return { units, spans, text: units.join("") };
}

function wrap(text: string, locale: Locale, limits: CaptionLimits): string[] | null {
  const compact = text.replace(/\s+/gu, " ").trim();
  const units = limits.lineBreaks === "graphemes" ? graphemes(compact, locale) : compact.split(" ");
  const lines: string[] = []; let line = "";
  for (const unit of units) {
    const separator = limits.lineBreaks === "spaces" && line ? " " : "", candidate = line + separator + unit;
    if (graphemes(candidate, locale).length <= limits.maximumGraphemesPerLine) line = candidate;
    else {
      if (!line || graphemes(unit, locale).length > limits.maximumGraphemesPerLine) return null;
      lines.push(line.trim()); line = unit;
      if (lines.length >= limits.maximumLines) return null;
    }
  }
  if (line) lines.push(line.trim());
  return lines.length && lines.length <= limits.maximumLines ? lines : null;
}

/** Every candidate uses actual word boundaries. No duration is synthesized. */
function partition(words: CaptionWord[], source: string, locale: Locale, limits: CaptionLimits): CaptionCue[] | null {
  const best: ({ count: number; next: number; cue: Omit<CaptionCue, "index"> } | null)[] = Array(words.length + 1).fill(null);
  best[words.length] = { count: 0, next: words.length, cue: {} as Omit<CaptionCue, "index"> };
  for (let first = words.length - 1; first >= 0; first--) {
    for (let last = first; last < words.length; last++) {
      const start = words[first]!.start, end = words[last]!.end, duration = end - start;
      if (duration > limits.maximumCueSeconds) break;
      if (duration < limits.minimumCueSeconds || !best[last + 1]) continue;
      const sourceStart = words[first]!.sourceStart, sourceEnd = words[last]!.sourceEnd, text = source.slice(sourceStart, sourceEnd).replace(/\s+/gu, " ").trim();
      if (graphemes(text, locale).length > limits.maximumLines * limits.maximumGraphemesPerLine + (limits.lineBreaks === "spaces" ? limits.maximumLines - 1 : 0)) break;
      const lines = wrap(text, locale, limits);
      if (!lines || graphemes(text, locale).length / duration > limits.maximumGraphemesPerSecond) continue;
      const count = best[last + 1]!.count + 1;
      if (!best[first] || count < best[first]!.count) best[first] = { count, next: last + 1, cue: { start, end, sourceStart, sourceEnd, text, lines } };
    }
  }
  if (!best[0]) return null;
  const cues: CaptionCue[] = [];
  for (let index = 0; index < words.length;) { const entry = best[index]!; cues.push({ index: cues.length + 1, ...entry.cue }); index = entry.next; }
  return cues;
}

export function alignCaptionTrack(input: { locale: Locale; sourceText: string; audioDurationSeconds: number; response: unknown; limits?: CaptionLimits }): CaptionAlignment {
  const failed = (code: string, message: string): CaptionAlignment => ({ status: "failed", codes: [code], diagnostics: [message] });
  const response = timestampResponseSchema.safeParse(input.response), limits = input.limits ?? captionLanguageLimits[input.locale];
  if (!Object.hasOwn(languages, input.locale) || !captionLimitsSchema.safeParse(limits).success) return failed("ALIGNMENT_LIMITS", "The frozen language or cue limits are unsupported.");
  if (!response.success) return failed("TIMESTAMP_SCHEMA", "The original response did not contain the frozen word and segment timestamp shape.");
  const raw = response.data;
  if (!input.sourceText.trim() || input.sourceText.length > 6000) return failed("SOURCE_SIZE", "The frozen script is outside the agreed alignment bounds.");
  if (!Number.isFinite(input.audioDurationSeconds) || input.audioDurationSeconds <= 0 || input.audioDurationSeconds > 180) return failed("AUDIO_DURATION", "The measured original recording duration is unavailable.");
  if (!languages[input.locale].includes(raw.language.toLowerCase())) return failed("ALIGNMENT_LANGUAGE", "The alignment language does not match the frozen recording locale.");
  if (Math.abs(raw.duration - input.audioDurationSeconds) > captionTimingStandard.durationToleranceSeconds) return failed("ALIGNMENT_DURATION", "The reported duration differs from the independently measured original audio.");
  const expected = normalize(input.sourceText, input.locale), transcript = normalize(raw.text, input.locale);
  if (!expected?.text || !transcript?.text) return failed("NORMALIZATION_AMBIGUOUS", "The source or response cannot be compared by the frozen conservative normalization.");
  if (expected.text !== transcript.text) return failed("TRANSCRIPT_MISMATCH", "The prompted response does not cover the exact frozen script; no caption timing was inferred.");
  let cursor = 0, previousEnd = 0;
  const words: CaptionWord[] = [], unitSpans: { start: number; end: number }[] = [];
  for (const word of raw.words) {
    if ([word.start, word.end].some(value => Math.abs(value * 1000 - Math.round(value * 1000)) > 1e-7)) return failed("TIMESTAMP_PRECISION", "A supplied word boundary cannot be represented in WebVTT without changing its timing.");
    if (word.end <= word.start || word.start < previousEnd || word.end > input.audioDurationSeconds + captionTimingStandard.wordEndToleranceSeconds) return failed("WORD_TIMING", "Word timestamps are nonpositive, overlapping, backwards or outside the measured recording.");
    const units = normalize(word.word, input.locale);
    if (!units?.text) return failed("WORD_NORMALIZATION", "A timed word has unsupported or empty normalized content.");
    if (expected.units[cursor] === " ") cursor++;
    const end = cursor + units.units.length;
    if (expected.units.slice(cursor, end).join("") !== units.text) return failed("WORD_COVERAGE", "Supplied timed words differ from the exact source order.");
    if (input.locale !== "ja" && (cursor > 0 && expected.units[cursor - 1] !== " " || end < expected.units.length && expected.units[end] !== " ")) return failed("WORD_BOUNDARY_AMBIGUOUS", "A timed word divides the frozen source's lexical word boundary.");
    if (cursor && expected.spans[cursor - 1]!.end > expected.spans[cursor]!.start || end < expected.units.length && expected.spans[end - 1]!.end > expected.spans[end]!.start) return failed("NORMALIZATION_BOUNDARY", "A proposed word boundary would divide one original grapheme. The timing remains unqualified.");
    words.push({ word: word.word, start: word.start, end: word.end, sourceStart: expected.spans[cursor]!.start, sourceEnd: expected.spans[end - 1]!.end });
    unitSpans.push({ start: cursor, end });
    cursor = end; previousEnd = word.end;
  }
  if (cursor !== expected.units.length) return failed("WORD_COVERAGE", "Some original script units have no supplied word timestamp.");
  previousEnd = 0; let segmentCursor = 0;
  for (const segment of raw.segments) {
    if ([segment.start, segment.end].some(value => Math.abs(value * 1000 - Math.round(value * 1000)) > 1e-7)) return failed("TIMESTAMP_PRECISION", "A supplied segment boundary has unsupported timestamp precision.");
    if (segment.end <= segment.start || segment.start < previousEnd || segment.end > input.audioDurationSeconds + captionTimingStandard.wordEndToleranceSeconds) return failed("SEGMENT_TIMING", "Segment timestamps are nonpositive, overlapping, backwards or outside the original recording.");
    previousEnd = segment.end;
    if (expected.units[segmentCursor] === " ") segmentCursor++;
    const units = normalize(segment.text, input.locale), segmentEnd = segmentCursor + (units?.units.length ?? 0);
    if (!units?.text || expected.units.slice(segmentCursor, segmentEnd).join("") !== units.text) return failed("SEGMENT_COVERAGE", "Timestamped segments differ from the exact source order.");
    for (const [index, span] of unitSpans.entries()) {
      if (span.end <= segmentCursor || span.start >= segmentEnd) continue;
      const word = words[index]!;
      if (span.start < segmentCursor || span.end > segmentEnd || word.start < segment.start || word.end > segment.end) return failed("TIMESTAMP_AMBIGUITY", "Word and segment boundaries disagree. No timing was interpolated to reconcile them.");
    }
    segmentCursor = segmentEnd;
  }
  if (segmentCursor !== expected.units.length) return failed("SEGMENT_COVERAGE", "Timestamped segment text does not cover the complete frozen source.");
  // Punctuation belongs to the original display spans; its own timing is not invented.
  for (let index = 0; index < words.length; index++) words[index]!.sourceEnd = words[index + 1]?.sourceStart ?? input.sourceText.length;
  words[0]!.sourceStart = 0;
  const cues = partition(words, input.sourceText, input.locale, limits);
  if (!cues) return failed("CUE_LIMITS", "No partition of actual word boundaries satisfies the frozen language limits. No timing was extended or interpolated.");
  return { status: "aligned", words, cues, timingsHash: digest(words), cuesHash: digest(cues), normalizedSourceHash: digest(expected.text), diagnostics: ["Prompted production alignment only. This does not replace the independent blind recognition report or human review."] };
}

const vttTimestamp = (seconds: number) => {
  const milliseconds = Math.round(seconds * 1000), hours = Math.floor(milliseconds / 3_600_000), minutes = Math.floor(milliseconds / 60_000) % 60, wholeSeconds = Math.floor(milliseconds / 1000) % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}.${String(milliseconds % 1000).padStart(3, "0")}`;
};
const escapeVtt = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export function renderCaptionVtt(cues: CaptionCue[]): string {
  return `WEBVTT\n\n${cues.map(cue => `${cue.index}\n${vttTimestamp(cue.start)} --> ${vttTimestamp(cue.end)}\n${cue.lines.map(escapeVtt).join("\n")}\n`).join("\n")}`;
}
