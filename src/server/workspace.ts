import { CONTRACT_VERSION, type WorkspaceSnapshot } from "@/contracts/guild";
import { planDigest } from "@/domain/fixture";
import { imageAcceptancePack } from "@/domain/images";
import { draftDependencyProposal } from "@/domain/draft-dependencies";
import { getCommission, latestCommission, seedCommission } from "./commissions";
import { normalizePayments } from "@/domain/payments";
import { digest, DomainError } from "@/domain/primitives";
import { translationAcceptancePack } from "@/domain/translation";
import { narrationAcceptancePack } from "@/domain/narration";
import { qualifiedAudioEngine } from "./media/audio-qualification";
import type { Session } from "./session";
import { getPool } from "./db";

export async function workspace(session:Session, commissionId?: string):Promise<WorkspaceSnapshot&{approvalDigest:string}>{
  const commission=commissionId?await getCommission(session,commissionId):await latestCommission(session)??await seedCommission(session);
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
  return {schemaVersion:CONTRACT_VERSION,session:{id:session.id,role:session.role,expiresAt:session.expiresAt},commission,contractProposals,approvalDigest:planDigest(commission),serverTime:new Date().toISOString()};
}
