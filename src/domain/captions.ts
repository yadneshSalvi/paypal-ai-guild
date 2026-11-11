import { z } from "zod";
import { locales, type AcceptancePack, type ArtifactManifest, type Locale } from "@/contracts/guild";
import { captionLanguageLimits, captionTimingStandard, timestampCapability } from "./caption-alignment";
import { whisperPromptPolicy } from "./caption-prompt-policy";
import { digest, DomainError } from "./primitives";
import { researchDraftSchema } from "./research";

const hash = z.string().regex(/^[a-f0-9]{64}$/), uuid = z.string().uuid(), key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/);
export const captionInputBindingSchema = z.object({ packageId: key, contractVersion: z.number().int().positive(), artifactId: uuid, artifactHash: hash,
  reviewKind: z.enum(["curator_acceptance", "automated_review"]), reviewId: uuid }).strict();
const referenceSchema = z.object({ artifactId: uuid, artifactHash: hash, packageId: key, contractVersion: z.number().int().positive() }).strict();
export const captionReviewEvidenceSchema = captionInputBindingSchema.extend({ recordHash: hash, verificationId: uuid, verificationHash: hash }).strict();
export const captionPromptSchema = z.object({ policy: z.unknown(), locale: z.enum(locales), sourceHash: hash, sourceStart: z.number().int().nonnegative(), sourceEnd: z.number().int().positive(),
  text: z.string().min(1).max(6000), textHash: hash, tokenCount: z.number().int().positive().max(224), leadingSpaceTokenCount: z.number().int().positive().max(224), boundedTokenCount: z.number().int().positive().max(224), tokenIdsHash: hash, leadingSpaceTokenIdsHash: hash, completeSourceIncluded: z.boolean() }).strict();
export const captionTrackSourceSchema = z.object({ locale: z.enum(locales), key, title: z.string().min(1).max(600), text: z.string().min(20).max(6000), textHash: hash,
  scriptBytesHash: hash, segmentHash: hash, mediaId: uuid, audioHash: hash, byteLength: z.number().int().positive().max(3 * 1024 * 1024), durationSeconds: z.number().finite().positive().max(180),
  origin: referenceSchema.extend({ productionJobId: uuid, contractDigest: hash, inputBindingsDigest: hash, approvalPlanDigest: hash,
    speechRunId: uuid, receiptHash: hash, pcmHash: hash, correctionAgreement: z.object({ id: uuid, digest: hash }).strict().nullable() }).strict(),
  prompt: captionPromptSchema,
}).strict();
export type CaptionTrackSource = z.infer<typeof captionTrackSourceSchema>;
export const captionConceptSchema = z.object({ id: key, key, kind: z.enum(["fact", "fictional_context", "uncertainty"]), text: z.string().min(1).max(1800), textHash: hash,
  citations: z.array(z.object({ spanId: z.string().min(1).max(200), quote: z.string().min(1).max(1600), spanHash: hash }).strict()).max(8) }).strict();
export type CaptionConcept = z.infer<typeof captionConceptSchema>;
export const captionSourceSchema = z.object({ schemaVersion: z.literal("northlight.caption-sources.v1"), narration: referenceSchema.extend({ productionJobId: uuid, approvalPlanDigest: hash, verificationReport: z.object({ jobId: uuid, outputHash: hash }).strict() }).strict(),
  translation: referenceSchema, research: referenceSchema, inputBindings: z.array(captionInputBindingSchema).min(1).max(6),
  reviews: z.array(captionReviewEvidenceSchema).min(3).max(12), requiredKeys: z.array(key).min(1).max(31),
  concepts: z.array(captionConceptSchema).min(1).max(372), tracks: z.array(captionTrackSourceSchema).min(6).max(186),
}).strict().superRefine((value, ctx) => {
  const keys = [...value.requiredKeys].sort();
  if (new Set(keys).size !== keys.length || value.tracks.length !== keys.length * locales.length
    || new Set(value.tracks.map(track => track.mediaId)).size !== value.tracks.length
    || new Set(value.concepts.map(concept => concept.id)).size !== value.concepts.length
    || value.concepts.some(concept => !keys.includes(concept.key))
    || keys.some(key => !value.concepts.some(concept => concept.key === key))
    || locales.some(locale => value.tracks.filter(track => track.locale === locale).map(track => track.key).sort().join("\0") !== keys.join("\0"))) ctx.addIssue({ code: "custom", message: "Every exact source key and locale must have one unique original recording and a concept register." });
  for (const track of value.tracks) if (digest(track.prompt.policy) !== digest(whisperPromptPolicy) || track.prompt.locale !== track.locale
    || track.prompt.sourceHash !== track.scriptBytesHash || track.text.slice(track.prompt.sourceStart, track.prompt.sourceEnd) !== track.prompt.text)
    ctx.addIssue({ code: "custom", message: "A prompted excerpt differs from its exact full source." });
});
export type CaptionSources = z.infer<typeof captionSourceSchema>;

