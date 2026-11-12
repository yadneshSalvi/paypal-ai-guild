import { CONTRACT_VERSION, type WorkspaceSnapshot } from "@/contracts/guild";
import { planDigest } from "@/domain/fixture";
import { imageAcceptancePack } from "@/domain/images";
import { draftDependencyProposal } from "@/domain/draft-dependencies";
import { getCommission, latestCommission } from "./commissions";
import { normalizePayments } from "@/domain/payments";
import { digest, DomainError } from "@/domain/primitives";
import { translationAcceptancePack } from "@/domain/translation";
import { narrationAcceptancePack } from "@/domain/narration";
import { qualifiedAudioEngine } from "./media/audio-qualification";
import type { Session } from "./session";
import { getPool } from "./db";
import { narrationCorrectionProposal } from "./narration-corrections";
import { narrationTargetedCorrectionProposal } from "./narration-targeted-corrections";
import { narrationFollowupCorrectionProposal } from "./narration-followup-corrections";
import { productionJobLimit } from "@/domain/narration-correction";
import { readAuthorityDeadline } from "./schedule-quotes";
import { captionContractProposal, captionCorrectionProposal } from "./captions/contracts";
import { webContractProposal, webCorrectionProposal } from "./web/contracts";
import { configuredWebCapabilities } from "./web/capability";
import { validateWebAuthority } from "./web/authority";
import { deepgramCaptionContractProposal, deepgramCaptionCorrectionProposal } from "./captions/deepgram-contracts";

