import test from "node:test";
import assert from "node:assert/strict";
import type { Locale } from "@/contracts/guild";
import { alignCaptionTrack, captionLanguageLimits, renderCaptionVtt } from "@/domain/caption-alignment";

function fixture(locale: Locale = "en") {
  const words: Record<Locale, string[]> = {
    en: ["The", "harbour", "holds", "many", "stories."],
    pt: ["O", "porto", "guarda", "muitas", "histórias."],
    es: ["El", "puerto", "guarda", "muchas", "historias."],
    fr: ["Le", "port", "conserve", "de", "nombreuses", "histoires."],
    ja: ["港に", "多くの", "物語が", "あります。"],
    ar: ["يحفظ", "الميناء", "قصصًا", "كثيرة."],
  };
  const text = words[locale].join(locale === "ja" ? "" : " "), duration = words[locale].length + 0.2;
  return { locale, sourceText: text, audioDurationSeconds: duration, response: { text, language: locale, duration,
    words: words[locale].map((word, index) => ({ word, start: index, end: index + 0.9 })), segments: [{ start: 0, end: words[locale].length, text }] } };
}
function failure(input: ReturnType<typeof fixture>, expected: string) {
  const result = alignCaptionTrack(input); assert.equal(result.status, "failed");
  if (result.status === "failed") assert.deepEqual(result.codes, [expected]);
}

test("all six locales use only actual word boundaries and preserve original inputs", () => {
  for (const locale of ["en", "pt", "es", "fr", "ja", "ar"] as const) {
    const input = fixture(locale), original = structuredClone(input), result = alignCaptionTrack(input);
    assert.equal(result.status, "aligned", locale); assert.deepEqual(input, original);
    if (result.status !== "aligned") continue;
    for (const cue of result.cues) {
      assert.ok(input.response.words.some(word => word.start === cue.start));
      assert.ok(input.response.words.some(word => word.end === cue.end));
      assert.ok(cue.lines.length <= 2);
    }
    assert.equal(result.cues.map(cue => cue.text).join(locale === "ja" ? "" : " "), input.sourceText);
    assert.match(renderCaptionVtt(result.cues), /^WEBVTT\n\n1\n/);
    assert.match(result.diagnostics[0]!, /Prompted production alignment only/);
  }
});

test("mismatching text, missing words and lost Arabic marks fail without inferred cues", () => {
  const altered = fixture(); altered.response.words[1]!.word = "museum"; failure(altered, "WORD_COVERAGE");
  const missing = fixture(); missing.response.words.pop(); failure(missing, "WORD_COVERAGE");
  const transcript = fixture(); transcript.response.text += " More words."; failure(transcript, "TRANSCRIPT_MISMATCH");
  const arabic = fixture("ar"); arabic.response.text = arabic.response.text.replace("ً", ""); failure(arabic, "TRANSCRIPT_MISMATCH");
  const language = fixture(); language.response.language = "ja"; failure(language, "ALIGNMENT_LANGUAGE");
});

test("ambiguous and unrepresentable timestamps are retained as failures", () => {
  const overlap = fixture(); overlap.response.words[1]!.start = 0.5; failure(overlap, "WORD_TIMING");
  const zero = fixture(); zero.response.words[0]!.end = 0; failure(zero, "WORD_TIMING");
  const fractional = fixture(); fractional.response.words[1]!.start = 1.0001; failure(fractional, "TIMESTAMP_PRECISION");
  const duration = fixture(); duration.response.duration += 1; failure(duration, "ALIGNMENT_DURATION");
  const segment = fixture(); segment.response.segments[0]!.end = 1; failure(segment, "TIMESTAMP_AMBIGUITY");
});

test("impossible display limits never stretch or subdivide supplied timing", () => {
  const input = fixture(), result = alignCaptionTrack({ ...input, limits: { ...captionLanguageLimits.en, maximumGraphemesPerLine: 2 } });
  assert.equal(result.status, "failed"); if (result.status === "failed") assert.deepEqual(result.codes, ["CUE_LIMITS"]);
});

test("lexical punctuation, word separation and numeric distinctions cannot disappear in normalization", () => {
  const changed = fixture(); changed.sourceText = "The harbour can't hold 1.2 stories."; changed.response.text = "The harbour cant hold 12 stories.";
  failure(changed, "TRANSCRIPT_MISMATCH");
  const separation = fixture(); separation.sourceText = "A therapist has stories."; separation.response.text = "A the rapist has stories.";
  failure(separation, "TRANSCRIPT_MISMATCH");
  const split = fixture(); split.sourceText = split.response.text = "The harbour holds many stories.";
  split.response.words.splice(1, 1, { word: "har", start: 1, end: 1.4 }, { word: "bour", start: 1.4, end: 1.9 });
  failure(split, "WORD_BOUNDARY_AMBIGUOUS");
});

test("multiple real segments preserve complete source coverage and reject a segment boundary inside a word", () => {
  const input = fixture(); input.response.segments = [{ start: 0, end: 2, text: "The harbour" }, { start: 2, end: 5, text: "holds many stories." }];
  assert.equal(alignCaptionTrack(input).status, "aligned");
  input.response.segments = [{ start: 0, end: 1.4, text: "The har" }, { start: 1.4, end: 5, text: "bour holds many stories." }];
  failure(input, "TIMESTAMP_AMBIGUITY");
  const japanese = fixture("ja"); japanese.response.segments = [{ start: 0, end: 2, text: "港に多くの" }, { start: 2, end: 4, text: "物語があります。" }];
  assert.equal(alignCaptionTrack(japanese).status, "aligned");
});

test("Japanese sentence punctuation remains in displayed source while separate timed lexical words align", () => {
  const text = "港です。写真を、見てください。", words = ["港", "です。", "写真", "を、", "見て", "ください。"];
  const result = alignCaptionTrack({ locale: "ja", sourceText: text, audioDurationSeconds: 6.2, response: { language: "ja", duration: 6.2, text,
    words: words.map((word, index) => ({ word, start: index, end: index + 0.9 })), segments: [{ start: 0, end: 6, text }] } });
  assert.equal(result.status, "aligned");
  if (result.status === "aligned") assert.equal(result.cues.map(item => item.text).join(""), text);
  const lexical = alignCaptionTrack({ locale: "ja", sourceText: "ニュー・ヨークです。", audioDurationSeconds: 6.2, response: { language: "ja", duration: 6.2, text: "ニューヨークです。", words: [{ word: "ニューヨークです。", start: 0, end: 6 }], segments: [{ start: 0, end: 6, text: "ニューヨークです。" }] } });
  assert.equal(lexical.status, "failed");
});

test("nonlexical punctuation stays in the exact display while a punctuation-only timed word remains failed", () => {
  const text = "Detroit & Cleveland have a shared record.", words = ["Detroit", "Cleveland", "have", "a", "shared", "record."];
  const input = { locale: "en" as const, sourceText: text, audioDurationSeconds: 6.2, response: { language: "en", duration: 6.2, text,
    words: words.map((word, index) => ({ word, start: index, end: index + 0.9 })), segments: [{ start: 0, end: 6, text }] } };
  const aligned = alignCaptionTrack(input);
  assert.equal(aligned.status, "aligned");
  if (aligned.status === "aligned") assert.equal(aligned.cues.map(cue => cue.text).join(" "), text);
  input.response.words.splice(1, 0, { word: "&", start: 0.9, end: 1 });
  const unsupported = alignCaptionTrack(input);
  assert.equal(unsupported.status, "failed");
  if (unsupported.status === "failed") assert.deepEqual(unsupported.codes, ["WORD_NORMALIZATION"]);
});
