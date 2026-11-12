import { randomUUID } from "node:crypto";
import { AgentCard } from "@a2a-js/sdk";
import type { Pool, PoolClient } from "pg";
import { A2A_PROTOCOL, MARKET_EXTENSION, providerPolicyInputSchema, providerProfileInputSchema, type MarketProvider, type ProviderPolicy, type ProviderPolicyInput } from "@/contracts/provider-market";
import { providerDefinitions } from "@/domain/fixture";
import { digest, DomainError } from "@/domain/primitives";
import type { Session } from "../session";

export type MarketDb = Pool | PoolClient;
export interface ProviderRow {
  id: string; profile: Omit<MarketProvider, "id">; profile_revision: number; monogram: string; color: string; kinds: MarketProvider["kinds"];
  owner_identity: string; provenance: MarketProvider["provenance"]["kind"]; synthetic_fixture: boolean;
  endpoint: string; card_url: string; enrollment_state: MarketProvider["enrollment"]["state"];
  current_policy_revision: number; observed_card: unknown; card_digest: string | null; card_observed_at: Date | null;
  last_failure: string | null; revoked_at: Date | null;
}

export function marketOrigin(): string {
  const value = process.env.GUILD_MARKET_APP_URL;
  if (!value) throw new DomainError("MARKET_NOT_CONFIGURED", "Provider discovery is not configured for this Guild deployment.", 503, true);
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)))) {
    throw new DomainError("MARKET_ORIGIN", "The configured provider origin must be an HTTPS origin or an explicit local qualification host.", 503, false);
  }
  return url.origin;
}

export async function requireMarketSession(db: MarketDb, session: Session): Promise<void> {
  const found = await db.query("SELECT s.id FROM guild_sessions s JOIN guild_tenants t ON t.id=s.tenant_id WHERE s.id=$1 AND s.tenant_id=$2 AND s.role=$3 AND s.expires_at>now() AND s.revoked_at IS NULL AND t.expires_at>now()", [session.id, session.tenantId, session.role]);
  if (!found.rowCount) throw new DomainError("SESSION_EXPIRED", "This workspace session has expired or was revoked.", 401, false);
}

export async function boundProvider(db: MarketDb, session: Session, required = true): Promise<string | null> {
  if (session.role !== "provider") {
    if (required) throw new DomainError("PROVIDER_OWNER_REQUIRED", "This action needs the provider owner's own console.", 403, false);
    return null;
  }
  const row = (await db.query<{ provider_id: string }>("SELECT b.provider_id FROM guild_market_provider_sessions b JOIN guild_market_providers p ON p.id=b.provider_id AND p.owner_identity=b.owner_identity WHERE b.session_id=$1 AND b.revoked_at IS NULL AND p.revoked_at IS NULL", [session.id])).rows[0];
  if (!row && required) throw new DomainError("PROVIDER_IDENTITY_REQUIRED", "This session has no active provider-owner binding. Open the console from your provider invitation.", 403, false);
  return row?.provider_id ?? null;
}

export async function providerRow(db: MarketDb, id: string, lock = false): Promise<ProviderRow> {
  const row = (await db.query<ProviderRow>(`SELECT * FROM guild_market_providers WHERE id=$1${lock ? " FOR UPDATE" : ""}`, [id])).rows[0];
  if (!row) throw new DomainError("PROVIDER_NOT_FOUND", "That provider is not enrolled in this marketplace.", 404, false);
  return row;
}

export async function currentProviderPolicy(db: MarketDb, row: ProviderRow): Promise<ProviderPolicy | null> {
  return (await db.query<{ policy: ProviderPolicy }>("SELECT policy FROM guild_market_policies WHERE provider_id=$1 AND revision=$2", [row.id, row.current_policy_revision])).rows[0]?.policy ?? null;
}

export async function providerCapacity(db: MarketDb, id: string): Promise<{ active: number; reserved: number }> {
  const row = (await db.query<{ active: number; reserved: number }>("SELECT count(*) FILTER (WHERE state='working')::int AS active,count(*) FILTER (WHERE state IN ('submitted','input_required','auth_required'))::int AS reserved FROM guild_market_tasks WHERE provider_id=$1", [id])).rows[0];
  return row ?? { active: 0, reserved: 0 };
}

