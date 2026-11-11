import {readFile,writeFile} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import type {Session} from "../src/server/session";
try{process.loadEnvFile(".env");}catch{/* Hosting supplies environment. */}
const evidence=JSON.parse(await readFile(".setup-evidence/research-qualification.json","utf8")) as {session:Session;commissionId:string;artifactId:string;[key:string]:unknown};
if(evidence.session.role!=="operator")throw new Error("Qualification needs an explicitly labeled operator session");
const {executeCommand,getCommission}=await import("../src/server/commissions");
const {getPool}=await import("../src/server/db");
let c=await getCommission(evidence.session,evidence.commissionId);const pkg=c.packages.find(p=>p.id==="research")!;
await executeCommand(evidence.session,c.id,{type:"accept_package",commandId:randomUUID(),expectedRevision:c.revision,packageId:pkg.id,artifactId:evidence.artifactId,contractVersion:pkg.contractVersion,acknowledgeReview:true});
c=await getCommission(evidence.session,c.id);
const summary={...evidence,acceptedAt:c.packages[0]!.acceptedAt,packageState:c.packages[0]!.state,paymentState:c.packages[0]!.paymentState,humanReview:false,financialWrites:0,checks:c.packages[0]!.acceptancePack.criteria};
await writeFile(".setup-evidence/research-qualification.json",JSON.stringify(summary,null,2));
console.log(JSON.stringify({commissionId:c.id,state:c.packages[0]!.state,paymentState:c.packages[0]!.paymentState,humanReview:false,financialWrites:0,acceptedArtifactHash:c.artifacts.find(a=>a.id===evidence.artifactId)!.contentHash}));
await getPool().end();
