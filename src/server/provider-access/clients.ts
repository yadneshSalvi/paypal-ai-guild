import { AGENT_ACCESS_VERSION, CUSTOMER_AGENT_SCOPES, PROVIDER_AGENT_SCOPES, agentAccessSnapshotSchema, protocolClientSummarySchema,
  type AgentAccessScope, type AgentAccessSnapshot, type AgentEndpointInstruction, type AgentScope, type ProtocolClientSummary } from "@/contracts/provider-access";
import { DomainError } from "@/domain/primitives";
import { transaction } from "../db";
import type { Session } from "../session";
import type { MarketDb, ProviderRow } from "../provider-market/registry";
import { providerDisplayIdentity, requireAccessActor, type AccessActor } from "./identity";

export interface AccessClientRow {
  id: string; tenant_id: string; actor_id: string; token_hash: string; scopes: AgentScope[];
  provider_id: string | null; expires_at: Date; revoked_at: Date | null; created_at: Date;
  access_kind: AgentAccessScope | null; label: string | null; token_prefix: string | null;
  owner_identity: string | null; issued_command_id: string | null;
}
const actions: Record<AgentScope, string[]> = {
  mcp: ["commission.create: create an unapproved draft", "commission.status: read own commission", "approval.link: request the original owner's continuation"],
  a2a: ["Request and negotiate exact provider offers", "Delegate only under the current approved buyer plan", "Read or cancel eligible original tasks; never approve, accept work or pay"],
  "provider:read": ["Read only this provider's contracts, negotiations and tasks"],
  "provider:negotiate": ["Counter or decline this provider's offers inside its current owner policy"],
  "provider:cancel": ["Cancel eligible unstarted tasks addressed to this provider"],
};

export function clientSummary(row: AccessClientRow, actor: AccessActor): ProtocolClientSummary {
  const scope = row.access_kind ?? "customer";
  if (row.actor_id !== actor.session.id || row.tenant_id !== actor.session.tenantId || scope !== actor.scope
    || scope === "provider" && (row.provider_id !== actor.provider!.id || row.owner_identity !== actor.provider!.owner_identity)) {
    throw new DomainError("CLIENT_BINDING_CHANGED", "This credential does not match its original owner and provider binding.", 409, false);
  }
  const state = row.revoked_at ? "revoked" : row.expires_at.getTime() <= Date.now() ? "expired" : "active";
  return protocolClientSummarySchema.parse({ id: row.id, label: row.label ?? "Retained agent credential", prefix: row.token_prefix ?? "not-retained",
    scope, scopes: row.scopes, actorId: row.actor_id, providerId: row.provider_id, issuedAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(), revokedAt: row.revoked_at?.toISOString() ?? null, state,
    canRevoke: !row.revoked_at, permittedActions: row.scopes.flatMap(scope => actions[scope] ?? []) });
}

export async function ownClient(db: MarketDb, actor: AccessActor, id: string, lock = false): Promise<AccessClientRow> {
  const row = (await db.query<AccessClientRow>(`SELECT * FROM guild_market_protocol_clients WHERE id=$1 AND actor_id=$2 AND tenant_id=$3${lock ? " FOR UPDATE" : ""}`, [id, actor.session.id, actor.session.tenantId])).rows[0];
  if (!row) throw new DomainError("CLIENT_NOT_FOUND", "That credential is not available to this original owner.", 404, false);
  clientSummary(row, actor);
  return row;
}

async function endpoints(db: MarketDb, actor: AccessActor, origin: string): Promise<AgentEndpointInstruction[]> {
  if (actor.scope === "provider") return [{ id: "provider-agent", name: "Your provider agent API", protocol: "Guild provider agent API",
    url: `${origin}/api/provider-agent/workspace`, discoveryUrl: null, providerId: actor.provider!.id, authentication: "Bearer",
    scopes: [...PROVIDER_AGENT_SCOPES], allowedActions: PROVIDER_AGENT_SCOPES.flatMap(scope => actions[scope]),
    disclosure: "A scoped Guild API. It cannot edit owner policy or profile, issue credentials, approve buyer work, accept artifacts or move money. It is separate from MCP and A2A." }];
  const providers = (await db.query<ProviderRow>("SELECT * FROM guild_market_providers WHERE revoked_at IS NULL ORDER BY id")).rows;
  return [{ id: "commission-mcp", name: "Guild commissioning", protocol: "MCP", url: `${origin}/api/mcp`, discoveryUrl: null,
    providerId: null, authentication: "Bearer", scopes: ["mcp"], allowedActions: actions.mcp,
    disclosure: "Exactly three commissioning tools. An agent cannot consume the owner's browser continuation or approve its Passport." },
  ...providers.map((provider): AgentEndpointInstruction => ({ id: `a2a-${provider.id}`, name: provider.profile.displayName,
    protocol: "A2A", url: provider.endpoint, discoveryUrl: provider.card_url, providerId: provider.id, authentication: "Bearer",
    scopes: ["a2a"], allowedActions: actions.a2a,
    disclosure: "This is the exact enrolled service endpoint. Its current owner policy, discovery and contract authority still govern availability; reading these instructions does not discover or dispatch it." }))];
}

export async function agentAccessSnapshot(session: Session, scope: AgentAccessScope, origin: string): Promise<AgentAccessSnapshot> {
  return transaction(async db => {
    await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const actor = await requireAccessActor(db, session, scope);
    const clients = (await db.query<AccessClientRow>("SELECT * FROM guild_market_protocol_clients WHERE actor_id=$1 AND tenant_id=$2 ORDER BY created_at DESC,id", [session.id, session.tenantId])).rows;
    return agentAccessSnapshotSchema.parse({ version: AGENT_ACCESS_VERSION, scope, serverTime: new Date().toISOString(),
      viewer: { actorId: session.id, tenantId: session.tenantId, role: session.role,
        label: actor.provider?.profile.ownerDisplayName ?? "Customer workspace owner", sessionExpiresAt: session.expiresAt,
        providerBinding: actor.provider ? providerDisplayIdentity(actor.provider) : null },
      credentials: clients.map(row => clientSummary(row, actor)), allowedScopes: scope === "provider" ? [...PROVIDER_AGENT_SCOPES] : [...CUSTOMER_AGENT_SCOPES],
      endpoints: await endpoints(db, actor, origin), permissions: { issue: true, revoke: true },
      disclosure: "Credentials remain inside this original session's fixed expiry and scope. Raw tokens are shown once; retained summaries can be read and revoked, never used to mint an automatic replacement." });
  });
}
