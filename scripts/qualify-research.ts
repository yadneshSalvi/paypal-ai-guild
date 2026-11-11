import { readFile,mkdir,writeFile } from "node:fs/promises";
import { createHash,randomUUID } from "node:crypto";
import type { SourceAsset } from "../src/contracts/guild";
try{process.loadEnvFile(".env");}catch{/* Hosting supplies environment. */}
const {createSession}=await import("../src/server/session");
const {createCommission,executeCommand,getCommission}=await import("../src/server/commissions");
const {getPool}=await import("../src/server/db");
const {planDigest}=await import("../src/domain/fixture");
const {runNextJob}=await import("../src/server/jobs");
const records=JSON.parse(await readFile("fixtures/museum/catalogue.json","utf8")) as {id:string;digitalId:string;itemId:string;title:string;description:string;creator:string;createdPublished:string;alt:string;nativeRights:string[]}[];
const singleSource=process.argv.includes("--one-source");
const sources:SourceAsset[]=await Promise.all((singleSource?records.slice(0,1):records).map(async r=>{
 const path=`/museum/originals/${r.digitalId}.jpg`,bytes=await readFile(`public${path}`);
 if(bytes[0]!==255||bytes[1]!==216||bytes[bytes.length-2]!==255||bytes[bytes.length-1]!==217)throw new Error("Source photograph is incomplete");
 return {id:r.id,title:r.title,description:r.description,imagePath:path,thumbnailPath:path,sourceUrl:`https://www.loc.gov/item/${r.itemId}/`,creator:r.creator,date:r.createdPublished,rights:r.nativeRights.join(" "),rightsUrl:"https://guides.loc.gov/p-and-p-rights-and-restrictions/rights#102_det.html",contentHash:createHash("sha256").update(bytes).digest("hex"),alt:r.alt,provenance:{mode:"sample",label:"Real archive input · controlled system qualification",sourceId:r.itemId,observedAt:new Date().toISOString(),sandbox:false}};
}));
const {session}=await createSession();session.role="operator";await getPool().query("UPDATE guild_sessions SET role='operator' WHERE id=$1",[session.id]);
let c=await createCommission(session,{commandId:randomUUID(),title:`Harbor Street · ${singleSource?"single-source ":""}research qualification`,museum:"Harbor Street Maritime Museum",objective:`This is a system-run research pipeline qualification using ${sources.length} supplied Library of Congress waterfront photograph${singleSource?"":"s"}. It is separate from the complete twelve-photograph exhibition. Preserve archive dates and uncertainty; clearly separate the fictional museum narrative. Produce a welcome label and a label for each supplied photograph, each 80–120 words.`,capMinor:64000,languages:["en","pt","es","fr","ja","ar"],sourceIds:sources.map(s=>s.id)},sources);
await executeCommand(session,c.id,{type:"approve_plan",commandId:randomUUID(),expectedRevision:c.revision,planDigest:planDigest(c)});
c=await getCommission(session,c.id);await executeCommand(session,c.id,{type:"produce_package",commandId:randomUUID(),expectedRevision:c.revision,packageId:"research"});
const outcome=await runNextJob(session.tenantId);c=await getCommission(session,c.id);
const artifact=c.artifacts.find(a=>a.id===c.packages[0]!.artifactIds.at(-1));
await mkdir(".setup-evidence",{recursive:true});
const evidence={kind:"guild.research-qualification.v1",observedAt:new Date().toISOString(),session,commissionId:c.id,sourceCount:sources.length,outcome,artifactId:artifact?.id??null,artifactHash:artifact?.contentHash??null,model:artifact?.provenance.label??null,financialWrites:0,humanReview:false};
await writeFile(".setup-evidence/research-qualification.json",JSON.stringify(evidence,null,2));
console.log(JSON.stringify({commissionId:c.id,sourceCount:sources.length,outcome,artifactId:artifact?.id??null,model:artifact?.provenance.label??null,error:c.jobs.at(-1)?.error??null,financialWrites:0}));
if(artifact){await executeCommand(session,c.id,{type:"verify_artifact",commandId:randomUUID(),expectedRevision:c.revision,packageId:"research",artifactId:artifact.id});c=await getCommission(session,c.id);console.log(JSON.stringify({state:c.packages[0]!.state,checks:c.packages[0]!.acceptancePack.criteria}));}
await getPool().end();
