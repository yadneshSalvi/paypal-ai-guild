/** Actual database/application seams against the separate synthetic HTTP copy.
 * Negative corruptions roll back. Only one deliberately synthetic uncertain
 * draft survives the six-way save race; no declaration or acceptance is made. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { PoolClient } from "pg";
import type { ArtifactManifest, Commission } from "../src/contracts/guild";
import { deepgramCaptionArtifactSchema } from "../src/domain/deepgram-captions";
import { webArtifactSchema } from "../src/domain/web-audits";
import { webAcceptancePack, webAuthoritySchema, webAuditCapabilitySchema, webRendererCapabilitySchema } from "../src/domain/web-exhibition";
import { webEffectiveCaptionTimingsHash } from "../src/domain/web-caption-provenance";
import { digest, DomainError } from "../src/domain/primitives";
import { loadComposedCaptionFixture } from "../tests/support/load-composed-caption-fixture";
import { composedCaptionFixtureSnapshot } from "../tests/support/composed-caption-snapshot";

const f=await loadComposedCaptionFixture(process.argv[2]??"missing-independent-http-fixture","http"),target=resolve(dirname(f.fixturePath),`caption-bindings-${new Date().toISOString().replaceAll(":","-")}.json`);
const {getPool}=await import("../src/server/db"),pool=getPool(),{getCommission}=await import("../src/server/commissions"),{buildWebSources}=await import("../src/server/web/sources");
const {acceptedWebCaptionRevisions}=await import("../src/server/web/caption-revisions"),{webExportBundle}=await import("../src/server/web/exports"),{validateWebJob,validateWebContract}=await import("../src/server/web/contracts");
const {readWebApprovalHistory}=await import("../src/server/web/approval-history"),{readCaptionReviewRevision,saveCaptionReview}=await import("../src/server/captions/review");
const report:{version:string;fixture:string;disclosure:string;checks:Record<string,unknown>[];passed:boolean;error?:string;before?:unknown;after?:unknown}={version:"guild.accepted-caption-web-binding-checks.v1",fixture:f.label,disclosure:f.disclosure,checks:[],passed:false};
const check=(name:string,details:Record<string,unknown>={})=>{report.checks.push({name,passed:true,...details});console.log(JSON.stringify({check:name,passed:true}));};
async function refused(run:()=>Promise<unknown>,codes:string[]){try{await run();assert.fail("Expected the exact source/authority guard to refuse this negative case.");}catch(error){assert.ok(error instanceof DomainError,error instanceof Error?error.message:String(error));assert.ok(codes.includes(error.code),`${error.code}: ${error.message}`);return error.code;}}
async function rollback(name:string,mutate:(db:PoolClient,c:Commission)=>Promise<void>,codes:string[]){
 const db=await pool.connect();try{await db.query("BEGIN");const c=await getCommission(f.owner,f.commissionId);await mutate(db,c);const web=c.packages.find(item=>item.kind==="web")!;const code=await refused(()=>buildWebSources(db,c,web),codes);check(name,{code,rolledBack:true});}finally{await db.query("ROLLBACK");db.release();}
}
try{
 const c=await getCommission(f.owner,f.commissionId),web=c.packages.find(item=>item.kind==="web")!,artifact=c.artifacts.find(item=>item.id===f.artifactId)!,content=webArtifactSchema.parse(artifact.content);
 const captionPackage=c.packages.find(item=>item.kind==="captions")!,captionArtifact=c.artifacts.find(item=>item.id===f.captionReview.correctedArtifactId)!,caption=deepgramCaptionArtifactSchema.parse(captionArtifact.content);
 const binding=content.sources.inputBindings.find(item=>item.artifactId===captionArtifact.id)!,bound=await acceptedWebCaptionRevisions(pool,c,captionPackage,captionArtifact,binding);
 assert.equal(binding.reviewKind,"curator_acceptance");assert.equal(bound.provenance.tracks.length,78);assert.equal(bound.synthetic,true);
 assert.equal(digest(await buildWebSources(pool,c,web,content.sources)),content.sourceDigest);assert.equal(caption.originalProductionJobId,f.captionReview.originalJob);
 for(const track of bound.provenance.tracks){const label=content.sources.labels[track.locale][track.key]!;assert.equal(label.captions.timingsHash,track.effectiveTimingsHash);assert.equal(label.captions.receiptHash,track.receiptHash);assert.equal(label.captions.cuesHash,track.cuesHash);assert.equal(label.captions.vtt.contentHash,track.vtt.contentHash);}
 check("all 78 accepted effective revisions, original recognition, source and VTT identities bind the same web source digest",{tracks:78,originalAutomaticReady:f.captionReview.counts.originalAutomaticReady,originalWithheld:f.captionReview.counts.originalWithheld});
 const baseline=await composedCaptionFixtureSnapshot();report.before=baseline;
 const history=await readWebApprovalHistory(pool,c,web,artifact);await validateWebJob(pool,history.snapshot,history.package,history.job,false);
 const staleJob=structuredClone(history.job);staleJob.input.webSourceDigest="f".repeat(64);
 check("the real producing worker refuses a stale source/capability fingerprint",{code:await refused(()=>validateWebJob(pool,history.snapshot,history.package,staleJob,false),["WEB_JOB_BINDING"])});
 const changed=structuredClone(content.sources),first=caption.sources.tracks[0]!,track=caption.tracks.find(item=>item.locale===first.locale&&item.key===first.key)!;
 const hypothetical=structuredClone(caption);hypothetical.tracks.find(item=>item.locale===first.locale&&item.key===first.key)!.reviewRevision!.digest="e".repeat(64);
 const changedTiming=webEffectiveCaptionTimingsHash(captionArtifact.contentHash,hypothetical,first,hypothetical.tracks.find(item=>item.locale===first.locale&&item.key===first.key)!);
 assert.notEqual(changedTiming,webEffectiveCaptionTimingsHash(captionArtifact.contentHash,caption,first,track));changed.labels[first.locale][first.key]!.captions.timingsHash=changedTiming;
 const parameters=web.acceptancePack.parameters!,rebound=webAcceptancePack(changed,webAuthoritySchema.parse(parameters.authority),webAuditCapabilitySchema.parse(parameters.auditCapability),webRendererCapabilitySchema.parse(parameters.rendererCapability));
 assert.notEqual(rebound.digest,web.acceptancePack.digest);assert.notEqual(digest(changed),content.sourceDigest);
 const alteredContract=structuredClone(web);alteredContract.acceptancePack=rebound;
 check("an effective revision change changes the web agreement and cannot reuse its old amendment or worker",{sourceChanged:true,agreementChanged:true,code:await refused(()=>validateWebContract(pool,c,alteredContract,false),["WEB_CONTRACT_CHANGED"])});
 const revoked=structuredClone(c);revoked.mandates[0]!.status="revoked";
 check("revoked current authority blocks new work while retained original bytes remain readable",{code:await refused(()=>validateWebContract(pool,revoked,revoked.packages.find(item=>item.kind==="web")!,true),["WEB_AUTHORITY_EXPIRED"])});

 await rollback("a coherent passing automated draft review cannot replace the separately accepted v3 caption edition",async(db,current)=>{
  const pkg=current.packages.find(item=>item.kind==="captions")!,verified=(await db.query("SELECT criteria_digest,result FROM guild_verifications WHERE tenant_id=$1 AND artifact_id=$2 ORDER BY created_at DESC LIMIT 1",[f.owner.tenantId,captionArtifact.id])).rows[0];
  pkg.state="awaiting_acceptance";pkg.acceptancePack=verified.result;const id=randomUUID();
  await db.query("INSERT INTO guild_artifact_reviews(id,tenant_id,commission_id,package_id,contract_version,artifact_id,artifact_hash,criteria_digest,actor_id,review_kind,findings,disclosures) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'automated',$10,$11)",[id,current.tenantId,current.id,pkg.id,pkg.contractVersion,captionArtifact.id,captionArtifact.contentHash,verified.criteria_digest,f.owner.id,"SYNTHETIC negative source admission only",{humanReviewed:false,accepted:false,syntheticFixture:true}]);
 },["WEB_CAPTION_REVIEW_BINDING"]);
 await rollback("an owner acceptance without the exact listening declaration disclosure is refused",async db=>{await db.query("UPDATE guild_acceptance_decisions SET review_disclosures=review_disclosures-'captionListening' WHERE id=$1",[binding.reviewId]);},["WEB_CAPTION_REVIEW_BINDING"]);
 await rollback("a provider/system actor cannot supply the recorded owner listening/acceptance role",async db=>{await db.query("UPDATE guild_sessions SET role='operator' WHERE id=$1",[bound.provenance.tracks[0]!.actorId]);},["WEB_CAPTION_REVIEW_BINDING"]);
 async function changedCaption(name:string,change:(content:typeof caption)=>void){
  await rollback(name,async(db,current)=>{
   const altered=structuredClone(captionArtifact),body=deepgramCaptionArtifactSchema.parse(altered.content);change(body);altered.content=body;altered.contentHash=digest(body);
   await db.query("UPDATE guild_artifacts SET content_hash=$1,manifest=$2 WHERE tenant_id=$3 AND id=$4",[altered.contentHash,altered,current.tenantId,altered.id]);
   await db.query("UPDATE guild_acceptance_decisions SET artifact_hash=$1 WHERE id=$2",[altered.contentHash,binding.reviewId]);
   current.artifacts=current.artifacts.map(item=>item.id===altered.id?altered:item);
  },["WEB_CAPTION_REVIEW_BINDING"]);
 }
 await changedCaption("a rehashed accepted manifest cannot substitute a stale or earlier draft revision",value=>{value.tracks[0]!.reviewRevision!.id=f.captionReview.earlierDraftIds[0]!;});
 await changedCaption("uncertain/withheld effective cues cannot borrow a passing accepted revision or old VTT",value=>{value.tracks[0]!.effective.status="withheld";value.tracks[0]!.effective.cues=[];value.tracks[0]!.effective.cuesHash=digest([]);});
 await changedCaption("a missing effective VTT cannot enter the accepted web register",value=>{value.tracks[0]!.vtt=null;});
 await rollback("rehashed but unsigned recognition changes cannot enter an accepted caption source",async db=>{
  const saved=(await db.query("SELECT receipt FROM guild_alignment_observations WHERE tenant_id=$1 AND run_id=$2",[f.owner.tenantId,track.alignmentRunId])).rows[0].receipt;saved.receipt.latencyMs++;
  await db.query("UPDATE guild_alignment_observations SET receipt=$1,receipt_hash=$2 WHERE tenant_id=$3 AND run_id=$4",[saved,digest(saved),f.owner.tenantId,track.alignmentRunId]);
 },["DEEPGRAM_EVIDENCE_CHANGED"]);
 await rollback("VTT metadata cannot be replaced under the accepted effective file identity",async db=>{
  await db.query("UPDATE guild_media_objects SET metadata=jsonb_set(metadata,'{effective,cuesHash}',to_jsonb($1::text)) WHERE tenant_id=$2 AND id=$3",["f".repeat(64),f.owner.tenantId,track.vtt!.mediaId]);
 },["WEB_CAPTION_REVIEW_BINDING"]);
 await rollback("an independent report for another effective revision cannot supply web admission",async db=>{
  await db.query("UPDATE guild_jobs SET output=jsonb_set(output,'{report,checks,0,reviewRevisionId}',to_jsonb($1::text)) WHERE tenant_id=$2 AND id=$3",[randomUUID(),f.owner.tenantId,f.captionReview.verificationJob]);
 },["WEB_SOURCE_BINDING"]);
 const opened=await webExportBundle(f.owner,f.artifactId,f.selectedOrdinal,f.media),file=opened.manifest.files.find(item=>item.mediaId===track.vtt!.mediaId)!;
 const object=(await pool.query("SELECT blob_pathname FROM guild_media_objects WHERE tenant_id=$1 AND id=$2",[f.owner.tenantId,track.vtt!.mediaId])).rows[0],original=f.media.files.get(object.blob_pathname)!;
 try{f.media.files.set(object.blob_pathname,{...original,bytes:Buffer.from("WEBVTT\n\nSYNTHETIC deliberately changed actual bytes\n")});check("preview/export refuse changed actual VTT bytes and return no substitute",{code:await refused(()=>opened.read(file),["MEDIA_CONTENT_MISMATCH"])});}finally{f.media.files.set(object.blob_pathname,original);}
 assert.equal(digest((await composedCaptionFixtureSnapshot()).tables),digest(baseline.tables));

 // Acquire every real application pool client before invoking the seam. Any
 // nested getPool() read would contend for an unavailable seventh connection.
 const clients=await Promise.all(Array.from({length:6},()=>pool.connect()));
 try{
  assert.equal(pool.totalCount,6);assert.equal(pool.idleCount,0);
  const results=await Promise.allSettled(clients.map(async db=>{await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");try{return digest(await buildWebSources(db,c,web,content.sources));}finally{await db.query("ROLLBACK");}}));
  for(const result of results){assert.equal(result.status,"fulfilled");if(result.status==="fulfilled")assert.equal(result.value,content.sourceDigest);}
  assert.equal(pool.waitingCount,0);check("six simultaneously held real application clients resolve accepted v3 ancestry without a seventh pooled connection",{clients:6});
 }finally{for(const client of clients)client.release();}
 const actors=JSON.parse(await readFile(resolve(dirname(f.fixturePath),"qa-actors.json"),"utf8")),operator=actors.actors.operator.session;assert.equal(operator.role,"operator");assert.equal(operator.tenantId,f.owner.tenantId);
 const originalArtifact=c.artifacts.find(item=>item.id===f.captionReview.originalArtifactId)!,source=caption.sources.tracks.find(item=>item.locale==="en"&&item.key==="welcome")!;
 const leaf=(await pool.query("SELECT r.id FROM guild_caption_review_revisions r WHERE tenant_id=$1 AND artifact_id=$2 AND locale='en' AND track_key='welcome' AND NOT EXISTS(SELECT 1 FROM guild_caption_review_revisions n WHERE n.parent_revision_id=r.id)",[f.owner.tenantId,originalArtifact.id])).rows[0];
 const parent=await readCaptionReviewRevision(pool,f.owner.tenantId,leaf.id),draft=structuredClone(parent.draft);draft.disposition="uncertain";draft.note="SYNTHETIC six-way concurrency draft. No human listening declaration or acceptance. Accepted edition remains unchanged.";draft.units[0]={...draft.units[0]!,heard:"uncertain",startMs:null,endMs:null,origin:"unassigned",providerWordIndex:null};
 const commands=Array.from({length:6},()=>({action:"save" as const,requestId:randomUUID(),parentRevisionId:parent.id,locale:source.locale,key:source.key,artifactHash:originalArtifact.contentHash,draft}));
 const outcomes=await Promise.allSettled(commands.map(command=>saveCaptionReview(operator,originalArtifact.id,command))),saved=outcomes.filter(item=>item.status==="fulfilled");assert.equal(saved.length,1);
 for(const outcome of outcomes.filter(item=>item.status==="rejected")){assert.ok(outcome.reason instanceof DomainError);assert.equal(outcome.reason.code,"CAPTION_REVIEW_CONFLICT");assert.equal(outcome.reason.status,409);}
 const successful=saved[0]!;if(successful.status==="fulfilled"){assert.equal(successful.value.attestation,null);assert.equal(successful.value.evaluation.status,"incomplete");assert.equal(successful.value.evaluation.cues.length,0);}
 check("six real save transactions append one uncertain draft and refuse five stale parents under the commission lock",{successfulDrafts:1,stale409:5,newListeningDeclarations:0,requests:commands.map(item=>item.requestId)});
 const after=await composedCaptionFixtureSnapshot();report.after=after;
 const changedTables=after.tables.filter(row=>baseline.tables.find(item=>item.table===row.table)?.sha256!==row.sha256).map(row=>row.table).sort();
 assert.deepEqual(changedTables,["guild_caption_review_revisions","guild_commissions","guild_events"]);
 const current=await getCommission(f.owner,f.commissionId);assert.equal(digest(await buildWebSources(pool,current,current.packages.find(item=>item.kind==="web")!,content.sources)),content.sourceDigest);
 assert.ok((await opened.read(file)).equals(original.bytes));assert.equal((current.packages.find(item=>item.kind==="captions")!.acceptancePack.parameters!.authorityCeiling as {expiresAt:string}).expiresAt,f.captionReview.authorityExpiresAt);assert.equal(digest(current.mandates.map(item=>item.expiresAt)),digest(c.mandates.map(item=>item.expiresAt)));assert.equal(digest(current.packages.find(item=>item.kind==="web")!.acceptancePack.parameters!.authority),digest(web.acceptancePack.parameters!.authority));
 check("later incomplete drafts do not rewrite the agreed accepted revision, VTT, worker capability, original artifact/media/payment/model/browser bytes or deadline",{changedTables,unchangedTables:after.tables.length-changedTables.length});
 report.passed=true;
}catch(error){report.error=error instanceof Error?error.stack:String(error);throw error;}
finally{await writeFile(target,JSON.stringify(report,null,2)+"\n",{mode:0o600});console.log(JSON.stringify({reportPath:target,passed:report.passed,checks:report.checks.length,providerCalls:0,newListeningDeclarations:0}));await pool.end();}