export async function listMarketProviders(db: MarketDb, canEditProvider: string | null): Promise<MarketProvider[]> {
  const rows = (await db.query<ProviderRow>("SELECT * FROM guild_market_providers ORDER BY created_at,id")).rows;
  const result: MarketProvider[] = [];
  for (const row of rows) {
    const policy = await currentProviderPolicy(db, row), capacity = await providerCapacity(db, row.id);
    const expired = !!policy && Date.parse(policy.validUntil) <= Date.now();
    const state = row.revoked_at ? "revoked" : expired ? "unavailable" : row.enrollment_state;
    const actions = state === "profile_required" ? ["Complete your profile"] : !policy ? ["Set your work policy"] : state === "discovery_required" || state === "unavailable" ? [expired ? "Update the expired policy" : "Check the service connection"] : [];
    result.push({ ...providerProfileInputSchema.parse(row.profile), id: row.id, monogram: row.monogram, color: row.color, kinds: row.kinds,
      endpoint: row.endpoint, cardUrl: row.card_url,
      protocol: { specification: "1.0.1", version: "1.0", binding: "JSONRPC", cardDigest: row.card_digest, observedAt: row.card_observed_at?.toISOString() ?? null,
        streaming: (row.observed_card as { capabilities?: { streaming?: boolean } } | null)?.capabilities?.streaming === true },
      enrollment: { state, revision: row.profile_revision, message: state === "ready" ? "Profile, owner policy and service discovery are ready." : (row.last_failure ?? actions.join(" · ")) || "This provider is unavailable.",
        requiredActions: actions, lastFailure: row.last_failure, canEdit: canEditProvider === row.id },
      policy, capacity: { ...capacity, maximum: policy?.maximumConcurrentTasks ?? 0 }, history: null,
      provenance: { kind: row.provenance, label: row.provenance === "guild_controlled_service" ? "Guild-operated demonstration service" : "Enrolled external service", syntheticFixture: row.synthetic_fixture } });
  }
  return result;
}

export async function saveProviderPolicy(db: PoolClient, row: ProviderRow, session: Session, input: ProviderPolicyInput): Promise<ProviderPolicy> {
  const parsed = providerPolicyInputSchema.parse(input);
  if (Date.parse(parsed.validUntil) <= Date.now()) throw new DomainError("POLICY_EXPIRED", "Set a future expiry for new offers. Earlier offers retain their original deadline.", 422, false);
  if (parsed.allowedKinds.some(kind => !row.kinds.includes(kind))) throw new DomainError("POLICY_CAPABILITY", "The policy cannot offer a work type this service does not implement.", 422, false);
  const previous = await currentProviderPolicy(db, row), id = randomUUID(), revision = row.current_policy_revision + 1;
  const value = { ...parsed, id, providerId: row.id, revision, previousDigest: previous?.digest ?? null, ownerId: row.owner_identity,
    createdAt: new Date().toISOString(), disclosure: row.synthetic_fixture ? "Policy set by the controlled demonstration provider owner." : "Versioned policy set by this provider owner." };
  const policy: ProviderPolicy = { ...value, digest: digest(value) };
  await db.query("INSERT INTO guild_market_policies(provider_id,revision,id,digest,previous_digest,policy,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7)", [row.id, revision, id, policy.digest, policy.previousDigest, policy, session.id]);
  await db.query("UPDATE guild_market_providers SET current_policy_revision=$2,enrollment_state=CASE WHEN card_digest IS NULL THEN 'discovery_required' ELSE 'ready' END,last_failure=NULL,updated_at=now() WHERE id=$1", [row.id, revision]);
  return policy;
}

