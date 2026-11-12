import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { canonical, DomainError } from "@/domain/primitives";
import type { Session } from "../session";
import { getPool } from "../db";
import { requireMarketSession, type MarketDb } from "./registry";
import type { MarketOperationRow } from "./snapshot";

const claimsSchema = z.object({ version: z.literal("guild.service-credential.v1"), providerId: z.string(), tenantId: z.string().uuid(),
  actorId: z.string().uuid(), operationId: z.string().uuid(), messageId: z.string().uuid(), requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  mode: z.enum(["dispatch", "read"]), expiresAt: z.string().datetime() }).strict();
type Claims = z.infer<typeof claimsSchema>;
export interface ProtocolPrincipal { session: Session; providerId: string | null; scopes: string[]; clientId: string; operation: Claims | null }
const tokenHash = (value: string) => createHash("sha256").update(value).digest("hex");
function signature(value: string): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 24) throw new DomainError("SERVICE_AUTH_UNAVAILABLE", "The service credential signer is unavailable.", 503, false);
  return createHmac("sha256", secret).update(`guild-provider-service-v1:${value}`).digest("base64url");
}

export function issueProviderCredential(op: MarketOperationRow, session: Session, mode: Claims["mode"]): string {
  const expires = Math.min(Date.now() + 5 * 60_000, Date.parse(session.expiresAt), mode === "dispatch" ? op.original_work_ceiling.getTime() : Infinity);
  if (expires <= Date.now()) throw new DomainError("SERVICE_AUTH_EXPIRED", "This original operation no longer has authority for new dispatch.", 422, false);
  const claims = claimsSchema.parse({ version: "guild.service-credential.v1", providerId: op.provider_id, tenantId: op.tenant_id,
    actorId: op.actor_id, operationId: op.id, messageId: op.original_message_id, requestDigest: op.request_digest, mode, expiresAt: new Date(expires).toISOString() });
  const payload = Buffer.from(canonical(claims)).toString("base64url");
  return `g1.${payload}.${signature(payload)}`;
}

async function activeActor(db: MarketDb, id: string, tenantId: string): Promise<Session> {
  const row = (await db.query<{ id: string; tenant_id: string; role: Session["role"]; expires_at: Date }>("SELECT id,tenant_id,role,expires_at FROM guild_sessions WHERE id=$1 AND tenant_id=$2 AND expires_at>now() AND revoked_at IS NULL", [id, tenantId])).rows[0];
  if (!row) throw new DomainError("SERVICE_AUTH_REQUIRED", "The service credential's original workspace is unavailable.", 401, false);
  const session = { id: row.id, tenantId: row.tenant_id, role: row.role, expiresAt: row.expires_at.toISOString() };
  await requireMarketSession(db, session); return session;
}

export async function authenticateProtocol(request: Request, requiredScope: "a2a" | "mcp", providerId?: string): Promise<ProtocolPrincipal> {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ") || header.length > 4096) throw new DomainError("SERVICE_AUTH_REQUIRED", "An authorized service credential is required.", 401, false);
  const token = header.slice(7), db = getPool();
  if (token.startsWith("g1.")) {
    if (requiredScope !== "a2a") throw new DomainError("SERVICE_SCOPE", "This provider credential cannot call commission tools.", 403, false);
    const parts = token.split(".");
    if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1]!) || !/^[A-Za-z0-9_-]+$/.test(parts[2]!)) throw new DomainError("SERVICE_AUTH_REQUIRED", "The service credential is invalid.", 401, false);
    const expected = Buffer.from(signature(parts[1]!)), actual = Buffer.from(parts[2]!);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new DomainError("SERVICE_AUTH_REQUIRED", "The service credential is invalid.", 401, false);
    let claims: Claims;
    try { claims = claimsSchema.parse(JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"))); }
    catch { throw new DomainError("SERVICE_AUTH_REQUIRED", "The service credential is invalid.", 401, false); }
    if (claims.providerId !== providerId || Date.parse(claims.expiresAt) <= Date.now()) throw new DomainError("SERVICE_AUTH_REQUIRED", "The service credential is expired or belongs to another provider.", 401, false);
    const op = (await db.query<MarketOperationRow>("SELECT * FROM guild_market_operations WHERE id=$1 AND tenant_id=$2 AND actor_id=$3 AND provider_id=$4", [claims.operationId, claims.tenantId, claims.actorId, providerId])).rows[0];
    if (!op || op.request_digest !== claims.requestDigest || op.original_message_id !== claims.messageId) throw new DomainError("SERVICE_OPERATION_CHANGED", "The service credential differs from its retained operation.", 403, false);
    const session = await activeActor(db, claims.actorId, claims.tenantId);
    return { session, providerId: claims.providerId, scopes: ["a2a", claims.mode], clientId: op.id, operation: claims };
  }
  const client = (await db.query<{ id: string; tenant_id: string; actor_id: string; scopes: string[]; provider_id: string | null }>("SELECT id,tenant_id,actor_id,scopes,provider_id FROM guild_market_protocol_clients WHERE token_hash=$1 AND access_kind IS DISTINCT FROM 'provider' AND expires_at>now() AND revoked_at IS NULL", [tokenHash(token)])).rows[0];
  if (!client || !client.scopes.includes(requiredScope) || client.provider_id && client.provider_id !== providerId) throw new DomainError("SERVICE_AUTH_REQUIRED", "The service credential is invalid for this endpoint.", 401, false);
  return { session: await activeActor(db, client.actor_id, client.tenant_id), providerId: client.provider_id,
    scopes: client.scopes, clientId: client.id, operation: null };
}

/** Explicit deployment/invitation setup only. The raw token is returned once to
 * the caller for private delivery; it is never persisted in a public record. */
export async function createProtocolClient(db: MarketDb, session: Session, scopes: ("a2a" | "mcp")[], providerId: string | null, expiresAt: string): Promise<{ id: string; token: string }> {
  await requireMarketSession(db, session);
  if (!["owner", "judge"].includes(session.role) || !scopes.length || new Set(scopes).size !== scopes.length || Date.parse(expiresAt) > Date.parse(session.expiresAt) || Date.parse(expiresAt) <= Date.now()) throw new DomainError("CLIENT_AUTHORITY", "A service client must stay inside its current owner's session and explicit scopes.", 422, false);
  const id = randomUUID(), token = `gc_${randomBytes(32).toString("base64url")}`;
  await db.query("INSERT INTO guild_market_protocol_clients(id,tenant_id,actor_id,token_hash,scopes,provider_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)", [id, session.tenantId, session.id, tokenHash(token), JSON.stringify(scopes), providerId, expiresAt]);
  return { id, token };
}
