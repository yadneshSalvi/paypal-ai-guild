import { z } from "zod";
import { locales, type Locale } from "@/contracts/guild";
import { digest } from "./primitives";
import { captionLanguageLimits, renderCaptionVtt, type CaptionCue } from "./caption-alignment";
import { normalizeDeepgramSourceText, partitionDeepgramSourceWords, type DeepgramCaptionCandidate } from "./deepgram-source-mapping";
import type { CaptionTrackSource } from "./captions";

export const captionHumanTimingPolicy = Object.freeze({
  version: "northlight.attributed-caption-review.v1",
  source: "Immutable complete title and body, in logical source order; every original non-whitespace character and grapheme is retained",
  timing: "Explicit human measurements in integer milliseconds on the unchanged recording; never interpolate, pad, infer a missing word, or silently copy recognition timing to different wording",
  observations: "Provider words and raw/rounded boundaries remain a separate original observation; a manually entered boundary is attributed to its author, never to Deepgram",
  disagreement: "Recognition disagreement is not proof of an audible omission. Mark words not heard or uncertain without timings; incomplete source coverage blocks a corrected edition",
  review: "Saving a draft is not listening review. A named person must separately attest complete listening, source coverage and each timing. Fluent review and final acceptance remain separate",
  authority: "Drafting on retained evidence is permitted in an active owner workspace after production expiry. Assembly needs the unchanged current authority and a fresh exact Passport",
  qualification: "The assisted workflow is not a qualified automatic aligner. Complete attributed human listening corrections can proceed through independent verification and explicit curator acceptance without asserting automatic qualification",
} as const);

const hash = z.string().regex(/^[a-f0-9]{64}$/), uuid = z.string().uuid();
export const captionReviewUnitSchema = z.object({
  sourceStart: z.number().int().nonnegative().max(6000), sourceEnd: z.number().int().positive().max(6000),
  heard: z.enum(["heard", "not_heard", "uncertain"]), startMs: z.number().int().nonnegative().max(180000).nullable(), endMs: z.number().int().positive().max(180000).nullable(),
  origin: z.enum(["deepgram", "manual", "unassigned"]), providerWordIndex: z.number().int().nonnegative().max(1499).nullable(),
}).strict();
export type CaptionReviewUnit = z.infer<typeof captionReviewUnitSchema>;
export const captionReviewDraftSchema = z.object({
  units: z.array(captionReviewUnitSchema).min(1).max(1500),
  disposition: z.enum(["timing_review", "recognition_difference", "source_audio_disagreement", "uncertain"]),
  note: z.string().trim().min(10).max(3000),
}).strict();
export type CaptionReviewDraft = z.infer<typeof captionReviewDraftSchema>;
export const captionReviewCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save"), requestId: uuid, parentRevisionId: uuid.nullable(), locale: z.enum(locales), key: z.string().min(1).max(160), artifactHash: hash, draft: captionReviewDraftSchema }).strict(),
  z.object({ action: z.literal("attest"), requestId: uuid, parentRevisionId: uuid, locale: z.enum(locales), key: z.string().min(1).max(160), artifactHash: hash,
    reviewerName: z.string().trim().min(2).max(160), completeRecordingListened: z.literal(true), completeSourceHeard: z.literal(true), everyTimingChecked: z.literal(true), acknowledgeNotFluentReview: z.literal(true) }).strict(),
]);
export type CaptionReviewCommand = z.infer<typeof captionReviewCommandSchema>;

export interface CaptionReviewEvaluation { status: "ready-for-review" | "incomplete"; codes: string[]; cues: CaptionCue[]; vtt: string | null; coveredUnits: number; totalUnits: number; humanReviewed: false; productionAccepted: false }
export interface CaptionReviewRevision {
  schemaVersion: "guild.caption-review-revision.v1"; id: string; tenantId: string; commissionId: string; packageId: string;
  artifactId: string; artifactHash: string; locale: Locale; key: string; sourceTrackDigest: string; audioHash: string; sourceTextHash: string;
  alignmentRunId: string; originalReceiptHash: string; policyDigest: string; parentRevisionId: string | null; parentRevisionDigest: string | null;
  requestId: string; requestHash: string; actorId: string; actorRole: string; createdAt: string; draft: CaptionReviewDraft;
  attestation: { reviewerName: string; statement: string; humanDeclaredListening: true; fluentReviewed: false } | null;
  evaluation: CaptionReviewEvaluation; digest: string; signature: string;
}

/** Blank units have no invented times, including Japanese and Arabic. */
export function blankCaptionReviewUnits(source: Pick<CaptionTrackSource, "text" | "locale">): CaptionReviewUnit[] {
  const spans = source.locale === "ja"
    ? [...new Intl.Segmenter("ja", { granularity: "word" }).segment(source.text)].filter(item => item.isWordLike).map(item => ({ start: item.index, end: item.index + item.segment.length }))
    : [...source.text.matchAll(/\S+/gu)].filter(item => /[\p{L}\p{N}\p{M}]/u.test(item[0])).map(item => ({ start: item.index, end: item.index + item[0].length }));
  if (!spans.length) return [{ sourceStart: 0, sourceEnd: source.text.length, heard: "uncertain", startMs: null, endMs: null, origin: "unassigned", providerWordIndex: null }];
  return spans.map((span, i) => ({ sourceStart: i ? span.start : 0, sourceEnd: spans[i + 1]?.start ?? source.text.length,
    heard: "uncertain", startMs: null, endMs: null, origin: "unassigned", providerWordIndex: null }));
}

