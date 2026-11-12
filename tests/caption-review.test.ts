import assert from "node:assert/strict";
import test from "node:test";
import { locales, type Locale } from "@/contracts/guild";
import { blankCaptionReviewUnits, evaluateCaptionReview, type CaptionReviewDraft } from "@/domain/caption-review";

const text: Record<Locale, string> = {
  en: "Recorded heading. Keep the complete source visible and check every boundary.",
  pt: "Título gravado. Mantenha a fonte completa e confira cada palavra com atenção.",
  es: "Título grabado. Mantenga la fuente completa y revise cada palabra con atención.",
  fr: "Titre enregistré. Gardez la source complète et vérifiez chaque mot avec soin.",
  ar: "عُنْوانٌ مُسَجَّلٌ. احْتَفِظْ بِالنَّصِّ كامِلًا وَراجِعْ كُلَّ كَلِمَةٍ بِعِنايَةٍ.",
  ja: "録音された見出し。完全な原文を保持し、一つ一つの言葉の境界を確認してください。",
};
/** Deliberately synthetic structural measurements; never acoustic qualification. */
function fixture(locale: Locale) {
  const source = { text: text[locale], locale, durationSeconds: 14 };
  const units = blankCaptionReviewUnits(source), weights = units.map(unit => [...new Intl.Segmenter(locale, { granularity: "grapheme" }).segment(source.text.slice(unit.sourceStart, unit.sourceEnd))].length), total = weights.reduce((a, b) => a + b, 0);
  let cursor = 0;
  const draft: CaptionReviewDraft = { disposition: "recognition_difference", note: "Synthetic structural fixture only. No audio was listened to and no human review is claimed.", units: units.map((unit, i) => { const startMs = Math.round(cursor / total * 12000); cursor += weights[i]!; return { ...unit, heard: "heard", startMs, endMs: Math.round(cursor / total * 12000), origin: "manual", providerWordIndex: null }; }) };
  return { source, draft };
}

test("blank review across all six locales supplies no timing, listening or VTT", () => {
  for (const locale of locales) {
    const { source } = fixture(locale), units = blankCaptionReviewUnits(source);
    assert.equal(units.map(unit => source.text.slice(unit.sourceStart, unit.sourceEnd)).join(""), source.text);
    assert.ok(units.every(unit => unit.startMs === null && unit.endMs === null && unit.origin === "unassigned"));
    const result = evaluateCaptionReview(source, { units, disposition: "uncertain", note: "The complete source has not been reviewed." });
    assert.equal(result.status, "incomplete"); assert.equal(result.vtt, null); assert.equal(result.humanReviewed, false);
  }
});
test("complete attributed synthetic measurements retain all Unicode source and do not invent human review", () => {
  for (const locale of locales) {
    const { source, draft } = fixture(locale), result = evaluateCaptionReview(source, draft);
    assert.equal(result.status, "ready-for-review", `${locale}: ${result.codes.join()}`);
    assert.equal(result.cues.map(cue => cue.text.replace(/\s/gu, "")).join(""), source.text.replace(/\s/gu, ""));
    assert.ok(result.cues.every(cue => cue.lines.length <= 2 && cue.end - cue.start >= 1 && cue.end - cue.start <= 7));
    assert.equal(result.humanReviewed, false); assert.equal(result.productionAccepted, false); assert.match(result.vtt!, /^WEBVTT/);
  }
});
test("unheard or uncertain source cannot receive a complete correction even with supplied times", () => {
  for (const heard of ["not_heard", "uncertain"] as const) {
    const { source, draft } = fixture("ar"); draft.units[1]!.heard = heard;
    const result = evaluateCaptionReview(source, draft);
    assert.equal(result.status, "incomplete"); assert.equal(result.vtt, null); assert.ok(result.codes.includes("UNHEARD_WORD_HAS_TIMING"));
  }
  const { source, draft } = fixture("ja"); draft.disposition = "source_audio_disagreement";
  assert.ok(evaluateCaptionReview(source, draft).codes.includes("SOURCE_AUDIO_REVIEW_OPEN"));
});
test("a heading, Arabic mark or word boundary cannot be omitted or merged to evade complete per-unit measurement", () => {
  const { source, draft } = fixture("ar");
  const omitted = structuredClone(draft); omitted.units.shift();
  assert.ok(evaluateCaptionReview(source, omitted).codes.includes("COMPLETE_SOURCE_SPANS"));
  const splitMark = structuredClone(draft); splitMark.units[0]!.sourceEnd = 1; splitMark.units[1]!.sourceStart = 1;
  assert.ok(evaluateCaptionReview(source, splitMark).codes.includes("COMPLETE_SOURCE_SPANS"));
  const combined = structuredClone(draft); combined.units[0]!.sourceEnd = combined.units[1]!.sourceEnd; combined.units[0]!.endMs = combined.units[1]!.endMs; combined.units.splice(1, 1);
  assert.ok(evaluateCaptionReview(source, combined).codes.includes("SOURCE_UNIT_PARTITION"));
});
test("manual timestamps cannot claim Deepgram provenance, overlap, stretch past audio or fill a missing boundary", () => {
  const { source, draft } = fixture("en");
  for (const mutate of [
    (d: CaptionReviewDraft) => { d.units[0]!.origin = "deepgram"; d.units[0]!.providerWordIndex = 0; },
    (d: CaptionReviewDraft) => { d.units[0]!.providerWordIndex = 0; },
    (d: CaptionReviewDraft) => { d.units[1]!.startMs = d.units[0]!.endMs! - 1; },
    (d: CaptionReviewDraft) => { d.units.at(-1)!.endMs = 14001; },
    (d: CaptionReviewDraft) => { d.units[1]!.endMs = null; },
  ]) { const changed = structuredClone(draft); mutate(changed); const result = evaluateCaptionReview(source, changed); assert.equal(result.status, "incomplete"); assert.equal(result.vtt, null); }
});
