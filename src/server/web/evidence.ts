import { createHash } from "node:crypto";
import { z } from "zod";
import { webAuditSummary } from "@/domain/web-audits";
import { digest, DomainError } from "@/domain/primitives";
import { getPool } from "../db";
import type { Session } from "../session";
import { ownedWebArtifact } from "./exports";
import { readWebApprovalHistory } from "./approval-history";
import { readWebAuditCase, readWebAuditCaseDetails, type WebAuditRow } from "./audit-store";
import { readWebEvidenceJson } from "./audit-evidence";

function owner(session:Session){if(!["owner","judge","operator"].includes(session.role))throw new DomainError("ROLE_REQUIRED","Original web attempts are available to this commission's owner workspace.",403,false);}
export async function ownedWebJob(session:Session,jobId:string){
  owner(session);
  const row=(await getPool().query<{id:string;commission_id:string;type:string;state:string;input:Record<string,unknown>;output:unknown;error:string|null;created_at:Date;updated_at:Date}>("SELECT id,commission_id,type,state,input,output,error,created_at,updated_at FROM guild_jobs WHERE tenant_id=$1 AND id=$2",[session.tenantId,jobId])).rows[0];
  const command=row&&(await getPool().query<{kind:string}>("SELECT p->>'kind' AS kind FROM guild_commands c CROSS JOIN LATERAL jsonb_array_elements(c.result->'commission'->'packages') p WHERE c.tenant_id=$1 AND c.commission_id=$2 AND c.result->>'jobId'=$3 AND p->>'id'=$4",[session.tenantId,row.commission_id,jobId,row.input.packageId])).rows;
  if(!row||!["produce_package","verify_artifact"].includes(row.type)||command?.length!==1||command[0]?.kind!=="web")throw new DomainError("WEB_JOB_NOT_FOUND","That saved web job is not in this workspace.",404,false);
  return row;
}
export async function webJobEvidence(session:Session,jobId:string,summaryOnly=false){
  const job=await ownedWebJob(session,jobId);
  const [models,audits,bundles,hosted]=await Promise.all([
    summaryOnly?Promise.resolve({rows:[]}):getPool().query("SELECT id,operation_key,model,input_hash,output_hash,status,provider_response_id,provider_status,failure_code,poll_count,created_at,updated_at FROM guild_model_runs WHERE tenant_id=$1 AND job_id=$2 ORDER BY created_at,id",[session.tenantId,jobId]),
    getPool().query(`SELECT a.id,a.case_key,a.mode,a.request_hash,a.state,a.failure_code,a.original_failure_code,a.recovered_at,a.dispatched_at,a.completed_at${summaryOnly?"":",o.result_hash,o.result,o.evidence_manifest,o.signature"} FROM guild_web_audit_cases a ${summaryOnly?"":"LEFT JOIN guild_web_audit_observations o ON o.case_id=a.id AND o.tenant_id=a.tenant_id"} WHERE a.tenant_id=$1 AND a.job_id=$2 ORDER BY a.case_key,a.id`,[session.tenantId,jobId]),
    summaryOnly?Promise.resolve({rows:[]}):getPool().query("SELECT id,ordinal,manifest_hash,manifest,signature,created_at FROM guild_web_bundles WHERE tenant_id=$1 AND job_id=$2 ORDER BY ordinal",[session.tenantId,jobId]),
    getPool().query<{case_id:string}>("SELECT case_id FROM guild_web_hosted_attempts WHERE tenant_id=$1 AND job_id=$2 ORDER BY created_at,case_id",[session.tenantId,jobId]),
  ]);
  const hostedAttempts=await Promise.all(hosted.rows.map(async item=>{
    const {PostgresHostedAttemptStore}=await import("./hosted-store"),record=await new PostgresHostedAttemptStore().read(session.tenantId,item.case_id);
    return {caseId:item.case_id,phase:record.phase,originalDeadline:record.binding.originalDeadline,originalDispatchedAt:record.binding.originalDispatchedAt,
      configurationDigest:record.binding.configurationDigest,snapshotId:record.binding.snapshotId,creationDescriptor:record.creationDescriptor,snapshotProof:record.snapshotProof,sessionReceipt:record.sessionReceipt,
      commands:record.commands,commandSpecs:record.commandSpecs,runtimeProof:record.runtimeProof,uploadProof:record.uploadProof,
      originalSessionId:record.session?.id??null,originalCommandId:record.commands.browser?.id??null,firstUnknownAt:record.firstUnknownAt,lastUnknownAt:record.lastUnknownAt,
      errors:record.errors,evidenceRetained:!!record.evidence,observationSaved:!!record.observationHash,
      recoveryUrl:`/api/web-jobs/${jobId}/recover`,
      disclosure:"Read-only recovery addresses this exact original attempt. It creates no new browser, work authority, acceptance or payment."};
  }));
  return {schemaVersion:"guild.web-job-evidence.v1",job:{...job,created_at:job.created_at.toISOString(),updated_at:job.updated_at.toISOString()},modelOperations:models.rows,
    browserCases:audits.rows.map(row=>({...row,originalEvidenceUrl:`/api/web-jobs/${jobId}/audit?caseId=${row.id}`})),hostedAttempts,bundles:bundles.rows,
    counts:{modelOperations:models.rows.length,knownModelResponses:models.rows.filter(row=>!!row.provider_response_id).length,knownIdReads:models.rows.reduce((n,row)=>n+Number(row.poll_count??0),0),
      browserIntents:audits.rows.filter(row=>!!row.dispatched_at).length,browserObservations:audits.rows.filter(row=>summaryOnly?row.state==="received":!!row.result).length,
      unresolvedBrowserIntents:audits.rows.filter(row=>["dispatching","indeterminate"].includes(row.state)).length},
    disclosure:"All saved operations for this exact job, including failures and uncertain outcomes. An operation record alone is not proof that a provider accepted a request. Original observations and raw files remain separate from inferred or missing outcomes. This read dispatches nothing."};
}
export async function webAuditEvidence(session:Session,jobId:string,caseId:string,path?:string){
  const job=await ownedWebJob(session,jobId),row=(await getPool().query<WebAuditRow>("SELECT * FROM guild_web_audit_cases WHERE tenant_id=$1 AND job_id=$2 AND id=$3",[session.tenantId,jobId,caseId])).rows[0];
  if(!row||row.commission_id!==job.commission_id||row.package_id!==job.input.packageId||row.request_hash!==digest(row.request))throw new DomainError("WEB_CASE_NOT_FOUND","That exact original browser case is not part of this job.",404,false);
  const files=(await getPool().query<{path:string;content_hash:string;byte_length:number}>("SELECT path,content_hash,byte_length FROM guild_web_audit_files WHERE tenant_id=$1 AND case_id=$2 ORDER BY path",[session.tenantId,caseId])).rows;
  const receipt=row.state==="received"?await readWebAuditCase(session.tenantId,caseId):null;
  if(path!==undefined){
    z.string().regex(/^[a-z][a-z0-9-]{0,150}\.json$/).parse(path);
    const reference=files.find(item=>item.path===path),saved=(await getPool().query<{bytes:Buffer}>("SELECT bytes FROM guild_web_audit_files WHERE tenant_id=$1 AND case_id=$2 AND path=$3",[session.tenantId,caseId,path])).rows[0];
    if(!reference||!saved||saved.bytes.length!==reference.byte_length||createHash("sha256").update(saved.bytes).digest("hex")!==reference.content_hash)throw new DomainError("WEB_CASE_FILE_CHANGED","The original native evidence file is unavailable or changed. No replacement was returned.",422,false);
    return {kind:"file" as const,path,bytes:saved.bytes,state:row.state};
  }
  return {kind:"index" as const,value:{schemaVersion:"guild.web-native-evidence.v1",jobId,caseId,caseKey:row.case_key,state:row.state,request:row.request,requestHash:row.request_hash,
    dispatchedAt:row.dispatched_at?.toISOString()??null,failureCode:row.failure_code,originalFailureCode:row.original_failure_code??null,recoveredAt:row.recovered_at?.toISOString()??null,receipt,
    files:files.map(file=>({path:file.path,contentHash:file.content_hash,byteLength:file.byte_length,download:`/api/web-jobs/${jobId}/audit?caseId=${caseId}&file=${encodeURIComponent(file.path)}`})),
    disclosure:receipt?"Complete original native JSON, signed result and immutable file hashes. Raw chunks reconstruct their exact original JSON without dropping findings. Scores and automated observations do not establish human acceptance.":"Retained partial evidence from the original attempt. Its outcome is incomplete or uncertain; no pass, replacement process or retry is inferred."}};
}
/** Plain native findings, reconstructed from exact complete raw JSON without a new audit. */
export async function webAuditFindings(session:Session,jobId:string,caseId:string){
  const job=await ownedWebJob(session,jobId),saved=await readWebAuditCaseDetails(session.tenantId,caseId);
  if(saved.row.job_id!==jobId||saved.row.commission_id!==job.commission_id)throw new DomainError("WEB_CASE_NOT_FOUND","That original browser case is not part of this exact job.",404,false);
  const result=saved.receipt.result;
  return {schemaVersion:"guild.web-native-findings.v1",caseId,jobId,locale:result.locale,viewport:result.viewport,sourceDigest:result.sourceDigest,designDigest:result.designDigest,bundleDigest:result.bundleDigest,
    states:result.axe.map(state=>{const raw=readWebEvidenceJson(state.file,result.files,saved.files);return {state:state.state,originalFile:state.file,violations:raw.violations,incomplete:raw.incomplete};}),
    lighthouse:result.lighthouse?readWebEvidenceJson(result.lighthouse.file,result.files,saved.files):null,
    disclosure:"All original axe violations and incomplete findings for each measured state, plus the complete original Lighthouse report. This read does not rerun the browser or change any result."};
}
export async function webEvidenceIndex(session:Session,artifactId:string){
  const owned=await ownedWebArtifact(session,artifactId);
  let producingApproval:{verified:boolean;planDigest:string|null;message:string},producingContract:unknown=null;
  try{const history=await readWebApprovalHistory(getPool(),owned.commission,null,owned.manifest);producingContract=history.package;producingApproval={verified:true,planDigest:history.snapshot.approvedPlanDigest,message:"The exact original producing command, signed historical approval and retained contract match this artifact. This grants no new work authority."};}
  catch(error){producingApproval={verified:false,planDigest:null,message:error instanceof DomainError?error.message:"The original producing approval could not be verified. No successful lineage is inferred."};}
  const jobs=(await getPool().query<{id:string;state:string;type:string}>("SELECT id,state,type FROM guild_jobs WHERE tenant_id=$1 AND commission_id=$2 AND (id=$3 OR (type='verify_artifact' AND input->>'artifactId'=$4 AND input->>'artifactHash'=$5)) ORDER BY created_at,id",[session.tenantId,owned.commission_id,owned.content.productionJobId,artifactId,owned.content_hash])).rows;
  const corrections=(await getPool().query("SELECT id,agreement_digest,agreement FROM guild_web_corrections WHERE tenant_id=$1 AND commission_id=$2 AND package_id=$3 AND (previous_job_id=$4 OR id=$5::uuid) ORDER BY created_at",[session.tenantId,owned.commission_id,owned.package_id,owned.content.productionJobId,owned.content.correction?.id??null])).rows;
  return {schemaVersion:"guild.web-evidence-index.v1",producingJobId:owned.content.productionJobId,attempt:owned.content.attempt,providerId:owned.content.providerId,pipelineVersion:owned.content.pipelineVersion,
    selectedOrdinal:owned.content.selectedOrdinal,producingContract,producingApproval,correctionAgreements:corrections,
    candidates:owned.content.candidates.map(item=>({ordinal:item.ordinal,designDigest:item.designDigest,bundleDigest:item.bundle.filesDigest,model:item.model,producerAuditSummary:webAuditSummary(item.producerAudits),
      preview:`/api/artifacts/${artifactId}/exhibition/${item.ordinal}/index.html`,portableArchive:`/api/artifacts/${artifactId}/exhibition-download?candidate=${item.ordinal}`})),
    originalJobs:jobs.map(job=>({...job,evidenceUrl:`/api/web-jobs/${job.id}/evidence`})),
    disclosure:"Every original design and its producer audit remains visible. Independent browser reports are separate. Existing downloads read their signed authored bytes and original media even when the current provider or newer renderer is unavailable."};
}