export async function workspace(session:Session, commissionId?: string):Promise<WorkspaceSnapshot&{approvalDigest:string}>{
  const commission=commissionId?await getCommission(session,commissionId):await latestCommission(session);
  if(!commission)throw new DomainError("WORKSPACE_EMPTY","This workspace has no commission yet. Choose Open a Sample commission to begin.",404,false);
  normalizePayments(commission);
  // Historical runs retain their original contracts. Project the durable job
  // input for older snapshots instead of showing their completion on a successor.
  const jobs=await getPool().query<{id:string;input:{packageId?:string;contractVersion?:number}}>("SELECT id,input FROM guild_jobs WHERE tenant_id=$1 AND commission_id=$2",[session.tenantId,commission.id]);
  for(const run of commission.jobs){const input=jobs.rows.find(item=>item.id===run.id)?.input;if(input?.packageId)run.packageId=input.packageId;if(Number.isSafeInteger(input?.contractVersion))run.contractVersion=input!.contractVersion;}
  for(const pkg of commission.packages)pkg.verificationDigest=digest(pkg.acceptancePack);
  const imageContract=commission.packages.find(pkg=>pkg.kind==="images");
  const draftProposal=draftDependencyProposal(commission);
  const research=commission.packages.find(pkg=>pkg.kind==="research"),source=commission.artifacts.find(item=>item.id===research?.artifactIds.at(-1)),translation=commission.packages.find(pkg=>pkg.kind==="translation");
  const contractProposals:NonNullable<WorkspaceSnapshot["contractProposals"]>={...(commission.mode==="live"&&imageContract?.acceptancePack.version==="1.0.0"?{images:imageAcceptancePack(commission.sourceAssets)}:{}),...(commission.mode==="live"&&translation?.acceptancePack.version==="1.0.0"&&source?{translation:translationAcceptancePack(source)}:{}),...(draftProposal?{draftDependencies:draftProposal}:{})};
  const narration=commission.packages.find(pkg=>pkg.kind==="narration"),translationSource=commission.artifacts.find(item=>item.id===translation?.artifactIds.at(-1));
  if(commission.mode==="live"&&narration?.acceptancePack.version==="1.0.0"&&translationSource?.content.schemaVersion==="guild.translation.v2"){
    try{contractProposals.narration=narrationAcceptancePack(translationSource,await qualifiedAudioEngine());}
    catch(error){contractProposals.narrationUnavailable=error instanceof DomainError?error.message:"The narration agreement is awaiting this host's audio qualification. Existing work remains available.";}
  }
  if(commission.mode==="live"&&narration?.acceptancePack.version==="2.0.0"&&narration.state==="correction_requested"&&commission.jobs.filter(job=>job.type==="produce_package"&&job.packageId===narration.id&&job.contractVersion===narration.contractVersion&&(job.state==="completed"||!!narration.narrationCorrection||!!narration.narrationTargetedCorrection||!!narration.narrationFollowupCorrection)).length>=productionJobLimit(narration)){
    if(narration.narrationTargetedCorrection||narration.narrationFollowupCorrection){
      try{contractProposals.narrationFollowupCorrection=await narrationFollowupCorrectionProposal(getPool(),commission,narration);}
      catch(error){contractProposals.narrationFollowupCorrectionUnavailable=error instanceof DomainError?error.message:"The follow-up is unavailable; every original recording and report remains inspectable.";}
    }else{
      if(narration.narrationCorrection)try{contractProposals.narrationTargetedCorrection=await narrationTargetedCorrectionProposal(getPool(),commission,narration);}
      catch(error){contractProposals.narrationTargetedCorrectionUnavailable=error instanceof DomainError?error.message:"The targeted agreement is unavailable; retained work remains inspectable.";}
      if(!contractProposals.narrationTargetedCorrection)try{contractProposals.narrationCorrection=await narrationCorrectionProposal(getPool(),commission,narration);}
      catch(error){contractProposals.narrationCorrectionUnavailable=error instanceof DomainError?error.message:"The additional-correction agreement could not be prepared. Existing recordings and reports remain available.";}
    }
  }
  const authorityDeadline=await readAuthorityDeadline(getPool(),commission,session);
  const captions=commission.packages.find(item=>item.kind==="captions");
  if(commission.mode==="live"&&captions?.acceptancePack.version==="1.0.0"){
    try{contractProposals.deepgramCaptions=await deepgramCaptionContractProposal(getPool(),commission,captions);}
    catch(error){contractProposals.deepgramCaptionsUnavailable=error instanceof DomainError?error.message:"The full source and review agreement are not yet available.";}
    try{contractProposals.captions=await captionContractProposal(getPool(),commission,captions);}
    catch(error){contractProposals.captionsUnavailable=error instanceof DomainError?error.message:"The original audio, source history or frozen tokenizer is not yet qualified on this host.";}
  }
  if(commission.mode==="live"&&captions?.acceptancePack.version==="2.0.0"&&captions.state==="correction_requested"&&!captions.captionCorrection){
    try{contractProposals.captionCorrection=await captionCorrectionProposal(getPool(),commission,captions);}
    catch(error){contractProposals.captionCorrectionUnavailable=error instanceof DomainError?error.message:"The exact original outcome and one included correction need review.";}
  }
  const web=commission.packages.find(item=>item.kind==="web");
  if(commission.mode==="live"&&web?.acceptancePack.version==="1.0.0"){
    try{contractProposals.web=await webContractProposal(getPool(),commission,web);}
    catch(error){contractProposals.webUnavailable=error instanceof DomainError?error.message:"The exact original sources and qualified authored reader/browser capability are not yet available.";}
  }
  if(commission.mode==="live"&&web?.acceptancePack.version==="2.0.0"){
    try{
      await validateWebAuthority(getPool(),commission,web,true);
      const runtime=await configuredWebCapabilities();
      if(digest(runtime.capability)!==digest(web.acceptancePack.parameters?.auditCapability))throw new DomainError("WEB_CAPABILITY_CHANGED","The current runtime differs from this exact agreed browser capability. Saved files and reports remain readable.",422,false);
      if(process.env.OPENAI_MODEL!=="gpt-6.1-sol"||!process.env.OPENAI_API_KEY)contractProposals.webUnavailable="The exact agreed design model is not connected. Existing exhibition files and reports remain readable.";
    }catch(error){contractProposals.webUnavailable=error instanceof DomainError?error.message:"The exact qualified web runtime is unavailable. Saved files and reports remain readable.";}
    if(web.state==="correction_requested"&&!web.webCorrection){
      try{contractProposals.webCorrection=await webCorrectionProposal(getPool(),commission,web);}
      catch(error){contractProposals.webCorrectionUnavailable=error instanceof DomainError?error.message:"The original outcome and one included exhibition correction need review.";}
    }
  }
  if(commission.mode==="live"&&captions?.acceptancePack.version==="3.0.0"&&captions.artifactIds.length&&!captions.deepgramCaptionCorrection&&!commission.jobs.some(job=>["queued","running"].includes(job.state))){
    try{contractProposals.deepgramCaptionCorrection=await deepgramCaptionCorrectionProposal(getPool(),commission,captions);}
    catch(error){contractProposals.deepgramCaptionCorrectionUnavailable=error instanceof DomainError?error.message:"Finish the per-track listening reviews before assembling an exact corrected edition.";}
  }
  return {schemaVersion:CONTRACT_VERSION,session:{id:session.id,role:session.role,expiresAt:session.expiresAt},commission,contractProposals,authorityDeadline,approvalDigest:planDigest(commission),serverTime:new Date().toISOString()};
}
