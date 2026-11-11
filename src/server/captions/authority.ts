import { createHmac, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Commission, WorkPackage } from "@/contracts/guild";
import { captionAuthorityCeilingSchema, captionCommercialPolicy, type CaptionAuthorityCeiling } from "@/domain/captions";
import { planDigest } from "@/domain/fixture";
import { canonical, digest, DomainError } from "@/domain/primitives";
import { readAuthorityDeadline } from "../schedule-quotes";
import type { Session } from "../session";

type Db = Pool | PoolClient;
function fail(code = "CAPTION_AUTHORITY_BINDING", message = "The caption agreement needs its exact original approval, signed authority limits and provider terms."): never { throw new DomainError(code, message, 422, false); }
interface Receipt { id: string; actor_id: string; plan_digest: string; payload: { kind: string; actor: string; commission: string; digest: string; at: string }; signature: string; created_at: Date; expires_at: Date; role: Session["role"] }
interface ApprovalCommand { command_id: string; payload_hash: string; created_at: Date; result: { ok: boolean; commandId: string; revision: number; jobId: string | null; commission: Commission } }

async function originalApproval(db: Db, c: Commission, id?: string) {
  if (!id && (!c.approvedPlanDigest || c.approvedPlanDigest !== planDigest(c))) fail("CAPTION_APPROVAL_REQUIRED", "Approve the current source contracts before reviewing the measured caption amendment.");
  const receipt = (await db.query<Receipt>("SELECT a.id,a.actor_id,a.plan_digest,a.payload,a.signature,a.created_at,s.expires_at,s.role FROM guild_approval_receipts a JOIN guild_sessions s ON s.id=a.actor_id AND s.tenant_id=a.tenant_id WHERE a.tenant_id=$1 AND a.commission_id=$2 AND ($3::uuid IS NOT NULL AND a.id=$3 OR $3::uuid IS NULL AND a.plan_digest=$4) ORDER BY a.created_at DESC,a.id DESC LIMIT 1", [c.tenantId, c.id, id ?? null, c.approvedPlanDigest])).rows[0];
  if (!receipt || !process.env.AUTH_SECRET || !["judge", "owner", "operator"].includes(receipt.role)
    || receipt.payload.kind !== "guild.server_signed_receipt.v1" || receipt.payload.actor !== receipt.actor_id || receipt.payload.commission !== c.id || receipt.payload.digest !== receipt.plan_digest
    || !Number.isFinite(Date.parse(receipt.payload.at)) || !/^[a-f0-9]{64}$/.test(receipt.signature)
    || !timingSafeEqual(Buffer.from(receipt.signature), Buffer.from(createHmac("sha256", process.env.AUTH_SECRET).update(canonical(receipt.payload)).digest("hex")))) fail();
  const candidates = (await db.query<ApprovalCommand>("SELECT command_id,payload_hash,result,created_at FROM guild_commands WHERE tenant_id=$1 AND commission_id=$2 AND result->'commission'->>'approvedPlanDigest'=$3 AND result->>'jobId' IS NULL", [c.tenantId, c.id, receipt.plan_digest])).rows;
  const commands = candidates.filter(row => {
    const s = row.result?.commission;
    return row.created_at.getTime() === receipt.created_at.getTime() && row.result?.ok === true && row.result.commandId === row.command_id && row.result.revision === s?.revision
      && s.id === c.id && s.tenantId === c.tenantId && s.mode === "live" && s.approvedPlanDigest === receipt.plan_digest && planDigest(s) === receipt.plan_digest
      && row.payload_hash === digest({ commissionId: c.id, command: { type: "approve_plan", commandId: row.command_id, expectedRevision: row.result.revision - 1, planDigest: receipt.plan_digest } });
  });
  if (commands.length !== 1) fail();
  // Workspace continuation updates the same session row. Recover its expiry at
  // this approval, rather than letting the newer workspace extend old work.
  const renewal = (await db.query<{ previous_expires_at: Date }>("SELECT previous_expires_at FROM guild_session_renewals WHERE session_id=$1 AND created_at>$2 ORDER BY created_at,request_id LIMIT 1", [receipt.actor_id, receipt.created_at])).rows[0];
  const actorExpiresAt = (renewal?.previous_expires_at ?? receipt.expires_at).toISOString();
  if (Date.parse(actorExpiresAt) <= Date.parse(receipt.payload.at)) fail();
  return { receipt, command: commands[0]!, actorExpiresAt };
}

