import { createHash } from "node:crypto";
import { providerDisplayIdentitySchema, type AgentAccessScope, type ProviderDisplayIdentity } from "@/contracts/provider-access";
import { digest, DomainError } from "@/domain/primitives";
import type { Session } from "../session";
import { boundProvider, providerRow, type MarketDb, type ProviderRow } from "../provider-market/registry";

export const secretHash = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Display/policy revisions do not change who owns the enrolled service. */
export function providerBindingDigest(row: ProviderRow): string {
  return digest({ id: row.id, ownerIdentity: row.owner_identity, endpoint: row.endpoint, cardUrl: row.card_url,
    kinds: row.kinds, provenance: row.provenance, syntheticFixture: row.synthetic_fixture });
}

export function providerDisplayIdentity(row: ProviderRow): ProviderDisplayIdentity {
  return providerDisplayIdentitySchema.parse({ id: row.id, displayName: row.profile.displayName,
    ownerDisplayName: row.profile.ownerDisplayName, ownerIdentity: row.owner_identity,
    specialty: row.profile.specialty, description: row.profile.description, bindingDigest: providerBindingDigest(row),
    provenance: { kind: row.provenance, syntheticFixture: row.synthetic_fixture,
      label: row.provenance === "guild_controlled_service" ? "Guild-operated service" : "Enrolled external service" } });
}

export interface AccessActor { scope: AgentAccessScope; session: Session; provider: ProviderRow | null }
export async function requireAccessActor(db: MarketDb, session: Session, scope: AgentAccessScope): Promise<AccessActor> {
  const current = await db.query("SELECT s.id FROM guild_sessions s JOIN guild_tenants t ON t.id=s.tenant_id WHERE s.id=$1 AND s.tenant_id=$2 AND s.role=$3 AND date_trunc('milliseconds',s.expires_at)=$4 AND s.expires_at>clock_timestamp() AND s.revoked_at IS NULL AND t.expires_at>clock_timestamp()", [session.id, session.tenantId, session.role, session.expiresAt]);
  if (!current.rowCount) throw new DomainError("SESSION_EXPIRED", "This original workspace session expired, was revoked or changed. It cannot be renewed by an access command.", 401, false);
  if (scope === "customer") {
    if (!["owner", "judge"].includes(session.role)) throw new DomainError("CUSTOMER_ACCESS_REQUIRED", "Open agent connections from your original customer workspace.", 403, false);
    return { scope, session, provider: null };
  }
  const id = await boundProvider(db, session);
  return { scope, session, provider: await providerRow(db, id!) };
}
