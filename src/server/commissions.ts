import { createHmac, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {createCommissionSchema, type ArtifactManifest, type ArtifactReview, type Commission, type CommissionCommand, type CommandResult, type DomainEvent, type JobRun, type Provenance, type SourceAsset } from "@/contracts/guild";
import type {z} from "zod";
import { collectionNotes, createSampleCommission, planDigest } from "@/domain/fixture";
import { researchAcceptancePack } from "@/domain/research";
import { imageAcceptancePack } from "@/domain/images";
import { translationAcceptancePack } from "@/domain/translation";
import { narrationAcceptancePack } from "@/domain/narration";
import { productionJobLimit } from "@/domain/narration-correction";
import { prepareNarrationCorrection, validateNarrationCorrection } from "./narration-corrections";
import { prepareNarrationTargetedCorrection, validateNarrationTargetedCorrection } from "./narration-targeted-corrections";
import { prepareNarrationFollowupCorrection, validateNarrationFollowupCorrection } from "./narration-followup-corrections";
import { qualifiedAudioEngine } from "./media/audio-qualification";
import { draftDependencyProposal } from "@/domain/draft-dependencies";
import { canonical, digest, DomainError } from "@/domain/primitives";
import { checkAuthority, reserveInSnapshot, validateChild } from "@/domain/authority";
import { assertAcceptable } from "@/domain/acceptance";
import { verifyArtifact } from "@/domain/verification";
import { getPool, transaction } from "./db";
import type { Session } from "./session";
import { museumSources } from "@/exhibition/museum";
import { assertAcceptedProductionInputs, resolveProductionInputs } from "./production-inputs";
import { captionAdmission, prepareCaptionContract, prepareCaptionCorrection, validateCaptionContract } from "./captions/contracts";
import { validateCaptionAuthority } from "./captions/authority";
import { prepareWebContract, prepareWebCorrection, validateWebContract, webAdmission } from "./web/contracts";
import { requireWebActor, requireWebVerificationAuthority } from "./web/authority";
import type { WebRuntimeAccess } from "./web/capability";
import { deepgramCaptionAdmission, prepareDeepgramCaptionContract, prepareDeepgramCaptionCorrection, validateDeepgramCaptionContract } from "./captions/deepgram-contracts";

const provenance=(commission:Commission):Provenance=>({mode:commission.mode,label:commission.mode==="sample"?"Sample workspace":"Live application",sourceId:commission.id,observedAt:new Date().toISOString(),sandbox:false});
export function appendEvent(commission:Commission,type:string,title:string,detail:string,actor:string,packageId:string|null=null,source?:Provenance):DomainEvent{
  const previous=commission.events.at(-1);
  const event:DomainEvent={id:randomUUID(),sequence:(previous?.sequence??0)+1,type,title,detail,actor,packageId,createdAt:new Date().toISOString(),provenance:source??provenance(commission),previousHash:previous?.hash??null,hash:""};
  event.hash=digest({...event,hash:undefined});commission.events.push(event);return event;
}
export async function saveCommission(db:PoolClient,commission:Commission):Promise<void>{
  commission.updatedAt=new Date().toISOString();
  await db.query("UPDATE guild_commissions SET revision=$1,state=$2,snapshot=$3,updated_at=now() WHERE id=$4 AND tenant_id=$5",[commission.revision,commission.state,commission,commission.id,commission.tenantId]);
  for(const artifact of commission.artifacts)await db.query("INSERT INTO guild_artifacts(id,tenant_id,commission_id,package_id,content_hash,manifest) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING",[artifact.id,commission.tenantId,commission.id,artifact.packageId,artifact.contentHash,artifact]);
  for(const event of commission.events)await db.query("INSERT INTO guild_events(id,tenant_id,commission_id,sequence,event_type,event,previous_hash,event_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING",[event.id,commission.tenantId,commission.id,event.sequence,event.type,event,event.previousHash,event.hash]);
}
export async function seedCommission(session:Session,sources:SourceAsset[]=museumSources):Promise<Commission>{
  return transaction(async db=>{const commission=createSampleCommission(session.tenantId,sources);appendEvent(commission,"commission.created","A new exhibition begins","A sample commission and a source-linked research label are ready to explore.","Guild studio");await db.query("INSERT INTO guild_commissions(id,tenant_id,state,snapshot) VALUES($1,$2,$3,$4)",[commission.id,session.tenantId,commission.state,commission]);await saveCommission(db,commission);return commission;});
}
export async function latestCommission(session:Session):Promise<Commission|null>{const result=await getPool().query<{snapshot:Commission}>("SELECT snapshot FROM guild_commissions WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 1",[session.tenantId]);return result.rows[0]?.snapshot??null;}
export async function createCommission(session:Session,input:z.infer<typeof createCommissionSchema>,sources:SourceAsset[]=[]):Promise<Commission>{
  return transaction(async db=>{
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`${session.tenantId}:${input.commandId}`]);
    const prior=await db.query<{payload_hash:string;result:{commission:Commission}}>("SELECT payload_hash,result FROM guild_commands WHERE tenant_id=$1 AND command_id=$2",[session.tenantId,input.commandId]);
    if(prior.rows[0]){if(prior.rows[0].payload_hash!==digest(input))throw new DomainError("COMMAND_CHANGED","This identity already belongs to another brief.");return prior.rows[0].result.commission;}
    const commission=createSampleCommission(session.tenantId,sources.filter(s=>input.sourceIds.includes(s.id)));
    if(commission.sourceAssets.length!==input.sourceIds.length)throw new DomainError("SOURCE_NOT_FOUND","Choose source material from the available collection.",422);
    Object.assign(commission,{title:input.title,museum:input.museum,objective:input.objective,capMinor:input.capMinor,languages:input.languages,mode:"live",state:"draft",artifacts:[]});
    for(const pkg of commission.packages){pkg.state="draft";pkg.artifactIds=[];if(pkg.kind==="research")pkg.acceptancePack=researchAcceptancePack(commission.sourceAssets,collectionNotes);if(pkg.kind==="images")pkg.acceptancePack=imageAcceptancePack(commission.sourceAssets);}
    for(const mandate of commission.mandates){mandate.capMinor=Math.min(mandate.capMinor,input.capMinor);mandate.digest=digest({...mandate,digest:undefined});}
    appendEvent(commission,"commission.created","Your commission is open","The brief is saved. Compile a plan, review the contracts, then approve its Passport.","Curator");
    await db.query("INSERT INTO guild_commissions(id,tenant_id,state,snapshot) VALUES($1,$2,$3,$4)",[commission.id,session.tenantId,commission.state,commission]);await saveCommission(db,commission);
    await db.query("INSERT INTO guild_commands(tenant_id,command_id,commission_id,payload_hash,result) VALUES($1,$2,$3,$4,$5)",[session.tenantId,input.commandId,commission.id,digest(input),{commission}]);return commission;
  });
}
export async function getCommission(session:Session,id:string):Promise<Commission>{const result=await getPool().query<{snapshot:Commission}>("SELECT snapshot FROM guild_commissions WHERE tenant_id=$1 AND id=$2",[session.tenantId,id]);if(!result.rows[0])throw new DomainError("NOT_FOUND","This commission is not in your workspace.",404,false);return result.rows[0].snapshot;}
export async function enqueueJob(db:PoolClient,commission:Commission,type:JobRun["type"],input:Record<string,unknown>,businessKey:string):Promise<string>{
  const id=randomUUID(),now=new Date().toISOString();
  const result=await db.query<{id:string}>("INSERT INTO guild_jobs(id,tenant_id,commission_id,business_key,type,input) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,business_key) DO UPDATE SET business_key=EXCLUDED.business_key RETURNING id",[id,commission.tenantId,commission.id,businessKey,type,input]);
  const actualId=result.rows[0]!.id;if(!commission.jobs.some(j=>j.id===actualId))commission.jobs.push({id:actualId,type,state:"queued",attempts:0,step:"Waiting for a worker",error:null,...(typeof input.packageId==="string"?{packageId:input.packageId}:{}),...(typeof input.contractVersion==="number"?{contractVersion:input.contractVersion}:{}),createdAt:now,updatedAt:now});return actualId;
}

