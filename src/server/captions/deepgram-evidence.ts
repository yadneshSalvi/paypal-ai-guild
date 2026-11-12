import type { ArtifactManifest, Commission, WorkPackage } from "@/contracts/guild";
import { deepgramCaptionArtifactSchema } from "@/domain/deepgram-captions";
import { digest, DomainError } from "@/domain/primitives";
import { getPool } from "../db";
import type { Session } from "../session";
import { readDeepgramRun } from "./deepgram-runs";
import { captionReviewTarget } from "./review";
import { readDeepgramCaptionApprovalHistory } from "./deepgram-contracts";

async function owned(session: Session, artifactId: string) {
  if (!["owner", "judge", "operator"].includes(session.role)) throw new DomainError("ROLE_REQUIRED", "Original caption evidence belongs to this commission’s owner workspace.", 403, false);
  const row = (await getPool().query<{ commission_id: string; package_id: string; content_hash: string; manifest: ArtifactManifest }>("SELECT commission_id,package_id,content_hash,manifest FROM guild_artifacts WHERE tenant_id=$1 AND id=$2", [session.tenantId, artifactId])).rows[0];
  if (!row || row.content_hash !== row.manifest.contentHash || row.manifest.id !== artifactId || digest(row.manifest.content) !== row.content_hash) throw new DomainError("CAPTION_EVIDENCE_BINDING", "The exact original caption artifact is unavailable.", 422, false);
  return { ...row, content: deepgramCaptionArtifactSchema.parse(row.manifest.content) };
}

export async function deepgramCaptionAlignmentEvidence(session: Session, artifactId: string, runId: string) {
  const value = await owned(session, artifactId), track = value.content.tracks.find(item => item.alignmentRunId === runId);
  if (!track) throw new DomainError("CAPTION_RESPONSE_NOT_FOUND", "That response is not part of this exact caption edition.", 404, false);
  const target = await captionReviewTarget(getPool(), session.tenantId, artifactId, track.locale, track.key), saved = await readDeepgramRun(session.tenantId, runId);
  return { schemaVersion: "guild.deepgram-caption-original-export.v1", artifactId, artifactHash: value.content_hash, locale: track.locale, key: track.key,
    originalAudio: { mediaId: target.source.mediaId, audioHash: target.source.audioHash, producingOrigin: target.source.origin }, completeScript: { text: target.source.text, bytesHash: target.source.scriptBytesHash },
    request: saved.row.request, requestHash: saved.row.input_hash, dispatchState: saved.row.state, dispatchedAt: saved.row.dispatched_at?.toISOString() ?? null,
    receiptHash: saved.evidenceHash, receipt: saved.receipt, automaticCandidate: track.candidate, attributedReview: track.reviewRevision,
    disclosure: "Signed original Deepgram bytes and blind recognition, with raw and separately rounded boundaries. Manual corrections are separate attributed records. This historical read sends no provider request and creates no current authority, listening review, acceptance or payment." };
}

export async function deepgramCaptionEvidenceIndex(session: Session, artifactId: string) {
  const value = await owned(session, artifactId), c = (await getPool().query<{ snapshot: Commission }>("SELECT snapshot FROM guild_commissions WHERE tenant_id=$1 AND id=$2", [session.tenantId, value.commission_id])).rows[0]?.snapshot;
  let producingContract: WorkPackage | null = null, producingApproval: { verified: boolean; planDigest: string | null; message: string };
  try {
    if (!c) throw new Error("Missing commission");
    let pkg = c.packages.find(item => item.id === value.package_id && item.acceptancePack.digest === value.content.contractDigest);
    if (!pkg) {
      const history = (await getPool().query<{ previous_contract: WorkPackage; proposed_contract: WorkPackage }>("SELECT previous_contract,proposed_contract FROM guild_contract_amendments WHERE tenant_id=$1 AND commission_id=$2 AND package_id=$3 ORDER BY to_version", [session.tenantId, c.id, value.package_id])).rows;
      pkg = history.flatMap(item => [item.previous_contract, item.proposed_contract]).find(item => item.acceptancePack.digest === value.content.contractDigest);
    }
    if (!pkg) throw new Error("Missing original contract");
    const original = await readDeepgramCaptionApprovalHistory(getPool(), c, pkg, value.manifest);
    producingContract = original.package; producingApproval = { verified: true, planDigest: original.snapshot.approvedPlanDigest, message: "The exact original producing command, signed Passport, source and review edition match. This history grants no current production authority." };
  } catch (error) { producingApproval = { verified: false, planDigest: null, message: error instanceof DomainError ? error.message : "The original producing approval could not be verified." }; }
  const rows = (await getPool().query<{ id: string; state: string; input_hash: string; receipt_hash: string | null; body_hash: string | null; provider_request_id: string | null }>("SELECT a.id,a.state,a.input_hash,o.receipt_hash,o.receipt->'receipt'->>'bodyHash' AS body_hash,o.receipt->'receipt'->>'providerRequestId' AS provider_request_id FROM guild_alignment_runs a LEFT JOIN guild_alignment_observations o ON o.run_id=a.id AND o.tenant_id=a.tenant_id WHERE a.tenant_id=$1 AND a.commission_id=$2 AND a.id=ANY($3::uuid[])", [session.tenantId, value.commission_id, value.content.tracks.map(item => item.alignmentRunId)])).rows;
  return { schemaVersion: "guild.caption-evidence-index.v2", attempt: value.content.attempt, producingJobId: value.content.productionJobId, originalProductionJobId: value.content.originalProductionJobId,
    producingContract, producingApproval, correction: value.content.correction, originalBlindReport: value.content.sources.narration.verificationReport,
    alignmentResponses: value.content.tracks.map(track => { const row = rows.find(item => item.id === track.alignmentRunId); return { locale: track.locale, key: track.key, runId: track.alignmentRunId,
      state: row?.state ?? "missing", requestHash: row?.input_hash ?? null, receiptHash: row?.receipt_hash ?? null, rawBodyHash: row?.body_hash ?? null, providerRequestId: row?.provider_request_id ?? null,
      receiptHashMatchesArtifact: row?.receipt_hash === track.receiptHash, automaticStatus: track.candidate.status, effectiveTimingSource: track.effective.provenance, reviewRevision: track.reviewRevision,
      originalResponseDownload: `/api/artifacts/${artifactId}/caption-alignment?runId=${track.alignmentRunId}`, reviewHistory: `/api/artifacts/${artifactId}/caption-review?locale=${track.locale}&key=${encodeURIComponent(track.key)}` }; }),
    automatedQualification: "not-qualified", disclosure: "Every original recording and recognition outcome remains visible. Listening declarations are attributed human statements; fluent-language review, final acceptance and payment are separate. The independent report rechecks actual audio, raw responses, complete source, revisions and VTT bytes." };
}