async function ceilingFromApproval(db: Db, c: Commission, pkg: WorkPackage, id?: string): Promise<CaptionAuthorityCeiling> {
  const { receipt, command, actorExpiresAt } = await originalApproval(db, c, id), approved = command.result.commission;
  const provider = approved.providers.find(item => item.id === pkg.providerId), approvedPackage = approved.packages.find(item => item.id === pkg.id);
  if (!provider || !approvedPackage || approvedPackage.providerId !== pkg.providerId || !provider.kinds.includes("captions")
    || provider.id !== captionCommercialPolicy.providerId || provider.priceFloorMinor > captionCommercialPolicy.providerAwardMinor || provider.corrections !== captionCommercialPolicy.correctionAllowance
    || pkg.providerAwardMinor !== captionCommercialPolicy.providerAwardMinor || pkg.serviceFeeMinor !== captionCommercialPolicy.serviceFeeMinor || pkg.grossMinor !== captionCommercialPolicy.grossMinor) fail("CAPTION_COMMERCIAL_CHANGED", "This controlled caption agreement preserves Northlight's $35 award, $5 service fee and one included correction.");
  const deadline = await readAuthorityDeadline(db, approved, { id: receipt.actor_id, tenantId: c.tenantId, role: receipt.role, expiresAt: actorExpiresAt });
  if (!deadline.effectiveUntil || deadline.unavailable) fail();
  const limits = deadline.limits.map(item => ({ label: `${item.source}: ${item.label}`, expiresAt: item.expiresAt }));
  for (const item of approved.packages) {
    const agreement = item.narrationFollowupCorrection ?? item.narrationTargetedCorrection ?? item.narrationCorrection;
    if (agreement) limits.push({ label: `${item.id}: original correction agreement ${agreement.id}`, expiresAt: agreement.proposal.providerOffer.expiresAt });
    if (item.kind === "captions" && item.acceptancePack.version === "2.0.0") {
      const anchor = captionAuthorityCeilingSchema.parse(item.acceptancePack.parameters?.authorityCeiling);
      limits.push({ label: `${item.id}: retained caption authority ceiling`, expiresAt: anchor.expiresAt });
    }
  }
  return captionAuthorityCeilingSchema.parse({ version: "guild.caption-authority-ceiling.v1",
    expiresAt: new Date(Math.min(Date.parse(actorExpiresAt), ...limits.map(item => Date.parse(item.expiresAt)))).toISOString(),
    approval: { id: receipt.id, actorId: receipt.actor_id, planDigest: receipt.plan_digest, receiptHash: digest({ payload: receipt.payload, signature: receipt.signature }), actorExpiresAt,
      commandId: command.command_id, snapshotHash: digest(command.result.commission) }, limits, providerPolicyDigest: provider.policyDigest });
}

/** Read-only proposals may disclose an expired ceiling. They do not revive it. */
export async function buildCaptionAuthority(db: Db, c: Commission, pkg: WorkPackage) { return ceilingFromApproval(db, c, pkg); }

/** Original producing approval, selected before the saved job existed. */
export async function captionApprovalAt(db: Db, c: Commission, approvedPlan: string, before: Date) {
  const receipt = (await db.query<{ id: string }>("SELECT id FROM guild_approval_receipts WHERE tenant_id=$1 AND commission_id=$2 AND plan_digest=$3 AND created_at<=$4 ORDER BY created_at DESC,id DESC LIMIT 1", [c.tenantId, c.id, approvedPlan, before])).rows[0];
  if (!receipt) fail();
  const result = await originalApproval(db, c, receipt.id);
  if (result.receipt.plan_digest !== approvedPlan || Date.parse(result.actorExpiresAt) <= before.getTime()
    || result.command.result.commission.mandates.some(item => Date.parse(item.expiresAt) <= before.getTime())) fail();
  return result;
}

export async function validateCaptionAuthority(db: Db, c: Commission, pkg: WorkPackage, dispatch: boolean) {
  const anchor = captionAuthorityCeilingSchema.parse(pkg.acceptancePack.parameters?.authorityCeiling);
  const expected = await ceilingFromApproval(db, c, pkg, anchor.approval.id);
  if (digest(anchor) !== digest(expected) || anchor.providerPolicyDigest !== c.providers.find(item => item.id === pkg.providerId)?.policyDigest) fail();
  if (dispatch && (Date.parse(anchor.expiresAt) <= Date.now() || c.mandates.some(item => !["draft", "active"].includes(item.status) || Date.parse(item.expiresAt) <= Date.now())))
    fail("CAPTION_AUTHORITY_EXPIRED", "The original caption work authority expired or was revoked. Retained recordings and responses remain readable; workspace continuation does not renew this agreement.");
  return anchor;
}

export async function requireCaptionActor(db: Db, session: Session) {
  if (!(await db.query("SELECT id FROM guild_sessions WHERE id=$1 AND tenant_id=$2 AND role IN ('judge','owner','operator') AND expires_at>now() AND revoked_at IS NULL", [session.id, session.tenantId])).rowCount)
    fail("CAPTION_ACTOR_REQUIRED", "An active owner workspace must review the exact caption agreement.");
}
