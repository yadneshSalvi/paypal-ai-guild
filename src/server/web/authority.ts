import type { Pool, PoolClient } from "pg";
import type { Commission, WorkPackage } from "@/contracts/guild";
import { captionAuthorityCeilingSchema } from "@/domain/captions";
import { digest, DomainError } from "@/domain/primitives";
import { webAuthoritySchema, webCommercialPolicy, type WebAuthority } from "@/domain/web-exhibition";
import { originalApproval } from "../captions/authority";
import { readAuthorityDeadline } from "../schedule-quotes";
import type { Session } from "../session";

type Db = Pool | PoolClient;
function fail(message = "The web agreement needs its exact original approval and unextended authority ceiling."): never { throw new DomainError("WEB_AUTHORITY_BINDING", message, 422, false); }
export function validateWebProvider(c: Commission, pkg: WorkPackage) {
  const provider = c.providers.find(item => item.id === pkg.providerId);
  if (!provider || !["formwork", "ostrava"].includes(provider.id) || !provider.kinds.includes("web") || provider.corrections !== webCommercialPolicy.correctionAllowance
    || provider.priceFloorMinor > pkg.providerAwardMinor || pkg.serviceFeeMinor !== 1500 || pkg.grossMinor !== pkg.providerAwardMinor + pkg.serviceFeeMinor || pkg.acceptancePack.correctionAllowance !== 1) fail("The controlled web service must retain its exact quoted award, $15 service fee and one included correction. Replacement prices require their own current signed offer and fresh Passport.");
  return provider;
}
async function fromApproval(db: Db, c: Commission, pkg: WorkPackage, id?: string): Promise<WebAuthority> {
  const { receipt, command, actorExpiresAt } = await originalApproval(db, c, id), approved = command.result.commission;
  const original = approved.packages.find(item => item.id === pkg.id);
  if (!original || original.kind !== "web") fail();
  const deadline = await readAuthorityDeadline(db, approved, { id: receipt.actor_id, tenantId: c.tenantId, role: receipt.role, expiresAt: actorExpiresAt });
  if (!deadline.effectiveUntil || deadline.unavailable) fail();
  const limits = deadline.limits.map(item => ({ label: `${item.source}: ${item.label}`, expiresAt: item.expiresAt }));
  for (const item of approved.packages) {
    const narration = item.narrationFollowupCorrection ?? item.narrationTargetedCorrection ?? item.narrationCorrection;
    if (narration) limits.push({ label: `${item.id}: original correction agreement ${narration.id}`, expiresAt: narration.proposal.providerOffer.expiresAt });
    if (item.kind === "captions" && ["2.0.0", "3.0.0"].includes(item.acceptancePack.version)) limits.push({ label: `${item.id}: retained caption authority ceiling`, expiresAt: captionAuthorityCeilingSchema.parse(item.acceptancePack.parameters?.authorityCeiling).expiresAt });
    if (item.kind === "web" && item.acceptancePack.version === "2.0.0") limits.push({ label: `${item.id}: retained web authority ceiling`, expiresAt: webAuthoritySchema.parse(item.acceptancePack.parameters?.authority).expiresAt });
  }
  return webAuthoritySchema.parse({ version: "guild.web-authority-ceiling.v1", expiresAt: new Date(Math.min(Date.parse(actorExpiresAt), ...limits.map(item => Date.parse(item.expiresAt)))).toISOString(),
    approval: { id: receipt.id, actorId: receipt.actor_id, planDigest: receipt.plan_digest, receiptHash: digest({ payload: receipt.payload, signature: receipt.signature }), actorExpiresAt, commandId: command.command_id, snapshotHash: digest(approved) }, limits });
}
export const buildWebAuthority = (db: Db, c: Commission, pkg: WorkPackage) => fromApproval(db, c, pkg);
export async function validateWebAuthority(db: Db, c: Commission, pkg: WorkPackage, dispatch: boolean) {
  const saved = webAuthoritySchema.parse(pkg.acceptancePack.parameters?.authority), expected = await fromApproval(db, c, pkg, saved.approval.id);
  if (digest(saved) !== digest(expected)) fail();
  validateWebProvider(c, pkg);
  if (dispatch && (Date.parse(saved.expiresAt) <= Date.now() || c.mandates.some(item => !["active", "draft"].includes(item.status) || Date.parse(item.expiresAt) <= Date.now())))
    throw new DomainError("WEB_AUTHORITY_EXPIRED", "The original work deadline has expired or was revoked. Existing web sources and reports remain readable; workspace continuation and a replacement quote cannot renew this authority.", 422, false);
  return saved;
}
export async function requireWebActor(db: Db, session: Session) {
  if (!(await db.query("SELECT id FROM guild_sessions WHERE id=$1 AND tenant_id=$2 AND role IN ('judge','owner','operator') AND expires_at>now() AND revoked_at IS NULL", [session.id, session.tenantId])).rowCount)
    throw new DomainError("WEB_ACTOR_REQUIRED", "An active owner workspace must review the exact web agreement.", 403, false);
}
/** A new independent browser process still needs current approved work authority.
 * Reading already retained files and native findings never calls this gate. */
export async function requireWebVerificationAuthority(db: Db, c: Commission, pkg: WorkPackage) {
  await validateWebAuthority(db, c, pkg, true);
  const approved = await originalApproval(db, c);
  await requireWebActor(db, { id: approved.receipt.actor_id, tenantId: c.tenantId, role: approved.receipt.role, expiresAt: approved.actorExpiresAt });
}
