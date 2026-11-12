import type { Pool, PoolClient } from "pg";
import type { ArtifactManifest, Commission, WorkPackage } from "@/contracts/guild";
import { webArtifactSchema } from "@/domain/web-audits";
import { webAuthoritySchema, webProductionPolicies, webSourcesFromPack } from "@/domain/web-exhibition";
import { digest, DomainError } from "@/domain/primitives";
import { readWebSourceApproval } from "./source-history";
import type { WebJobInput } from "./contracts";

function fail(): never { throw new DomainError("WEB_APPROVAL_HISTORY", "This web artifact needs its exact original job, signed producing snapshot and correction/pipeline identity. Historical authority cannot authorize new work.", 422, false); }
export async function readWebApprovalHistory(db: Pool | PoolClient, c: Commission, pkg: WorkPackage | null, artifact: ArtifactManifest) {
  const parsed = webArtifactSchema.safeParse(artifact.content);
  if (!parsed.success || pkg && (parsed.data.contractDigest !== pkg.acceptancePack.digest || artifact.packageId !== pkg.id)) fail();
  const value = parsed.data, history = await readWebSourceApproval(db, c, pkg, artifact), input = history.job.input as WebJobInput;
  const producingPackage = history.snapshot.packages.find(item => item.id === artifact.packageId);
  if (!producingPackage || value.contractDigest !== producingPackage.acceptancePack.digest) fail();
  const source = webSourcesFromPack(producingPackage.acceptancePack), pipeline = webProductionPolicies[value.providerId];
  const correction = value.attempt === 2 ? { id: producingPackage.webCorrection?.id, digest: producingPackage.webCorrection?.proposal.digest } : null;
  if (history.job.id !== value.productionJobId || input.webAttempt !== value.attempt || input.webSourceDigest !== value.sourceDigest || digest(input.inputBindings) !== digest(value.inputBindings)
    || value.providerId !== producingPackage.providerId || input.webProviderPolicyDigest !== value.providerPolicyDigest || digest(correction) !== digest(value.correction)
    || value.pipelineVersion !== pipeline.version || input.webPipelineDigest !== digest(pipeline) || value.sourceDigest !== digest(source) || digest(value.sources) !== digest(source)
    || value.attempt === 1 && producingPackage.webCorrection || input.webCorrectionId !== correction?.id || input.webCorrectionDigest !== correction?.digest
    || history.job.created_at.getTime() >= Date.parse(webAuthoritySchema.parse(producingPackage.acceptancePack.parameters?.authority).expiresAt)) fail();
  return { ...history, job: { ...history.job, input } };
}
