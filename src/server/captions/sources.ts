import { createHash } from "node:crypto";
import { z } from "zod";
import type { Pool, PoolClient } from "pg";
import type { AcceptancePack, ArtifactInputBinding, ArtifactManifest, Commission, WorkPackage } from "@/contracts/guild";
import { captionConcepts, captionInputBindingSchema, captionSourceSchema, type CaptionSources, type CaptionTrackSource } from "@/domain/captions";
import { completeNarrationArtifactSchema, narrationAcceptancePack, narrationScripts } from "@/domain/narration";
import { researchTranslationSource, translationArtifactSchema } from "@/domain/translation";
import { digest, DomainError } from "@/domain/primitives";
import { readNarrationApprovalHistory } from "../narration-approval-history";
import { validateNarrationCorrection } from "../narration-corrections";
import { validateNarrationTargetedCorrection } from "../narration-targeted-corrections";
import { validateNarrationFollowupCorrection } from "../narration-followup-corrections";
import { resolveProductionInputs } from "../production-inputs";
import { narrationFileMetadata } from "../media/narration-metadata";
import { qualifiedWhisperTokenizer } from "./tokenizer";

type Db = Pool | PoolClient;
function fail(message = "The caption source no longer matches its exact immutable audio, source reviews and producing approval chain."): never { throw new DomainError("CAPTION_SOURCE_BINDING", message, 422, false); }
interface ProducingJob { id: string; state: string; input: { packageId: string; contractVersion: number; inputBindings: ArtifactInputBinding[]; correctionAgreementId?: string; correctionAgreementDigest?: string; targetedAgreementId?: string; targetedAgreementDigest?: string; followupAgreementId?: string; followupAgreementDigest?: string }; output: { artifactId?: string } | null }
export async function captionOwnedArtifact(db: Db, commission: Commission, id: string, hash?: string) {
  const row = (await db.query<{ content_hash: string; manifest: ArtifactManifest }>("SELECT content_hash,manifest FROM guild_artifacts WHERE tenant_id=$1 AND commission_id=$2 AND id=$3", [commission.tenantId, commission.id, id])).rows[0];
  if (!row || hash && hash !== row.content_hash || row.manifest.id !== id || row.manifest.contentHash !== row.content_hash || digest(row.manifest.content) !== row.content_hash || row.manifest.provenance.mode !== "live") fail();
  return row.manifest;
}
async function originalContract(db: Db, c: Commission, packageId: string, version: number) {
  const current = c.packages.find(item => item.id === packageId);
  if (!current) fail();
  if (current.contractVersion === version) return current;
  const history = (await db.query<{ previous_contract: WorkPackage; proposed_contract: WorkPackage }>("SELECT previous_contract,proposed_contract FROM guild_contract_amendments WHERE tenant_id=$1 AND commission_id=$2 AND package_id=$3 AND (from_version=$4 OR to_version=$4) ORDER BY to_version", [c.tenantId, c.id, packageId, version])).rows;
  const matches = history.flatMap(row => [row.previous_contract, row.proposed_contract]).filter(item => item.contractVersion === version && item.id === packageId);
  if (!matches.length) fail();
  return matches[0]!;
}
async function originalJob(db: Db, c: Commission, artifact: ArtifactManifest): Promise<ProducingJob> {
  const job = (await db.query<ProducingJob>("SELECT id,state,input,output FROM guild_jobs WHERE tenant_id=$1 AND commission_id=$2 AND type='produce_package' AND output->>'artifactId'=$3", [c.tenantId, c.id, artifact.id])).rows;
  if (job.length !== 1 || job[0]!.state !== "completed" || job[0]!.input.packageId !== artifact.packageId || job[0]!.output?.artifactId !== artifact.id) fail();
  return job[0]!;
}