/** Failed jobs may have evidence even when no complete artifact was published. */
export async function deepgramCaptionJobEvidence(session: Session, commissionId: string, jobId: string, runId?: string) {
  if (!["owner", "judge", "operator"].includes(session.role)) throw new DomainError("ROLE_REQUIRED", "Original request evidence belongs to this owner workspace.", 403, false);
  const job = (await getPool().query<{ state: string; input: { packageId?: string; captionSourceDigest?: string }; error: string | null }>("SELECT state,input,error FROM guild_jobs WHERE tenant_id=$1 AND commission_id=$2 AND id=$3 AND type='produce_package'", [session.tenantId, commissionId, jobId])).rows[0];
  const c = (await getPool().query<{ snapshot: Commission }>("SELECT snapshot FROM guild_commissions WHERE tenant_id=$1 AND id=$2", [session.tenantId, commissionId])).rows[0]?.snapshot;
  if (!job || !c || !job.input.captionSourceDigest || c.packages.find(item => item.id === job.input.packageId)?.kind !== "captions") throw new DomainError("CAPTION_JOB_EVIDENCE", "That original caption job is not in this workspace.", 404, false);
  const rows = (await getPool().query<{ id: string }>("SELECT id FROM guild_alignment_runs WHERE tenant_id=$1 AND commission_id=$2 AND job_id=$3 AND capability_version='guild.deepgram-word-timestamps.v1' ORDER BY created_at,id", [session.tenantId, commissionId, jobId])).rows;
  if (runId && !rows.some(row => row.id === runId)) throw new DomainError("CAPTION_JOB_EVIDENCE", "That original request does not belong to this job.", 404, false);
  const observations = [];
  for (const row of rows.filter(item => !runId || item.id === runId)) {
    const saved = await readDeepgramRun(session.tenantId, row.id);
    if (saved.row.commission_id !== commissionId || saved.row.job_id !== jobId || saved.row.package_id !== job.input.packageId) throw new DomainError("CAPTION_JOB_EVIDENCE", "The original request binding changed.", 422, false);
    observations.push({ runId: row.id, state: saved.row.state, failureCode: saved.row.failure_code, dispatchedAt: saved.row.dispatched_at?.toISOString() ?? null,
      request: saved.row.request, requestHash: saved.row.input_hash, receiptHash: saved.evidenceHash, bodyComplete: saved.receipt?.bodyComplete ?? false,
      parseFailure: saved.receipt?.parseFailure ?? null, rawBodyHash: saved.receipt?.bodyHash ?? null,
      ...(runId ? { receipt: saved.receipt } : {}),
      originalResponseDownload: `/api/commissions/${commissionId}/caption-operations?jobId=${jobId}&runId=${row.id}` });
  }
  return { schemaVersion: "guild.deepgram-caption-job-evidence.v1", commissionId, jobId, state: job.state, sourceDigest: job.input.captionSourceDigest, observations,
    retryAuthorized: false, disclosure: "Retained original requests, including partial or unknown outcomes. A missing complete artifact is not a missing attempt. This read sends no request, grants no retry and records no human review or acceptance." };
}
