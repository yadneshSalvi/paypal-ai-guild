import type { PoolClient } from "pg";
import { PROVIDER_AGENT_SCOPES, type ProviderAgentScope } from "@/contracts/provider-access";
import type { ProviderMarketCommand } from "@/contracts/provider-market";
import { digest, DomainError } from "@/domain/primitives";
import { getPool } from "../db";
import type { Session } from "../session";
import { clientSummary, type AccessClientRow } from "./clients";
import { requireAccessActor, secretHash, type AccessActor } from "./identity";

export interface ProviderAgentPrincipal extends AccessActor { clientId: string; scopes: ProviderAgentScope[] }
export async function authenticateProviderAgent(request: Request, permission: ProviderAgentScope): Promise<ProviderAgentPrincipal> {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ") || header.length > 1024) throw new DomainError("PROVIDER_AGENT_REQUIRED", "A scoped provider-agent credential is required. Browser cookies cannot replace it.", 401, false);
  const token = header.slice(7);
  if (!/^gp_[A-Za-z0-9_-]{43}$/.test(token)) throw new DomainError("PROVIDER_AGENT_REQUIRED", "This credential does not belong to the provider-agent API.", 401, false);
  const row = (await getPool().query<AccessClientRow>("SELECT * FROM guild_market_protocol_clients WHERE token_hash=$1 AND access_kind='provider' AND expires_at>clock_timestamp() AND revoked_at IS NULL", [secretHash(token)])).rows[0];
  if (!row || !row.scopes.includes("provider:read") || !row.scopes.includes(permission) || row.scopes.some(scope => !(PROVIDER_AGENT_SCOPES as readonly string[]).includes(scope))) {
    throw new DomainError("PROVIDER_AGENT_SCOPE", "This original provider credential does not permit that action.", 403, false);
  }
  const original = (await getPool().query<{ id: string; tenant_id: string; role: Session["role"]; expires_at: Date }>("SELECT id,tenant_id,role,expires_at FROM guild_sessions WHERE id=$1 AND tenant_id=$2 AND role='provider' AND revoked_at IS NULL AND expires_at>clock_timestamp()", [row.actor_id, row.tenant_id])).rows[0];
  if (!original) throw new DomainError("PROVIDER_AGENT_SESSION", "The original provider session is expired or revoked.", 401, false);
  const actor = await requireAccessActor(getPool(), { id: original.id, tenantId: original.tenant_id, role: original.role, expiresAt: original.expires_at.toISOString() }, "provider");
  clientSummary(row, actor);
  if (row.expires_at.getTime() > original.expires_at.getTime()) throw new DomainError("PROVIDER_AGENT_CEILING", "This credential exceeds its original provider session ceiling.", 403, false);
  return { ...actor, clientId: row.id, scopes: row.scopes as ProviderAgentScope[] };
}

/** The same transaction that changes an offer/task locks the original session
 * then credential, matching revocation's lock order. A preflight alone cannot
 * authorize a command after its credential was revoked. */
export async function recheckProviderAgent(db: PoolClient, principal: ProviderAgentPrincipal, permission: ProviderAgentScope, command: ProviderMarketCommand): Promise<void> {
  const session = principal.session;
  const active = await db.query("SELECT id FROM guild_sessions WHERE id=$1 AND tenant_id=$2 AND role='provider' AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE", [session.id, session.tenantId]);
  const row = (await db.query<AccessClientRow>("SELECT * FROM guild_market_protocol_clients WHERE id=$1 AND actor_id=$2 AND tenant_id=$3 AND access_kind='provider' AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE", [principal.clientId, session.id, session.tenantId])).rows[0];
  if (!active.rowCount || !row || !row.scopes.includes(permission) || JSON.stringify(row.scopes) !== JSON.stringify(principal.scopes)
    || row.provider_id !== principal.provider!.id || row.owner_identity !== principal.provider!.owner_identity
    || row.expires_at.getTime() > Date.parse(session.expiresAt)) {
    throw new DomainError("PROVIDER_AGENT_AUTHORITY", "The original provider credential is no longer valid for this command. No decision was made.", 401, false);
  }
  try { await requireAccessActor(db, session, "provider"); }
  catch (error) {
    if (!(error instanceof DomainError)) throw error;
    throw new DomainError("PROVIDER_AGENT_AUTHORITY", "The original provider identity is no longer available for this command.", 401, false);
  }
  const requestDigest = digest(command);
  const prior = (await db.query<{ request_digest: string }>("SELECT request_digest FROM guild_provider_agent_authorizations WHERE actor_id=$1 AND client_id=$2 AND command_id=$3", [session.id, principal.clientId, command.commandId])).rows[0];
  if (prior && prior.request_digest !== requestDigest) throw new DomainError("COMMAND_CHANGED", "This provider-agent command identity belongs to a different original request.", 409, false);
  if (!prior) await db.query("INSERT INTO guild_provider_agent_authorizations(actor_id,tenant_id,client_id,command_id,provider_id,owner_identity,permission,request_digest,decision_already_recorded) VALUES($1,$2,$3,$4,$5,$6,$7,$8,EXISTS(SELECT 1 FROM guild_market_commands WHERE actor_id=$1 AND command_id=$4)) ON CONFLICT(actor_id,client_id,command_id) DO NOTHING",
    [session.id, session.tenantId, principal.clientId, command.commandId, principal.provider!.id, principal.provider!.owner_identity, permission, requestDigest]);
}