/** Deployment setup is explicit. Reading a marketplace never invents providers. */
export async function configureControlledProviders(db: PoolClient, syntheticFixture: boolean): Promise<void> {
  const origin = marketOrigin();
  for (const item of providerDefinitions) {
    const endpoint = `${origin}/api/providers/${item.id}/a2a`, cardUrl = `${origin}/api/providers/${item.id}/.well-known/agent-card.json`;
    const profile = { displayName: item.name, ownerDisplayName: `${item.name} owner`, specialty: item.specialty,
      description: item.description, portfolioUrl: null };
    const prior = (await db.query<ProviderRow>("SELECT * FROM guild_market_providers WHERE id=$1", [item.id])).rows[0];
    if (prior) {
      if (prior.endpoint !== endpoint || prior.card_url !== cardUrl || prior.synthetic_fixture !== syntheticFixture || prior.provenance !== "guild_controlled_service") throw new DomainError("PROVIDER_SETUP_CHANGED", "Existing provider setup differs. Review a separate configuration migration.", 409, false);
      continue;
    }
    await db.query("INSERT INTO guild_market_providers(id,profile,monogram,color,kinds,owner_identity,provenance,synthetic_fixture,endpoint,card_url,enrollment_state) VALUES($1,$2,$3,$4,$5,$6,'guild_controlled_service',$7,$8,$9,'policy_required')",
      [item.id, profile, item.monogram, item.color, JSON.stringify(item.kinds), randomUUID(), syntheticFixture, endpoint, cardUrl]);
  }
}

export function providerAgentCard(row: ProviderRow): AgentCard {
  return AgentCard.fromJSON({ name: row.profile.displayName, description: `${row.profile.description} Guild-operated service; artifact completion is separate from customer acceptance and payment.`,
    version: "1.0.0", provider: { organization: "Guild demonstration network", url: `${marketOrigin()}/market` },
    supportedInterfaces: [{ url: row.endpoint, protocolBinding: "JSONRPC", protocolVersion: A2A_PROTOCOL.protocolVersion }],
    capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: false,
      extensions: [{ uri: MARKET_EXTENSION, description: "Contract-bound offers and delegated work under current buyer and provider policies.", required: true, params: { providerId: row.id, sourceSpecification: "1.0.1" } }] },
    securitySchemes: { guild: { httpAuthSecurityScheme: { scheme: "Bearer", bearerFormat: "Guild scoped service credential" } } },
    securityRequirements: [{ schemes: { guild: { list: [] } } }], defaultInputModes: ["application/json"], defaultOutputModes: ["application/json"],
    skills: row.kinds.map(kind => ({ id: kind, name: row.profile.specialty, description: `Quote, negotiate and produce ${kind} work under an approved current contract.`, tags: [kind, "guild"], examples: [], inputModes: ["application/json"], outputModes: ["application/json"], securityRequirements: [] })) });
}

export async function discoverProvider(row: ProviderRow, fetcher: typeof fetch = fetch): Promise<{ card: unknown; cardDigest: string }> {
  // Endpoint enrollment is separate from discovery. No browser/model-supplied URL is fetched.
  const origin = marketOrigin();
  if (row.provenance !== "guild_controlled_service" || row.card_url !== `${origin}/api/providers/${row.id}/.well-known/agent-card.json` || row.endpoint !== `${origin}/api/providers/${row.id}/a2a`) {
    throw new DomainError("PROVIDER_ENROLLMENT_REQUIRED", "External services need verified endpoint ownership before discovery is enabled.", 422, false);
  }
  const response = await fetcher(row.card_url, { redirect: "error", signal: AbortSignal.timeout(8000), headers: { Accept: "application/json" }, cache: "no-store" });
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) throw new DomainError("PROVIDER_DISCOVERY_UNAVAILABLE", "The provider did not return an available agent card.", 502, true);
  const reader = response.body?.getReader(); if (!reader) throw new DomainError("PROVIDER_CARD_EMPTY", "The provider returned no card.", 502, true);
  const parts: Uint8Array[] = []; let bytes = 0;
  try { for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.length; if (bytes > 65_536) { await reader.cancel(); throw new DomainError("PROVIDER_CARD_TOO_LARGE", "The provider card exceeds the discovery limit.", 502, false); } parts.push(next.value); } }
  finally { reader.releaseLock(); }
  const raw = JSON.parse(Buffer.concat(parts).toString("utf8")), card = AgentCard.fromJSON(raw), expected = providerAgentCard(row);
  if (digest(AgentCard.toJSON(card)) !== digest(AgentCard.toJSON(expected))) throw new DomainError("PROVIDER_CARD_CHANGED", "The discovered card differs from the enrolled service identity or capabilities.", 502, false);
  return { card: AgentCard.toJSON(card), cardDigest: digest(AgentCard.toJSON(card)) };
}
