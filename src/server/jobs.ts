import { randomUUID } from "node:crypto";
import type { ArtifactManifest, Commission, JobRun } from "@/contracts/guild";
import { digest, DomainError } from "@/domain/primitives";
import { checkAuthority } from "@/domain/authority";
import { planDigest } from "@/domain/fixture";
import { transaction } from "./db";
import { appendEvent, saveCommission } from "./commissions";
import { compileBrief, produce } from "./production";
import { pollSavedModelResponse, type ModelContext } from "./models";
import { ProductionContinuation, ProductionReviewRequired } from "./production-continuation";
import { verifyImages } from "./media/image-verification";
import type { PrivateBlobGateway } from "./media/blob-store";
import { validateProductionInputs } from "./production-inputs";
import { verifyTranslation } from "./localization/translation-verification";
import { pollSavedVerifierBatch } from "./localization/verifier-batches";
import type { VerifierBatchGateway } from "./localization/gemini-batch-gateway";
import { verifyNarration } from "./media/narration-verification";
import type { SpeechGateway } from "./media/speech-gateway";
import type { TranscriptionGateway } from "./media/transcription-gateway";
import { validateNarrationTargetedCorrection } from "./narration-targeted-corrections";
import { validateNarrationFollowupCorrection } from "./narration-followup-corrections";

interface Job {id:string;tenant_id:string;commission_id:string;type:JobRun["type"];input:{packageId?:string;contractVersion?:number;revision?:number;artifactId?:string;artifactHash?:string;acceptancePackDigest?:string;inputBindings?:unknown;targetedAgreementId?:string;targetedAgreementDigest?:string;followupAgreementId?:string;followupAgreementDigest?:string;scheduleBinding?:Commission["schedule"]};lease_token:string;attempts:number}
function productionAuthority(commission: Commission, job: Job): boolean {
  if(job.type==="compile_brief")return commission.state==="planning"&&!commission.approvedPlanDigest;
  const pkg=commission.packages.find(p=>p.id===job.input.packageId);
  if(job.type==="verify_artifact")return !!pkg&&pkg.state==="verifying"&&pkg.contractVersion===job.input.contractVersion&&pkg.acceptancePack.digest===job.input.acceptancePackDigest&&pkg.artifactIds.includes(job.input.artifactId??"")&&commission.artifacts.some(artifact=>artifact.id===job.input.artifactId&&artifact.packageId===pkg.id&&artifact.contentHash===job.input.artifactHash);
  const mandate=(pkg?commission.mandates.find(m=>m.parentId&&m.allowedKinds.includes(pkg.kind)):undefined)??commission.mandates.find(m=>!m.parentId);
  const authority=pkg&&mandate&&checkAuthority(commission.mandates,{mandateId:mandate.id,amountMinor:0,kind:pkg.kind,providerId:pkg.providerId,purpose:mandate.purpose,now:new Date().toISOString()});
  return job.type==="produce_package"&&!!pkg&&pkg.contractVersion===job.input.contractVersion&&pkg.state==="producing"&&!!commission.approvedPlanDigest&&commission.approvedPlanDigest===planDigest(commission)&&!!authority?.allowed&&digest(job.input.scheduleBinding??null)===digest(commission.schedule??null);
}

async function claim(tenantId?:string):Promise<{job:Job;commission:Commission}|null>{
  return transaction(async db=>{
    const found=await db.query<Job>("SELECT * FROM guild_jobs WHERE ((state='queued' AND available_at<=now()) OR (state='running' AND lease_until<now())) AND ($1::uuid IS NULL OR tenant_id=$1) ORDER BY available_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1",[tenantId??null]);
    const job=found.rows[0];if(!job)return null;
    const result=await db.query<{snapshot:Commission}>("SELECT snapshot FROM guild_commissions WHERE id=$1 AND tenant_id=$2 FOR UPDATE",[job.commission_id,job.tenant_id]);
    const commission=result.rows[0]!.snapshot;
    job.lease_token=randomUUID();job.attempts++;
    await db.query("UPDATE guild_jobs SET state='running',lease_token=$1,lease_until=now()+interval '6 minutes',attempts=attempts+1,updated_at=now() WHERE id=$2",[job.lease_token,job.id]);
    const run=commission.jobs.find(j=>j.id===job.id);if(run){run.state="running";run.attempts=job.attempts;if(job.input.contractVersion)run.contractVersion=job.input.contractVersion;if(job.attempts===1)run.step=job.type==="compile_brief"?"Compiling the brief":job.type==="verify_artifact"?"Measuring the submitted files":"Producing the artifact";run.updatedAt=new Date().toISOString();}
    commission.revision++;await saveCommission(db,commission);return {job,commission};
  });
}