export const easyReadStandard = {
  version: "northlight.source-linked-easy-read.v1", model: "gpt-6.1-sol", reasoning: "max", originalRequestsPerLocalePerJob: 1,
  minimumParagraphs: 1, maximumParagraphs: 5, maximumGraphemesPerParagraph: 360,
  requiredConcepts: "Every frozen factual, fictional-context and uncertainty segment; invitations may be simplified without adding a factual claim",
  citations: "Exact permitted source-span quotes attached to their registered concepts",
  interpretation: "Concept IDs and quotation checks establish presence and source integrity, not semantic preservation, a reading grade or fluent review",
  humanReview: "A curator must review meaning, uncertainty and reading experience; each language remains not fluent-reviewed unless a named human review is separately recorded",
} as const;

export const captionProductionStandard = {
  version: "northlight.production.v2", maximumProductionJobs: 2, correctionAllowance: 1,
  attempts: "Every saved producing job counts, including failed, interrupted and rejected attempts",
  timestampRequests: "At most one original timestamp POST per exact original audio file in each job; no hidden retries or replacement recordings",
  easyReadRequests: "At most one original structured response per locale in each job; known-response retrieval may continue without a new create",
  correction: "One explicitly reviewed correction note and exact prior-job/result reference, followed by fresh current Passport approval; unchanged source, limits, price and authority deadline",
  unknownResults: "Hold new dispatch and correction while any original outcome is unknown",
  authority: "Current signed approval, active actor, source and schedule binding are rechecked before dispatch and publication; retained responses grant no present authority",
} as const;

export const captionAuthorityCeilingSchema = z.object({ version: z.literal("guild.caption-authority-ceiling.v1"), expiresAt: z.string().datetime(),
  approval: z.object({ id: uuid, actorId: uuid, planDigest: hash, receiptHash: hash, actorExpiresAt: z.string().datetime(), commandId: uuid, snapshotHash: hash }).strict(),
  limits: z.array(z.object({ label: z.string().min(1).max(200), expiresAt: z.string().datetime() }).strict()).min(2).max(30), providerPolicyDigest: hash,
}).strict().superRefine((value, ctx) => {
  if (Date.parse(value.expiresAt) !== Math.min(Date.parse(value.approval.actorExpiresAt), ...value.limits.map(item => Date.parse(item.expiresAt)))) ctx.addIssue({ code: "custom", message: "The original authority ceiling must be the earliest actual limit." });
});
export type CaptionAuthorityCeiling = z.infer<typeof captionAuthorityCeilingSchema>;
export const captionCommercialPolicy = { version: "northlight.controlled-caption-terms.v2", providerId: "northlight", providerAwardMinor: 3500, serviceFeeMinor: 500, grossMinor: 4000,
  correctionAllowance: 1, additionalCorrectionChargeMinor: 0, disclosure: "Guild-controlled Northlight service terms, not an independent marketplace quote" } as const;

export function captionAcceptancePack(raw: CaptionSources, rawAuthority: CaptionAuthorityCeiling): AcceptancePack {
  const sources = captionSourceSchema.parse(raw), authorityCeiling = captionAuthorityCeilingSchema.parse(rawAuthority);
  const criteria: AcceptancePack["criteria"] = [
    { id: "source", label: "Exact original audio and source chain", description: "Bind each immutable audio file, original producing approval, script, locale, source reviews and full research/translation ancestors. No replacement audio or rewritten blind result.", blocking: true, kind: "deterministic", status: "pending", evidence: null },
    { id: "coverage", label: "Every recording has its complete source text", description: "Exactly every registered locale/key, original file and full script. A bounded prompt excerpt never reduces required full-script coverage.", blocking: true, kind: "deterministic", status: "pending", evidence: null },
    { id: "alignment", label: "Caption timing comes from original word timestamps", description: "Independently reparse retained prompted alignment responses, compare complete source wording and segments, reject ambiguous normalization, missing words, overlaps and invalid boundaries. Never interpolate or pad timings.", blocking: true, kind: "deterministic", status: "pending", evidence: null },
    { id: "vtt", label: "Exact downloadable VTT meets frozen language limits", description: "Read actual stored VTT bytes and recompute their text, cues, source/timing hashes, line limits and reading speed. The locale limits below are agreed product targets, not universal accessibility proof.", blocking: true, kind: "deterministic", status: "pending", evidence: null },
    { id: "easy_read", label: "Six easy-read files retain every registered concept", description: "Exact locale/key coverage, required concept IDs, permitted verbatim source quotes, bounded paragraphs and no unresolved placeholders. This checks identifiers and source integrity; meaning remains for review.", blocking: true, kind: "deterministic", status: "pending", evidence: null },
    { id: "meaning", label: "Review captions, meaning and reading experience", description: "Review all languages alongside the original audio and sources. Prompted alignment is not independent transcription. Human listening, fluent review, final source acceptance and payment remain separate.", blocking: true, kind: "human", status: "pending", evidence: null },
  ];
  const definition = { id: "pack-captions-v2", version: "2.0.0", title: "Original-audio captions and source-linked easy read", correctionAllowance: 1, criteria,
    parameters: { sources, sourceDigest: digest(sources), timestampCapability, promptPolicy: whisperPromptPolicy, timing: captionTimingStandard, limits: captionLanguageLimits,
      easyRead: easyReadStandard, production: captionProductionStandard, authorityCeiling, commercial: captionCommercialPolicy, promptedAlignmentOnly: true, independentBlindAsrUnchanged: true } };
  return { ...definition, digest: digest(definition) };
}

