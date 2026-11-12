/** Read-only recovery of a FAILED SYNTHETIC test attempt. Recreate only exact
 * encoded bytes from its retained PCM/source/cue records, verify every original
 * hash, and keep the failed schema and its invalid test rows unchanged. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { automaticCaptionReviewUnits, evaluateCaptionReview } from "../src/domain/caption-review";
import { deepgramCaptionArtifactSchema } from "../src/domain/deepgram-captions";
import { completeNarrationArtifactSchema } from "../src/domain/narration";
import { renderCaptionVtt } from "../src/domain/caption-alignment";
import { digest, DomainError } from "../src/domain/primitives";
import { syntheticMeasuredDraft } from "../tests/support/deepgram-caption-fixture";

const attemptFile=resolve(process.argv[2]??"missing-failed-attempt"),attempt=JSON.parse(await readFile(attemptFile,"utf8")),url=new URL(process.env.DATABASE_URL!);
assert.equal(attempt.version,"guild.synthetic-caption-web-attempt.v1");assert.equal(attempt.label,"native-v1");assert.match(attempt.schema,/^guild_caption_web_fixture_[a-f0-9]{32}$/);assert.equal(url.port,"55562");assert.equal(url.username,"guild_caption_web_app");
url.searchParams.set("options",`-c search_path=${attempt.schema} -c default_transaction_read_only=on`);process.env.DATABASE_URL=url.href;
const {getPool}=await import("../src/server/db"),pool=getPool(),target=resolve(dirname(attemptFile),"failed-media-recovered-v1"),sha=(bytes:Buffer|string)=>createHash("sha256").update(bytes).digest("hex");
await mkdir(target,{recursive:false,mode:0o700});await mkdir(resolve(target,"media"),{mode:0o700});
const {composedCaptionFixtureSnapshot}=await import("../tests/support/composed-caption-snapshot"),before=await composedCaptionFixtureSnapshot();
await writeFile(resolve(target,"before.json"),JSON.stringify(before,null,2)+"\n",{mode:0o600});
try{
 assert.equal((await pool.query("SHOW default_transaction_read_only")).rows[0].default_transaction_read_only,"on");
 const c=(await pool.query("SELECT snapshot FROM guild_commissions WHERE snapshot->'packages' @> '[{\"kind\":\"captions\",\"acceptancePack\":{\"version\":\"3.0.0\"}}]'::jsonb")).rows[0].snapshot;
 const captionArtifact=c.artifacts.find((artifact:{content:{schemaVersion:string}})=>artifact.content.schemaVersion==="guild.captions.v3"),caption=deepgramCaptionArtifactSchema.parse(captionArtifact.content);
 const preflight=caption.sources.tracks.map(source=>{const track=caption.tracks.find(item=>item.locale===source.locale&&item.key===source.key)!;const units=automaticCaptionReviewUnits(source,track.candidate);const evaluation=evaluateCaptionReview(source,syntheticMeasuredDraft(source,units??undefined),units);return{locale:source.locale,key:source.key,status:evaluation.status,codes:evaluation.codes,originalPartition:units?"exact automatic source units":"unchanged blank source units"};});
 assert.ok(preflight.every(item=>item.status==="ready-for-review"),JSON.stringify(preflight.filter(item=>item.status!=="ready-for-review")));await writeFile(resolve(target,"fixed-generator-preflight.json"),JSON.stringify({tracks:preflight.length,results:preflight,productPolicyChanged:false},null,2)+"\n",{mode:0o600});
 const pkg=c.packages.find((item:{kind:string})=>item.kind==="captions");
 const {deepgramCaptionCorrectionProposal}=await import("../src/server/captions/deepgram-contracts");
 let refusal="";try{await deepgramCaptionCorrectionProposal(pool,c,pkg);assert.fail("The invalid first synthetic attempt must remain unadmitted.");}catch(error){assert.ok(error instanceof DomainError);refusal=error.code;assert.ok(["CAPTION_REVIEW_ATTRIBUTION","DEEPGRAM_REVIEW_INCOMPLETE"].includes(refusal),refusal);}
 const narration=completeNarrationArtifactSchema.parse(c.artifacts.find((artifact:{id:string})=>artifact.id===caption.sources.narration.artifactId).content);
 const {readCompletedSpeech}=await import("../src/server/media/speech-runs"),{renderNarration}=await import("../src/server/media/audio-processing"),{loadSourceImage,treatImage}=await import("../src/server/media/image-processing");
 const media=(await pool.query("SELECT id,job_id,package_id,operation_key,blob_pathname,content_hash,byte_length,media_type,metadata FROM guild_media_objects WHERE tenant_id=$1 AND commission_id=$2 AND state='ready' ORDER BY package_id,operation_key",[c.tenantId,c.id])).rows;
 const originals=new Map<string,{bytes:Buffer;provenance:string}>(),imageCache=new Map<string,Awaited<ReturnType<typeof treatImage>>>();
 for(const row of media){
  let bytes:Buffer,provenance:string;
  if(row.media_type==="audio/mpeg"){
   const segment=narration.segments.find(item=>item.audio.mediaId===row.id)!;assert.ok(segment);
   const original=await readCompletedSpeech(c.tenantId,segment.speechRun.id);assert.equal(sha(original.pcm),segment.speechRun.pcmHash);assert.equal(original.receiptHash,segment.speechRun.receiptHash);
   bytes=(await renderNarration(original.pcm,segment.estimateSeconds)).bytes;provenance="Exact original synthetic MP3 hash recovered from retained PCM chunks with the unchanged bitexact engine and original target duration; no speech request.";
  }else if(row.media_type==="image/webp"){
   const source=c.sourceAssets.find((item:{id:string})=>item.id===row.metadata.sourceId);assert.ok(source);
   let image=imageCache.get(source.id);if(!image){image=await treatImage(await loadSourceImage(source));imageCache.set(source.id,image);}
   assert.ok(row.metadata.kind==="full"||row.metadata.kind==="thumbnail");bytes=image[row.metadata.kind as "full"|"thumbnail"].bytes;provenance="Exact original synthetic image derivative hash recovered from the unchanged registered source and pinned treatment; no image/model request.";
  }else{
   assert.equal(row.media_type,"text/vtt");const track=caption.tracks.find(item=>item.vtt?.mediaId===row.id)!;assert.ok(track);bytes=Buffer.from(renderCaptionVtt(track.effective.cues));provenance="Exact original VTT hash recovered from its unchanged original cue record; no timing correction or recognition request.";
  }
  assert.equal(bytes.length,Number(row.byte_length),row.id);assert.equal(sha(bytes),row.content_hash,row.id);assert.ok(!originals.has(row.id));originals.set(row.id,{bytes,provenance});
  await writeFile(resolve(target,"media",sha(row.blob_pathname)+".bin"),bytes,{flag:"wx",mode:0o600});
 }
 const dumpUrl=new URL(url);dumpUrl.searchParams.delete("options");const dump=spawnSync("/opt/homebrew/bin/pg_dump",["--format=custom","--schema",attempt.schema,"--file",resolve(target,"failed-attempt.dump"),"--dbname",dumpUrl.href],{encoding:"utf8",env:{PATH:"/opt/homebrew/bin:/usr/bin:/bin",NODE_ENV:"test",PGOPTIONS:"-c default_transaction_read_only=on"}});assert.equal(dump.status,0,dump.stderr);
 const after=await composedCaptionFixtureSnapshot();assert.deepEqual(after.tables,before.tables);await writeFile(resolve(target,"after.json"),JSON.stringify(after,null,2)+"\n",{mode:0o600});
 const result={version:"guild.failed-synthetic-caption-fixture-recovery.v1",disclosure:"FAILED SYNTHETIC ATTEMPT. The original first source-unit generator error and invalid signed test row remain preserved and unaccepted. The first MemoryMedia process had no durable object spool; this read-only recovery reconstructed only bytes whose hashes exactly match every original stored identity. Later fixtures spool each object immediately.",
  schema:attempt.schema,unchangedRowHash:before.sha256,productPolicyChanged:false,sourceUnitGeneratorPreflight:preflight.length,correctionAdmissionRefused:refusal,actualProviders:0,newRecognitionRequests:0,deadlinesRenewed:false,
  recovered:media.map(row=>({mediaId:row.id,pathname:row.blob_pathname,bytes:Number(row.byte_length),sha256:row.content_hash,file:sha(row.blob_pathname)+".bin",provenance:originals.get(row.id)!.provenance})),
  retainedDumpSha256:sha(await readFile(resolve(target,"failed-attempt.dump")))};
 await writeFile(resolve(target,"result.json"),JSON.stringify(result,null,2)+"\n",{mode:0o600});console.log(JSON.stringify({schema:attempt.schema,originalObjectsRecovered:media.length,originalRowsUnchanged:true,correctedGeneratorPreflight:preflight.length,correctionAdmissionRefused:refusal,providerCalls:0}));
}finally{await pool.end();}
