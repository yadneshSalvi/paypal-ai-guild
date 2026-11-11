import { createHmac, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { ArtifactManifest, Commission, WorkPackage } from "@/contracts/guild";
import { planDigest } from "@/domain/fixture";
import { completeNarrationArtifactSchema } from "@/domain/narration";
import { canonical, digest } from "@/domain/primitives";

type Db = Pool | PoolClient;
type Failure = () => never;
interface SavedCommand {
  command_id: string; payload_hash: string; created_at: Date;
  result: { ok: boolean; commandId: string; revision: number; jobId: string | null; commission: Commission };
}
interface Production {
  id: string; state: string; created_at: Date;
  input: { packageId: string; contractVersion: number; inputBindings: unknown; correctionAgreementId?: string; correctionAgreementDigest?: string; targetedAgreementId?: string; targetedAgreementDigest?: string; followupAgreementId?: string; followupAgreementDigest?: string };
  output: { artifactId?: string } | null;
}

/** Contract terms only. Progress, annotations and later measurements are not new terms. */
export function narrationContractTerms(pkg: WorkPackage) {
  return { id: pkg.id, kind: pkg.kind, contractVersion: pkg.contractVersion, providerId: pkg.providerId,
    providerAwardMinor: pkg.providerAwardMinor, serviceFeeMinor: pkg.serviceFeeMinor, grossMinor: pkg.grossMinor,
    dependsOn: pkg.dependsOn, workingHours: pkg.workingHours, inputPolicy: pkg.inputPolicy,
    pack: { ...pkg.acceptancePack, criteria: pkg.acceptancePack.criteria.map(item => ({ ...item, status: "pending", evidence: null })) },
    narrationCorrection: pkg.narrationCorrection, narrationTargetedCorrection: pkg.narrationTargetedCorrection,
    narrationFollowupCorrection: pkg.narrationFollowupCorrection };
}

function exactSnapshot(snapshot: Commission, owner: Commission, pkg: WorkPackage, expectedPlan: string) {
  try {
    const contract = snapshot.packages.find(item => item.id === pkg.id);
    return snapshot.id === owner.id && snapshot.tenantId === owner.tenantId && snapshot.mode === "live"
      && snapshot.approvedPlanDigest === expectedPlan && planDigest(snapshot) === expectedPlan
      && !!contract && digest(narrationContractTerms(contract)) === digest(narrationContractTerms(pkg));
  } catch { return false; }
}

function exactCommand(row: SavedCommand, commissionId: string, command: Record<string, unknown>) {
  return row.result.ok === true && row.result.commandId === row.command_id
    && row.result.revision === row.result.commission.revision
    && row.payload_hash === digest({ commissionId, command: { ...command, commandId: row.command_id, expectedRevision: row.result.revision - 1 } });
}

/**
 * Retained narration is read under the approval that actually commissioned its
 * producing job. This function never grants current authority or extends expiry.
 * The original command, approval, agreement and artifact are only read.
 */
export async function readNarrationApprovalHistory(db: Db, owner: Commission, pkg: WorkPackage, fail: Failure, jobId?: string): Promise<Commission> {
  const jobs = (await db.query<Production>("SELECT id,state,input,output,created_at FROM guild_jobs WHERE tenant_id=$1 AND commission_id=$2 AND type='produce_package' AND input->>'packageId'=$3 AND input->>'contractVersion'=$4 AND ($5::uuid IS NULL OR id=$5) ORDER BY created_at,id", [owner.tenantId, owner.id, pkg.id, String(pkg.contractVersion), jobId ?? null])).rows;
  if (jobs.length !== 1 || jobs[0]!.state !== "completed" || !jobs[0]!.output?.artifactId) fail();
  const job = jobs[0]!;
  const amendment = (await db.query<{ proposed_contract: WorkPackage }>("SELECT proposed_contract FROM guild_contract_amendments WHERE tenant_id=$1 AND commission_id=$2 AND package_id=$3 AND to_version=$4", [owner.tenantId, owner.id, pkg.id, pkg.contractVersion])).rows[0];
  if (!amendment || digest(narrationContractTerms(amendment.proposed_contract)) !== digest(narrationContractTerms(pkg))) fail();

  const queued = (await db.query<SavedCommand>("SELECT command_id,payload_hash,result,created_at FROM guild_commands WHERE tenant_id=$1 AND commission_id=$2 AND result->>'jobId'=$3 ORDER BY created_at", [owner.tenantId, owner.id, job.id])).rows;
  if (queued.length !== 1) fail();
  const production = queued[0]!, snapshot = production.result.commission, approvedPlan = snapshot?.approvedPlanDigest;
  if (!approvedPlan || !exactSnapshot(snapshot, owner, pkg, approvedPlan)
    || !exactCommand(production, owner.id, { type: "produce_package", packageId: pkg.id })
    || production.created_at.getTime() !== job.created_at.getTime()
    || !snapshot.jobs.some(item => item.id === job.id && item.type === "produce_package" && item.packageId === pkg.id && item.contractVersion === pkg.contractVersion)) fail();

  const approvals = (await db.query<{ actor_id: string; plan_digest: string; payload: { kind: string; actor: string; commission: string; digest: string; at: string }; signature: string; created_at: Date }>("SELECT actor_id,plan_digest,payload,signature,created_at FROM guild_approval_receipts WHERE tenant_id=$1 AND commission_id=$2 AND plan_digest=$3 AND created_at<=$4 ORDER BY created_at", [owner.tenantId, owner.id, approvedPlan, job.created_at])).rows;
  const commands = (await db.query<SavedCommand>("SELECT command_id,payload_hash,result,created_at FROM guild_commands WHERE tenant_id=$1 AND commission_id=$2 AND result->'commission'->>'approvedPlanDigest'=$3 AND result->>'jobId' IS NULL ORDER BY created_at", [owner.tenantId, owner.id, approvedPlan])).rows;
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET required");
  let approved: Commission | undefined;
  for (const receipt of approvals) {
    if (receipt.payload.kind !== "guild.server_signed_receipt.v1" || receipt.payload.actor !== receipt.actor_id
      || receipt.payload.commission !== owner.id || receipt.payload.digest !== approvedPlan || receipt.plan_digest !== approvedPlan
      || !Number.isFinite(Date.parse(receipt.payload.at)) || Date.parse(receipt.payload.at) > job.created_at.getTime()
      || !/^[a-f0-9]{64}$/.test(receipt.signature)
      || !timingSafeEqual(Buffer.from(createHmac("sha256", secret).update(canonical(receipt.payload)).digest("hex")), Buffer.from(receipt.signature))) continue;
    const command = commands.find(item => item.created_at.getTime() === receipt.created_at.getTime()
      && exactSnapshot(item.result.commission, owner, pkg, approvedPlan)
      && exactCommand(item, owner.id, { type: "approve_plan", planDigest: approvedPlan }));
    if (command) { approved = command.result.commission; break; }
  }
  if (!approved) fail();
  const deadline = pkg.narrationFollowupCorrection?.proposal.providerOffer.expiresAt
    ?? pkg.narrationTargetedCorrection?.proposal.providerOffer.expiresAt ?? pkg.narrationCorrection?.proposal.providerOffer.expiresAt;
  if (deadline && job.created_at.getTime() >= Date.parse(deadline)
    || approved.mandates.some(item => !Number.isFinite(Date.parse(item.expiresAt)) || job.created_at.getTime() >= Date.parse(item.expiresAt))) fail();

  const saved = (await db.query<{ content_hash: string; manifest: ArtifactManifest }>("SELECT content_hash,manifest FROM guild_artifacts WHERE tenant_id=$1 AND commission_id=$2 AND package_id=$3 AND id=$4", [owner.tenantId, owner.id, pkg.id, job.output!.artifactId])).rows[0];
  const parsed = completeNarrationArtifactSchema.safeParse(saved?.manifest.content);
  if (!saved || saved.manifest.id !== job.output!.artifactId || saved.manifest.packageId !== pkg.id
    || saved.content_hash !== saved.manifest.contentHash || digest(saved.manifest.content) !== saved.content_hash || !parsed.success
    || parsed.data.contractDigest !== pkg.acceptancePack.digest || digest(parsed.data.inputBindings) !== digest(job.input.inputBindings)
    || parsed.data.sourceArtifactId !== pkg.acceptancePack.parameters?.sourceArtifactId
    || parsed.data.sourceArtifactHash !== pkg.acceptancePack.parameters?.sourceArtifactHash) fail();
  const content = parsed.data, bounded = pkg.narrationFollowupCorrection ?? pkg.narrationTargetedCorrection;
  const full = pkg.narrationCorrection ? { id: pkg.narrationCorrection.id, digest: pkg.narrationCorrection.proposal.digest } : null;
  if (content.schemaVersion === "guild.narration.v2") {
    if (bounded || digest(content.correctionAgreement ?? null) !== digest(full)
      || full && (job.input.correctionAgreementId !== full.id || job.input.correctionAgreementDigest !== full.digest)) fail();
  } else {
    if (!bounded || full) fail();
    const identity = { agreementId: bounded.id, agreementDigest: bounded.proposal.digest, registerDigest: bounded.proposal.scope.registerDigest, assemblyJobId: job.id, contractVersion: pkg.contractVersion };
    if (content.schemaVersion === "guild.narration.v4") {
      const followup = pkg.narrationFollowupCorrection;
      if (!followup || job.input.followupAgreementId !== followup.id || job.input.followupAgreementDigest !== followup.proposal.digest
        || digest(content.followupCorrection) !== digest({ ...identity, referenceArtifactId: followup.proposal.reference.artifactId, referenceArtifactHash: followup.proposal.reference.artifactHash })) fail();
    } else if (pkg.narrationFollowupCorrection || job.input.targetedAgreementId !== bounded.id || job.input.targetedAgreementDigest !== bounded.proposal.digest
      || digest(content.targetedCorrection) !== digest(identity)) fail();
  }
  const speech = (await db.query("SELECT id FROM guild_speech_runs WHERE id=$1 AND tenant_id=$2 AND commission_id=$3 AND package_id=$4 AND job_id=$5 AND state='completed'", [saved.manifest.provenance.sourceId, owner.tenantId, owner.id, pkg.id, job.id])).rows[0];
  if (!speech) fail();
  return approved;
}