export function captionSourcesFromPack(pack: AcceptancePack): CaptionSources {
  const parsed = captionSourceSchema.safeParse(pack.parameters?.sources);
  const authority = captionAuthorityCeilingSchema.safeParse(pack.parameters?.authorityCeiling);
  if (!parsed.success || !authority.success || pack.version !== "2.0.0"
    || digest({ ...pack, criteria: pack.criteria.map(item => ({ ...item, status: "pending", evidence: null })) }) !== digest(captionAcceptancePack(parsed.data, authority.data))) throw new DomainError("CAPTION_CONTRACT_CHANGED", "The exact caption source, prompt, model, limits or correction allowance differs from its reviewed agreement.", 422, false);
  return parsed.data;
}

/** Required concepts are source segments, not an inferred or model-written checklist. */
export function captionConcepts(source: ArtifactManifest): CaptionConcept[] {
  const spans = z.array(z.object({ id: z.string(), text: z.string(), textHash: hash }).passthrough()).safeParse(source.content.sourceSpans);
  // Materialized labels additionally carry body/sourceIds; validate those without dropping their provenance.
  const labels = z.array(researchDraftSchema.shape.labels.element.passthrough()).safeParse(source.content.labels);
  if (source.content.schemaVersion !== "guild.research.v2" || digest(source.content) !== source.contentHash || !labels.success || !spans.success
    || new Set(spans.data.map(span => span.id)).size !== spans.data.length || spans.data.some(span => digest(span.text) !== span.textHash)
    || labels.data.some(label => label.body !== label.segments.map(segment => segment.text.trim()).join(" "))) throw new DomainError("CAPTION_RESEARCH_REQUIRED", "Easy read requires the exact source-grounded research artifact and its original source spans.", 422, false);
  const concepts: CaptionConcept[] = [];
  for (const label of labels.data) for (const [index, segment] of label.segments.entries()) {
    if (segment.kind === "invitation") continue;
    const citations = segment.citations.map(citation => {
      const span = spans.data.find(item => item.id === citation.spanId);
      if (!span || !span.text.includes(citation.quote) || citation.quote.length < Math.min(8, span.text.length)) throw new DomainError("CAPTION_RESEARCH_CITATION", "A registered concept no longer has its exact permitted source quotation.", 422, false);
      return { ...citation, spanHash: span.textHash };
    });
    if (segment.kind !== "uncertainty" && !citations.length) throw new DomainError("CAPTION_RESEARCH_CITATION", "Every registered factual or fictional-context concept needs a source quotation.", 422, false);
    concepts.push(captionConceptSchema.parse({ id: `concept-${digest({ key: label.id, index, segment }).slice(0, 32)}`, key: label.id, kind: segment.kind, text: segment.text, textHash: digest(segment.text), citations }));
  }
  return concepts;
}

export const easyReadParagraphSchema = z.object({ text: z.string().min(1).max(1800), conceptIds: z.array(key).min(1).max(12),
  sourceQuotes: z.array(z.object({ spanId: z.string().min(1).max(200), quote: z.string().min(1).max(1600) }).strict()).max(32) }).strict();
export const easyReadLabelSchema = z.object({ title: z.string().min(1).max(600), paragraphs: z.array(easyReadParagraphSchema).min(1).max(5) }).strict();
export function easyReadOutputSchema(locale: Locale, keys: string[]) {
  return z.object({ locale: z.literal(locale), labels: z.object(Object.fromEntries(keys.map(key => [key, easyReadLabelSchema]))).strict(), limitations: z.array(z.string().max(1200)).max(12) }).strict();
}
export const easyReadFileSchema = z.object({ locale: z.enum(locales), labels: z.record(key, easyReadLabelSchema), limitations: z.array(z.string().max(1200)).max(12), modelRunId: uuid,
  model: z.literal(easyReadStandard.model), inputHash: hash, providerResponseId: z.string().regex(/^resp_[A-Za-z0-9_-]{1,240}$/), outputHash: hash }).strict();
