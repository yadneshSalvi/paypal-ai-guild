import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Pool, type PoolClient } from "pg";

const target=resolve(process.argv[2]??"missing-private-evidence-directory"),oldFile=resolve(process.argv[3]??"missing-recorded-synthetic-fixture"),base=new URL(process.env.DATABASE_URL!);
assert.equal(base.port,"55562");assert.equal(base.username,"guild_caption_web_app");assert.equal(base.pathname,"/guild_caption_web_tests");assert.ok(!base.searchParams.has("options"));
const sha=(bytes:Buffer|string)=>createHash("sha256").update(bytes).digest("hex"),oldBytes=await readFile(oldFile),old=JSON.parse(oldBytes.toString("utf8"));
assert.equal(old.version,"guild.synthetic-composed-web-fixture.v1");assert.ok(old.label.startsWith("http-"));assert.match(old.disclosure,/^SYNTHETIC PUBLICATION FIXTURE\./);
const frozenPath=resolve(oldFile,"../../freeze.json"),frozenBytes=await readFile(frozenPath);assert.equal(sha(frozenBytes),"58c99bede96bd42edcb0f6187366286be8fc7778025b4496f7e3bb3418508d23");
const frozen=JSON.parse(frozenBytes.toString("utf8")),input=frozen.fixtures.find((item:{path:string})=>resolve(item.path)===oldFile);assert.ok(input);assert.equal(sha(oldBytes),input.sha256);
const sourceUrl=new URL(old.databaseUrl),sourceSchema=(sourceUrl.searchParams.get("options")??"").replace("-c search_path=","");
assert.equal(sourceUrl.port,"55561");assert.equal(sourceUrl.username,"guild_composed_app");assert.equal(sourceUrl.pathname,"/guild_composed_web_tests");assert.match(sourceSchema,/^guild_composition_fixture_[a-f0-9]{32}$/);
await mkdir(target,{recursive:false,mode:0o700});
const sourceReadonly=new URL(sourceUrl);sourceReadonly.searchParams.set("options",`-c search_path=${sourceSchema} -c default_transaction_read_only=on`);
const source=new Pool({connectionString:sourceReadonly.href,max:1}),schema="guild_caption_web_upgrade_"+randomUUID().replaceAll("-","");
const copiedUrl=new URL(base);copiedUrl.searchParams.set("options",`-c search_path=${schema}`);
let db:Pool|undefined,sourceClient:PoolClient|undefined;
type Snapshot={table:string;rows:number;sha256:string}[];
async function snapshot(client:Pool|PoolClient,whichSchema:string):Promise<Snapshot>{
 assert.match(whichSchema,/^guild_[a-z_]+[a-f0-9]{32}$/);
 const tables=(await client.query<{tablename:string}>("SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename",[whichSchema])).rows,records=[];
 for(const {tablename}of tables){assert.match(tablename,/^[a-z][a-z_0-9]+$/);const rows=(await client.query<{hash:string}>(`SELECT encode(sha256(convert_to(row_to_json(t)::text,'UTF8')),'hex') AS hash FROM "${whichSchema}"."${tablename}" t ORDER BY hash`)).rows;records.push({table:tablename,rows:rows.length,sha256:sha(rows.map(row=>row.hash).join("\n"))});}
 return records;
}
const retained=(rows:Snapshot)=>rows.filter(row=>row.table!=="guild_schema_migrations");
async function evidence(name:string,rows:Snapshot){await writeFile(resolve(target,name+".json"),JSON.stringify({schema:name.startsWith("source")?sourceSchema:schema,tables:rows,sha256:sha(JSON.stringify(rows))},null,2)+"\n",{mode:0o600});}
try{
 sourceClient=await source.connect();await sourceClient.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
 assert.equal((await sourceClient.query("SHOW transaction_read_only")).rows[0].transaction_read_only,"on");
 const before=await snapshot(sourceClient,sourceSchema);await evidence("source019-before-readonly-copy",before);
 assert.equal((await sourceClient.query(`SELECT max(version) AS maximum FROM "${sourceSchema}".guild_schema_migrations`)).rows[0].maximum,19);
 const token=(await sourceClient.query<{snapshot:string}>("SELECT pg_export_snapshot() AS snapshot")).rows[0]!.snapshot;
 const dumpUrl=new URL(sourceUrl);dumpUrl.searchParams.delete("options");
 const dump=spawnSync("/opt/homebrew/bin/pg_dump",["--format=plain","--no-owner","--no-privileges","--schema",sourceSchema,"--snapshot",token,"--dbname",dumpUrl.href],{encoding:"utf8",maxBuffer:256*1024*1024,env:{PATH:"/opt/homebrew/bin:/usr/bin:/bin",NODE_ENV:"test",PGOPTIONS:"-c default_transaction_read_only=on"}});
 assert.equal(dump.status,0,dump.stderr);await writeFile(resolve(target,"original019.sql"),dump.stdout,{mode:0o600});
 await sourceClient.query("COMMIT");sourceClient.release();sourceClient=undefined;
 const copied=dump.stdout.replaceAll(sourceSchema,schema);await writeFile(resolve(target,"copied019.sql"),copied,{mode:0o600});
 const restore=spawnSync("/opt/homebrew/bin/psql",["--no-psqlrc","--set","ON_ERROR_STOP=1","--dbname",base.href],{input:copied,encoding:"utf8",maxBuffer:16*1024*1024,env:{PATH:"/opt/homebrew/bin:/usr/bin:/bin",NODE_ENV:"test"}});
 await writeFile(resolve(target,"restore.log"),restore.stdout+restore.stderr,{mode:0o600});assert.equal(restore.status,0,"Restricted restore into the NEW own cluster failed; inspect retained restore.log.");
 db=new Pool({connectionString:copiedUrl.href,max:6});const baseline=await snapshot(db,schema);assert.deepEqual(baseline,before);await evidence("copied019-before020",baseline);
 const role=(await db.query("SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0];assert.deepEqual(role,{rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolbypassrls:false});
 const migration=await readFile(new URL("../migrations/020_deepgram_caption_review.sql",import.meta.url),"utf8");await db.query(migration);
 const after=await snapshot(db,schema);await evidence("copied-after020",after);assert.deepEqual(retained(after).filter(row=>baseline.some(old=>old.table===row.table)),retained(baseline));
 assert.equal((await db.query("SELECT max(version) AS maximum FROM guild_schema_migrations")).rows[0].maximum,20);assert.equal(after.length,baseline.length+2);
 for(const name of(await readdir(new URL("../migrations/",import.meta.url))).filter(name=>name.endsWith(".sql")).sort())await db.query(await readFile(new URL("../migrations/"+name,import.meta.url),"utf8"));
 assert.deepEqual(await snapshot(db,schema),after);
 process.env.DATABASE_URL=copiedUrl.href;process.env.AUTH_SECRET=old.authSecret;process.env.JUDGE_SESSION_SECRET=old.sessionSecret;
 const runtime=globalThis as unknown as{guildPool?:Pool};runtime.guildPool=db;
 const {publicationWorkspace,publicationEditionReceipt}=await import("../src/server/web/publications");
 const workspace=await publicationWorkspace(old.session,old.commissionId);assert.ok(workspace.editions.length>=3);
 for(const edition of workspace.editions)assert.ok(await publicationEditionReceipt(old.session,old.commissionId,edition.id));
 assert.deepEqual(await snapshot(db,schema),after);
 const sourceAfter=await snapshot(source,sourceSchema);await evidence("source019-after-readonly-copy",sourceAfter);assert.deepEqual(sourceAfter,before);
 const result={version:"guild.caption-web-prior019-migration.v1",baselineVersion:19,finalVersion:20,sourceFixture:old.label,sourceFixtureSha256:sha(oldBytes),sourceReadonly:true,sourceFixtureMutated:false,
  newRestrictedSchema:schema,restrictedRole:role,preservedTables:retained(baseline).length,originalRowsHash:sha(JSON.stringify(retained(baseline))),originalDumpSha256:sha(dump.stdout),migration020Sha256:sha(migration),
  originalArtifactMediaPublicationPaymentModelBrowserAndAuthorityBytesPreserved:true,signedEarlierEditionsVerified:workspace.editions.length,idempotentFullReapply:true,providerCalls:0,humanReviewClaimed:false};
 await writeFile(resolve(target,"result.json"),JSON.stringify(result,null,2)+"\n",{mode:0o600});console.log(JSON.stringify(result));
}finally{if(sourceClient){await sourceClient.query("ROLLBACK");sourceClient.release();}await db?.end();await source.end();}