/** Freeze the exact original review and its passing report, rather than the latest annotation. */
async function reviewEvidence(db: Db, c: Commission, binding: ArtifactInputBinding): Promise<CaptionSources["reviews"][number]> {
  const params = [binding.reviewId, c.tenantId, c.id, binding.packageId, binding.contractVersion, binding.artifactId, binding.artifactHash];
  let record: Record<string, unknown>, criteria: string;
  if (binding.reviewKind === "automated_review") {
    const row = (await db.query<{ id: string; criteria_digest: string; disclosures: Record<string, unknown>; [key: string]: unknown }>("SELECT id,package_id,contract_version,artifact_id,artifact_hash,criteria_digest,actor_id,review_kind,findings,disclosures,created_at FROM guild_artifact_reviews WHERE id=$1 AND tenant_id=$2 AND commission_id=$3 AND package_id=$4 AND contract_version=$5 AND artifact_id=$6 AND artifact_hash=$7 AND review_kind='automated'", params)).rows[0];
    if (!row || row.disclosures.humanReviewed !== false || row.disclosures.accepted !== false) fail("The exact automated source review is missing or claims a different kind of acceptance.");
    record = row; criteria = row.criteria_digest;
  } else {
    const row = (await db.query<{ id: string; criteria_digest: string; review_disclosures: Record<string, unknown>; [key: string]: unknown }>("SELECT id,package_id,contract_version,artifact_id,artifact_hash,criteria_digest,actor_id,decision,review_disclosures,created_at FROM guild_acceptance_decisions WHERE id=$1 AND tenant_id=$2 AND commission_id=$3 AND package_id=$4 AND contract_version=$5 AND artifact_id=$6 AND artifact_hash=$7 AND decision='accepted'", params)).rows[0];
    if (!row || row.review_disclosures.humanReviewed !== true) fail("The exact source acceptance is missing or is only a system qualification acknowledgment.");
    record = row; criteria = row.criteria_digest;
  }
  const reports = (await db.query<{ id: string; criteria_digest: string; result: AcceptancePack; created_at: Date }>("SELECT id,criteria_digest,result,created_at FROM guild_verifications WHERE tenant_id=$1 AND commission_id=$2 AND package_id=$3 AND contract_version=$4 AND artifact_id=$5 AND artifact_hash=$6 ORDER BY created_at,id", [c.tenantId, c.id, binding.packageId, binding.contractVersion, binding.artifactId, binding.artifactHash])).rows;
  const report = reports.find(row => row.criteria_digest === digest(row.result) && (binding.reviewKind === "automated_review" ? row.criteria_digest === criteria : row.result.digest === criteria)
    && row.result.criteria.some(item => item.blocking && item.kind === "deterministic") && row.result.criteria.every(item => !item.blocking || item.kind !== "deterministic" || item.status === "passed"));
  if (!report) fail("The source review has no matching complete passing deterministic report. No human review is inferred.");
  // Dates must hash as their actual values; canonical(Date) would otherwise be {}.
  return { ...binding, recordHash: digest(JSON.parse(JSON.stringify(record))), verificationId: report.id, verificationHash: digest(JSON.parse(JSON.stringify(report))) };
}

