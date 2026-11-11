import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { getPool, transaction } from "./db";
import { DomainError } from "@/domain/primitives";

export const SESSION_COOKIE = "guild_session";
export interface Session { id: string; tenantId: string; role: "judge" | "owner" | "provider" | "operator"; expiresAt: string }
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
function sign(token:string):string { const secret=process.env.JUDGE_SESSION_SECRET;if(!secret)throw new Error("JUDGE_SESSION_SECRET is required");return createHmac("sha256",secret).update(token).digest("hex"); }
function validate(value:string):string|null {const [token,signature]=value.split(".");if(!token||!signature||!/^[a-f0-9]{64}$/.test(signature))return null;const expected=Buffer.from(sign(token));const got=Buffer.from(signature);return got.length===expected.length&&timingSafeEqual(got,expected)?token:null;}
export async function sessionFromToken(value:string|undefined):Promise<Session|null>{
  if(!value)return null;const token=validate(value);if(!token)return null;
  const result=await getPool().query<{id:string;tenant_id:string;role:Session["role"];expires_at:Date}>("SELECT id,tenant_id,role,expires_at FROM guild_sessions WHERE token_hash=$1 AND expires_at>now() AND revoked_at IS NULL",[hash(token)]);
  const row=result.rows[0];return row?{id:row.id,tenantId:row.tenant_id,role:row.role,expiresAt:row.expires_at.toISOString()}:null;
}
export async function currentSession():Promise<Session|null>{return sessionFromToken((await cookies()).get(SESSION_COOKIE)?.value);}
export async function requireSession():Promise<Session>{const session=await currentSession();if(!session)throw new DomainError("SESSION_REQUIRED","Open a studio workspace to continue.",401);return session;}
export async function createSession():Promise<{session:Session;cookie:string}>{
  const id=randomUUID(),tenantId=randomUUID(),token=randomBytes(32).toString("base64url"),expiresAt=new Date(Date.now()+8*3600000).toISOString();
  await transaction(async db=>{await db.query("INSERT INTO guild_tenants(id,expires_at,mode) VALUES($1,$2,'judge')",[tenantId,expiresAt]);await db.query("INSERT INTO guild_sessions(id,tenant_id,token_hash,role,expires_at) VALUES($1,$2,$3,'judge',$4)",[id,tenantId,hash(token),expiresAt]);});
  return {session:{id,tenantId,role:"judge",expiresAt},cookie:`${token}.${sign(token)}`};
}
export function requireSameOrigin(request:Request):void {
  const origin=request.headers.get("origin");const expected=new URL(request.url).origin;
  if(!origin||origin!==expected)throw new DomainError("ORIGIN_MISMATCH","This action must start from your Guild workspace.",403,false);
  if(request.headers.get("sec-fetch-site")==="cross-site")throw new DomainError("CROSS_SITE_COMMAND","Open Guild to continue this action.",403,false);
}
export async function rateLimit(bucket:string,limit:number,minutes=60):Promise<void>{
  const result=await getPool().query<{count:number}>("INSERT INTO guild_rate_limits(bucket,window_start,count) VALUES($1,now(),1) ON CONFLICT(bucket) DO UPDATE SET count=CASE WHEN guild_rate_limits.window_start < now()-($2::text||' minutes')::interval THEN 1 ELSE guild_rate_limits.count+1 END, window_start=CASE WHEN guild_rate_limits.window_start < now()-($2::text||' minutes')::interval THEN now() ELSE guild_rate_limits.window_start END RETURNING count",[bucket,minutes]);
  if((result.rows[0]?.count??limit+1)>limit)throw new DomainError("RATE_LIMIT","This workspace has reached its current operation limit. Try again later.",429);
}
export function anonymousBucket(request:Request):string{return hash(request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()??"local");}
