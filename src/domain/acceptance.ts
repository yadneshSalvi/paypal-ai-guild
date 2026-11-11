import type { ArtifactManifest, WorkPackage } from "@/contracts/guild";
import { DomainError } from "./primitives";

export function assertAcceptable(pkg: WorkPackage, artifact: ArtifactManifest, contractVersion: number): void {
  if (pkg.contractVersion !== contractVersion) throw new DomainError("CONTRACT_CHANGED", "The contract changed. Review the current criteria before accepting.");
  if (!pkg.artifactIds.includes(artifact.id) || artifact.packageId !== pkg.id) throw new DomainError("ARTIFACT_NOT_OFFERED", "This artifact is not an offered submission for this package.", 404, false);
  if (pkg.state === "accepted") throw new DomainError("ALREADY_ACCEPTED", "This package already has an acceptance decision.");
  if (pkg.state !== "awaiting_acceptance") throw new DomainError("VERIFICATION_REQUIRED", "Run the agreed checks before accepting this submission.");
  const blocking = pkg.acceptancePack.criteria.filter(c => c.blocking && c.kind === "deterministic" && c.status !== "passed");
  if (blocking.length) throw new DomainError("BLOCKING_CHECKS", `${blocking.length} required checks still need to pass.`, 422);
}

export function assertEarnedCapture(pkg: WorkPackage, amountMinor: number): void {
  if (pkg.state !== "accepted" || !pkg.acceptedAt || !pkg.acceptedBy) throw new DomainError("WORK_NOT_ACCEPTED", "Payment is available only after the curator accepts this exact work.", 422);
  if (pkg.grossMinor !== amountMinor) throw new DomainError("AMOUNT_CHANGED", "The charge must match the accepted contract, including its disclosed service fee.", 422, false);
  if (pkg.provenance.mode !== "live") throw new DomainError("SAMPLE_NOT_PAYABLE", "Sample and replay work cannot create a live sandbox charge.", 422, false);
  if (pkg.paymentState === "not_eligible") throw new DomainError("ACCEPTANCE_NOT_PAYABLE", "A system qualification acknowledgment does not grant payment authority.", 422, false);
}