/** Read-only source construction. It never requests speech, transcription or model work. */
export async function buildCaptionSources(db: Db, c: Commission, pkg: WorkPackage, frozen?: CaptionSources): Promise<CaptionSources> {
  if (pkg.kind !== "captions" || c.mode !== "live") fail("Captions need a live contract with exact original narration, research and translation.");
  const current = await resolveProductionInputs(db, c, pkg);
  const inputBindings = frozen?.inputBindings ?? current.bindings;
  if (current.bindings.length !== inputBindings.length || !current.bindings.every(binding => inputBindings.some(item => item.packageId === binding.packageId && item.contractVersion === binding.contractVersion && item.artifactId === binding.artifactId && item.artifactHash === binding.artifactHash))) fail();
  const narrationPkg = c.packages.find(item => item.kind === "narration"), binding = inputBindings.find(item => item.packageId === narrationPkg?.id);
  if (!narrationPkg || !binding) fail();
  const narration = await captionOwnedArtifact(db, c, binding.artifactId, binding.artifactHash), content = completeNarrationArtifactSchema.parse(narration.content);
  const translation = await captionOwnedArtifact(db, c, content.sourceArtifactId, content.sourceArtifactHash), translated = translationArtifactSchema.parse(translation.content);
  const research = await captionOwnedArtifact(db, c, translated.sourceArtifactId, translated.sourceArtifactHash), english = researchTranslationSource(research);
  if (digest(english) !== digest(translated.translations.en) || narrationPkg.contractVersion !== binding.contractVersion || content.contractDigest !== narrationPkg.acceptancePack.digest
    || narrationPkg.acceptancePack.digest !== narrationAcceptancePack(translation, content.engine).digest) fail();
  const narrationJob = await originalJob(db, c, narration);
  const approved = await readNarrationApprovalHistory(db, c, narrationPkg, fail, narrationJob.id);
  if (content.schemaVersion === "guild.narration.v4") await validateNarrationFollowupCorrection(db, c, narrationPkg, narrationJob, true);
  else if (content.schemaVersion === "guild.narration.v3") await validateNarrationTargetedCorrection(db, c, narrationPkg, narrationJob, true);
  else await validateNarrationCorrection(db, c, narrationPkg, narrationJob, true);
  const translationBinding = content.inputBindings.find(item => item.artifactId === translation.id && item.artifactHash === translation.contentHash);
  const researchBinding = translated.inputBindings.find(item => item.artifactId === research.id && item.artifactHash === research.contentHash);
  if (!translationBinding || !researchBinding) fail();
  const allBindings = [binding, translationBinding, researchBinding], reviews = [];
  for (const item of allBindings) reviews.push(await reviewEvidence(db, c, captionInputBindingSchema.parse(item)));
  const report = (await db.query<{ id: string; output: { pack: AcceptancePack; report: { artifactId: string; artifactHash: string; checks: { locale: string; key: string; mediaId: string; source: boolean; audio: boolean; duration: boolean; transcript: boolean; loudness: boolean }[] } } }>("SELECT id,output FROM guild_jobs WHERE tenant_id=$1 AND commission_id=$2 AND type='verify_artifact' AND state='completed' AND input->>'artifactId'=$3 AND input->>'artifactHash'=$4 AND ($5::uuid IS NULL OR id=$5) ORDER BY created_at DESC,id DESC LIMIT 1", [c.tenantId, c.id, narration.id, narration.contentHash, frozen?.narration.verificationReport.jobId ?? null])).rows[0];
  if (!report?.output?.report || report.output.report.artifactId !== narration.id || report.output.report.artifactHash !== narration.contentHash || report.output.pack.digest !== narrationPkg.acceptancePack.digest
    || report.output.report.checks.length !== content.segments.length || report.output.report.checks.some(item => !item.source || !item.audio || !item.duration || !item.transcript || !item.loudness)) fail("The complete narration needs its exact passing independent report. Its blind-recognition advisory remains unchanged.");
  const scripts = narrationScripts(translation), tokenizer = await qualifiedWhisperTokenizer(), tracks: CaptionTrackSource[] = [];
  const producingApprovals = new Map<string, { job: ProducingJob; pkg: WorkPackage; plan: string }>();
  producingApprovals.set(narrationJob.id, { job: narrationJob, pkg: narrationPkg, plan: approved.approvedPlanDigest! });
  for (const script of scripts) {
    const segment = content.segments.find(item => item.locale === script.locale && item.key === script.key);
    if (!segment || segment.text !== script.text || segment.title !== script.title || segment.textHash !== script.textHash) fail();
    const origin = content.schemaVersion === "guild.narration.v2" ? null : content.lineage.find(item => item.locale === script.locale && item.key === script.key);
    if (content.schemaVersion !== "guild.narration.v2" && !origin) fail();
    const producingArtifact = origin?.mode === "carried" ? await captionOwnedArtifact(db, c, origin.originalArtifactId!, origin.originalArtifactHash!) : narration;
    const producingContent = completeNarrationArtifactSchema.parse(producingArtifact.content), originalSegment = producingContent.segments.find(item => item.locale === script.locale && item.key === script.key);
    if (!originalSegment || digest(originalSegment) !== digest(segment)) fail();
    const jobId = origin?.productionJobId ?? narrationJob.id;
    let producer = producingApprovals.get(jobId);
    if (!producer) {
      const job = await originalJob(db, c, producingArtifact), priorPkg = await originalContract(db, c, narrationPkg.id, job.input.contractVersion);
      if (job.id !== jobId) fail();
      const approval = await readNarrationApprovalHistory(db, c, priorPkg, fail, job.id);
      if (producingContent.schemaVersion === "guild.narration.v4") await validateNarrationFollowupCorrection(db, c, priorPkg, job, true);
      else if (producingContent.schemaVersion === "guild.narration.v3") await validateNarrationTargetedCorrection(db, c, priorPkg, job, true);
      else await validateNarrationCorrection(db, c, priorPkg, job, true);
      producer = { job, pkg: priorPkg, plan: approval.approvedPlanDigest! }; producingApprovals.set(jobId, producer);
    }
    const speech = (await db.query<{ job_id: string; input_hash: string; request: Record<string, unknown>; receipt: Record<string, unknown>; receipt_hash: string; pcm_hash: string }>("SELECT job_id,input_hash,request,receipt,receipt_hash,pcm_hash FROM guild_speech_runs WHERE tenant_id=$1 AND commission_id=$2 AND package_id=$3 AND id=$4 AND state='completed'", [c.tenantId, c.id, narrationPkg.id, segment.speechRun.id])).rows[0];
    const media = (await db.query<{ job_id: string; operation_key: string; content_hash: string; byte_length: string; metadata: unknown }>("SELECT job_id,operation_key,content_hash,byte_length,metadata FROM guild_media_objects WHERE tenant_id=$1 AND commission_id=$2 AND package_id=$3 AND id=$4 AND state='ready' AND media_type='audio/mpeg'", [c.tenantId, c.id, narrationPkg.id, segment.audio.mediaId])).rows[0];
    const correction = origin?.correctionAgreement ?? (producingContent.schemaVersion === "guild.narration.v2" ? producingContent.correctionAgreement : undefined);
    const { audio: _audio, ...segmentMetadata } = segment, { mediaId: _mediaId, url: _url, ...measurement } = segment.audio;
    const { operationId: _operationId, ...speechRequest } = speech?.request ?? {};
    if (!speech || !media || producer.job.id !== speech.job_id || media.job_id !== speech.job_id || media.operation_key !== `narration:${script.locale}:${script.key}:mp3`
      || media.content_hash !== segment.audio.contentHash || Number(media.byte_length) !== segment.audio.byteLength || segment.audio.url !== `/api/media/${segment.audio.mediaId}`
      || speech.receipt_hash !== segment.speechRun.receiptHash || digest(speech.receipt) !== speech.receipt_hash || speech.pcm_hash !== segment.speechRun.pcmHash
      || speech.receipt.contentHash !== segment.speechRun.pcmHash || speech.receipt.model !== segment.speechRun.model || speech.receipt.transcript !== segment.speechRun.transcript
      || speechRequest.text !== script.text || speechRequest.locale !== script.locale
      || speech.input_hash !== digest({ ...speechRequest, contractVersion: producer.pkg.contractVersion, contractDigest: producer.pkg.acceptancePack.digest, inputBindings: producer.job.input.inputBindings })
      || digest(media.metadata) !== digest(narrationFileMetadata(producer.pkg.acceptancePack.digest, translation, segmentMetadata, measurement, correction))
      || !report.output.report.checks.some(item => item.locale === script.locale && item.key === script.key && item.mediaId === segment.audio.mediaId)) fail();
    tracks.push({ ...script, scriptBytesHash: createHash("sha256").update(script.text).digest("hex"), segmentHash: digest(segment), mediaId: segment.audio.mediaId,
      audioHash: segment.audio.contentHash, byteLength: segment.audio.byteLength, durationSeconds: segment.audio.durationSeconds,
      origin: { artifactId: producingArtifact.id, artifactHash: producingArtifact.contentHash, packageId: narrationPkg.id, productionJobId: jobId, contractVersion: producer.pkg.contractVersion,
        contractDigest: producer.pkg.acceptancePack.digest, inputBindingsDigest: digest(producer.job.input.inputBindings), approvalPlanDigest: producer.plan,
        speechRunId: segment.speechRun.id, receiptHash: segment.speechRun.receiptHash, pcmHash: segment.speechRun.pcmHash, correctionAgreement: correction ?? null },
      prompt: tokenizer.excerpt(script.text, script.locale) });
  }
  // estimateSeconds belongs to original narration; it is never a caption timing.
  const stripped = tracks.map(track => { const { estimateSeconds: _estimate, ...value } = track as CaptionTrackSource & { estimateSeconds?: number }; return value; });
  const result = captionSourceSchema.parse({ schemaVersion: "northlight.caption-sources.v1",
    narration: { artifactId: narration.id, artifactHash: narration.contentHash, packageId: narration.packageId, contractVersion: binding.contractVersion, productionJobId: narrationJob.id, approvalPlanDigest: approved.approvedPlanDigest,
      verificationReport: { jobId: report.id, outputHash: digest(report.output) } },
    translation: { artifactId: translation.id, artifactHash: translation.contentHash, packageId: translation.packageId, contractVersion: translationBinding.contractVersion },
    research: { artifactId: research.id, artifactHash: research.contentHash, packageId: research.packageId, contractVersion: researchBinding.contractVersion },
    inputBindings, reviews, requiredKeys: Object.keys(english).sort(), concepts: captionConcepts(research), tracks: stripped });
  if (frozen && digest(result) !== digest(frozen)) fail();
  return result;
}
