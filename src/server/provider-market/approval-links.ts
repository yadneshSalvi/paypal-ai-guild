import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import type { Commission } from "@/contracts/guild";
import { mcpApprovalLinkSchema, type McpApprovalLinkResult } from "@/contracts/provider-market";
import { planDigest } from "@/domain/fixture";
import { canonical, DomainError } from "@/domain/primitives";
import { transaction } from "../db";
import type { Session } from "../session";
import { marketOrigin } from "./registry";
import { lockApprovalOwner, originalApprovalCeiling } from "./mcp-authority";

export const approvalChallengeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const approvalConsumeSchema = z.object({ challenge: approvalChallengeSchema }).strict();
const idSchema = z.string().uuid();
interface ApprovalLinkRow {
  id: string; tenant_id: string; commission_id: string; owner_session_id: string; request_id: string;
  expected_revision: number; approval_digest: string; challenge_hash: string; expires_at: Date; consumed_at: Date | null;
}
export interface ApprovalLinkPreview {
  id: string; commissionId: string; title: string; expectedRevision: number; capMinor: number;
  packageCount: number; expiresAt: string; passportUrl: string; approvalRequired: true; paymentAuthorized: false;
}
export interface ApprovalLinkConsumed { ok: true; commissionId: string; continueUrl: string; approvalRequired: true; paymentAuthorized: false }
function secret(): string {
  const value = process.env.AUTH_SECRET;
  if (!value || value.length < 24) throw new DomainError("APPROVAL_SIGNER_UNAVAILABLE", "The approval-link signer is unavailable. No approval was granted.", 503, true);
  return value;
}
const hashChallenge = (challenge: string) => createHash("sha256").update(challenge).digest("hex");
function challengeFor(row: Omit<ApprovalLinkRow, "challenge_hash" | "consumed_at">): string {
  return createHmac("sha256", secret()).update("guild.mcp.approval-link.challenge.v1\0").update(canonical({ id: row.id, tenantId: row.tenant_id, commissionId: row.commission_id, ownerSessionId: row.owner_session_id, requestId: row.request_id, revision: row.expected_revision, approvalDigest: row.approval_digest, expiresAt: row.expires_at.toISOString() })).digest("base64url");
}
function challengeMatches(row: ApprovalLinkRow, challenge: string): boolean {
  const expected = Buffer.from(row.challenge_hash, "hex"), actual = Buffer.from(hashChallenge(challenge), "hex");
  return expected.length === 32 && actual.length === expected.length && timingSafeEqual(expected, actual);
}
function linkResult(row: ApprovalLinkRow): McpApprovalLinkResult {
  const challenge = challengeFor(row);
  if (!challengeMatches(row, challenge)) throw new DomainError("APPROVAL_SIGNER_CHANGED", "This retained link cannot be reconstructed by the current signer. Its original expiry and identity have not been replaced.", 503, false);
  const url = new URL(`/approval/${row.id}`, marketOrigin()); url.searchParams.set("challenge", challenge);
  return { url: url.href, expiresAt: row.expires_at.toISOString(), commissionId: row.commission_id, expectedRevision: row.expected_revision, ownerInteractionRequired: true, paymentAuthorized: false };
}
const withClient = <T>(client: PoolClient | undefined, run: (db: PoolClient) => Promise<T>): Promise<T> => client ? run(client) : transaction(run);

