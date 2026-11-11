import type { ArtifactManifest } from "@/contracts/guild";
import { digest } from "@/domain/primitives";
import { narrationStandard, type NarrationSegment } from "@/domain/narration";

/** Shared exact serialization; v2 media metadata is deliberately unchanged. */
export function narrationFileMetadata(contractDigest: string, source: ArtifactManifest, item: Omit<NarrationSegment, "audio">, measure: Omit<NarrationSegment["audio"], "mediaId" | "url">, correctionAgreement?: { id: string; digest: string }) {
  return { purpose: "museum-narration", locale: item.locale, labelKey: item.key, textHash: item.textHash, sourceArtifactId: source.id, sourceArtifactHash: source.contentHash, contractDigest, speechRunId: item.speechRun.id, receiptHash: item.speechRun.receiptHash, pcmHash: item.speechRun.pcmHash, rendering: item.rendering, standardHash: digest(narrationStandard), measure, ...(correctionAgreement ? { correctionAgreement } : {}) };
}
