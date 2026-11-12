import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { PROVIDER_ACCESS_VERSION, PROVIDER_CLAIM_VERSION, PROVIDER_INVITATION_PREVIEW_VERSION,
  providerClaimSchema, providerInvitationSchema, providerInvitationPreviewSchema,
  type ProviderClaim, type ProviderClaimResult, type ProviderInvitation, type ProviderInvitationPreview } from "@/contracts/provider-access";
import { DomainError } from "@/domain/primitives";
import { transaction } from "../db";
import type { Session } from "../session";
import { providerRow, type MarketDb, type ProviderRow } from "../provider-market/registry";
import { providerBindingDigest, providerDisplayIdentity, requireAccessActor, secretHash } from "./identity";
import { originalProviderCookie } from "./sessions";

interface InvitationRow {
  id: string; provider_id: string; owner_identity: string; provider_binding_digest: string;
  issuer_identity: string; browser_origin: string; service_origin: string; setup_operation_id: string;
  challenge_hash: string; expires_at: Date; session_expires_at: Date; created_at: Date;
  consumed_claim_id: string | null; consumed_session_id: string | null; consumed_at: Date | null;
  retained_result: ProviderClaimResult | null; revoked_at: Date | null;
}

function privateInvitation(row: InvitationRow): ProviderInvitation {
  const parsed = providerInvitationSchema.safeParse({ version: PROVIDER_ACCESS_VERSION, id: row.id,
    providerId: row.provider_id, ownerIdentity: row.owner_identity, providerBindingDigest: row.provider_binding_digest,
    setupOperationId: row.setup_operation_id, issuerIdentity: row.issuer_identity, browserOrigin: row.browser_origin,
    serviceOrigin: row.service_origin, challengeHash: row.challenge_hash, issuedAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(), sessionCeilingAt: row.session_expires_at.toISOString(),
    consumedAt: row.consumed_at?.toISOString() ?? null, consumedSessionId: row.consumed_session_id,
    consumedClaimId: row.consumed_claim_id, revokedAt: row.revoked_at?.toISOString() ?? null, retainedResult: row.retained_result });
  if (!parsed.success) throw new DomainError("INVITATION_INTEGRITY", "This invitation's original binding could not be verified. Retain it for operator review.", 409, false);
  return parsed.data;
}

async function findInvitation(db: MarketDb, id: string, challenge: string, lock = false): Promise<InvitationRow | undefined> {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(challenge)) return undefined;
  return (await db.query<InvitationRow>(`SELECT * FROM guild_provider_invitations WHERE id=$1 AND challenge_hash=$2${lock ? " FOR UPDATE" : ""}`, [id, secretHash(challenge)])).rows[0];
}

async function currentIdentity(db: MarketDb, invitation: ProviderInvitation, origin: string, lock = false): Promise<ProviderRow | null> {
  if (invitation.browserOrigin !== origin) return null;
  const row = await providerRow(db, invitation.providerId, lock);
  if (row.revoked_at || row.owner_identity !== invitation.ownerIdentity || providerBindingDigest(row) !== invitation.providerBindingDigest
    || new URL(row.endpoint).origin !== invitation.serviceOrigin || new URL(row.card_url).origin !== invitation.serviceOrigin) return null;
  return row;
}

async function originalSession(db: MarketDb, invitation: ProviderInvitation): Promise<{ session: Session; tokenHash: string } | null> {
  if (!invitation.consumedSessionId || !invitation.retainedResult) return null;
  const row = (await db.query<{ id: string; tenant_id: string; role: Session["role"]; expires_at: Date; tenant_expires_at: Date; token_hash: string }>(
    "SELECT s.id,s.tenant_id,s.role,s.expires_at,s.token_hash,t.expires_at AS tenant_expires_at FROM guild_sessions s JOIN guild_tenants t ON t.id=s.tenant_id JOIN guild_market_provider_sessions b ON b.session_id=s.id AND b.revoked_at IS NULL WHERE s.id=$1 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND t.expires_at>clock_timestamp()",
    [invitation.consumedSessionId])).rows[0];
  if (!row || row.role !== "provider" || row.expires_at.toISOString() !== invitation.retainedResult.sessionExpiresAt
    || row.expires_at.toISOString() !== invitation.sessionCeilingAt || row.tenant_expires_at.toISOString() !== invitation.sessionCeilingAt) return null;
  const session: Session = { id: row.id, tenantId: row.tenant_id, role: row.role, expiresAt: row.expires_at.toISOString() };
  const actor = await requireAccessActor(db, session, "provider");
  if (actor.provider!.id !== invitation.providerId || actor.provider!.owner_identity !== invitation.ownerIdentity) return null;
  return { session, tokenHash: row.token_hash };
}

function unavailable(id: string): ProviderInvitationPreview {
  return { version: PROVIDER_INVITATION_PREVIEW_VERSION, invitationId: id, serverTime: new Date().toISOString(), state: "unavailable",
    provider: null, invitationExpiresAt: null, sessionCeilingAt: null, originalSessionExpiresAt: null, claimedAt: null,
    permissions: { claim: false, recoverOriginal: false }, message: "This invitation is not available at this original browser entry.",
    disclosure: "Reading an invitation creates no session, approves no work and moves no money.", consoleUrl: "/provider" };
}

