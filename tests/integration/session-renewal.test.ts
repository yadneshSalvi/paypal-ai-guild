import test,{after} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {isolatedPostgres} from "../support/postgres";
const cleanup=await isolatedPostgres("guild_renewal_test");
const {createSession,sessionFromToken,requireSameOrigin}=await import("../../src/server/session");
const {renewWorkspace}=await import("../../src/server/session-renewal");
const {getPool}=await import("../../src/server/db");
const {seedCommission}=await import("../../src/server/commissions");
const {DomainError}=await import("../../src/domain/primitives");
after(cleanup);
const code=(value:string)=>(e:unknown)=>e instanceof DomainError&&e.code===value;
async function expiring(){const entry=await createSession();const expires=new Date(Date.now()+30*60000).toISOString();await getPool().query("UPDATE guild_sessions SET expires_at=$2 WHERE id=$1",[entry.session.id,expires]);return {...entry,input:{requestId:randomUUID(),expectedExpiresAt:expires}};}

test("same active actor renews once concurrently without changing any saved contract or financial state",async()=>{
  const a=await expiring(),b=await createSession();await seedCommission(a.session);
  const snapshot=await getPool().query("SELECT snapshot FROM guild_commissions WHERE tenant_id=$1",[a.session.tenantId]);
  const [first,replayed]=await Promise.all([renewWorkspace(a.cookie,a.input),renewWorkspace(a.cookie,a.input)]);
  assert.deepEqual(first,replayed);assert.equal(first.id,a.session.id);assert.equal(first.tenantId,a.session.tenantId);assert.equal(first.role,"judge");
  const remaining=new Date(first.expiresAt).getTime()-Date.now();assert.ok(remaining>7.99*3600000&&remaining<=8*3600000);
  assert.equal((await sessionFromToken(a.cookie))!.expiresAt,first.expiresAt);
  assert.equal((await sessionFromToken(b.cookie))!.expiresAt,b.session.expiresAt);
  assert.deepEqual((await getPool().query("SELECT snapshot FROM guild_commissions WHERE tenant_id=$1",[a.session.tenantId])).rows,snapshot.rows);
  assert.equal((await getPool().query("SELECT count(*)::int n FROM guild_session_renewals WHERE session_id=$1",[a.session.id])).rows[0].n,1);
  for(const table of ["guild_checkout_challenges","guild_approval_receipts","guild_payment_intents","guild_acceptance_decisions"]){assert.equal((await getPool().query(`SELECT count(*)::int n FROM ${table} WHERE tenant_id=$1`,[a.session.tenantId])).rows[0].n,0);}
});
test("concurrent distinct commands cannot stack a session extension",async()=>{const a=await expiring();const results=await Promise.allSettled([renewWorkspace(a.cookie,a.input),renewWorkspace(a.cookie,{...a.input,requestId:randomUUID()})]);assert.equal(results.filter(r=>r.status==="fulfilled").length,1);assert.equal(results.filter(r=>r.status==="rejected"&&code("SESSION_CHANGED")(r.reason)).length,1);});
test("expired, revoked and forged cookies cannot revive access",async()=>{for(const mode of ["expired","revoked"]){const a=await expiring();await getPool().query(mode==="expired"?"UPDATE guild_sessions SET expires_at=now()-interval '1 second' WHERE id=$1":"UPDATE guild_sessions SET revoked_at=now() WHERE id=$1",[a.session.id]);await assert.rejects(renewWorkspace(a.cookie,a.input),code("SESSION_REQUIRED"));}const a=await expiring();await assert.rejects(renewWorkspace(a.cookie+"x",a.input),code("SESSION_REQUIRED"));});
test("provider and operator capabilities cannot renew themselves",async()=>{for(const role of ["provider","operator"]){const a=await expiring();await getPool().query("UPDATE guild_sessions SET role=$2 WHERE id=$1",[a.session.id,role]);await assert.rejects(renewWorkspace(a.cookie,a.input),code("RENEWAL_ROLE"));}});
test("early extension and stale or changed request revisions are rejected",async()=>{const a=await createSession();await assert.rejects(renewWorkspace(a.cookie,{requestId:randomUUID(),expectedExpiresAt:a.session.expiresAt}),code("RENEWAL_EARLY"));const b=await expiring();await assert.rejects(renewWorkspace(b.cookie,{...b.input,expectedExpiresAt:a.session.expiresAt}),code("SESSION_CHANGED"));await renewWorkspace(b.cookie,b.input);await assert.rejects(renewWorkspace(b.cookie,{...b.input,expectedExpiresAt:a.session.expiresAt}),code("RENEWAL_CHANGED"));});
test("foreign origins and client-selected tenant or duration never enter renewal",async()=>{assert.throws(()=>requireSameOrigin(new Request("https://guild.example/api/judge/sessions/renew",{method:"POST",headers:{Origin:"https://foreign.example"}})),code("ORIGIN_MISMATCH"));const a=await expiring();for(const extra of [{tenantId:randomUUID()},{duration:999999},{role:"owner"}])await assert.rejects(renewWorkspace(a.cookie,{...a.input,...extra}));assert.equal((await sessionFromToken(a.cookie))!.expiresAt,a.input.expectedExpiresAt);});
