import test from "node:test";
import assert from "node:assert/strict";
import type { Locale } from "@/contracts/guild";
import { deepgramLocaleModels, inspectDeepgramTimings } from "@/domain/deepgram-caption-alignment";
import { buildDeepgramCaptionCandidate } from "@/domain/deepgram-source-mapping";

function input(sourceText: string, transcript: string, words: string[], locale: Locale = "en") {
  const model = deepgramLocaleModels[locale], duration = words.length + .2;
  return { sourceText, locale, audioDurationSeconds: duration, response: {
    metadata: { request_id: "abf10438-242e-4b81-9930-40f3710d8166", duration, channels: 1, models: [model.uuid], model_info: { [model.uuid]: { name: "general", arch: "nova-3", version: model.version } } },
    results: { channels: [{ alternatives: [{ transcript, confidence: .95, words: words.map((word, index) => ({ word, start: index + .10000001, end: index + .9, confidence: .95 })) }] }] },
  } };
}

test("new mapping retains literal original punctuation while measuring equivalent lexical forms", () => {
  const original = input("A volunteer-run museum’s story.", "A volunteer run museum's story.", ["a", "volunteer", "run", "museum's", "story"]);
  const snapshot = structuredClone(original), result = buildDeepgramCaptionCandidate(original);
  assert.equal(result.status, "ready-for-review"); assert.equal(result.productionAccepted, false); assert.equal(result.humanReviewed, false);
  assert.equal(result.cues.map(x => x.text).join(" "), original.sourceText); assert.match(result.vtt!, /volunteer-run museum’s story/);
  assert.equal(result.cues[0]?.start, .1); assert.equal(result.cues.at(-1)?.end, 4.9); assert.deepEqual(original, snapshot);
});

test("transcript similarity, transliteration, number conversion and dropped source headings cannot pass", () => {
  for (const fixture of [
    input("The harbour.", "The harbor.", ["the", "harbor"]),
    input("Heading. The harbour.", "The harbour.", ["the", "harbour"]),
    input("Two hundred boats.", "200 boats.", ["200", "boats"]),
    input("ハーバー Harbor", "ハーバー", ["ハーバー"], "ja"),
    input("مرحبًا بك", "مرحبا بك", ["مرحبا", "بك"], "ar"),
  ]) { const result = buildDeepgramCaptionCandidate(fixture); assert.equal(result.status, "withheld"); assert.deepEqual(result.codes, ["TRANSCRIPT_MISMATCH"]); assert.equal(result.vtt, null); }
});

test("signed numbers and semantic punctuation are not silently removed", () => {
  for (const fixture of [input("-5 degrees.", "5 degrees.", ["5", "degrees"]), input("5% growth.", "5 growth.", ["5", "growth"]), input("A & B", "A B", ["a", "b"])]) {
    assert.deepEqual(buildDeepgramCaptionCandidate(fixture).codes, ["NORMALIZATION_AMBIGUOUS"]);
  }
});

test("timed words must cover the complete transcript even when transcript text exactly matches", () => {
  for (const words of [["the"], ["the", "harbor"], ["harbour", "the"], ["the", "har", "bour"]]) {
    const result = buildDeepgramCaptionCandidate(input("The harbour.", "The harbour.", words));
    assert.equal(result.status, "withheld"); assert.ok(result.codes.some(x => ["WORD_COVERAGE", "WORD_BOUNDARY_AMBIGUOUS"].includes(x))); assert.equal(result.vtt, null);
  }
});

test("an Arabic mark cannot acquire a separate invented word interval inside its grapheme", () => {
  const result = buildDeepgramCaptionCandidate(input("بِ باب", "بِ باب", ["ب", "ِ", "باب"], "ar"));
  assert.equal(result.status, "withheld"); assert.ok(result.codes.includes("WORD_BOUNDARY_AMBIGUOUS") || result.codes.includes("GRAPHEME_BOUNDARY_AMBIGUOUS"));
});

test("cue constraints can reject exact text; no padding or time stretching is used to rescue it", () => {
  const fixture = input("The harbour.", "The harbour.", ["the", "harbour"]);
  const result = buildDeepgramCaptionCandidate({ ...fixture, limits: { minimumCueSeconds: 2, maximumCueSeconds: 7, maximumLines: 2, maximumGraphemesPerLine: 42, maximumGraphemesPerSecond: 20, lineBreaks: "spaces" } });
  assert.deepEqual(result.codes, ["CUE_LIMITS"]); assert.equal(result.vtt, null);
});

test("Japanese original punctuation and graphemes remain exact in the rendered candidate", () => {
  const result = buildDeepgramCaptionCandidate(input("海を見ます。", "海を見ます。", ["海", "を", "見", "ます"], "ja"));
  assert.equal(result.status, "ready-for-review"); assert.equal(result.cues.map(x => x.text).join(""), "海を見ます。");
});

test("missing response is withheld without fabricating a digest or throwing during schema inspection", () => {
  const result = inspectDeepgramTimings({ response: undefined, locale: "en", audioDurationSeconds: 3 });
  assert.equal(result.status, "withheld"); assert.equal(result.responseDigest, null); assert.deepEqual(result.issues, [{ code: "DEEPGRAM_SCHEMA" }]);
});