export async function previewProviderInvitation(id: string, challenge: string, origin: string): Promise<ProviderInvitationPreview> {
  return transaction(async db => {
    await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const row = await findInvitation(db, id, challenge);
    if (!row) return unavailable(id);
    const invitation = privateInvitation(row), provider = await currentIdentity(db, invitation, origin);
    if (!provider) return unavailable(id);
    let state: ProviderInvitationPreview["state"], original: Awaited<ReturnType<typeof originalSession>> = null;
    if (invitation.revokedAt) state = "revoked";
    else if (Date.parse(invitation.sessionCeilingAt) <= Date.now()) state = "expired";
    else if (invitation.consumedSessionId) { original = await originalSession(db, invitation); state = original ? "claimed" : "revoked"; }
    else state = Date.parse(invitation.expiresAt) <= Date.now() ? "expired" : "available";
    const messages = {
      available: "Review this provider identity, then explicitly open its own console.",
      claimed: "This invitation already opened one provider session. Only its original saved claim can restore that same session before its fixed expiry.",
      expired: "The original invitation or session ceiling has expired. It cannot be extended or replaced by retrying.",
      revoked: "This invitation or its original provider access was revoked. Its retained history remains unchanged.",
      unavailable: "This original invitation is unavailable.",
    };
    return providerInvitationPreviewSchema.parse({ version: PROVIDER_INVITATION_PREVIEW_VERSION, invitationId: id,
      serverTime: new Date().toISOString(), state, provider: providerDisplayIdentity(provider), invitationExpiresAt: invitation.expiresAt,
      sessionCeilingAt: invitation.sessionCeilingAt, originalSessionExpiresAt: invitation.retainedResult?.sessionExpiresAt ?? null,
      claimedAt: invitation.consumedAt, permissions: { claim: state === "available", recoverOriginal: state === "claimed" },
      message: messages[state], disclosure: "This opens only the invited provider's console. The separate customer workspace, commercial approvals and financial records are unchanged.", consoleUrl: "/provider" });
  });
}

async function claim(db: PoolClient, id: string, input: ProviderClaim, origin: string): Promise<{ result: ProviderClaimResult; cookie: string }> {
  const row = await findInvitation(db, id, input.challenge, true);
  if (!row) throw new DomainError("INVITATION_UNAVAILABLE", "This original provider invitation is unavailable.", 404, false);
  const invitation = privateInvitation(row), provider = await currentIdentity(db, invitation, origin, true);
  if (!provider) throw new DomainError("INVITATION_IDENTITY_CHANGED", "The original provider identity or entry changed. This invitation cannot be rebound.", 409, false);
  if (invitation.revokedAt) throw new DomainError("INVITATION_REVOKED", "This original invitation was revoked.", 410, false);
  if (invitation.consumedSessionId) {
    if (invitation.consumedClaimId !== input.claimId) throw new DomainError("INVITATION_ALREADY_CLAIMED", "This invitation belongs to an earlier claim. A different request cannot open another session.", 409, false);
    const original = await originalSession(db, invitation);
    if (!original) throw new DomainError("PROVIDER_SESSION_UNAVAILABLE", "The exact original provider session is expired, revoked or changed. It will not be replaced.", 410, false);
    const credential = originalProviderCookie(id, input.claimId, original.session.id);
    if (secretHash(credential.token) !== original.tokenHash) throw new DomainError("PROVIDER_SIGNER_CHANGED", "The original session signer changed. Restore the original authorized configuration; this claim cannot mint a replacement.", 409, false);
    return { result: { ...invitation.retainedResult!, restoredOriginal: true }, cookie: credential.cookie };
  }
  if (Date.parse(invitation.expiresAt) <= Date.now() || Date.parse(invitation.sessionCeilingAt) <= Date.now()) {
    throw new DomainError("INVITATION_EXPIRED", "The original invitation has expired. No session was created or renewed.", 410, false);
  }
  const sessionId = randomUUID(), tenantId = randomUUID();
  const credential = originalProviderCookie(id, input.claimId, sessionId);
  await db.query("INSERT INTO guild_tenants(id,expires_at,mode) VALUES($1,$2,'owner')", [tenantId, invitation.sessionCeilingAt]);
  await db.query("INSERT INTO guild_sessions(id,tenant_id,token_hash,role,expires_at) VALUES($1,$2,$3,'provider',$4)", [sessionId, tenantId, secretHash(credential.token), invitation.sessionCeilingAt]);
  await db.query("INSERT INTO guild_market_provider_sessions(session_id,provider_id,owner_identity) VALUES($1,$2,$3)", [sessionId, invitation.providerId, invitation.ownerIdentity]);
  const result: ProviderClaimResult = { version: PROVIDER_CLAIM_VERSION, invitationId: id, claimId: input.claimId,
    providerId: invitation.providerId, sessionExpiresAt: invitation.sessionCeilingAt, restoredOriginal: false, consoleUrl: "/provider" };
  const updated = await db.query("UPDATE guild_provider_invitations SET consumed_claim_id=$2,consumed_session_id=$3,consumed_at=clock_timestamp(),retained_result=$4 WHERE id=$1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp() AND session_expires_at>clock_timestamp()",
    [id, input.claimId, sessionId, result]);
  if (updated.rowCount !== 1) throw new DomainError("INVITATION_EXPIRED", "The original invitation expired before the claim completed. No session was created.", 410, false);
  return { result, cookie: credential.cookie };
}

export async function claimProviderInvitation(id: string, value: unknown, origin: string): Promise<{ result: ProviderClaimResult; cookie: string }> {
  const input = providerClaimSchema.parse(value);
  return transaction(db => claim(db, id, input, origin));
}