async function assertNoUnresolvedGeneration(db:PoolClient,commission:Commission,packageId:string|null,contractVersion:number|null){
  const unresolved=await db.query("SELECT j.id FROM guild_jobs j JOIN guild_model_runs m ON m.job_id=j.id AND m.tenant_id=j.tenant_id WHERE j.tenant_id=$1 AND j.commission_id=$2 AND j.type=$3 AND ($4::text IS NULL OR (j.input->>'packageId'=$4 AND j.input->>'contractVersion'=$5)) AND (m.status IN ('dispatching','running','received','indeterminate','unavailable') OR (m.operation_key IS NULL AND m.status<>'completed')) LIMIT 1",[commission.tenantId,commission.id,packageId?"produce_package":"compile_brief",packageId,contractVersion===null?null:String(contractVersion)]);
  if(unresolved.rowCount)throw new DomainError("ORIGINAL_MODEL_RESULT_PENDING","An earlier production request still has an unresolved result. Keep its saved job for review; a new request would duplicate that work.",409,false);
  if(packageId&&commission.packages.find(item=>item.id===packageId)?.kind==="narration"){
    const speech=await db.query("SELECT id FROM guild_speech_runs WHERE tenant_id=$1 AND commission_id=$2 AND package_id=$3 AND state IN ('connecting','dispatching','streaming','indeterminate') LIMIT 1",[commission.tenantId,commission.id,packageId]);
    if(speech.rowCount)throw new DomainError("ORIGINAL_SPEECH_RESULT_PENDING","An earlier narration stream has no confirmed complete result. Its request, provider IDs and partial bytes remain saved; a new stream would duplicate unresolved work.",409,false);
  }
}

