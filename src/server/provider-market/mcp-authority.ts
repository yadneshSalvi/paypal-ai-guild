import type { PoolClient } from "pg";
import type { Commission } from "@/contracts/guild";
import { DomainError } from "@/domain/primitives";
import { marketWorkCeiling } from "@/domain/provider-market";
import { readAuthorityDeadline } from "../schedule-quotes";
import type { Session } from "../session";
import { requireMarketSession, type MarketDb } from "./registry";

export function requireCommissionOwner(session: Session): void {
  if (!["owner", "judge"].includes(session.role)) throw new DomainError("MCP_OWNER_REQUIRED", "These commission tools need the original owner's workspace authority.", 403, false);
}
/** The session/tenant locks serialize a continuation with access revocation.
 * A caller-owned client remains inside that caller's existing transaction. */
export async function lockApprovalOwner(db: PoolClient, session: Session): Promise<Session> {
  requireCommissionOwner(session);
  const row = (await db.query<{ expires_at: Date; tenant_expires_at: Date; revoked_at: Date | null }>(
    "SELECT s.expires_at,s.revoked_at,t.expires_at AS tenant_expires_at FROM guild_sessions s JOIN guild_tenants t ON t.id=s.tenant_id WHERE s.id=$1 AND s.tenant_id=$2 AND s.role=$3 FOR SHARE OF s,t", [session.id, session.tenantId, session.role])).rows[0];
  const ceiling = row ? Math.min(row.expires_at.getTime(), row.tenant_expires_at.getTime(), Date.parse(session.expiresAt)) : 0;
  if (!row || row.revoked_at || !Number.isFinite(ceiling) || ceiling <= Date.now()) throw new DomainError("SESSION_EXPIRED", "The original owner workspace has expired or was revoked.", 401, false);
  await requireMarketSession(db, session);
  return { ...session, expiresAt: new Date(ceiling).toISOString() };
}
export async function originalApprovalCeiling(db: MarketDb, commission: Commission, session: Session): Promise<number> {
  if (!commission.mandates.length || commission.mandates.some(page => !["draft", "active"].includes(page.status))) throw new DomainError("APPROVAL_AUTHORITY_REVOKED", "A Passport page is revoked or expired. Review the current authority in the studio.", 422, false);
  const deadline = await readAuthorityDeadline(db, commission, session);
  const values = [deadline.effectiveUntil, marketWorkCeiling(commission, session.expiresAt), ...commission.packages.map(work => work.marketOffer?.originalWorkCeiling).filter((value): value is string => Boolean(value))];
  if (deadline.unavailable || values.some(value => !value || !Number.isFinite(Date.parse(value)))) throw new DomainError("APPROVAL_AUTHORITY_UNAVAILABLE", "The original work deadline could not be verified. Retained work remains unchanged.", 422, false);
  const ceiling = Math.min(...values.map(value => Date.parse(value!)));
  if (ceiling <= Date.now()) throw new DomainError("APPROVAL_AUTHORITY_EXPIRED", "The original work authority has expired. This link cannot extend it.", 422, false);
  return ceiling;
}
