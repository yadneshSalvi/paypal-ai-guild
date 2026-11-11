import { createHmac, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import type { Commission } from "@/contracts/guild";
import { checkAuthority } from "@/domain/authority";
import { planDigest } from "@/domain/fixture";
import { canonical, digest, DomainError } from "@/domain/primitives";
import { ProductionContinuation, ProductionReviewRequired } from "./production-continuation";
import { validateProductionInputs } from "./production-inputs";
import { validateNarrationCorrection } from "./narration-corrections";
import { validateNarrationTargetedCorrection } from "./narration-targeted-corrections";
import { validateNarrationFollowupCorrection } from "./narration-followup-corrections";

export interface ProductionLease { jobId: string; tenantId: string; leaseToken?: string; externalCalls?: number }
async function ownedJob(db: PoolClient, context: ProductionLease) {
  const job = (await db.query<{ commission_id: string; type: string; input: { packageId?: string; contractVersion?: number; artifactId?: string; artifactHash?: string; acceptancePackDigest?: string; inputBindings?: unknown; correctionAgreementId?: string; correctionAgreementDigest?: string; targetedAgreementId?: string; targetedAgreementDigest?: string; followupAgreementId?: string; followupAgreementDigest?: string; scheduleBinding?: Commission["schedule"]; captionSourceDigest?: string; captionAttempt?: number; captionCorrectionId?: string; captionCorrectionDigest?: string } }>("SELECT commission_id,type,input FROM guild_jobs WHERE id=$1 AND tenant_id=$2 AND state='running' AND lease_token=$3 AND lease_until>now() FOR UPDATE", [context.jobId, context.tenantId, context.leaseToken ?? null])).rows[0];
  if (!job) throw new ProductionReviewRequired("PRODUCTION_LEASE_REQUIRED", "The worker no longer owns this saved job. No new provider request was sent.");
  const c = (await db.query<{ snapshot: Commission }>("SELECT snapshot FROM guild_commissions WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [job.commission_id, context.tenantId])).rows[0]?.snapshot;
  if (!c) throw new ProductionReviewRequired("PRODUCTION_COMMISSION_REQUIRED", "This job's commission is no longer available.");
  if (c.state === "paused") throw new ProductionContinuation("Commission paused; completed drafts remain saved", 60);
  return { commission: c, job };
}
export async function requireProductionLease(db: PoolClient, context: ProductionLease, packageId?: string) {
  const { commission: c, job } = await ownedJob(db, context);
  if (job.type === "compile_brief") {
    if (packageId || c.state !== "planning" || c.approvedPlanDigest) throw new ProductionReviewRequired("PRODUCTION_CONTRACT_CHANGED", "The brief changed before production. Review its current plan before continuing.");
    return { commission: c, job, package: null };
  }
  const pkg = c.packages.find(item => item.id === job.input.packageId);
  const mandate = (pkg ? c.mandates.find(item => item.parentId && item.allowedKinds.includes(pkg.kind)) : undefined) ?? c.mandates.find(item => !item.parentId);
  const authority = pkg && mandate && checkAuthority(c.mandates, { mandateId: mandate.id, amountMinor: 0, kind: pkg.kind, providerId: pkg.providerId, purpose: mandate.purpose, now: new Date().toISOString() });
  if (job.type !== "produce_package" || !pkg || packageId && pkg.id !== packageId || pkg.state !== "producing" || pkg.contractVersion !== job.input.contractVersion || !authority?.allowed || !c.approvedPlanDigest || c.approvedPlanDigest !== planDigest(c)) throw new ProductionReviewRequired("PRODUCTION_CONTRACT_CHANGED", "The contract or Passport changed before the next provider request. Completed drafts remain saved for review.");
  try {
    if(digest(job.input.scheduleBinding??null)!==digest(c.schedule??null))throw new DomainError("SCHEDULE_AUTHORITY_CHANGED","This job belongs to a different approved schedule.",422,false);
    if(c.schedule)await (await import("./scheduling")).validateScheduleAuthority(db,c,"production");
    await validateProductionInputs(db,c,pkg,job.input.inputBindings);
    if(pkg.kind==="narration"){await validateNarrationCorrection(db,c,pkg,{id:context.jobId,input:job.input});await validateNarrationTargetedCorrection(db,c,pkg,{id:context.jobId,input:job.input});await validateNarrationFollowupCorrection(db,c,pkg,{id:context.jobId,input:job.input});}
    if(pkg.kind==="captions")await (await import("./captions/contracts")).validateCaptionJob(db,c,pkg,{id:context.jobId,input:job.input});
  } catch(error) { if(error instanceof DomainError)throw new ProductionReviewRequired(error.code,error.message);throw error; }
  const receipt = (await db.query<{ actor_id: string; payload: Record<string, unknown>; signature: string }>("SELECT a.actor_id,a.payload,a.signature FROM guild_approval_receipts a JOIN guild_sessions s ON s.id=a.actor_id AND s.tenant_id=a.tenant_id WHERE a.tenant_id=$1 AND a.commission_id=$2 AND a.plan_digest=$3 AND s.role IN ('judge','owner','operator') AND s.expires_at>now() AND s.revoked_at IS NULL ORDER BY a.created_at DESC LIMIT 1", [c.tenantId, c.id, c.approvedPlanDigest])).rows[0];
  const secret = process.env.AUTH_SECRET;
  const expected = receipt && secret ? createHmac("sha256", secret).update(canonical(receipt.payload)).digest("hex") : "";
  if (!receipt || !expected || !/^[a-f0-9]{64}$/.test(receipt.signature) || !timingSafeEqual(Buffer.from(receipt.signature), Buffer.from(expected)) || receipt.payload.actor !== receipt.actor_id || receipt.payload.commission !== c.id || receipt.payload.digest !== c.approvedPlanDigest) throw new ProductionReviewRequired("PRODUCTION_APPROVAL_REQUIRED", "This production contract needs its current signed approval from an active workspace actor.");
  return { commission: c, job, package: pkg };
}

/** Verification can inspect retained work; it cannot dispatch production or accept it. */
export async function requireVerificationLease(db: PoolClient, context: ProductionLease) {
  const { commission: c, job } = await ownedJob(db, context);
  const pkg = c.packages.find(item => item.id === job.input.packageId);
  const artifact = c.artifacts.find(item => item.id === job.input.artifactId && item.packageId === pkg?.id);
  if (job.type !== "verify_artifact" || !pkg || pkg.state !== "verifying" || pkg.contractVersion !== job.input.contractVersion || pkg.acceptancePack.digest !== job.input.acceptancePackDigest || !artifact || !pkg.artifactIds.includes(artifact.id) || artifact.contentHash !== job.input.artifactHash) throw new ProductionReviewRequired("VERIFICATION_CONTRACT_CHANGED", "This verification belongs to a different artifact or contract. Its measurements remain saved without replacing the current review.");
  return { commission: c, job, package: pkg, artifact };
}