export interface CommissionCommandServices { webRuntime?:WebRuntimeAccess; marketTaskId?:string }
export async function executeCommand(session:Session,commissionId:string,command:CommissionCommand,services:CommissionCommandServices={}):Promise<CommandResult>{
  return transaction(db=>executeCommandWithClient(db,session,commissionId,command,services));
}
/** Internal composition point: one transaction owns delegation, reservation and job creation. */
export async function executeCommandWithClient(db:PoolClient,session:Session,commissionId:string,command:CommissionCommand,services:CommissionCommandServices={}):Promise<CommandResult>{
  if(!["judge","owner","operator"].includes(session.role))throw new DomainError("ROLE_REQUIRED","This action needs the commission owner's authority.",403,false);
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`${session.tenantId}:${command.commandId}`]);
    const found=await db.query<{snapshot:Commission}>("SELECT snapshot FROM guild_commissions WHERE id=$1 AND tenant_id=$2 FOR UPDATE",[commissionId,session.tenantId]);
    if(!found.rows[0])throw new DomainError("NOT_FOUND","This commission is not in your workspace.",404,false);
    const old=await db.query<{payload_hash:string;result:CommandResult}>("SELECT payload_hash,result FROM guild_commands WHERE tenant_id=$1 AND command_id=$2",[session.tenantId,command.commandId]);
    if(old.rows[0]){if(old.rows[0].payload_hash!==digest({commissionId,command}))throw new DomainError("COMMAND_CHANGED","A command identity cannot be reused for a different decision.",409,false);return old.rows[0].result;}
    const commission=found.rows[0].snapshot;
    // Attributed annotations bind the exact artifact, contract and check report.
    // Unrelated producer progress does not change what the reviewer inspected.
    const reviewTarget=command.type==="record_automated_review"?commission.packages.find(item=>item.id===command.packageId):null;
    const scopedReview=command.type==="record_automated_review"&&reviewTarget&&command.criteriaDigest===digest(reviewTarget.acceptancePack)&&reviewTarget.contractVersion===command.contractVersion&&reviewTarget.artifactIds.at(-1)===command.artifactId&&commission.artifacts.some(item=>item.id===command.artifactId&&item.contentHash===command.artifactHash&&digest(item.content)===command.artifactHash);
    if(commission.revision!==command.expectedRevision&&!scopedReview)return {ok:false,code:"REVISION_CONFLICT",message:"The commission changed while you were reviewing it. Refresh the current artifact and check report before saving.",recoverable:true,currentRevision:commission.revision};
    let jobId:string|null=null;
    const pkg="packageId" in command?commission.packages.find(p=>p.id===command.packageId):null;
    if("packageId" in command&&!pkg)throw new DomainError("PACKAGE_NOT_FOUND","That work package is not in this commission.",404,false);
    const now=new Date().toISOString();
    switch(command.type){
      case "approve_plan":{
        for(const item of commission.packages)if(item.kind==="captions"&&["2.0.0","3.0.0"].includes(item.acceptancePack.version)){if(item.acceptancePack.version==="3.0.0")await validateDeepgramCaptionContract(db,commission,item,false);else await validateCaptionContract(db,commission,item,false);await validateCaptionAuthority(db,commission,item,true);}
        for(const item of commission.packages)if(item.kind==="web"&&item.acceptancePack.version==="2.0.0"){await requireWebActor(db,session);await validateWebContract(db,commission,item,true,services.webRuntime);}
        if(commission.schedule)await (await import("./scheduling")).validateScheduleAuthority(db,commission,"approval");
        if(commission.approvedPlanDigest===command.planDigest)throw new DomainError("ALREADY_APPROVED","This exact plan already has an approval receipt.");
        if(command.planDigest!==planDigest(commission))throw new DomainError("PLAN_CHANGED","The contract or authority pages changed. Review the current plan.");
        const root=commission.mandates.find(m=>!m.parentId)!;
        for(const mandate of commission.mandates){if(mandate.parentId)validateChild(root,mandate);mandate.status="active";mandate.approvalId=randomUUID();}
        if(commission.packages.reduce((sum,p)=>sum+p.grossMinor,0)>commission.capMinor)throw new DomainError("PLAN_OVER_CAP","The proposed packages exceed the commission cap.",422);
        commission.approvedPlanDigest=command.planDigest;commission.state="producing";
        const secret=process.env.AUTH_SECRET;if(!secret)throw new Error("AUTH_SECRET required");
        const receiptPayload={kind:"guild.server_signed_receipt.v1",actor:session.id,commission:commission.id,digest:command.planDigest,at:now};
        const receipt=createHmac("sha256",secret).update(canonical(receiptPayload)).digest("hex");
        const receiptId=randomUUID();
        await db.query("INSERT INTO guild_approval_receipts(id,tenant_id,commission_id,actor_id,plan_digest,payload,signature) VALUES($1,$2,$3,$4,$5,$6,$7)",[receiptId,session.tenantId,commission.id,session.id,command.planDigest,receiptPayload,receipt]);
        if(commission.schedule)await (await import("./schedule-quotes")).recordScheduleQuoteApproval(db,commission,receiptId);
        appendEvent(commission,"mandate.approved","Passport approved",`${session.role==="operator"?"The system qualification operator":"The curator"} approved this plan and its authority pages. This server-signed receipt does not authorize or capture PayPal funds.`,session.role==="operator"?"System qualification operator":"Curator");
        commission.decisions.unshift({id:randomUUID(),allowed:true,ruleId:"PASSPORT.OWNER_APPROVAL",title:"Commission authority approved",reason:`Server-signed approval receipt ${receipt.slice(0,12)}. Budget authority and PayPal payer consent remain separate.`,amountMinor:commission.capMinor,mandateId:root.id,mandateRevision:root.revision,createdAt:now,provenance:provenance(commission)});break;
      }
      case "compile_brief":{
        if(commission.state==="planning")throw new DomainError("ALREADY_PLANNING","A brief compiler job is already running.");
        if(commission.approvedPlanDigest)throw new DomainError("PLAN_ALREADY_ACTIVE","An active plan needs a versioned amendment. Its accepted obligations cannot be replaced by a new brief.");
        await assertNoUnresolvedGeneration(db,commission,null,null);
        commission.state="planning";jobId=await enqueueJob(db,commission,"compile_brief",{revision:commission.revision},`compile:${commission.id}:${commission.revision}`);
        appendEvent(commission,"commission.planning","The brief is with the compiler","A real model call will propose work packages. The result still needs your approval.","Brief compiler");break;
      }
      case "produce_package":{
        await (await import("./provider-market/delegation")).requireMarketProductionBinding(db,session,commission,pkg!,services.marketTaskId);
        if(commission.state==="paused")throw new DomainError("COMMISSION_PAUSED","Resume the commission before starting new work.",422);
        if(!commission.approvedPlanDigest)throw new DomainError("APPROVAL_REQUIRED","Approve the proposed work and Passport pages before commissioning production.",422);
        if(commission.schedule)await (await import("./scheduling")).validateScheduleAuthority(db,commission,"production");
        if(!["research","translation","images","narration","captions","web"].includes(pkg!.kind))throw new DomainError("PROVIDER_NOT_READY","This provider's production adapter is still being qualified. Its contract and existing artifacts are preserved.",422);
        if(pkg!.kind==="images"&&(pkg!.acceptancePack.version!=="2.0.0"||pkg!.acceptancePack.digest!==imageAcceptancePack(commission.sourceAssets).digest))throw new DomainError("IMAGE_CONTRACT_REQUIRED","Review the measured image acceptance pack and approve its contract amendment before production.",422);
        if(pkg!.kind==="narration"&&pkg!.acceptancePack.version!=="2.0.0")throw new DomainError("NARRATION_CONTRACT_REQUIRED","Review the measured voice, exact scripts, audio engine and acceptance pack, then approve a fresh Passport before recording.",422);
        if(pkg!.kind==="captions"&&!["2.0.0","3.0.0"].includes(pkg!.acceptancePack.version))throw new DomainError("CAPTION_CONTRACT_REQUIRED","Review the exact original-audio, prompted-alignment and easy-read agreement, then approve a fresh Passport before production.",422);
        if(pkg!.kind==="web"&&pkg!.acceptancePack.version!=="2.0.0")throw new DomainError("WEB_CONTRACT_REQUIRED","Review the exact original sources, authored reader, bounded provider pipeline and qualified browser agreement, then approve a fresh Passport before production.",422);
        if(pkg!.state==="accepted"||pkg!.state==="producing"||pkg!.state==="verifying")throw new DomainError("PACKAGE_STATE","This package cannot start another production job in its current state.");
        const inputs=await resolveProductionInputs(db,commission,pkg!);
        const caption=pkg!.kind==="captions"?(pkg!.acceptancePack.version==="3.0.0"?await deepgramCaptionAdmission(db,commission,pkg!):await captionAdmission(db,commission,pkg!)):null;
        const web=pkg!.kind==="web"?await webAdmission(db,commission,pkg!,services.webRuntime):null;
        if(caption)inputs.bindings=caption.inputBindings;
        if(web)inputs.bindings=web.inputBindings;
        if(pkg!.kind==="narration"){
          const source=inputs.artifacts.find(item=>item.packageId===pkg!.dependsOn[0]);
          if(!source||pkg!.acceptancePack.digest!==narrationAcceptancePack(source,await qualifiedAudioEngine()).digest)throw new DomainError("NARRATION_CONTRACT_REQUIRED","The exact narration source or qualified engine differs from the approved agreement. No recording was queued.",422,false);
          await validateNarrationCorrection(db,commission,pkg!);
          await validateNarrationTargetedCorrection(db,commission,pkg!);
          await validateNarrationFollowupCorrection(db,commission,pkg!);
          if(pkg!.narrationTargetedCorrection&&digest(inputs.bindings)!==digest(pkg!.narrationTargetedCorrection.proposal.inputBindings))throw new DomainError("NARRATION_TARGETED_BINDING","The source review bound to the targeted agreement changed.",422,false);
          if(pkg!.narrationCorrection&&digest(inputs.bindings)!==digest(pkg!.narrationCorrection.proposal.inputBindings))throw new DomainError("NARRATION_CORRECTION_BINDING","The source review bound to the additional agreement changed. Review that agreement before commissioning work.",422,false);
        }
        await assertNoUnresolvedGeneration(db,commission,pkg!.id,pkg!.contractVersion);
        const mandate=commission.mandates.find(m=>m.parentId&&m.allowedKinds.includes(pkg!.kind))??commission.mandates.find(m=>!m.parentId)!;
        const reservationKey=`production:${commission.id}:${pkg!.id}:${pkg!.contractVersion}`;
        const existing=await db.query("SELECT id FROM guild_budget_reservations WHERE tenant_id=$1 AND operation_key=$2 AND state IN ('reserved','committed')",[session.tenantId,reservationKey]);
        const request={mandateId:mandate.id,amountMinor:existing.rowCount?0:pkg!.grossMinor,kind:pkg!.kind,providerId:pkg!.providerId,purpose:mandate.purpose,now};
        const authority=checkAuthority(commission.mandates,request);
        if(!authority.allowed)throw new DomainError(authority.ruleId,authority.reason,422);
        if(commission.approvedPlanDigest!==planDigest(commission))throw new DomainError("APPROVAL_REQUIRED","Approve the current work and Passport pages before reserving production.",422);
        if(!existing.rowCount){
          reserveInSnapshot(commission.mandates,request);
          await db.query("INSERT INTO guild_budget_reservations(id,tenant_id,commission_id,mandate_id,operation_key,amount_minor,currency,state) VALUES($1,$2,$3,$4,$5,$6,'USD','reserved')",[randomUUID(),session.tenantId,commission.id,mandate.id,reservationKey,pkg!.grossMinor]);
        }
        const produced=await db.query<{count:string}>("SELECT count(*) FROM guild_jobs WHERE tenant_id=$1 AND commission_id=$2 AND type='produce_package' AND input->>'packageId'=$3 AND input->>'contractVersion'=$4 AND (state='completed' OR $5)",[session.tenantId,commission.id,pkg!.id,String(pkg!.contractVersion),!!(caption||web||pkg!.narrationCorrection||pkg!.narrationTargetedCorrection||pkg!.narrationFollowupCorrection)]);
        if(Number(produced.rows[0]!.count)>=productionJobLimit(pkg!))throw new DomainError("CORRECTION_ALLOWANCE",(pkg!.narrationCorrection||pkg!.narrationTargetedCorrection||pkg!.narrationFollowupCorrection)?"This explicit agreement permits one additional job, and its original job is already retained. Another run needs a new reviewed agreement and fresh Passport.":"This contract's agreed correction has been used. Retain the submissions and agree a new contract before commissioning more work.",422);
        pkg!.state="producing";
        for(const criterion of pkg!.acceptancePack.criteria){criterion.status="pending";criterion.evidence=null;}
        jobId=await enqueueJob(db,commission,"produce_package",{packageId:pkg!.id,contractVersion:pkg!.contractVersion,...(web??caption??{inputBindings:inputs.bindings}),...(commission.schedule?{scheduleBinding:commission.schedule}:{}),...(pkg!.narrationFollowupCorrection?{followupAgreementId:pkg!.narrationFollowupCorrection.id,followupAgreementDigest:pkg!.narrationFollowupCorrection.proposal.digest}:{}),...(pkg!.narrationTargetedCorrection?{targetedAgreementId:pkg!.narrationTargetedCorrection.id,targetedAgreementDigest:pkg!.narrationTargetedCorrection.proposal.digest}:{}),...(pkg!.narrationCorrection?{correctionAgreementId:pkg!.narrationCorrection.id,correctionAgreementDigest:pkg!.narrationCorrection.proposal.digest}:{})},`produce:${commission.id}:${pkg!.id}:${pkg!.contractVersion}:${pkg!.webCorrection?.id??pkg!.deepgramCaptionCorrection?.id??pkg!.captionCorrection?.id??pkg!.narrationFollowupCorrection?.id??pkg!.narrationTargetedCorrection?.id??pkg!.narrationCorrection?.id??commission.revision}`);
        appendEvent(commission,"provider.production_started",`${pkg!.title}: production started`,"A durable job has been queued. Closing the page will not cancel it.",pkg!.providerId,pkg!.id);break;
      }
      case "amend_draft_dependencies":{
        const proposal=draftDependencyProposal(commission);
        if(!proposal||proposal.digest!==command.proposalDigest)throw new DomainError("DRAFT_AMENDMENT_CHANGED","The draft-input proposal changed. Review its current affected contracts before preparing approval.",422);
        const targets=proposal.packages.map(item=>commission.packages.find(pkg=>pkg.id===item.id)!);
        if(targets.some(pkg=>pkg.artifactIds.length||!["draft","bidding","awarded"].includes(pkg.state)))throw new DomainError("DRAFT_AMENDMENT_STARTED","These draft-input terms must be agreed before a dependent contract starts. Its original submissions cannot be moved to different terms.",422);
        const work=await db.query("SELECT id FROM guild_jobs WHERE tenant_id=$1 AND commission_id=$2 AND (state IN ('queued','running') OR (type='produce_package' AND input->>'packageId'=ANY($3::text[]))) LIMIT 1",[session.tenantId,commission.id,targets.map(pkg=>pkg.id)]);
        if(work.rowCount)throw new DomainError("AMENDMENT_WORK_RUNNING","Finish the active saved work before amending; a dependent contract with a prior production attempt retains its original terms.",409);
        const billing=await db.query("SELECT id FROM guild_payment_intents WHERE tenant_id=$1 AND commission_id=$2 LIMIT 1",[session.tenantId,commission.id]);
        if(billing.rowCount)throw new DomainError("AMENDMENT_BILLING_STARTED","This draft-input amendment is available before checkout. An existing financial agreement needs its separate billing amendment review.",422);
        const previous=targets.map(pkg=>structuredClone(pkg)),previousPlan=commission.approvedPlanDigest;
        for(const target of targets){target.contractVersion++;target.inputPolicy="reviewed_drafts";target.state="awarded";}
        commission.approvedPlanDigest=null;commission.state="awaiting_approval";
        for(const mandate of commission.mandates){if(mandate.status==="active")mandate.status="draft";}
        const proposedPlan=planDigest(commission);
        for(const [index,target] of targets.entries())await db.query("INSERT INTO guild_contract_amendments(id,tenant_id,commission_id,package_id,from_version,to_version,previous_plan_digest,proposed_plan_digest,previous_contract,proposed_contract,actor_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",[randomUUID(),session.tenantId,commission.id,target.id,previous[index]!.contractVersion,target.contractVersion,previousPlan,proposedPlan,previous[index],target,session.id,proposal.disclosure]);
        appendEvent(commission,"contract.draft_inputs_amended","Draft production terms are ready for approval",proposal.disclosure,session.role==="operator"?"System qualification operator":"Curator");break;
      }
      case "amend_image_contract":{
        const nextPack=imageAcceptancePack(commission.sourceAssets);
        if(commission.mode!=="live"||pkg!.kind!=="images"||pkg!.acceptancePack.version!=="1.0.0"||pkg!.contractVersion!==command.contractVersion||command.acceptancePackDigest!==nextPack.digest)throw new DomainError("IMAGE_AMENDMENT_CHANGED","The image amendment no longer matches the displayed source set and contract. Review the current proposal.",422);
        if(!["draft","bidding","awarded"].includes(pkg!.state)||pkg!.artifactIds.length)throw new DomainError("IMAGE_AMENDMENT_STARTED","This measured pack must be agreed before image production. Existing submissions retain their original terms.",422);
        const active=await db.query("SELECT id FROM guild_jobs WHERE tenant_id=$1 AND commission_id=$2 AND state IN ('queued','running') LIMIT 1",[session.tenantId,commission.id]);
        if(active.rowCount)throw new DomainError("AMENDMENT_WORK_RUNNING","Let the current saved production or verification finish before changing the plan's approval.",409);
        const billing=await db.query("SELECT id FROM guild_payment_intents WHERE tenant_id=$1 AND commission_id=$2 LIMIT 1",[session.tenantId,commission.id]);
        if(billing.rowCount)throw new DomainError("AMENDMENT_BILLING_STARTED","This measured-pack amendment is available before checkout. An existing financial agreement needs its separate billing amendment review.",422);
        const reservation=await db.query("SELECT id FROM guild_budget_reservations WHERE tenant_id=$1 AND operation_key=$2 AND state IN ('reserved','committed')",[session.tenantId,`production:${commission.id}:${pkg!.id}:${pkg!.contractVersion}`]);
        if(reservation.rowCount)throw new DomainError("AMENDMENT_COMMITMENT_EXISTS","This contract already has a reserved obligation. Retain its original terms until that obligation is explicitly resolved.",422);
        const previous=structuredClone(pkg!),previousPlan=commission.approvedPlanDigest;
        pkg!.contractVersion++;pkg!.acceptancePack=nextPack;pkg!.state="awarded";
        pkg!.description="Full-frame archival derivatives and thumbnails with measured dimensions, embedded sRGB profiles, source and rights hashes, six-language alt descriptions and an independent byte comparison. Curator fidelity review remains required.";
        commission.approvedPlanDigest=null;commission.state="awaiting_approval";
        for(const mandate of commission.mandates){if(mandate.status==="active")mandate.status="draft";}
        await db.query("INSERT INTO guild_contract_amendments(id,tenant_id,commission_id,package_id,from_version,to_version,previous_plan_digest,proposed_plan_digest,previous_contract,proposed_contract,actor_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",[randomUUID(),session.tenantId,commission.id,pkg!.id,previous.contractVersion,pkg!.contractVersion,previousPlan,planDigest(commission),previous,pkg!,session.id,"Measured image acceptance pack 2.0.0, agreed before image production; provider award, service fee, source set and other contracts are unchanged."]);
        appendEvent(commission,"contract.amended","The image standard is ready for approval",`Image contract v${previous.contractVersion} → v${pkg!.contractVersion}. The new measured pack preserves the ${pkg!.grossMinor/100} USD gross price. Review the current Passport before production; earlier records and accepted work remain attached to their original contracts.`,session.role==="operator"?"System qualification operator":"Curator",pkg!.id);break;
      }
      case "amend_translation_contract":{
        const research=commission.packages.find(item=>item.kind==="research"),source=commission.artifacts.find(item=>item.id===research?.artifactIds.at(-1));
        if(!source||commission.mode!=="live"||pkg!.kind!=="translation"||pkg!.acceptancePack.version!=="1.0.0"||pkg!.contractVersion!==command.contractVersion)throw new DomainError("TRANSLATION_AMENDMENT_CHANGED","This successor needs the current unaccepted translation contract and exact research source.",422);
        const nextPack=translationAcceptancePack(source),prior=commission.artifacts.find(item=>item.id===pkg!.artifactIds.at(-1));
        if(command.acceptancePackDigest!==nextPack.digest||(prior?.id??null)!==command.priorArtifactId||(prior?.contentHash??null)!==command.priorArtifactHash)throw new DomainError("TRANSLATION_AMENDMENT_CHANGED","The displayed source, glossary, proposed checks or prior draft changed. Review the successor agreement again.",422);
        if(pkg!.acceptedAt||!["draft","bidding","awarded","submitted","awaiting_acceptance","correction_requested"].includes(pkg!.state))throw new DomainError("TRANSLATION_AMENDMENT_ACCEPTED","An accepted obligation or active producer keeps its original terms. Use its separate recourse process.",422);
        const active=await db.query("SELECT id FROM guild_jobs WHERE tenant_id=$1 AND commission_id=$2 AND state IN ('queued','running') LIMIT 1",[session.tenantId,commission.id]);
        if(active.rowCount)throw new DomainError("AMENDMENT_WORK_RUNNING","Finish the current saved production and checks before changing the Passport.",409);
        const downstream=new Set<string>([pkg!.id]);for(let pass=0;pass<commission.packages.length;pass++)for(const candidate of commission.packages)if(candidate.dependsOn.some(id=>downstream.has(id)))downstream.add(candidate.id);downstream.delete(pkg!.id);
        const dependent=await db.query("SELECT id FROM guild_jobs WHERE tenant_id=$1 AND commission_id=$2 AND type='produce_package' AND input->>'packageId'=ANY($3::text[]) LIMIT 1",[session.tenantId,commission.id,[...downstream]]);
        if(dependent.rowCount)throw new DomainError("TRANSLATION_DEPENDENTS_STARTED","A dependent producer already used these terms. Preserve its exact lineage and resolve that work before a successor agreement.",422);
        const billing=await db.query("SELECT id FROM guild_payment_intents WHERE tenant_id=$1 AND commission_id=$2 LIMIT 1",[session.tenantId,commission.id]);
        if(billing.rowCount)throw new DomainError("AMENDMENT_BILLING_STARTED","This successor is available before buyer checkout. An existing financial agreement needs its separate amendment review.",422);
        await assertNoUnresolvedGeneration(db,commission,pkg!.id,pkg!.contractVersion);
        const reservationKey=`production:${commission.id}:${pkg!.id}:${pkg!.contractVersion}`;
        const reservation=(await db.query<{id:string;state:string;amount_minor:string;mandate_id:string}>("SELECT id,state,amount_minor,mandate_id FROM guild_budget_reservations WHERE tenant_id=$1 AND operation_key=$2 FOR UPDATE",[session.tenantId,reservationKey])).rows[0];
        if(reservation&&reservation.state!=="reserved"&&reservation.state!=="released")throw new DomainError("AMENDMENT_COMMITMENT_EXISTS","The previous contract has a committed obligation. Its terms cannot be replaced by this pre-acceptance successor.",422);
        const previous=structuredClone(pkg!),previousPlan=commission.approvedPlanDigest;
        if(reservation?.state==="reserved"){
          const amount=Number(reservation.amount_minor);if(amount!==pkg!.grossMinor)throw new DomainError("AMENDMENT_RESERVATION_MISMATCH","The reserved obligation no longer matches the displayed contract.",422,false);
          let page=commission.mandates.find(item=>item.id===reservation.mandate_id);if(!page)throw new DomainError("AMENDMENT_RESERVATION_MISMATCH","The reserved authority page is unavailable.",422,false);
          while(page){if(page.reservedMinor<amount)throw new DomainError("AMENDMENT_RESERVATION_MISMATCH","The recorded reservation cannot be safely released.",422,false);page.reservedMinor-=amount;page=commission.mandates.find(item=>item.id===page!.parentId);}
          await db.query("UPDATE guild_budget_reservations SET state='released' WHERE id=$1 AND tenant_id=$2",[reservation.id,session.tenantId]);
        }
        pkg!.contractVersion++;pkg!.acceptancePack=nextPack;pkg!.artifactIds=[];pkg!.state="awarded";pkg!.paymentState="not_eligible";
        pkg!.description="A successor translation under an explicitly agreed glossary, complete language/script/placeholder checks and independent blind back-translation. Earlier work and check reports remain attached to the original contract. Human or disclosed curator review remains required.";
        commission.approvedPlanDigest=null;commission.state="awaiting_approval";for(const mandate of commission.mandates)if(mandate.status==="active")mandate.status="draft";
        const reason="Explicit pre-acceptance successor language standard. Original contract, submissions, checks and review notes are retained unchanged; its unaccepted production reservation is released. The same controlled provider, award and service fee apply. A fresh Passport must approve the new contract before a new submission is produced and reserved. No existing work was relabeled as passing the new standard.";
        await db.query("INSERT INTO guild_contract_amendments(id,tenant_id,commission_id,package_id,from_version,to_version,previous_plan_digest,proposed_plan_digest,previous_contract,proposed_contract,actor_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",[randomUUID(),session.tenantId,commission.id,pkg!.id,previous.contractVersion,pkg!.contractVersion,previousPlan,planDigest(commission),previous,pkg!,session.id,reason]);
        appendEvent(commission,"contract.translation_successor","The full language standard is ready for approval",reason,session.role==="operator"?"System qualification operator":"Curator",pkg!.id);break;
      }
      case "amend_narration_contract":{
        const translation=commission.packages.find(item=>item.kind==="translation"),source=commission.artifacts.find(item=>item.id===translation?.artifactIds.at(-1));
        if(!source||source.content.schemaVersion!=="guild.translation.v2"||commission.mode!=="live"||pkg!.kind!=="narration"||pkg!.acceptancePack.version!=="1.0.0"||pkg!.contractVersion!==command.contractVersion)throw new DomainError("NARRATION_AMENDMENT_CHANGED","This agreement needs the current unstarted narration contract and complete submission under the full language standard.",422);
        const nextPack=narrationAcceptancePack(source,await qualifiedAudioEngine());
        if(command.acceptancePackDigest!==nextPack.digest||command.sourceArtifactId!==source.id||command.sourceArtifactHash!==source.contentHash)throw new DomainError("NARRATION_AMENDMENT_CHANGED","The displayed scripts, source, audio engine or proposed measurements changed. Review the narration agreement again.",422);
        if(pkg!.artifactIds.length||pkg!.acceptedAt||!["draft","bidding","awarded"].includes(pkg!.state))throw new DomainError("NARRATION_AMENDMENT_STARTED","An existing narration submission or obligation keeps its original terms. This measured agreement must precede recording.",422);
        const active=await db.query("SELECT id FROM guild_jobs WHERE tenant_id=$1 AND commission_id=$2 AND state IN ('queued','running') LIMIT 1",[session.tenantId,commission.id]);
        if(active.rowCount)throw new DomainError("AMENDMENT_WORK_RUNNING","Finish the current saved production and checks before changing the Passport.",409);
        const prior=await db.query("SELECT id FROM guild_jobs WHERE tenant_id=$1 AND commission_id=$2 AND type='produce_package' AND input->>'packageId'=$3 LIMIT 1",[session.tenantId,commission.id,pkg!.id]);
        if(prior.rowCount)throw new DomainError("NARRATION_AMENDMENT_STARTED","An original recording attempt already belongs to this contract. Preserve its terms and resolve that work before another agreement.",422);
        const billing=await db.query("SELECT id FROM guild_payment_intents WHERE tenant_id=$1 AND commission_id=$2 LIMIT 1",[session.tenantId,commission.id]);
        if(billing.rowCount)throw new DomainError("AMENDMENT_BILLING_STARTED","This measured agreement is available before buyer checkout. An existing financial agreement needs its separate amendment review.",422);
        const reservation=await db.query("SELECT id FROM guild_budget_reservations WHERE tenant_id=$1 AND operation_key=$2 AND state IN ('reserved','committed')",[session.tenantId,`production:${commission.id}:${pkg!.id}:${pkg!.contractVersion}`]);
        if(reservation.rowCount)throw new DomainError("AMENDMENT_COMMITMENT_EXISTS","This contract already has a reserved obligation. Retain its original terms until that obligation is explicitly resolved.",422);
        const previous=structuredClone(pkg!),previousPlan=commission.approvedPlanDigest;
        pkg!.contractVersion++;pkg!.acceptancePack=nextPack;pkg!.state="awarded";
        pkg!.description="Complete AI-generated narration of every exact translated title and body, with frozen language-specific duration estimates, a measured audio format and independent file, loudness, transcript and recognition reports. Human listening and source acceptance remain required.";
        commission.approvedPlanDigest=null;commission.state="awaiting_approval";for(const mandate of commission.mandates)if(mandate.status==="active")mandate.status="draft";
        const reason="Measured narration acceptance pack 2.0.0, agreed before recording. Exact source scripts, AI voice, measured engine, bounded tempo treatment and independent recognition are frozen; award, service fee and human listening/acceptance gates remain unchanged. No recording or payment was dispatched by this amendment.";
        await db.query("INSERT INTO guild_contract_amendments(id,tenant_id,commission_id,package_id,from_version,to_version,previous_plan_digest,proposed_plan_digest,previous_contract,proposed_contract,actor_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",[randomUUID(),session.tenantId,commission.id,pkg!.id,previous.contractVersion,pkg!.contractVersion,previousPlan,planDigest(commission),previous,pkg!,session.id,reason]);
        appendEvent(commission,"contract.narration_amended","The measured voice agreement is ready for approval",reason,session.role==="operator"?"System qualification operator":"Curator",pkg!.id);break;
      }
      case "agree_narration_targeted_correction":{
        const {reason}=await prepareNarrationTargetedCorrection(db,session,commission,pkg!,command.contractVersion,command.proposalDigest);
        appendEvent(commission,"contract.narration_targeted_correction_agreed","The targeted narration repair is ready for approval",reason,session.role==="operator"?"System qualification operator":"Workspace owner",pkg!.id);break;
      }
      case "amend_web_contract":{
        const {reason}=await prepareWebContract(db,session,commission,pkg!,command.contractVersion,command.acceptancePackDigest,services.webRuntime);
        appendEvent(commission,"contract.web_amended","The measured exhibition agreement needs your Passport",reason,session.role==="operator"?"System qualification operator":"Curator",pkg!.id);break;
      }
      case "agree_web_correction":{
        const {reason}=await prepareWebCorrection(db,session,commission,pkg!,command.contractVersion,command.proposalDigest,services.webRuntime);
        appendEvent(commission,"contract.web_correction_agreed","The included exhibition correction needs a fresh Passport",reason,session.role==="operator"?"System qualification operator":"Curator",pkg!.id);break;
      }
      case "amend_deepgram_caption_contract":{
        const {reason}=await prepareDeepgramCaptionContract(db,session,commission,pkg!,command.contractVersion,command.acceptancePackDigest);
        appendEvent(commission,"contract.deepgram_captions_amended","The six-language review agreement needs its Passport",reason,session.role==="operator"?"System qualification operator":"Curator",pkg!.id);break;
      }
      case "agree_deepgram_caption_review":{
        const {reason}=await prepareDeepgramCaptionCorrection(db,session,commission,pkg!,command.contractVersion,command.proposalDigest);
        appendEvent(commission,"contract.deepgram_caption_review_agreed","The exact correction assembly needs a fresh Passport",reason,session.role==="operator"?"System qualification operator":"Curator",pkg!.id);break;
      }
      case "amend_caption_contract":{
        const {reason}=await prepareCaptionContract(db,session,commission,pkg!,command.contractVersion,command.acceptancePackDigest);
        appendEvent(commission,"contract.captions_amended","The caption agreement is ready for approval",reason,session.role==="operator"?"System qualification operator":"Curator",pkg!.id);break;
      }
      case "agree_caption_correction":{
        const {reason}=await prepareCaptionCorrection(db,session,commission,pkg!,command.contractVersion,command.proposalDigest);
        appendEvent(commission,"contract.caption_correction_agreed","The included caption correction needs a fresh Passport",reason,session.role==="operator"?"System qualification operator":"Curator",pkg!.id);break;
      }
      case "agree_narration_followup_correction":{
        const {reason}=await prepareNarrationFollowupCorrection(db,session,commission,pkg!,command.contractVersion,command.proposalDigest);
        appendEvent(commission,"contract.narration_followup_correction_agreed","One narration follow-up is ready for approval",reason,session.role==="operator"?"System qualification operator":"Workspace owner",pkg!.id);break;
      }
      case "agree_narration_correction":{
        const {reason}=await prepareNarrationCorrection(db,session,commission,pkg!,command.contractVersion,command.proposalDigest);
        appendEvent(commission,"contract.narration_correction_agreed","One additional narration round is ready for approval",reason,session.role==="operator"?"System qualification operator":"Workspace owner",pkg!.id);break;
      }
      case "verify_artifact":{
        if(pkg!.kind==="web"&&pkg!.acceptancePack.version==="2.0.0"){await requireWebActor(db,session);await requireWebVerificationAuthority(db,commission,pkg!);}
        const artifact=commission.artifacts.find(a=>a.id===command.artifactId&&a.packageId===pkg!.id);
        if(!artifact||!pkg!.artifactIds.includes(artifact.id))throw new DomainError("ARTIFACT_NOT_FOUND","That submission is not offered for this contract.",404,false);
        if(pkg!.state==="accepted")throw new DomainError("IMMUTABLE_ACCEPTANCE","Accepted work is immutable; open recourse for a later concern.");
        if(pkg!.state==="producing"||pkg!.state==="verifying")throw new DomainError("VERIFICATION_WORK_RUNNING","Wait for the current saved production or verification before starting another check.");
        if(["images","translation","narration","captions","web"].includes(pkg!.kind)&&pkg!.acceptancePack.version==="2.0.0"||pkg!.kind==="captions"&&pkg!.acceptancePack.version==="3.0.0"){
          pkg!.state="verifying";
          jobId=await enqueueJob(db,commission,"verify_artifact",{packageId:pkg!.id,contractVersion:pkg!.contractVersion,artifactId:artifact.id,artifactHash:artifact.contentHash,acceptancePackDigest:pkg!.acceptancePack.digest},`verify:${commission.id}:${pkg!.id}:${artifact.id}:${commission.revision}`);
          appendEvent(commission,"verification.started",pkg!.kind==="web"?"The original exhibition and browser behavior are being checked":pkg!.kind==="captions"?"The original caption files are being checked":pkg!.kind==="images"?"The image files are being measured":pkg!.kind==="narration"?"The recordings are being measured":"The language files are being checked",pkg!.kind==="web"?"The verifier rereads the exact original source and portable files, then retains all 18 independent browser cases with native axe/Lighthouse reports and keyboard, focus, RTL and original-audio measurements. No model generation, acceptance, publication or payment is created.":pkg!.kind==="captions"?(pkg!.acceptancePack.version==="3.0.0"?"The verifier will reread original audio and VTT bytes, reparse signed Deepgram observations, and check complete sources and attributed listening revisions. No new recognition request, human declaration or acceptance is created.":"The verifier will reread original audio and VTT bytes, reparse the retained prompted timestamp responses and check exact easy-read source references. No new recognition request, human review or acceptance is created."):pkg!.kind==="images"?"The verifier will retrieve the exact private files and independently recompute their hashes, dimensions, profiles and pixel comparisons. Curator review remains separate.":pkg!.kind==="narration"?"The verifier will read every original audio file and stream receipt, independently decode and measure its format, duration, loudness and transcript, then retain recognition without the expected wording. Listening and human acceptance stay open.":"The verifier will inspect exact keys, English/source binding, placeholders, glossary, scripts and independent language ID, then retain a separate blind back-translation advisory. Human acceptance stays open.","Acceptance verifier",pkg!.id,artifact.provenance);break;
        }
        pkg!.acceptancePack=verifyArtifact(commission,pkg!,artifact);
        await db.query("INSERT INTO guild_verifications(id,tenant_id,commission_id,package_id,contract_version,artifact_id,artifact_hash,criteria_digest,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",[randomUUID(),session.tenantId,commission.id,pkg!.id,pkg!.contractVersion,artifact.id,artifact.contentHash,digest(pkg!.acceptancePack),pkg!.acceptancePack]);
        const failed=pkg!.acceptancePack.criteria.some(c=>c.blocking&&c.kind==="deterministic"&&c.status==="failed");
        const missing=pkg!.acceptancePack.criteria.some(c=>c.blocking&&c.kind==="deterministic"&&c.status!=="passed");
        pkg!.state=failed?"correction_requested":missing?"submitted":"awaiting_acceptance";
        appendEvent(commission,"verification.completed",failed?"The contract needs a correction":missing?"More verification is needed":"The agreed checks passed",missing?"Required checks remain open. The package cannot be accepted yet.":"The artifact passed deterministic checks. The curator's meaning and quality review is still required.","Acceptance verifier",pkg!.id,artifact.provenance);break;
      }
      case "record_automated_review":{
        const artifact=commission.artifacts.find(item=>item.id===command.artifactId&&item.packageId===pkg!.id);
        if(!artifact||!pkg!.artifactIds.includes(artifact.id)||artifact.contentHash!==command.artifactHash||digest(artifact.content)!==artifact.contentHash||pkg!.contractVersion!==command.contractVersion)throw new DomainError("REVIEW_BINDING_CHANGED","The review must identify the exact offered artifact and its current contract version.",422);
        if(command.criteriaDigest&&command.criteriaDigest!==digest(pkg!.acceptancePack))throw new DomainError("REVIEW_CHECKS_CHANGED","The check report changed after this review opened. Inspect the current checks before saving.",422);
        if(pkg!.state==="producing"||pkg!.state==="verifying")throw new DomainError("REVIEW_WORK_RUNNING","Wait for the saved production or checks to finish before recording this review.");
        const disclosure="Automated review of this exact artifact and check report. No human curator or fluent-language review is claimed. This record does not accept work or grant payment eligibility.";
        const review:ArtifactReview={id:randomUUID(),packageId:pkg!.id,contractVersion:pkg!.contractVersion,artifactId:artifact.id,artifactHash:artifact.contentHash,criteriaDigest:digest(pkg!.acceptancePack),kind:"automated",findings:command.findings,createdAt:now,humanReviewed:false,accepted:false,disclosure};
        await db.query("INSERT INTO guild_artifact_reviews(id,tenant_id,commission_id,package_id,contract_version,artifact_id,artifact_hash,criteria_digest,actor_id,review_kind,findings,disclosures) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'automated',$10,$11)",[review.id,session.tenantId,commission.id,pkg!.id,pkg!.contractVersion,artifact.id,artifact.contentHash,review.criteriaDigest,session.id,review.findings,{humanReviewed:false,fluentReviewed:false,accepted:false,actorKind:session.role,disclosure}]);
        (commission.artifactReviews??=[]).push(review);
        appendEvent(commission,"artifact.automated_reviewed","Automated findings recorded",disclosure,"Automated reviewer",pkg!.id,artifact.provenance);break;
      }
      case "accept_package":{
        const artifact=commission.artifacts.find(a=>a.id===command.artifactId);if(!artifact)throw new DomainError("ARTIFACT_NOT_FOUND","That artifact is not in this workspace.",404,false);
        let captionListening: Record<string,unknown>|null=null;
        if(pkg!.kind==="captions"&&pkg!.acceptancePack.version==="3.0.0"){if(session.role==="operator"||!command.acknowledgeCaptionListeningAndLanguageDisclosure)throw new DomainError("CAPTION_HUMAN_ACCEPTANCE_REQUIRED","A curator must explicitly accept the complete attributed listening edition and each language’s stated review limits. An operator or AI annotation cannot perform this human decision.",422,false);captionListening=await (await import("./captions/deepgram-contracts")).assertDeepgramCaptionAcceptable(db,commission,pkg!,artifact);}
        assertAcceptable(pkg!,artifact,command.contractVersion);
        if(session.role!=="operator")await assertAcceptedProductionInputs(db,commission,pkg!,artifact);
        const bound=await db.query("SELECT id FROM guild_verifications WHERE tenant_id=$1 AND commission_id=$2 AND package_id=$3 AND contract_version=$4 AND artifact_id=$5 AND artifact_hash=$6 AND criteria_digest=$7",[session.tenantId,commission.id,pkg!.id,pkg!.contractVersion,artifact.id,artifact.contentHash,digest(pkg!.acceptancePack)]);
        if(!bound.rowCount)throw new DomainError("VERIFICATION_BINDING","Run checks on this exact artifact before accepting it.",422);
        const operator=session.role==="operator";
        await db.query("INSERT INTO guild_acceptance_decisions(id,tenant_id,commission_id,package_id,contract_version,artifact_id,artifact_hash,criteria_digest,actor_id,decision,review_disclosures) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'accepted',$10)",[randomUUID(),session.tenantId,commission.id,pkg!.id,pkg!.contractVersion,artifact.id,artifact.contentHash,pkg!.acceptancePack.digest,session.id,{fluentReviewed:false,humanReviewed:!operator,actorKind:session.role,disclosure:operator?"System-run qualification decision; no human curator or fluent-language review claimed":pkg!.kind==="translation"?"Automated checks passed; not fluent-reviewed":"Curator accepted after reviewing meaning and quality",mode:artifact.provenance.mode,...(captionListening?{captionListening}:{}),...(pkg!.kind==="translation"||captionListening?{languages:Object.fromEntries(commission.languages.map(locale=>[locale,{fluentReviewed:false,reviewer:null,reviewedAt:null,disclosure:captionListening?"Complete attributed listening revisions and independent structural checks; fluent-language review remains unverified":"Automated checks passed; not fluent-reviewed",curatorAcknowledged:!operator,acknowledgedAt:now,actorKind:session.role}]))}:{})}]);
        pkg!.state="accepted";pkg!.acceptedAt=now;pkg!.acceptedBy=session.id;pkg!.provenance=artifact.provenance;pkg!.paymentState=!operator&&artifact.provenance.mode==="live"?"eligible":"not_eligible";
        const reserved=await db.query<{mandate_id:string;amount_minor:string}>("UPDATE guild_budget_reservations SET state='committed' WHERE tenant_id=$1 AND operation_key=$2 AND state='reserved' RETURNING mandate_id,amount_minor",[session.tenantId,`production:${commission.id}:${pkg!.id}:${pkg!.contractVersion}`]);
        if(reserved.rows[0]){let page=commission.mandates.find(m=>m.id===reserved.rows[0]!.mandate_id);while(page){page.reservedMinor-=Number(reserved.rows[0].amount_minor);page.committedMinor+=Number(reserved.rows[0].amount_minor);page=commission.mandates.find(m=>m.id===page!.parentId);}}
        for(const criterion of pkg!.acceptancePack.criteria.filter(c=>c.kind==="human")){criterion.status=operator?"review":"passed";criterion.evidence=operator?"System qualification acknowledgment only. No human curator review is recorded.":"Curator accepted this exact artifact and contract version.";}
        commission.state=commission.packages.every(p=>p.state==="accepted")?"delivered":"producing";
        appendEvent(commission,"package.accepted",operator?"Work accepted in system qualification":"Work accepted",operator?"The operator recorded a system-run acceptance of this exact artifact. Human curator and fluent-language reviews are not claimed. No payment was dispatched.":artifact.provenance.mode==="live"?"The curator accepted this exact artifact. A payment can now be proposed through the qualified billing route.":"This sample artifact was accepted in your workspace. Sample work does not create a PayPal charge.",operator?"System qualification operator":"Curator",pkg!.id,artifact.provenance);break;
      }
      case "request_correction":{
        if(pkg!.state==="accepted")throw new DomainError("RECOURSE_REQUIRED","Accepted work needs a recourse review; its original decision stays in history.");
        if(pkg!.state==="producing"||pkg!.state==="verifying")throw new DomainError("CORRECTION_WORK_RUNNING","Finish the saved production or checks before recording a new correction note. The active job keeps its exact instructions.",409);
        pkg!.state="correction_requested";appendEvent(commission,"package.correction_requested","A correction was requested",command.reason,"Curator",pkg!.id);break;
      }
      case "check_policy":{
        const target=commission.mandates.find(m=>m.id===(command.scenario==="premium_voice"?"passport-localization":"passport-root"))!;
        const result=checkAuthority(commission.mandates,{mandateId:target.id,amountMinor:command.scenario==="premium_voice"?6000:90000,kind:command.scenario==="premium_voice"?"premium_voice":"web",providerId:command.scenario==="premium_voice"?"quill":"formwork",purpose:target.purpose,now});
        const scenarioLabel=command.scenario==="premium_voice"?"Premium voice proposal":"Injected bid note";
        const source:Provenance={mode:"sample",label:"Labeled policy challenge",sourceId:command.scenario,observedAt:now,sandbox:false};
        commission.decisions.unshift({id:randomUUID(),allowed:result.allowed,ruleId:result.ruleId,title:scenarioLabel,reason:result.reason,amountMinor:command.scenario==="premium_voice"?6000:90000,mandateId:target.id,mandateRevision:target.revision,createdAt:now,provenance:source});
        appendEvent(commission,"mandate.policy_checked",`${scenarioLabel}: ${result.allowed?"allowed":"denied"}`,result.reason,"Passport gateway",null,source);break;
      }
      case "revoke_mandate":{
        const mandate=commission.mandates.find(m=>m.id===command.mandateId);if(!mandate)throw new DomainError("MANDATE_NOT_FOUND","This Passport page is not in your workspace.",404,false);
        mandate.status="revoked";mandate.revision++;appendEvent(commission,"mandate.revoked",`${mandate.title}: authority revoked`,"Future commitments under this page are blocked. Previously accepted obligations and payment history remain.","Curator");break;
      }
      case "pause":commission.state="paused";appendEvent(commission,"commission.paused","Commission paused","New production jobs will wait. In-flight jobs and uncertain financial operations still reconcile.","Curator");break;
      case "resume":commission.state="producing";appendEvent(commission,"commission.resumed","Commission resumed","Authorized work can continue from the last confirmed records.","Curator");break;
    }
    commission.revision++;await saveCommission(db,commission);
    const result:CommandResult={ok:true,commandId:command.commandId,revision:commission.revision,commission,jobId};
    await db.query("INSERT INTO guild_commands(tenant_id,command_id,commission_id,payload_hash,result) VALUES($1,$2,$3,$4,$5)",[session.tenantId,command.commandId,commission.id,digest({commissionId,command}),result]);return result;
}
export async function getArtifact(session:Session,id:string):Promise<ArtifactManifest>{const result=await getPool().query<{manifest:ArtifactManifest}>("SELECT manifest FROM guild_artifacts WHERE id=$1 AND tenant_id=$2",[id,session.tenantId]);if(!result.rows[0])throw new DomainError("ARTIFACT_NOT_FOUND","That artifact is not in this workspace.",404,false);return result.rows[0].manifest;}