/** Only an already exact automatic candidate can seed provider-attributed units. */
export function automaticCaptionReviewUnits(source: Pick<CaptionTrackSource, "text" | "locale">, candidate: DeepgramCaptionCandidate): CaptionReviewUnit[] | null {
  if (candidate.status !== "ready-for-review") return null;
  const expected = normalizeDeepgramSourceText(source.text, source.locale); if (!expected) return null;
  const units: CaptionReviewUnit[] = []; let cursor = 0;
  for (const [providerWordIndex, word] of candidate.timing.words.entries()) {
    if (expected.units[cursor] === " ") cursor++;
    const normalized = normalizeDeepgramSourceText(word.word, source.locale), end = cursor + (normalized?.units.length ?? 0);
    if (!normalized?.units.length || expected.units.slice(cursor, end).join("") !== normalized.units.join("")) return null;
    units.push({ sourceStart: expected.spans[cursor]!.start, sourceEnd: expected.spans[end - 1]!.end, heard: "heard", startMs: word.startMs, endMs: word.endMs, origin: "deepgram", providerWordIndex }); cursor = end;
  }
  if (cursor !== expected.units.length || !units.length) return null;
  for (const [i, unit] of units.entries()) unit.sourceEnd = units[i + 1]?.sourceStart ?? source.text.length;
  units[0]!.sourceStart = 0; return units;
}

/** A deterministic structural check, never acoustic ground truth or listening. */
export function evaluateCaptionReview(source: Pick<CaptionTrackSource, "text" | "locale" | "durationSeconds">, draft: CaptionReviewDraft, automatic: CaptionReviewUnit[] | null = null): CaptionReviewEvaluation {
  const result: CaptionReviewEvaluation = { status: "incomplete", codes: [], cues: [], vtt: null, coveredUnits: 0, totalUnits: draft.units.length, humanReviewed: false, productionAccepted: false };
  const codes = new Set<string>();
  const boundaries = new Set([...new Intl.Segmenter(source.locale, { granularity: "grapheme" }).segment(source.text)].map(item => item.index)); boundaries.add(source.text.length);
  if (!captionReviewDraftSchema.safeParse(draft).success) codes.add("REVIEW_SCHEMA");
  if (["source_audio_disagreement", "uncertain"].includes(draft.disposition)) codes.add("SOURCE_AUDIO_REVIEW_OPEN");
  const originalUnits = automatic ?? blankCaptionReviewUnits(source);
  if (digest(draft.units.map(unit => [unit.sourceStart, unit.sourceEnd])) !== digest(originalUnits.map(unit => [unit.sourceStart, unit.sourceEnd]))) codes.add("SOURCE_UNIT_PARTITION");
  let sourceCursor = 0, previousEnd = 0;
  const words: Array<{ start: number; end: number; sourceStart: number; sourceEnd: number }> = [];
  for (const unit of draft.units) {
    if (unit.sourceStart !== sourceCursor || unit.sourceEnd <= unit.sourceStart || !boundaries.has(unit.sourceStart) || !boundaries.has(unit.sourceEnd)
      || !/[\p{L}\p{N}\p{M}]/u.test(source.text.slice(unit.sourceStart, unit.sourceEnd))) codes.add("COMPLETE_SOURCE_SPANS");
    if (unit.heard !== "heard") { codes.add(unit.heard === "not_heard" ? "SOURCE_WORD_NOT_HEARD" : "SOURCE_WORD_UNCERTAIN"); if (unit.startMs !== null || unit.endMs !== null) codes.add("UNHEARD_WORD_HAS_TIMING"); }
    if (unit.startMs === null || unit.endMs === null || unit.origin === "unassigned") codes.add("MISSING_MEASURED_BOUNDARY");
    else {
      if (unit.endMs <= unit.startMs || unit.startMs < previousEnd || unit.endMs / 1000 > source.durationSeconds) codes.add("REVIEW_TIMING");
      if (unit.origin === "deepgram" && !automatic?.some(item => digest(item) === digest(unit))) codes.add("PROVIDER_ATTRIBUTION_CHANGED");
      if (unit.origin === "manual" && unit.providerWordIndex !== null) codes.add("MANUAL_PROVIDER_ATTRIBUTION");
      if (unit.heard === "heard") result.coveredUnits++;
      words.push({ start: unit.startMs / 1000, end: unit.endMs / 1000, sourceStart: unit.sourceStart, sourceEnd: unit.sourceEnd }); previousEnd = unit.endMs;
    }
    sourceCursor = unit.sourceEnd;
  }
  if (sourceCursor !== source.text.length) codes.add("COMPLETE_SOURCE_SPANS");
  if (!codes.size) {
    const cues = partitionDeepgramSourceWords(words, source.text, source.locale, captionLanguageLimits[source.locale]);
    if (!cues) codes.add("REVIEW_CUE_LIMITS");
    else if (cues.map(cue => cue.text.replace(/\s/gu, "")).join("") !== source.text.replace(/\s/gu, "")) codes.add("REVIEW_DISPLAY_COVERAGE");
    else { result.status = "ready-for-review"; result.cues = cues; result.vtt = renderCaptionVtt(cues); }
  }
  result.codes = [...codes]; return result;
}

export function captionReviewRevisionDigest(value: CaptionReviewRevision) {
  const { digest: _digest, signature: _signature, ...body } = value; return digest(body);
}
