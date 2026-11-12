import { z } from "zod";
import type { CaptionTrackSource } from "./captions";
import type { DeepgramCaptionArtifact, DeepgramCaptionTrack } from "./deepgram-captions";
import { digest } from "./primitives";

const hash = z.string().regex(/^[a-f0-9]{64}$/), uuid = z.string().uuid();
/** Private publication evidence. The public reader keeps the compatible,
 * qualified source schema: ancestor hash + timings/cues/VTT fingerprints bind
 * this same edition without publishing private names or recognition bodies. */
export const acceptedWebCaptionProvenanceSchema = z.object({
  version: z.literal("guild.web-accepted-caption-revisions.v1"), artifactId: uuid, artifactHash: hash,
  contractDigest: hash, sourceDigest: hash, productionJobId: uuid, originalProductionJobId: uuid,
  originalArtifactId: uuid, originalArtifactHash: hash, correctionId: uuid, correctionDigest: hash,
  acceptanceId: uuid, acceptanceRecordHash: hash, syntheticFixture: z.boolean(),
  disclosure: z.string().min(1),
  tracks: z.array(z.object({
    locale: z.enum(["en", "pt", "es", "fr", "ja", "ar"]), key: z.string().min(1),
    sourceTrackDigest: hash, audioHash: hash, scriptBytesHash: hash,
    alignmentRunId: uuid, receiptHash: hash, rawBodyHash: hash, automaticCandidateHash: hash,
    reviewRevisionId: uuid, reviewRevisionDigest: hash, parentRevisionId: uuid, parentRevisionDigest: hash,
    actorId: uuid, actorRole: z.enum(["owner", "judge"]), declaredAt: z.string().datetime(), attributionHash: hash,
    effectiveTimingsHash: hash, cuesHash: hash,
    vtt: z.object({ mediaId: uuid, contentHash: hash, byteLength: z.number().int().positive() }).strict(),
  }).strict()).min(6).max(78),
}).strict();
export type AcceptedWebCaptionProvenance = z.infer<typeof acceptedWebCaptionProvenanceSchema>;

/** Versioned because these are effective attributed measurements, not the
 * automatic recognizer's original word timings. The revision digest binds its
 * complete signed draft, attribution and append-only parent digest chain. */
export function webEffectiveCaptionTimingsHash(artifactHash: string, content: DeepgramCaptionArtifact, source: CaptionTrackSource, track: DeepgramCaptionTrack) {
  return digest({ version: "guild.web-effective-caption-timing.v1", artifactHash, contractDigest: content.contractDigest,
    sourceDigest: content.sourceDigest, productionJobId: content.productionJobId, originalProductionJobId: content.originalProductionJobId,
    correction: content.correction, sourceTrackDigest: digest(source), audioHash: source.audioHash, scriptBytesHash: source.scriptBytesHash,
    alignmentRunId: track.alignmentRunId, receiptHash: track.receiptHash, observationJobId: track.observationJobId,
    automaticCandidateHash: digest(track.candidate), reviewRevision: track.reviewRevision, effective: track.effective });
}