export async function runNextJob(tenantId?:string,dependencies:{media?:PrivateBlobGateway;verifier?:VerifierBatchGateway;speech?:SpeechGateway;transcription?:TranscriptionGateway}={}):Promise<{id:string;state:string}|null>{
  const claimed=await claim(tenantId);if(!claimed)return null;
  const {job,commission}=claimed;
  try{
    const context:ModelContext={jobId:job.id,tenantId:job.tenant_id,leaseToken:job.lease_token,externalCalls:0};
    // Known response reads keep temporary provider output from being lost while
    // the owner pauses work. They never authorize another model create.
    await pollSavedModelResponse(context);
    await pollSavedVerifierBatch(context,dependencies.verifier);
    if(commission.state==="paused")throw new ProductionContinuation("Commission paused; completed drafts remain saved",60);
    if(!productionAuthority(commission,job))throw new ProductionReviewRequired("PRODUCTION_AUTHORITY_CHANGED","The contract or Passport changed. Previously dispatched results are retained; no new model request was sent.");
    if(job.type==="verify_artifact"){
      const kind=commission.packages.find(item=>item.id===job.input.packageId)?.kind;
      if(kind!=="images"&&kind!=="translation"&&kind!=="narration")throw new DomainError("VERIFIER_NOT_READY","This package's independent verifier is not yet qualified.",422,false);
      const result=kind==="images"?await verifyImages(context,dependencies.media):kind==="narration"?await verifyNarration(context,{storage:dependencies.media,transcription:dependencies.transcription}):await verifyTranslation(context,dependencies.verifier);
      return await transaction(async db=>{
        const lease=await db.query<Job>("SELECT * FROM guild_jobs WHERE id=$1 AND lease_token=$2 AND state='running' FOR UPDATE",[job.id,job.lease_token]);
        if(!lease.rows[0])return {id:job.id,state:"superseded"};
        const current=(await db.query<{snapshot:Commission}>("SELECT snapshot FROM guild_commissions WHERE id=$1 AND tenant_id=$2 FOR UPDATE",[job.commission_id,job.tenant_id])).rows[0]!.snapshot;
        const valid=current.state!=="paused"&&productionAuthority(current,job),state=valid?"completed":"needs_review",pkg=current.packages.find(item=>item.id===job.input.packageId)!;
        if(valid){
          pkg.acceptancePack=result.pack;
          await db.query("INSERT INTO guild_verifications(id,tenant_id,commission_id,package_id,contract_version,artifact_id,artifact_hash,criteria_digest,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",[randomUUID(),current.tenantId,current.id,pkg.id,pkg.contractVersion,job.input.artifactId,job.input.artifactHash,digest(result.pack),result.pack]);
          const failed=result.pack.criteria.some(item=>item.kind==="deterministic"&&item.blocking&&item.status==="failed"),missing=result.pack.criteria.some(item=>item.kind==="deterministic"&&item.blocking&&item.status!=="passed");
          pkg.state=failed?"correction_requested":missing?"submitted":"awaiting_acceptance";
          appendEvent(current,"verification.completed",failed?"The submission needs a correction":missing?"Further checks remain open":"The agreed deterministic checks passed",failed||missing?"The independent report is saved against this exact artifact. Review its findings before requesting the agreed correction.":pkg.kind==="images"?"The original private files passed the frozen byte, geometry, profile, source and comparison checks. Curator fidelity and alt-text review remain separate.":pkg.kind==="narration"?"Every exact recording passed the independently measured format, loudness, duration and provider-transcript checks. Recognition remains advisory; human listening and source acceptance are still required.":"The full source, locale, placeholder, glossary, script and independent language checks passed. Blind back-translation remains advisory; human or disclosed curator review is still required.","Acceptance verifier",pkg.id);
        }else appendEvent(current,"verification.retained","Measurements retained for review","The artifact or contract changed before verification completed. These measurements did not replace the current review.","Acceptance verifier",job.input.packageId??null);
        const run=current.jobs.find(item=>item.id===job.id);if(run){run.state=state;run.step=valid?"Independent report saved for curator review":"Report retained; current contract needs review";run.error=null;run.blocksNewProduction=false;run.updatedAt=new Date().toISOString();}
        current.revision++;await saveCommission(db,current);
        await db.query("UPDATE guild_jobs SET state=$1,output=$2,lease_until=NULL,updated_at=now() WHERE id=$3 AND lease_token=$4",[state,result,job.id,job.lease_token]);
        return {id:job.id,state};
      });
    }
    const result=job.type==="compile_brief"?await compileBrief(context,commission):await produce(context,commission,job.input.packageId!,dependencies.media,dependencies.speech);
    return await transaction(async db=>{
      const lease=await db.query<Job>("SELECT * FROM guild_jobs WHERE id=$1 AND lease_token=$2 AND state='running' FOR UPDATE",[job.id,job.lease_token]);
      if(!lease.rows[0])return {id:job.id,state:"superseded"};
      const current=(await db.query<{snapshot:Commission}>("SELECT snapshot FROM guild_commissions WHERE id=$1 AND tenant_id=$2 FOR UPDATE",[job.commission_id,job.tenant_id])).rows[0]!.snapshot;
      const now=new Date().toISOString();let state:JobRun["state"]="completed";
      const output="content" in result?result.content:result.data;
      const artifactId=randomUUID(),content=output as Record<string,unknown>;
      const artifact:ArtifactManifest={id:artifactId,packageId:job.input.packageId??"brief",title:"title" in result?result.title:"Guild · compiled exhibition brief",mediaType:"application/json",contentHash:digest(content),downloadUrl:`/api/artifacts/${artifactId}/download`,previewUrl:null,sourceIds:"sourceIds" in result?result.sourceIds:current.sourceAssets.map(s=>s.id),createdAt:now,provenance:{mode:"live",label:"provenanceLabel" in result&&typeof result.provenanceLabel==="string"?result.provenanceLabel:`Generated by ${result.model}`,sourceId:result.runId,observedAt:now,sandbox:false},reviewStatus:"Generated · awaiting verification and curator review",content};
      const same=current.artifacts.find(a=>a.packageId===artifact.packageId&&a.contentHash===artifact.contentHash);
      const actual=same??artifact;if(!same)current.artifacts.push(artifact);
      if(job.type==="compile_brief"){
        if(current.approvedPlanDigest||current.state!=="planning")state="needs_review";
        else {
          const brief=output as {packages:{kind:string;title:string;description:string;workingHours:number}[]};
          if(new Set(brief.packages.map(p=>p.kind)).size!==6||brief.packages.length!==6)throw new DomainError("BRIEF_COVERAGE","The compiler did not propose all six agreed work packages.",422);
          for(const proposal of brief.packages){const pkg=current.packages.find(p=>p.kind===proposal.kind)!;pkg.title=proposal.title;pkg.description=proposal.description;pkg.workingHours=proposal.workingHours;}
          current.state="awaiting_approval";
        }
      }else{
        const pkg=current.packages.find(p=>p.id===job.input.packageId);
        let inputsCurrent=true;
        if(pkg){try{if(current.schedule)await (await import("./scheduling")).validateScheduleAuthority(db,current,"production");await validateProductionInputs(db,current,pkg,job.input.inputBindings);if(pkg.narrationTargetedCorrection)await validateNarrationTargetedCorrection(db,current,pkg,{id:job.id,input:job.input});if(pkg.narrationFollowupCorrection)await validateNarrationFollowupCorrection(db,current,pkg,{id:job.id,input:job.input});}catch(error){if(error instanceof DomainError)inputsCurrent=false;else throw error;}}
        if(!pkg||!productionAuthority(current,job)||!inputsCurrent)state="needs_review";
        else{pkg.artifactIds.push(actual.id);pkg.state="submitted";pkg.provenance=artifact.provenance;current.state=current.state==="paused"?"paused":"reviewing";}
      }
      const run=current.jobs.find(j=>j.id===job.id);if(run){run.state=state;run.step=state==="completed"?"Artifact saved for review":"Result retained; current contract needs review";run.error=null;run.blocksNewProduction=state==="needs_review";run.updatedAt=now;}
      appendEvent(current,"provider.artifact_submitted",artifact.title,state==="completed"?"The generated artifact is saved with its model-run provenance and content hash. Verification and acceptance remain separate decisions.":"A late result was retained as evidence without replacing the current contract.","Production service",job.input.packageId??null,artifact.provenance);
      current.revision++;await saveCommission(db,current);
      await db.query("UPDATE guild_jobs SET state=$1,output=$2,lease_until=NULL,updated_at=now() WHERE id=$3 AND lease_token=$4",[state,{artifactId:actual.id,runId:result.runId},job.id,job.lease_token]);
      return {id:job.id,state};
    });
  }catch(error){
    if(error instanceof ProductionContinuation){
      await transaction(async db=>{
        const updated=await db.query("UPDATE guild_jobs SET state='queued',error=NULL,lease_until=NULL,lease_token=NULL,available_at=now()+($1*interval '1 second'),continuation_count=continuation_count+1,updated_at=now() WHERE id=$2 AND lease_token=$3 AND state='running' RETURNING id",[Math.max(1,Math.min(error.retryAfterSeconds,60)),job.id,job.lease_token]);
        if(!updated.rowCount)return;
        const current=(await db.query<{snapshot:Commission}>("SELECT snapshot FROM guild_commissions WHERE id=$1 AND tenant_id=$2 FOR UPDATE",[job.commission_id,job.tenant_id])).rows[0]!.snapshot;
        const run=current.jobs.find(j=>j.id===job.id);if(run){const progress=run.step.match(/^(?:Research · \d+ of \d+ labels saved|Images · \d+ of \d+ photographs saved|Image checks · \d+ of \d+ files measured|Translation · \d+ of \d+ (?:languages saved|complete language files saved under the full contract)|Narration · \d+ of \d+ complete recordings saved|Narration checks · \d+ of \d+ recordings measured)\./)?.[0];run.state="queued";run.step=progress&&!/^(Research|Images|Image checks|Translation|Narration|Narration checks) · /.test(error.step)?`${progress} ${error.step}.`:error.step;run.error=null;run.updatedAt=new Date().toISOString();}
        current.revision++;await saveCommission(db,current);
      });
      return {id:job.id,state:"queued"};
    }
    const message=error instanceof DomainError?error.message:"The production service could not finish this job. Its contract and source material are preserved.";
    const state=error instanceof ProductionReviewRequired?"needs_review":"failed";
    await transaction(async db=>{
      const updated=await db.query("UPDATE guild_jobs SET state=$1,error=$2,lease_until=NULL,updated_at=now() WHERE id=$3 AND lease_token=$4 AND state='running' RETURNING id",[state,message,job.id,job.lease_token]);
      if(!updated.rowCount)return;
      const current=(await db.query<{snapshot:Commission}>("SELECT snapshot FROM guild_commissions WHERE id=$1 AND tenant_id=$2 FOR UPDATE",[job.commission_id,job.tenant_id])).rows[0]!.snapshot;
      const run=current.jobs.find(j=>j.id===job.id);if(run){run.state=state;run.step=job.type==="verify_artifact"?"Verification needs attention":state==="needs_review"?"Production needs review":"Production paused";run.error=message;run.blocksNewProduction=state==="needs_review"&&job.type!=="verify_artifact";run.updatedAt=new Date().toISOString();}
      const pkg=current.packages.find(p=>p.id===job.input.packageId);if(pkg?.state==="producing")pkg.state=state==="needs_review"?"awarded":"correction_requested";
      if(pkg?.state==="verifying"&&job.type==="verify_artifact")pkg.state="submitted";
      if(job.type==="compile_brief"&&current.state==="planning")current.state="draft";
      appendEvent(current,state==="needs_review"?"job.needs_review":"job.failed","Production needs attention",message,"Production service",job.input.packageId??null);
      current.revision++;await saveCommission(db,current);
    });
    return {id:job.id,state};
  }
}
