/** Nonempty financial-history migration probe in a NEW restricted copy. The
 * original019 dump and source fixture remain read-only; no provider is called. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Pool } from "pg";
const previous=resolve(process.argv[2]??"missing-prior019-proof"),target=resolve(process.argv[3]??"missing-new-evidence-directory"),oldFile=resolve(process.argv[4]??"missing-original-synthetic-fixture");
const proof=JSON.parse(await readFile(resolve(previous,"result.json"),"utf8")),dump=await readFile(resolve(previous,"original019.sql"),"utf8"),oldBytes=await readFile(oldFile),old=JSON.parse(oldBytes.toString("utf8")),base=new URL(process.env.DATABASE_URL!);
const sha=(bytes:Buffer|string)=>createHash("sha256").update(bytes).digest("hex");assert.equal(sha(dump),proof.originalDumpSha256);assert.equal(sha(oldBytes),proof.sourceFixtureSha256);
assert.equal(base.port,"55562");assert.equal(base.username,"guild_caption_web_app");assert.equal(base.pathname,"/guild_caption_web_tests");assert.ok(!base.searchParams.has("options"));assert.match(old.disclosure,/^SYNTHETIC PUBLICATION FIXTURE\./);
const sourceSchema=new URL(old.databaseUrl).searchParams.get("options")!.replace("-c search_path=",""),schema="guild_caption_web_upgrade_"+randomUUID().replaceAll("-","");assert.match(sourceSchema,/^guild_composition_fixture_[a-f0-9]{32}$/);
await mkdir(target,{recursive:false,mode:0o700});
const restore=spawnSync("/opt/homebrew/bin/psql",["--no-psqlrc","--set","ON_ERROR_STOP=1","--dbname",base.href],{input:dump.replaceAll(sourceSchema,schema),encoding:"utf8",maxBuffer:16*1024*1024,env:{PATH:"/opt/homebrew/bin:/usr/bin:/bin",NODE_ENV:"test"}});
await writeFile(resolve(target,"restore.log"),restore.stdout+restore.stderr,{mode:0o600});assert.equal(restore.status,0,"Inspect the retained restricted restore log.");
base.searchParams.set("options",`-c search_path=${schema}`);const pool=new Pool({connectionString:base.href,max:6});
async function snapshot(name:string){const tables=(await pool.query<{tablename:string}>("SELECT tablename FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename")).rows,records=[];
 for(const {tablename}of tables){assert.match(tablename,/^[a-z][a-z_0-9]+$/);const hashes=(await pool.query<{hash:string}>(`SELECT encode(sha256(convert_to(row_to_json(t)::text,'UTF8')),'hex') AS hash FROM "${tablename}" t ORDER BY hash`)).rows.map(row=>row.hash);records.push({table:tablename,rows:hashes.length,sha256:sha(hashes.join("\n"))});}
 const result={schema,tables:records,sha256:sha(JSON.stringify(records))};await writeFile(resolve(target,name+".json"),JSON.stringify(result,null,2)+"\n",{mode:0o600});return result;}
try{
 const original=await snapshot("original019-copy");assert.equal((await pool.query("SELECT max(version) AS maximum FROM guild_schema_migrations")).rows[0].maximum,19);
 const approval=(await pool.query("SELECT id,signature FROM guild_approval_receipts WHERE tenant_id=$1 AND commission_id=$2 ORDER BY created_at LIMIT 1",[old.session.tenantId,old.commissionId])).rows[0];assert.match(approval.signature,/^[a-f0-9]{64}$/);
 const intentId=randomUUID(),resourceId="SYNTHETIC_UNDISPATCHED_CAPTION_UPGRADE_"+randomUUID();
 await pool.query("INSERT INTO guild_payment_intents(id,tenant_id,commission_id,business_key,kind,approval_id,command,binding) VALUES($1,$2,$3,$4,'synthetic_caption_upgrade_undispatched',$5,$6,$7)",[intentId,old.session.tenantId,old.commissionId,"synthetic-caption-upgrade:"+intentId,approval.id,{syntheticFixture:true,dispatched:false},{syntheticFixture:true,amountMinor:1234,originalApprovalSignature:approval.signature}]);
 await pool.query("INSERT INTO guild_payment_resources(kind,resource_id,tenant_id,commission_id,operation_id,resource,observed_at) VALUES('synthetic_undispatched',$1,$2,$3,$4,$5,now())",[resourceId,old.session.tenantId,old.commissionId,intentId,{syntheticFixture:true,providerRequest:false,originalBytes:"Original synthetic financial history · لا دفع · 決済なし"}]);
 const baseline=await snapshot("baseline019-with-nonempty-financial-history");
 for(const row of original.tables){const next=baseline.tables.find(item=>item.table===row.table)!;if(["guild_payment_intents","guild_payment_resources"].includes(row.table))assert.equal(next.rows,row.rows+1);else assert.deepEqual(next,row);}
 for(const table of ["guild_artifacts","guild_media_objects","guild_model_runs","guild_web_audit_cases","guild_web_publication_editions","guild_payment_intents","guild_payment_resources"])assert.ok(baseline.tables.find(row=>row.table===table)!.rows>0,table);
 await pool.query(await readFile(new URL("../migrations/020_deepgram_caption_review.sql",import.meta.url),"utf8"));
 const after=await snapshot("after020");for(const row of baseline.tables.filter(row=>row.table!=="guild_schema_migrations"))assert.deepEqual(after.tables.find(item=>item.table===row.table),row);
 for(const file of(await readdir(new URL("../migrations/",import.meta.url))).filter(name=>name.endsWith(".sql")).sort())await pool.query(await readFile(new URL("../migrations/"+file,import.meta.url),"utf8"));assert.deepEqual((await snapshot("after-full-idempotent-reapply")).tables,after.tables);
 process.env.DATABASE_URL=base.href;process.env.AUTH_SECRET=old.authSecret;process.env.JUDGE_SESSION_SECRET=old.sessionSecret;(globalThis as unknown as {guildPool?:Pool}).guildPool=pool;
 const {publicationWorkspace,publicationEditionReceipt}=await import("../src/server/web/publications"),workspace=await publicationWorkspace(old.session,old.commissionId);assert.equal(workspace.editions.length,3);for(const edition of workspace.editions)assert.ok(await publicationEditionReceipt(old.session,old.commissionId,edition.id));
 assert.deepEqual((await snapshot("after-signed-original-receipt-reads")).tables,after.tables);
 const result={version:"guild.caption-web-nonempty-financial-upgrade.v1",newRestrictedSchema:schema,sourceDatabaseConnected:false,verifiedOriginal019DumpSha256:sha(dump),preservedBusinessTables:baseline.tables.length-1,
  explicitlySyntheticUndispatchedPaymentSamples:2,nonemptyArtifactMediaModelBrowserPublicationPaymentTables:true,originalSourceApprovalAndAuthorityBytesPreserved:true,originalSignedEditionsVerified:3,exactBaselineHash:baseline.sha256,idempotentFullReapply:true,actualProviderCalls:0,financialDispatch:false};
 await writeFile(resolve(target,"result.json"),JSON.stringify(result,null,2)+"\n",{mode:0o600});console.log(JSON.stringify(result));
}finally{await pool.end();}
