import type { Locale } from "@/contracts/guild";
import { digest } from "@/domain/primitives";
import { captionLanguageLimits, captionLimitsSchema, renderCaptionVtt, type CaptionLimits, type CaptionCue } from "./caption-alignment";
import { deepgramResponseSchema, inspectDeepgramTimings, type DeepgramTimingInspection } from "./deepgram-caption-alignment";

export const deepgramSourcePolicy = Object.freeze({
  version: "guild.deepgram-exact-source-map.v1",
  normalization: "NFC, locale lowercase, whitespace collapse; equivalent straight/curly apostrophes; internal letter-to-letter hyphen, Unicode hyphen and nonbreaking hyphen become word separators; preserve letters, marks, numbers and all other internal lexical punctuation",
  display: "Every original non-whitespace character is retained in source-bound cues; normalization never rewrites display text",
  ambiguity: "Reject case expansions, unsupported symbols, divided graphemes, missing words, changed spelling, transliteration, diacritic removal, numeral conversion and ambiguous boundaries",
  timing: "Cue boundaries use the first and last measured word rounded by the separately frozen timing policy; no synthetic segment observations",
  qualification: "development-only; requires a new contract and held-out qualification before production admission",
} as const);

interface UnitMap { units: string[]; spans: Array<{ start: number; end: number }> }
const parts = (text: string, locale: Locale) => [...new Intl.Segmenter(locale, { granularity: "grapheme" }).segment(text)];
const count = (text: string, locale: Locale) => parts(text, locale).length;
function normalize(text: string, locale: Locale): UnitMap | null {
  const graphemes = parts(text, locale), units: string[] = [], spans: UnitMap["spans"] = [];
  const lexical = (text: string | undefined) => !!text && /[\p{L}\p{N}\p{M}]/u.test(text);
  const letter = (text: string | undefined) => !!text && /\p{L}/u.test(text);
  const add = (unit: string, start: number, end: number) => { if (unit === " " && (!units.length || units.at(-1) === " ")) return; units.push(unit); spans.push({ start, end }); };
  for (const [index, item] of graphemes.entries()) {
    const nfc = item.segment.normalize("NFC"), folded = nfc.toLocaleLowerCase(locale);
    if (Array.from(nfc).length !== Array.from(folded).length) return null;
    const previous = graphemes[index - 1]?.segment, next = graphemes[index + 1]?.segment;
    const displayJapanese = locale === "ja" && /^[。、！？：；「」『』（）【】〈〉《》]+$/u.test(folded);
    const internal = !displayJapanese && /^\p{P}+$/u.test(folded) && lexical(previous) && lexical(next);
    for (const unit of Array.from(folded)) {
      if (/[\p{L}\p{N}\p{M}]/u.test(unit)) add(unit, item.index, item.index + item.segment.length);
      else if (internal) add(/[\-‐‑]/u.test(unit) && letter(previous) && letter(next) ? " " : /['’‘]/u.test(unit) ? "'" : unit, item.index, item.index + item.segment.length);
      else if (/[\-‐‑%‰‱&#@]/u.test(unit)) return null;
      else if (/[\s\p{Z}]/u.test(unit)) add(" ", item.index, item.index + item.segment.length);
      else if (!/\p{P}/u.test(unit)) return null;
    }
  }
  if (units.at(-1) === " ") { units.pop(); spans.pop(); }
  return { units, spans };
}

interface MappedWord { start: number; end: number; sourceStart: number; sourceEnd: number }
function wrap(text: string, locale: Locale, limits: CaptionLimits): string[] | null {
  const units = limits.lineBreaks === "graphemes" ? parts(text, locale).map(x => x.segment) : text.split(" ");
  const lines: string[] = []; let line = "";
  for (const unit of units) {
    const candidate = line + (line && limits.lineBreaks === "spaces" ? " " : "") + unit;
    if (count(candidate, locale) <= limits.maximumGraphemesPerLine) line = candidate;
    else {
      if (!line || count(unit, locale) > limits.maximumGraphemesPerLine) return null;
      lines.push(line.trim()); line = unit;
      if (lines.length >= limits.maximumLines) return null;
    }
  }
  if (line) lines.push(line.trim());
  return lines.length && lines.length <= limits.maximumLines ? lines : null;
}
function partition(words: MappedWord[], source: string, locale: Locale, limits: CaptionLimits): CaptionCue[] | null {
  const best: Array<{ count: number; next: number; cue: Omit<CaptionCue, "index"> } | null> = Array(words.length + 1).fill(null);
  best[words.length] = { count: 0, next: words.length, cue: {} as Omit<CaptionCue, "index"> };
  for (let first = words.length - 1; first >= 0; first--) {
    for (let last = first; last < words.length; last++) {
      const start = words[first]!.start, end = words[last]!.end, duration = end - start;
      if (duration > limits.maximumCueSeconds) break;
      if (duration < limits.minimumCueSeconds || !best[last + 1]) continue;
      const sourceStart = words[first]!.sourceStart, sourceEnd = words[last]!.sourceEnd;
      const text = source.slice(sourceStart, sourceEnd).replace(/\s+/gu, " ").trim(), lines = wrap(text, locale, limits);
      if (!lines || count(text, locale) / duration > limits.maximumGraphemesPerSecond) continue;
      const candidateCount = 1 + best[last + 1]!.count;
      if (!best[first] || candidateCount < best[first]!.count) best[first] = { count: candidateCount, next: last + 1, cue: { start, end, sourceStart, sourceEnd, text, lines } };
    }
  }
  if (!best[0]) return null;
  const cues: CaptionCue[] = [];
  for (let index = 0; index < words.length;) { const next = best[index]!; cues.push({ index: cues.length + 1, ...next.cue }); index = next.next; }
  return cues;
}

export type DeepgramCaptionCandidate = {
  status: "ready-for-review" | "withheld"; codes: string[]; sourceHash: string; responseHash: string | null;
  sourcePolicyHash: string; limitsHash: string; timing: DeepgramTimingInspection; cues: CaptionCue[]; vtt: string | null;
  productionAccepted: false; humanReviewed: false;
};

/** Exact mapping only. An ASR disagreement remains unresolved, regardless of confidence. */
export function buildDeepgramCaptionCandidate(input: { sourceText: string; locale: Locale; audioDurationSeconds: number; response: unknown; limits?: CaptionLimits }): DeepgramCaptionCandidate {
  const limits = input.limits ?? captionLanguageLimits[input.locale], timing = inspectDeepgramTimings(input);
  const result: DeepgramCaptionCandidate = { status: "withheld", codes: [], sourceHash: digest(input.sourceText), responseHash: timing.responseDigest,
    sourcePolicyHash: digest(deepgramSourcePolicy), limitsHash: digest(limits), timing, cues: [], vtt: null, productionAccepted: false, humanReviewed: false };
  const fail = (code: string) => { result.codes.push(code); return result; };
  if (!captionLimitsSchema.safeParse(limits).success || !input.sourceText.trim() || input.sourceText.length > 6000) return fail("SOURCE_OR_LIMITS");
  if (timing.status !== "measured") return fail("WORD_TIMING_UNQUALIFIED");
  const response = deepgramResponseSchema.parse(input.response), alternative = response.results.channels[0]!.alternatives[0]!;
  const expected = normalize(input.sourceText, input.locale), recognized = normalize(alternative.transcript, input.locale);
  if (!expected?.units.length || !recognized?.units.length) return fail("NORMALIZATION_AMBIGUOUS");
  if (expected.units.join("") !== recognized.units.join("")) return fail("TRANSCRIPT_MISMATCH");
  const words: MappedWord[] = []; let cursor = 0;
  for (const word of timing.words) {
    if (expected.units[cursor] === " ") cursor++;
    const units = normalize(word.word, input.locale), end = cursor + (units?.units.length ?? 0);
    if (!units?.units.length || expected.units.slice(cursor, end).join("") !== units.units.join("")) return fail("WORD_COVERAGE");
    if (input.locale !== "ja" && (cursor > 0 && expected.units[cursor - 1] !== " " || end < expected.units.length && expected.units[end] !== " ")) return fail("WORD_BOUNDARY_AMBIGUOUS");
    if (cursor > 0 && expected.spans[cursor - 1]!.end > expected.spans[cursor]!.start || end < expected.units.length && expected.spans[end - 1]!.end > expected.spans[end]!.start) return fail("GRAPHEME_BOUNDARY_AMBIGUOUS");
    words.push({ start: word.startMs / 1000, end: word.endMs / 1000, sourceStart: expected.spans[cursor]!.start, sourceEnd: expected.spans[end - 1]!.end }); cursor = end;
  }
  if (cursor !== expected.units.length) return fail("WORD_COVERAGE");
  for (const [index, word] of words.entries()) word.sourceEnd = words[index + 1]?.sourceStart ?? input.sourceText.length;
  words[0]!.sourceStart = 0;
  const cues = partition(words, input.sourceText, input.locale, limits);
  if (!cues) return fail("CUE_LIMITS");
  if (cues.map(cue => cue.text.replace(/\s/gu, "")).join("") !== input.sourceText.replace(/\s/gu, "")) return fail("DISPLAY_COVERAGE");
  result.status = "ready-for-review"; result.cues = cues; result.vtt = renderCaptionVtt(cues); return result;
}
