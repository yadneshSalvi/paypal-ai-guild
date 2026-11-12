import { z } from "zod";
import { locales, type AcceptancePack } from "@/contracts/guild";
import { captionLanguageLimits } from "./caption-alignment";
import { captionAuthorityCeilingSchema, captionCommercialPolicy, captionInputBindingSchema, captionSourceSchema, easyReadFileSchema, easyReadStandard, type CaptionAuthorityCeiling, type CaptionSources } from "./captions";
import { deepgramLocaleModels, deepgramQueryPolicy, deepgramTimestampCapability, deepgramTimingPolicy } from "./deepgram-caption-alignment";
import { deepgramSourcePolicy } from "./deepgram-source-mapping";
import { captionHumanTimingPolicy } from "./caption-review";
import { digest, DomainError } from "./primitives";

const hash = z.string().regex(/^[a-f0-9]{64}$/), uuid = z.string().uuid();
export const deepgramCaptionReviewPolicy = Object.freeze({
  version: "northlight.deepgram-assisted-review.v1", mode: "review-only", maximumRecordings: 78, originalRecognitionJobs: 1,
  recognitionRequestsPerRecording: 1, automaticRetries: 0, correctionAssemblyJobs: 1, correctionRecognitionRequests: 0,
  correction: "One separately agreed assembly of exact attributed listening revisions; reuse original audio, source, raw recognition and easy read. No repeated ASR or new narration",
  observedCapability: "Nova3 development: 2 English review candidates of 12 spoken recordings; 6 lexical disagreements and 4 Arabic/Japanese timing failures. All six silence controls withheld. No held-out qualification or fluent review",
  automatedQualification: "not-qualified", publicationAdmission: "complete-attributed-human-listening-correction-independent-checks-and-curator-acceptance",
  disclosure: "The six-language review workbench remains available for every source track. A candidate, manual draft, listening attestation or system test does not establish automatic capability qualification, final acceptance or payment",
} as const);

export function deepgramCaptionAcceptancePack(raw: CaptionSources, rawAuthority: CaptionAuthorityCeiling): AcceptancePack {
  const sources = captionSourceSchema.parse(raw), authorityCeiling = captionAuthorityCeilingSchema.parse(rawAuthority);
  if (sources.tracks.length > deepgramCaptionReviewPolicy.maximumRecordings) throw new DomainError("DEEPGRAM_COLLECTION_BOUND", "This review agreement supports at most 78 complete original recordings across all six languages. No source track may be omitted to fit it.", 422, false);
  const criteria: AcceptancePack["criteria"] = [
    { id: "source", label: "Exact original audio and full source chain", description: "Independently reread each original recording, full script, historical producing approval and exact source reviews.", blocking: true, kind: "deterministic", status: "pending", evidence: null },
    { id: "coverage", label: "Every source character and recording retained", description: "Complete title and body in all six languages. Failed and uncertain tracks stay in the denominator.", blocking: true, kind: "deterministic", status: "pending", evidence: null },
    { id: "alignment", label: "Original or explicitly attributed timing", description: "Rebuild automatic candidates from signed original raw bytes. Manual measurements must match their immutable attributed revisions and never be reported as provider observations.", blocking: true, kind: "deterministic", status: "pending", evidence: null },
    { id: "vtt", label: "Actual VTT bytes and agreed language limits", description: "Recompute source spans, positive ordered measured boundaries, cue limits, reading speed and exact stored VTT bytes.", blocking: true, kind: "deterministic", status: "pending", evidence: null },
    { id: "easy_read", label: "Six source-linked easy-read files", description: "Retain all original locale responses, exact concepts and quotations. Source-presence checks do not prove meaning.", blocking: true, kind: "deterministic", status: "pending", evidence: null },
    { id: "listening", label: "Separate complete listening attestations", description: "Every corrected track needs a named person’s recorded full-audio, full-source and timing attestation. Saving or importing a draft does not make this claim.", blocking: true, kind: "deterministic", status: "pending", evidence: null },
    { id: "qualification", label: "Automatic alignment qualification remains open", description: "Blind recognition is not a qualified six-language automatic aligner. A complete independently reverified human correction can be accepted under this explicitly reviewed contract, without claiming automatic qualification. Synthetic checks or AI annotations cannot replace listening review.", blocking: false, kind: "advisory", status: "pending", evidence: null },
    { id: "meaning", label: "Curator meaning, reading and language review", description: "Review original audio, source meaning, uncertainty and each language’s reading experience. Fluent-language review and final source acceptance remain explicit separate decisions.", blocking: true, kind: "human", status: "pending", evidence: null },
  ];
  const definition = { id: "pack-captions-deepgram-review-v3", version: "3.0.0", title: "Deepgram-assisted captions · six-language review edition", correctionAllowance: 1, criteria,
    parameters: { sources, sourceDigest: digest(sources), authorityCeiling, timestampCapability: deepgramTimestampCapability, models: deepgramLocaleModels,
      query: deepgramQueryPolicy, timing: deepgramTimingPolicy, sourcePolicy: deepgramSourcePolicy, humanTiming: captionHumanTimingPolicy,
      limits: captionLanguageLimits, production: deepgramCaptionReviewPolicy, commercial: captionCommercialPolicy, easyRead: easyReadStandard,
      sourceTextSupplied: false, independentBlindAsrUnchanged: true, productionAccepted: false } };
  return { ...definition, digest: digest(definition) };
}

