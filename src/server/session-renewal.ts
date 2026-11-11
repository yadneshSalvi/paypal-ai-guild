import { z } from "zod";
import { DomainError } from "@/domain/primitives";
import { transaction } from "./db";
import { sessionFromToken, type Session } from "./session";

export const renewalInput = z.object({ requestId: z.uuid(), expectedExpiresAt: z.iso.datetime() }).strict();

/** Interactive continuation of the same active workspace. Never revives expired access. */
export async function renewWorkspace(cookie: string | undefined, raw: unknown): Promise<Session> {
  const input = renewalInput.parse(raw), authenticated = await sessionFromToken(cookie);
  if (!authenticated) throw new DomainError("SESSION_REQUIRED", "This workspace session has ended. Its saved work is retained.", 401);
  return transaction(async db => {
    const row = (await db.query<{id:string;tenant_id:string;role:Session["role"];expires_at:Date;revoked_at:Date|null;now:Date}>(
      "SELECT id,tenant_id,role,expires_at,revoked_at,clock_timestamp() AS now FROM guild_sessions WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
      [authenticated.id, authenticated.tenantId]
    )).rows[0];
    if (!row || row.revoked_at || row.expires_at <= row.now) throw new DomainError("SESSION_REQUIRED", "This workspace session has ended. Its saved work is retained.", 401);
    if (!["judge", "owner"].includes(row.role)) throw new DomainError("RENEWAL_ROLE", "Only the workspace owner can continue this session.", 403);
    const saved = (await db.query<{previous_expires_at:Date;renewed_expires_at:Date}>("SELECT previous_expires_at,renewed_expires_at FROM guild_session_renewals WHERE session_id=$1 AND request_id=$2", [row.id,input.requestId])).rows[0];
    if (saved) {
      if (saved.previous_expires_at.toISOString() !== input.expectedExpiresAt) throw new DomainError("RENEWAL_CHANGED", "This continuation request already belongs to a different session revision.", 409);
      return {id:row.id,tenantId:row.tenant_id,role:row.role,expiresAt:row.expires_at.toISOString()};
    }
    if (row.expires_at.toISOString() !== input.expectedExpiresAt) throw new DomainError("SESSION_CHANGED", "Your workspace was already continued. Refresh its current access time.", 409);
    if (row.expires_at.getTime()-row.now.getTime() > 3600000) throw new DomainError("RENEWAL_EARLY", "You can continue the workspace during the final hour of its session.", 409);
    const expiresAt = new Date(row.now.getTime()+8*3600000).toISOString();
    await db.query("UPDATE guild_sessions SET expires_at=$2 WHERE id=$1",[row.id,expiresAt]);
    await db.query("UPDATE guild_tenants SET expires_at=greatest(expires_at,$2) WHERE id=$1",[row.tenant_id,expiresAt]);
    await db.query("INSERT INTO guild_session_renewals(session_id,request_id,previous_expires_at,renewed_expires_at) VALUES($1,$2,$3,$4)",[row.id,input.requestId,row.expires_at,expiresAt]);
    // No mandate, checkout challenge, acceptance, payment intent or provider credential changes.
    return {id:row.id,tenantId:row.tenant_id,role:row.role,expiresAt};
  });
}
