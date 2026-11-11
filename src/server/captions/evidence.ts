import type { ArtifactManifest, Commission, WorkPackage } from "@/contracts/guild";
import { captionArtifactSchema } from "@/domain/captions";
import { digest, DomainError } from "@/domain/primitives";
import { getPool } from "../db";
import type { Session } from "../session";
import { readAlignmentRecord } from "./alignment-runs";
import { readCaptionApprovalHistory } from "./approval-history";

function owner(session: Session) {
  if (!["owner", "judge", "operator"].includes(session.role)) throw new DomainError("ROLE_REQUIRED", "Original caption responses are available to this commission's owner workspace.", 403, false);
}
async function ownedCaption(session: Session, artifactId: string) {
  owner(session);
  const row = (await getPool().query<{ commission_id: string; package_id: string; content_hash: string; manifest: ArtifactManifest }>("SELECT commission_id,package_id,content_hash,manifest FROM guild_artifacts WHERE id=$1 AND tenant_id=$2", [artifactId, session.tenantId])).rows[0];
  if (!row) throw new DomainError("ARTIFACT_NOT_FOUND", "That artifact is not in this workspace.", 404, false);
  const parsed = captionArtifactSchema.safeParse(row.manifest.content);
  if (!parsed.success || row.manifest.id !== artifactId || row.manifest.packageId !== row.package_id || row.manifest.contentHash !== row.content_hash || digest(row.manifest.content) !== row.content_hash || digest(parsed.data.sources) !== parsed.data.sourceDigest)
    throw new DomainError("CAPTION_EVIDENCE_BINDING", "The caption manifest no longer matches its retained complete source and content hash.", 422, false);
  return { ...row, content: parsed.data };
}

/** One owner-only original response at a time keeps the download bounded. */
export async function captionAlignmentEvidence(session: Session, artifactId: string, runId: string) {
  const owned = await ownedCaption(session, artifactId), track = owned.content.tracks.find(item => item.alignmentRunId === runId);
  if (!track) throw new DomainError("CAPTION_RESPONSE_NOT_FOUND", "That original response does not belong to this exact caption submission.", 404, false);
  const source = owned.content.sources.tracks.find(item => item.locale === track.locale && item.key === track.key), saved = await readAlignmentRecord(session.tenantId, runId);
  if (!source || saved.row.commission_id !== owned.commission_id || saved.row.package_id !== owned.package_id || saved.row.job_id !== owned.content.productionJobId
    || saved.row.media_id !== source.mediaId || saved.row.request.sourceDigest !== owned.content.sourceDigest || saved.row.request.contractDigest !== owned.content.contractDigest
    || saved.row.request.sourceTrackDigest !== digest(source) || track.sourceTrackDigest !== digest(source) || saved.receiptHash !== track.receiptHash
    || saved.row.request.originalAudio.contentHash !== source.audioHash || digest(saved.row.request.prompt) !== digest(source.prompt))
    throw new DomainError("CAPTION_EVIDENCE_BINDING", "This retained response no longer matches the exact original audio, script prompt, job and artifact.", 422, false);
  return { schemaVersion: "guild.caption-original-response-export.v1", artifactId, artifactHash: owned.content_hash, locale: source.locale, key: source.key,
    originalAudio: { mediaId: source.mediaId, audioHash: source.audioHash, producingOrigin: source.origin }, completeScript: { text: source.text, bytesHash: source.scriptBytesHash },
    request: saved.row.request, requestHash: saved.row.input_hash, dispatchState: saved.row.state, dispatchedAt: saved.row.dispatched_at?.toISOString() ?? null,
    receiptHash: saved.receiptHash, receipt: saved.receipt,
    disclosure: "Original private timestamp response and explicit bounded source-script prompt. Prompted production alignment is not blind recognition. This retained read makes no provider request and grants no current work authority; the separate independent report determines whether these timings pass." };
}

export async function captionEvidenceIndex(session: Session, artifactId: string) {
  const owned = await ownedCaption(session, artifactId), ids = owned.content.tracks.map(item => item.alignmentRunId);
  const rows = (await getPool().query<{ id: string; job_id: string; media_id: string; state: string; input_hash: string; dispatched_at: Date | null; receipt_hash: string | null; body_hash: string | null; provider_request_id: string | null }>("SELECT a.id,a.job_id,a.media_id,a.state,a.input_hash,a.dispatched_at,o.receipt_hash,o.receipt->>'bodyHash' AS body_hash,o.receipt->>'providerRequestId' AS provider_request_id FROM guild_alignment_runs a LEFT JOIN guild_alignment_observations o ON o.run_id=a.id AND o.tenant_id=a.tenant_id WHERE a.tenant_id=$1 AND a.commission_id=$2 AND a.package_id=$3 AND a.job_id=$4 AND a.id=ANY($5::uuid[]) ORDER BY a.operation_key", [session.tenantId, owned.commission_id, owned.package_id, owned.content.productionJobId, ids])).rows;
  const corrections = (await getPool().query("SELECT id,agreement_digest,agreement FROM guild_caption_corrections WHERE tenant_id=$1 AND commission_id=$2 AND package_id=$3 AND (previous_job_id=$4 OR id=$5::uuid) ORDER BY created_at", [session.tenantId, owned.commission_id, owned.package_id, owned.content.productionJobId, owned.content.correction?.id ?? null])).rows;
  let producingContract: WorkPackage | null = null, producingApproval: { verified: boolean; planDigest: string | null; message: string };
  try {
    const c = (await getPool().query<{ snapshot: Commission }>("SELECT snapshot FROM guild_commissions WHERE id=$1 AND tenant_id=$2", [owned.commission_id, session.tenantId])).rows[0]?.snapshot, pkg = c?.packages.find(item => item.id === owned.package_id);
    if (!c || !pkg) throw new Error("Current lineage unavailable");
    const original = await readCaptionApprovalHistory(getPool(), c, pkg, owned.manifest);
    producingContract = original.package;
    producingApproval = { verified: true, planDigest: original.snapshot.approvedPlanDigest, message: "The exact original producing command, approval snapshot and signed receipt match this retained artifact. This is historical evidence only." };
  } catch (error) { producingApproval = { verified: false, planDigest: null, message: error instanceof DomainError ? error.message : "The original producing approval could not be verified. No successful authority or source lineage is inferred." }; }
  return { schemaVersion: "guild.caption-evidence-index.v1", attempt: owned.content.attempt, producingJobId: owned.content.productionJobId, producingContract, producingApproval, correctionAgreements: corrections,
    originalBlindReport: owned.content.sources.narration.verificationReport,
    alignmentResponses: owned.content.tracks.map(track => { const row = rows.find(item => item.id === track.alignmentRunId); return { locale: track.locale, key: track.key, runId: track.alignmentRunId,
      available: !!row?.receipt_hash, state: row?.state ?? "missing", mediaId: row?.media_id ?? null, requestHash: row?.input_hash ?? null, receiptHash: row?.receipt_hash ?? null,
      receiptHashMatchesArtifact: row?.receipt_hash === track.receiptHash, rawBodyHash: row?.body_hash ?? null, providerRequestId: row?.provider_request_id ?? null,
      originalResponseDownload: `/api/artifacts/${artifactId}/caption-alignment?runId=${track.alignmentRunId}` }; }),
    disclosure: "An index of all submitted tracks and their retained original responses, including failures. Download each bounded raw response separately; this index does not recheck file bytes or create new recognition, human review, acceptance or payment." };
}
