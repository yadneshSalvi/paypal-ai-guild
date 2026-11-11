import type { NarrationCorrectionProposal, WorkPackage } from "@/contracts/guild";
import { digest } from "./primitives";

/** A separate, narrowly scoped offer from the team-operated service. */
export const narrationCorrectionPolicy = {
  version: "quill.additional-correction.v1",
  issuer: "Guild controlled Quill & Echo service",
  providerId: "quill",
  originalPolicyDigest: digest("quill-v1"),
  maximumProductionJobs: 1,
  additionalChargeMinor: 0,
  requires: "Exhausted original allowance; complete retained and independently measured submissions; Arabic timing failures only; no acceptance, checkout, unresolved production or dependent work; unchanged source, acceptance pack, model, voice, engine and prices; fresh Passport approval.",
  disclosure: "A bounded offer issued by Guild's team-operated Quill & Echo service. The server signs its offer receipt; this is not an independent provider-owner signature or an A2A negotiation.",
} as const;

export const arabicCorrectionDelivery: NarrationCorrectionProposal["scope"]["arabicDelivery"] = {
  version: "quill.arabic-pacing.v1",
  minimumWordsPerMinute: 165,
  maximumWordsPerMinute: 175,
  instruction: "Use a brisk, natural Arabic delivery at approximately 165–175 words per minute, with brief sentence pauses and no elongated syllables. Preserve clear pronunciation and every exact word. This delivery cue replaces the earlier slow-pacing instruction; it does not change the agreed duration estimate or any audio check.",
};

export function narrationCorrectionDigest(proposal: Omit<NarrationCorrectionProposal, "digest"> | NarrationCorrectionProposal): string {
  const { digest: _digest, ...terms } = proposal as NarrationCorrectionProposal;
  return digest(terms);
}

export function productionJobLimit(pkg: WorkPackage): number {
  // An additional-correction contract is one further complete run. It does not
  // renew the original pack's included correction allowance.
  return pkg.narrationCorrection || pkg.narrationTargetedCorrection ? 1 : 1 + pkg.acceptancePack.correctionAllowance;
}