/** Durable exact retries reconstruct the retained challenge; only its hash is stored. */
export async function issueApprovalLink(session: Session, raw: unknown, client?: PoolClient): Promise<McpApprovalLinkResult> {
  const input = mcpApprovalLinkSchema.parse(raw);
  return withClient(client, async db => {
    const owner = await lockApprovalOwner(db, session);
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`guild.mcp.approval-link:${owner.id}:${input.requestId}`]);
    const prior = (await db.query<ApprovalLinkRow>("SELECT * FROM guild_market_approval_links WHERE owner_session_id=$1 AND request_id=$2 FOR UPDATE", [owner.id, input.requestId])).rows[0];
    if (prior) {
      if (prior.tenant_id !== owner.tenantId || prior.commission_id !== input.commissionId || prior.expected_revision !== input.expectedRevision || prior.approval_digest !== input.approvalDigest) throw new DomainError("APPROVAL_REQUEST_CHANGED", "This request identity already belongs to different approval-link terms.", 409, false);
      return linkResult(prior);
    }
    const found = (await db.query<{ revision: number; snapshot: Commission }>("SELECT revision,snapshot FROM guild_commissions WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [input.commissionId, owner.tenantId])).rows[0];
    if (!found) throw new DomainError("NOT_FOUND", "This commission is not in your workspace.", 404, false);
    if (found.revision !== input.expectedRevision || found.snapshot.revision !== input.expectedRevision || planDigest(found.snapshot) !== input.approvalDigest) throw new DomainError("APPROVAL_PLAN_CHANGED", "The commission revision or plan changed. Review its current identity before requesting a link.", 409, false);
    const ceiling = await originalApprovalCeiling(db, found.snapshot, owner);
    const row: ApprovalLinkRow = { id: randomUUID(), tenant_id: owner.tenantId, commission_id: input.commissionId, owner_session_id: owner.id, request_id: input.requestId, expected_revision: input.expectedRevision, approval_digest: input.approvalDigest, challenge_hash: "", expires_at: new Date(Math.min(Date.now() + 10 * 60_000, ceiling)), consumed_at: null };
    row.challenge_hash = hashChallenge(challengeFor(row));
    await db.query("INSERT INTO guild_market_approval_links(id,tenant_id,commission_id,owner_session_id,request_id,expected_revision,approval_digest,challenge_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [row.id, row.tenant_id, row.commission_id, row.owner_session_id, row.request_id, row.expected_revision, row.approval_digest, row.challenge_hash, row.expires_at]);
    return linkResult(row);
  });
}
async function checkedLink(db: PoolClient, session: Session, id: string, challenge: string, consuming: boolean): Promise<{ row: ApprovalLinkRow; commission: Commission; ceiling: number }> {
  const owner = await lockApprovalOwner(db, session);
  const row = (await db.query<ApprovalLinkRow>(`SELECT * FROM guild_market_approval_links WHERE id=$1 AND tenant_id=$2 AND owner_session_id=$3 FOR ${consuming ? "UPDATE" : "SHARE"}`, [id, owner.tenantId, owner.id])).rows[0];
  if (!row || !challengeMatches(row, challenge)) throw new DomainError("APPROVAL_LINK_UNAVAILABLE", "This approval link is not available to this original owner workspace.", 404, false);
  if (row.consumed_at) throw new DomainError("APPROVAL_LINK_USED", "This one-use link has already been continued. Open your commission in the studio to inspect its current Passport.", 410, false);
  if (row.expires_at.getTime() <= Date.now()) throw new DomainError("APPROVAL_LINK_EXPIRED", "This link has expired. Its original authority was not extended.", 410, false);
  const found = (await db.query<{ revision: number; snapshot: Commission }>(`SELECT revision,snapshot FROM guild_commissions WHERE id=$1 AND tenant_id=$2 FOR ${consuming ? "UPDATE" : "SHARE"}`, [row.commission_id, owner.tenantId])).rows[0];
  if (!found || found.revision !== row.expected_revision || found.snapshot.revision !== row.expected_revision || planDigest(found.snapshot) !== row.approval_digest) throw new DomainError("APPROVAL_PLAN_CHANGED", "The commission or Passport plan changed. This link cannot continue a different revision.", 409, false);
  const ceiling = await originalApprovalCeiling(db, found.snapshot, owner);
  if (Math.min(ceiling, row.expires_at.getTime()) <= Date.now()) throw new DomainError("APPROVAL_LINK_EXPIRED", "This link or its original work authority has expired.", 410, false);
  return { row, commission: found.snapshot, ceiling };
}
/** GET/prefetch validates and reads. It never consumes the link or approves a plan. */
export async function previewApprovalLink(session: Session, rawId: unknown, rawChallenge: unknown, client?: PoolClient): Promise<ApprovalLinkPreview> {
  const id = idSchema.parse(rawId), challenge = approvalChallengeSchema.parse(rawChallenge);
  return withClient(client, async db => {
    const { row, commission } = await checkedLink(db, session, id, challenge, false);
    return { id: row.id, commissionId: commission.id, title: commission.title, expectedRevision: row.expected_revision, capMinor: commission.capMinor, packageCount: commission.packages.length, expiresAt: row.expires_at.toISOString(), passportUrl: `/?view=passport&commission=${encodeURIComponent(commission.id)}`, approvalRequired: true, paymentAuthorized: false };
  });
}
/** Only the link is consumed. Commission, Passport, production and payment stay untouched. */
export async function consumeApprovalLink(session: Session, rawId: unknown, rawChallenge: unknown, client?: PoolClient): Promise<ApprovalLinkConsumed> {
  const id = idSchema.parse(rawId), challenge = approvalChallengeSchema.parse(rawChallenge);
  return withClient(client, async db => {
    const { row, ceiling } = await checkedLink(db, session, id, challenge, true);
    const result = await db.query("UPDATE guild_market_approval_links SET consumed_at=clock_timestamp() WHERE id=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp() AND $5::timestamptz>clock_timestamp() AND EXISTS(SELECT 1 FROM guild_sessions s JOIN guild_tenants t ON t.id=s.tenant_id WHERE s.id=$2 AND s.tenant_id=$3 AND s.role=$4 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND t.expires_at>clock_timestamp()) RETURNING id", [row.id, session.id, session.tenantId, session.role, new Date(ceiling)]);
    if (result.rowCount !== 1) throw new DomainError("APPROVAL_LINK_EXPIRED", "This link expired before it could be continued. No approval was granted.", 410, false);
    return { ok: true, commissionId: row.commission_id, continueUrl: `/?view=passport&commission=${encodeURIComponent(row.commission_id)}`, approvalRequired: true, paymentAuthorized: false };
  });
}