export function deepgramSourcesFromPack(pack: AcceptancePack): CaptionSources {
  const source = captionSourceSchema.safeParse(pack.parameters?.sources), authority = captionAuthorityCeilingSchema.safeParse(pack.parameters?.authorityCeiling);
  if (!source.success || !authority.success || pack.version !== "3.0.0"
    || digest({ ...pack, criteria: pack.criteria.map(item => ({ ...item, status: "pending", evidence: null })) }) !== digest(deepgramCaptionAcceptancePack(source.data, authority.data)))
    throw new DomainError("DEEPGRAM_CONTRACT_CHANGED", "The exact provider, full source, timing, review policy, limits or authority differs from the agreed review edition.", 422, false);
  return source.data;
}

const measuredWord = z.object({ word: z.string().min(1).max(800), rawStart: z.number().finite(), rawEnd: z.number().finite(), startMs: z.number().int(), endMs: z.number().int(), confidence: z.number().min(0).max(1) }).strict();
export const deepgramCueSchema = z.object({ index: z.number().int().positive(), start: z.number().finite().nonnegative(), end: z.number().finite().positive(), sourceStart: z.number().int().nonnegative(), sourceEnd: z.number().int().positive(), text: z.string().min(1).max(6000), lines: z.array(z.string()).min(1).max(3) }).strict();
export const deepgramCandidateSchema = z.object({ status: z.enum(["ready-for-review", "withheld"]), codes: z.array(z.string()).max(32), sourceHash: hash, responseHash: hash.nullable(), sourcePolicyHash: hash, limitsHash: hash,
  timing: z.object({ policyDigest: hash, responseDigest: hash.nullable(), locale: z.enum(locales), audioDurationSeconds: z.number().finite().positive(), status: z.enum(["measured", "withheld"]),
    issues: z.array(z.object({ code: z.string(), wordIndex: z.number().int().nonnegative().optional() }).strict()).max(10000), words: z.array(measuredWord).max(1500),
    maximumDisplacementSeconds: z.number().finite().nonnegative(), sourceCoverage: z.literal("not-established"), productionAccepted: z.literal(false) }).strict(),
  cues: z.array(deepgramCueSchema).max(1500), vtt: z.string().max(1000000).nullable(), productionAccepted: z.literal(false), humanReviewed: z.literal(false) }).strict();
const vtt = z.object({ mediaId: uuid, url: z.string().regex(/^\/api\/media\/[0-9a-f-]{36}$/), contentHash: hash, byteLength: z.number().int().positive().max(1000000) }).strict();
export const deepgramCaptionTrackSchema = z.object({ locale: z.enum(locales), key: z.string().min(1).max(160), sourceTrackDigest: hash,
  alignmentRunId: uuid, receiptHash: hash, observationJobId: uuid, candidate: deepgramCandidateSchema,
  reviewRevision: z.object({ id: uuid, digest: hash }).strict().nullable(),
  effective: z.object({ status: z.enum(["ready-for-review", "withheld"]), provenance: z.enum(["deepgram-exact-source", "attributed-listening"]), cues: z.array(deepgramCueSchema).max(1500), cuesHash: hash,
    listeningAttested: z.boolean(), fluentReviewed: z.literal(false), productionAccepted: z.literal(false) }).strict(), vtt: vtt.nullable(),
}).strict();
export type DeepgramCaptionTrack = z.infer<typeof deepgramCaptionTrackSchema>;
export const deepgramCaptionArtifactSchema = z.object({ schemaVersion: z.literal("guild.captions.v3"), contractDigest: hash, sourceDigest: hash, sources: captionSourceSchema,
  productionJobId: uuid, originalProductionJobId: uuid, attempt: z.union([z.literal(1), z.literal(2)]), inputBindings: z.array(captionInputBindingSchema).min(1).max(6),
  correction: z.object({ id: uuid, digest: hash, baseArtifactId: uuid, baseArtifactHash: hash }).strict().nullable(),
  tracks: z.array(deepgramCaptionTrackSchema).min(6).max(78), easyRead: z.array(easyReadFileSchema).length(6),
  sourceTextSupplied: z.literal(false), independentBlindAsrUnchanged: z.literal(true), fluentHumanReviewed: z.literal(false), productionAccepted: z.literal(false),
  automatedQualification: z.literal("not-qualified"), limitations: z.array(z.string().max(2000)).max(16),
}).strict();
export type DeepgramCaptionArtifact = z.infer<typeof deepgramCaptionArtifactSchema>;

export interface DeepgramCaptionCorrectionProposal {
  version: "guild.deepgram-caption-correction.v1"; digest: string; commissionId: string; packageId: string; contractVersion: number; contractDigest: string; sourceDigest: string;
  previousPlanDigest: string; baseArtifactId: string; baseArtifactHash: string; originalProductionJobId: string; originalVerificationId: string; originalVerificationHash: string;
  revisions: Array<{ locale: (typeof locales)[number]; key: string; id: string; digest: string }>; authorityExpiresAt: string;
  recognitionRequests: 0; easyReadRequests: 0; additionalChargeMinor: 0; disclosure: string;
}
export interface DeepgramCaptionCorrectionAgreement { id: string; proposal: DeepgramCaptionCorrectionProposal; actorId: string; agreedAt: string; signature: string }
export function deepgramCaptionCorrectionDigest(value: Omit<DeepgramCaptionCorrectionProposal, "digest"> | DeepgramCaptionCorrectionProposal) { const { digest: _digest, ...body } = value as DeepgramCaptionCorrectionProposal; return digest(body); }
