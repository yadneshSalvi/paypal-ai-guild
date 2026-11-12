import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import { sampleEntryRequestSchema, type SampleEntryRequest } from "@/contracts/sample-entry";
import { canonical, digest, DomainError } from "@/domain/primitives";
import { transaction } from "./db";
import { seedCommissionWithClient } from "./commissions";
import type { Session } from "./session";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function secret(value?: string): string { const key = value ?? process.env.JUDGE_SESSION_SECRET; if (!key || key.length < 24) throw new DomainError("SAMPLE_ENTRY_UNAVAILABLE", "Sample entry is not configured on this host.", 503, false); return key; }
function uuid(key: string, purpose: string, requestId: string): string {
  const bytes = createHmac("sha256", key).update(`guild.sample-entry.${purpose}.v1:${requestId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 64; bytes[8] = (bytes[8]! & 63) | 128;
  const value = bytes.toString("hex"); return `${value.slice(0,8)}-${value.slice(8,12)}-${value.slice(12,16)}-${value.slice(16,20)}-${value.slice(20)}`;
}
export function sampleEntryIdentity(raw: SampleEntryRequest, signingKey?: string) {
  const request = sampleEntryRequestSchema.parse(raw), key = secret(signingKey);
  const token = createHmac("sha256", key).update("guild.sample-entry.token.v1:" + canonical(request)).digest("base64url");
  return { request, id: uuid(key, "session", request.requestId), tenantId: uuid(key, "tenant", request.requestId), tokenHash: hash(token),
    cookie: `${token}.${createHmac("sha256", key).update(token).digest("hex")}` };
}
export interface SampleEntryResult { session: Session; cookie: string; commissionId: string; created: boolean }
/** Caller owns this transaction. The original session and first commission are
 * committed together; no nested pool lease, replacement or renewal is used. */
export async function openSampleEntryWithClient(db: PoolClient, raw: SampleEntryRequest, bucket: string, signingKey?: string): Promise<SampleEntryResult> {
  const identity = sampleEntryIdentity(raw, signingKey);
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["guild.sample-entry:" + identity.id]);
  const now = (await db.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now;
  const existing = (await db.query<{ id: string; tenant_id: string; token_hash: string; role: Session["role"]; expires_at: Date; revoked_at: Date | null; tenant_mode: string; tenant_expires_at: Date; original_expires_at: Date | null }>(
    "SELECT s.id,s.tenant_id,s.token_hash,s.role,s.expires_at,s.revoked_at,t.mode AS tenant_mode,t.expires_at AS tenant_expires_at,(SELECT r.previous_expires_at FROM guild_session_renewals r WHERE r.session_id=s.id ORDER BY r.created_at,r.request_id LIMIT 1) AS original_expires_at FROM guild_sessions s JOIN guild_tenants t ON t.id=s.tenant_id WHERE s.id=$1 FOR UPDATE OF s,t", [identity.id])).rows[0];
  if (existing) {
    const actual = Buffer.from(existing.token_hash), expected = Buffer.from(identity.tokenHash);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected) || existing.tenant_id !== identity.tenantId || existing.role !== "judge" || existing.tenant_mode !== "judge") throw new DomainError("SAMPLE_ENTRY_CHANGED", "This entry belongs to its original request. Keep that request to recover it.", 409, false);
    const expiresAt = existing.original_expires_at ?? existing.expires_at;
    if (existing.revoked_at || expiresAt.getTime() <= now.getTime() || existing.expires_at.getTime() <= now.getTime() || existing.tenant_expires_at.getTime() <= now.getTime()) throw new DomainError("SAMPLE_ENTRY_EXPIRED", "This original Sample session has ended. Its records remain retained; recovery cannot renew it.", 410, false);
    const first = (await db.query<{ id: string }>("SELECT id FROM guild_commissions WHERE tenant_id=$1 ORDER BY created_at,id LIMIT 1", [existing.tenant_id])).rows[0];
    if (!first) throw new DomainError("SAMPLE_ENTRY_INCOMPLETE", "The original Sample needs recovery on this host. No replacement was created.", 503, false);
    return { session: { id: existing.id, tenantId: existing.tenant_id, role: existing.role, expiresAt: expiresAt.toISOString() }, cookie: identity.cookie, commissionId: first.id, created: false };
  }
  const requestedAt = Date.parse(identity.request.requestedAt);
  if (requestedAt > now.getTime() + 30_000 || requestedAt < now.getTime() - 300_000) throw new DomainError("SAMPLE_ENTRY_EXPIRED", "This unopened entry has expired. Choose a separate Sample explicitly to begin again.", 410, false);
  if (!/^entry:[a-f0-9]{64}$/.test(bucket)) throw new DomainError("SAMPLE_ENTRY_UNAVAILABLE", "Sample entry is unavailable for this request.", 503, false);
  const rate = (await db.query<{ count: number }>("INSERT INTO guild_rate_limits(bucket,window_start,count) VALUES($1,now(),1) ON CONFLICT(bucket) DO UPDATE SET count=CASE WHEN guild_rate_limits.window_start<now()-interval '60 minutes' THEN 1 ELSE guild_rate_limits.count+1 END,window_start=CASE WHEN guild_rate_limits.window_start<now()-interval '60 minutes' THEN now() ELSE guild_rate_limits.window_start END RETURNING count", [bucket])).rows[0]!;
  if (rate.count > 20) throw new DomainError("RATE_LIMIT", "Sample entry has reached its current operation limit. Try again later.", 429, false);
  const expiresAt = new Date(Math.min(requestedAt, now.getTime()) + 8 * 3_600_000).toISOString();
  const session: Session = { id: identity.id, tenantId: identity.tenantId, role: "judge", expiresAt };
  await db.query("INSERT INTO guild_tenants(id,expires_at,mode) VALUES($1,$2,'judge')", [session.tenantId, expiresAt]);
  await db.query("INSERT INTO guild_sessions(id,tenant_id,token_hash,role,expires_at) VALUES($1,$2,$3,'judge',$4)", [session.id, session.tenantId, identity.tokenHash, expiresAt]);
  const commission = await seedCommissionWithClient(db, session);
  return { session, cookie: identity.cookie, commissionId: commission.id, created: true };
}
export async function openSampleEntry(raw: SampleEntryRequest, bucket: string): Promise<SampleEntryResult> { return transaction(db => openSampleEntryWithClient(db, raw, bucket)); }

/** An authenticated empty workspace retains its original role, cookie and expiry.
 * A receipt binds any first Sample creation to the exact explicit request. */
export async function openSampleForSessionWithClient(db: PoolClient, original: Session, raw: SampleEntryRequest): Promise<{session:Session;commissionId:string;created:boolean}> {
  const request=sampleEntryRequestSchema.parse(raw),payloadHash=digest({version:"guild.existing-sample-entry.v1",actor:original.id,request});
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["guild.sample-existing-entry:"+original.tenantId]);
  const row=(await db.query<{id:string;tenant_id:string;role:Session["role"];expires_at:Date;revoked_at:Date|null;tenant_expires_at:Date}>("SELECT s.id,s.tenant_id,s.role,s.expires_at,s.revoked_at,t.expires_at AS tenant_expires_at FROM guild_sessions s JOIN guild_tenants t ON t.id=s.tenant_id WHERE s.id=$1 AND s.tenant_id=$2 FOR UPDATE OF s,t",[original.id,original.tenantId])).rows[0];
  const now=(await db.query<{now:Date}>("SELECT clock_timestamp() AS now")).rows[0]!.now;
  if(!row||row.revoked_at||row.expires_at<=now||row.tenant_expires_at<=now)throw new DomainError("SESSION_REQUIRED","The original workspace session has ended. No replacement was created.",401,false);
  if(!["owner","judge","operator"].includes(row.role)||row.role!==original.role)throw new DomainError("ROLE_DENIED","Use your original customer workspace to open a commission.",403,false);
  const session:Session={id:row.id,tenantId:row.tenant_id,role:row.role,expiresAt:row.expires_at.toISOString()};
  const prior=(await db.query<{payload_hash:string;commission_id:string;result:{version?:string}}>("SELECT payload_hash,commission_id,result FROM guild_commands WHERE tenant_id=$1 AND command_id=$2",[session.tenantId,request.requestId])).rows[0];
  if(prior){
    if(prior.payload_hash!==payloadHash||prior.result.version!=="guild.existing-sample-entry.v1")throw new DomainError("SAMPLE_ENTRY_CHANGED","This entry identity already belongs to its original request.",409,false);
    if(!(await db.query("SELECT 1 FROM guild_commissions WHERE id=$1 AND tenant_id=$2",[prior.commission_id,session.tenantId])).rowCount)throw new DomainError("SAMPLE_ENTRY_INCOMPLETE","The original commission is unavailable. No replacement was created.",503,false);
    return {session,commissionId:prior.commission_id,created:false};
  }
  const current=(await db.query<{id:string}>("SELECT id FROM guild_commissions WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",[session.tenantId])).rows[0];
  if(current)return {session,commissionId:current.id,created:false};
  const requestedAt=Date.parse(request.requestedAt);
  if(requestedAt>now.getTime()+30_000||requestedAt<now.getTime()-300_000)throw new DomainError("SAMPLE_ENTRY_EXPIRED","This unopened entry has expired. Choose a separate Sample explicitly to begin again.",410,false);
  const commission=await seedCommissionWithClient(db,session);
  await db.query("INSERT INTO guild_commands(tenant_id,command_id,commission_id,payload_hash,result) VALUES($1,$2,$3,$4,$5)",[session.tenantId,request.requestId,commission.id,payloadHash,{version:"guild.existing-sample-entry.v1",commissionId:commission.id}]);
  return {session,commissionId:commission.id,created:true};
}
export async function openSampleForSession(session:Session,request:SampleEntryRequest){return transaction(db=>openSampleForSessionWithClient(db,session,request));}
