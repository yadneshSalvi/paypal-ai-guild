import type { Pool, PoolClient } from "pg";
import type { ArtifactManifest, Commission, WorkPackage } from "@/contracts/guild";
import { captionArtifactSchema, captionAuthorityCeilingSchema } from "@/domain/captions";
import { planDigest } from "@/domain/fixture";
import { digest, DomainError } from "@/domain/primitives";
import { captionApprovalAt } from "./authority";
import { captionContractTerms, type CaptionJobInput } from "./contracts";

function fail(): never { throw new DomainError("CAPTION_APPROVAL_HISTORY", "The caption artifact needs its exact original producing command, approved snapshot, signed receipt and current-contract lineage. Retained history does not authorize new dispatch.", 422, false); }
export async function readCaptionApprovalHistory(db: Pool | PoolClient, c: Commission, pkg: WorkPackage, artifact: ArtifactManifest) {
  const content = captionArtifactSchema.safeParse(artifact.content);
  if (!content.success || digest(artifact.content) !== artifact.contentHash || artifact.packageId !== pkg.id || content.data.contractDigest !== pkg.acceptancePack.digest) fail();
  const job = (await db.query<{ id: string; state: string; input: CaptionJobInput; output: { artifactId?: string }; created_at: Date }>("SELECT id,state,input,output,created_at FROM guild_jobs WHERE id=$1 AND tenant_id=$2 AND commission_id=$3 AND type='produce_package'", [content.data.productionJobId, c.tenantId, c.id])).rows[0];
  if (!job || job.state !== "completed" || job.output?.artifactId !== artifact.id || job.input.packageId !== pkg.id || job.input.contractVersion !== pkg.contractVersion
    || job.input.captionAttempt !== content.data.attempt || job.input.captionSourceDigest !== content.data.sourceDigest || digest(job.input.inputBindings) !== digest(content.data.inputBindings)) fail();
  const commands = (await db.query<{ command_id: string; payload_hash: string; created_at: Date; result: { ok: boolean; commandId: string; revision: number; jobId: string; commission: Commission } }>("SELECT command_id,payload_hash,result,created_at FROM guild_commands WHERE tenant_id=$1 AND commission_id=$2 AND result->>'jobId'=$3", [c.tenantId, c.id, job.id])).rows;
  if (commands.length !== 1) fail();
  const queued = commands[0]!, snapshot = queued.result?.commission, savedPackage = snapshot?.packages.find(item => item.id === pkg.id);
  const expectedCorrection = content.data.attempt === 2 ? { id: savedPackage?.captionCorrection?.id, digest: savedPackage?.captionCorrection?.proposal.digest } : null;
  if (!snapshot || !savedPackage || !snapshot.approvedPlanDigest || snapshot.id !== c.id || snapshot.tenantId !== c.tenantId || snapshot.mode !== "live" || planDigest(snapshot) !== snapshot.approvedPlanDigest
    || digest(captionContractTerms(savedPackage)) !== digest(captionContractTerms(pkg)) || digest(expectedCorrection) !== digest(content.data.correction)
    || content.data.attempt === 1 && savedPackage.captionCorrection || job.input.captionCorrectionId !== expectedCorrection?.id || job.input.captionCorrectionDigest !== expectedCorrection?.digest
    || queued.result.ok !== true || queued.result.commandId !== queued.command_id || queued.result.revision !== snapshot.revision || queued.created_at.getTime() !== job.created_at.getTime()
    || queued.payload_hash !== digest({ commissionId: c.id, command: { type: "produce_package", packageId: pkg.id, commandId: queued.command_id, expectedRevision: queued.result.revision - 1 } })
    || !snapshot.jobs.some(item => item.id === job.id && item.type === "produce_package" && item.packageId === pkg.id && item.contractVersion === pkg.contractVersion)) fail();
  const approved = await captionApprovalAt(db, c, snapshot.approvedPlanDigest, job.created_at), approvedPkg = approved.command.result.commission.packages.find(item => item.id === pkg.id);
  if (!approvedPkg || digest(captionContractTerms(approvedPkg)) !== digest(captionContractTerms(savedPackage)) || digest(approvedPkg.captionCorrection ?? null) !== digest(savedPackage.captionCorrection ?? null)
    || job.created_at.getTime() >= Date.parse(captionAuthorityCeilingSchema.parse(pkg.acceptancePack.parameters?.authorityCeiling).expiresAt)) fail();
  return { job, snapshot: approved.command.result.commission, package: approvedPkg };
}