export type EasyReadFile = z.infer<typeof easyReadFileSchema>;
export function checkEasyRead(file: Pick<EasyReadFile, "locale" | "labels">, source: Pick<CaptionSources, "requiredKeys" | "concepts">) {
  const failures: string[] = [], keys = Object.keys(file.labels).sort();
  if (keys.join("\0") !== [...source.requiredKeys].sort().join("\0")) failures.push("The locale must contain exactly every registered label.");
  const placeholder = /\{\{[^}]*\}\}|\$\{|\b(?:TODO|TBD|LOREM IPSUM|__TRANSLATE__)\b|<\/?[A-Za-z][^>]*>|[\u202a-\u202e\u2066-\u2069]/iu;
  for (const key of source.requiredKeys) {
    const label = file.labels[key], concepts = source.concepts.filter(item => item.key === key);
    if (!label || !easyReadLabelSchema.safeParse(label).success) { failures.push(`${key}: complete label missing.`); continue; }
    const covered = new Set(label.paragraphs.flatMap(item => item.conceptIds));
    if (concepts.some(concept => !covered.has(concept.id)) || [...covered].some(id => !concepts.some(concept => concept.id === id))) failures.push(`${key}: required concepts are missing or foreign concepts were added.`);
    if (placeholder.test(label.title)) failures.push(`${key}: title contains unresolved markup or controls.`);
    for (const paragraph of label.paragraphs) {
      if (placeholder.test(paragraph.text) || [...new Intl.Segmenter(file.locale, { granularity: "grapheme" }).segment(paragraph.text)].length > easyReadStandard.maximumGraphemesPerParagraph || new Set(paragraph.conceptIds).size !== paragraph.conceptIds.length) failures.push(`${key}: paragraph exceeds the agreed bounds or repeats a concept reference.`);
      const permitted = concepts.filter(concept => paragraph.conceptIds.includes(concept.id)).flatMap(concept => concept.citations);
      if (paragraph.sourceQuotes.some(quote => !permitted.some(citation => citation.spanId === quote.spanId && citation.quote === quote.quote))
        || permitted.some(citation => !paragraph.sourceQuotes.some(quote => citation.spanId === quote.spanId && citation.quote === quote.quote))) failures.push(`${key}: concept quotations differ from their exact permitted spans.`);
    }
  }
  return { passed: !failures.length, failures: [...new Set(failures)], semanticReviewRequired: true as const };
}

const wordSchema = z.object({ word: z.string().min(1).max(800), start: z.number().finite().nonnegative(), end: z.number().finite().positive(), sourceStart: z.number().int().nonnegative(), sourceEnd: z.number().int().positive() }).strict();
const cueSchema = wordSchema.omit({ word: true }).extend({ index: z.number().int().positive(), text: z.string().min(1).max(6000), lines: z.array(z.string()).min(1).max(3) }).strict();
export const captionAlignmentSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("aligned"), words: z.array(wordSchema).min(1).max(1500), cues: z.array(cueSchema).min(1).max(1500), timingsHash: hash, cuesHash: hash, normalizedSourceHash: hash, diagnostics: z.array(z.string()).max(12) }).strict(),
  z.object({ status: z.literal("failed"), codes: z.array(z.string()).min(1).max(20), diagnostics: z.array(z.string()).min(1).max(20) }).strict(),
]);
const vttSchema = z.object({ mediaId: uuid, url: z.string().regex(/^\/api\/media\/[0-9a-f-]{36}$/), contentHash: hash, byteLength: z.number().int().positive().max(1000000) }).strict();
export const captionTrackSchema = z.object({ locale: z.enum(locales), key, sourceTrackDigest: hash, alignmentRunId: uuid, receiptHash: hash,
  alignment: captionAlignmentSchema, vtt: vttSchema.nullable() }).strict();
export type CaptionTrack = z.infer<typeof captionTrackSchema>;
export const captionArtifactSchema = z.object({ schemaVersion: z.literal("guild.captions.v2"), contractDigest: hash, sourceDigest: hash, sources: captionSourceSchema,
  productionJobId: uuid, attempt: z.union([z.literal(1), z.literal(2)]), correction: z.object({ id: uuid, digest: hash }).strict().nullable(),
  inputBindings: z.array(captionInputBindingSchema).min(1).max(6), tracks: z.array(captionTrackSchema).min(6).max(186), easyRead: z.array(easyReadFileSchema).length(6),
  promptedAlignmentOnly: z.literal(true), independentBlindAsrUnchanged: z.literal(true), humanListeningReviewed: z.literal(false), fluentHumanReviewed: z.literal(false),
  limitations: z.array(z.string().max(2000)).max(16),
}).strict();
export type CaptionArtifact = z.infer<typeof captionArtifactSchema>;
