import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { ArtifactManifest, Commission, NarrationCorrectionRecording, NarrationTargetedCorrectionAgreement, NarrationTargetedCorrectionProposal, WorkPackage } from "@/contracts/guild";
import { planDigest } from "@/domain/fixture";
import { narrationArtifactSchema, narrationScripts, narrationStandard } from "@/domain/narration";
import { narrationTargetedPolicy, targetedCorrectionDigest, targetedDelivery, targetedSpeechInstructions } from "@/domain/narration-targeted-correction";
import { canonical, digest, DomainError } from "@/domain/primitives";
import { readNarrationCorrectionBasis, validateNarrationCorrection } from "./narration-corrections";
import type { Session } from "./session";
import { narrationFileMetadata } from "./media/narration-metadata";
import type { SpeechRequest } from "./media/speech-gateway";
import { resolveProductionInputs } from "./production-inputs";
import { readNarrationApprovalHistory } from "./narration-approval-history";

type Db = Pool | PoolClient;
function fail(code: string, message: string): never { throw new DomainError(code, message, 422, false); }
function bindingFailure(): never { return fail("NARRATION_TARGETED_BINDING", "The targeted agreement no longer matches its signed source, exact recording register, original reports or commercial terms."); }

export async function narrationTargetedCorrectionProposal(db: Db, c: Commission, pkg: WorkPackage): Promise<NarrationTargetedCorrectionProposal> {
  if (pkg.narrationTargetedCorrection) fail("NARRATION_TARGETED_REVIEW_REQUIRED", "The targeted job has used its one attempt. Retain its results and review a new scope before commissioning any further recording.");
  if (!pkg.narrationCorrection) fail("NARRATION_TARGETED_PRIOR_AGREEMENT", "This targeted policy follows the separately agreed complete correction round. The original allowance and offer keep their own limits.");
  await validateNarrationCorrection(db, c, pkg);
  const base = await readNarrationCorrectionBasis(db, c, pkg);
  const { approval, source, inputs, frozenPack, history, latest, latestCheck, latestReport, scriptCount, note, expiresAt, provider } = base;
  const artifact = c.artifacts.find(item => item.id === latest.artifactId)!;
  const content = narrationArtifactSchema.parse(artifact.content), scripts = narrationScripts(source);
  const report = latestReport.report;
  const evaluation = base.evaluations.filter(item => item.input.artifactId === artifact.id && item.input.contractVersion === pkg.contractVersion && item.state === "completed").at(-1)!;
  if (digest(content.standard) !== digest(narrationStandard) || content.contractDigest !== pkg.acceptancePack.digest || content.sourceArtifactId !== source.id || content.sourceArtifactHash !== source.contentHash || digest(content.inputBindings) !== digest(inputs.bindings) || content.segments.length !== scripts.length || new Set(report.checks.map(item => `${item.locale}/${item.key}`)).size !== scripts.length) bindingFailure();
  const register: NarrationCorrectionRecording[] = scripts.map(script => {
    const segment = content.segments.find(item => item.locale === script.locale && item.key === script.key);
    const check = report.checks.find(item => item.locale === script.locale && item.key === script.key);
    if (!segment || !check || segment.text !== script.text || segment.textHash !== script.textHash || segment.title !== script.title || segment.estimateSeconds !== script.estimateSeconds || check.mediaId !== segment.audio.mediaId || !check.source || !check.audio || !check.loudness || typeof check.duration !== "boolean" || typeof check.transcript !== "boolean") fail("NARRATION_TARGETED_SCOPE", "Targeted repair requires complete exact-source files with passing coverage, format and loudness. Other failures need a separate reviewed scope.");
    const failures: NarrationCorrectionRecording["failures"] = [];
    if (!check.duration) { if (script.locale !== "ar") fail("NARRATION_TARGETED_SCOPE", "Only the measured Arabic duration failures are covered by this offer."); failures.push("duration"); }
    if (!check.transcript) { if (script.locale !== "en") fail("NARRATION_TARGETED_SCOPE", "Only the measured English provider-transcript failures are covered by this offer."); failures.push("transcript"); }
    return { locale: script.locale, key: script.key, action: failures.length ? "replace" : "carry_forward", failures, textHash: script.textHash, replacementInstructionsHash: failures.length ? digest(targetedSpeechInstructions(script)) : null, cue: failures.length ? `${script.locale}/${script.key}` === narrationTargetedPolicy.durationCueKey ? "duration_cue" : "original_cue" : null, segmentHash: digest(segment), artifactId: artifact.id, artifactHash: artifact.contentHash, productionJobId: latest.productionJobId, contractVersion: latest.contractVersion, contractDigest: content.contractDigest, inputBindingsDigest: digest(content.inputBindings), mediaId: segment.audio.mediaId, mediaHash: segment.audio.contentHash, speechRunId: segment.speechRun.id, receiptHash: segment.speechRun.receiptHash, pcmHash: segment.speechRun.pcmHash, ...(content.correctionAgreement ? { correctionAgreement: content.correctionAgreement } : {}) };
  });
  const replacements = register.filter(item => item.action === "replace");
  if (!replacements.length || replacements.length > narrationTargetedPolicy.maximumReplacementRecordings || replacements.length === scriptCount || pkg.acceptancePack.criteria.some(item => item.kind === "deterministic" && item.blocking && item.status !== (replacements.some(entry => entry.failures.includes(item.id as "duration" | "transcript")) ? "failed" : "passed"))) fail("NARRATION_TARGETED_SCOPE", "This offer permits at most five exact failed recordings and preserves every passing original. Review other failure scopes separately.");
  const proposal: Omit<NarrationTargetedCorrectionProposal, "digest"> = {
    version: "guild.narration-targeted-correction.v1", commissionId: c.id, packageId: pkg.id, fromVersion: pkg.contractVersion, toVersion: pkg.contractVersion + 1, previousPlanDigest: c.approvedPlanDigest!, acceptancePackDigest: pkg.acceptancePack.digest,
    authorityCeiling: structuredClone(pkg.narrationCorrection.proposal.previousApproval),
    previousApproval: { id: approval.id, actorId: approval.actor_id, actorExpiresAt: approval.expires_at.toISOString(), receiptDigest: digest({ payload: approval.payload, signature: approval.signature }) },
    sourceArtifactId: source.id, sourceArtifactHash: source.contentHash, inputBindings: inputs.bindings,
    correction: { eventId: note.id, eventHash: note.hash, note: note.detail },
    scope: { maximumProductionJobs: 1, maximumAttemptsPerRecording: 1, selectionRule: narrationTargetedPolicy.selectionRule, recordings: scriptCount, replacementRecordings: replacements.length, carriedRecordings: scriptCount - replacements.length, locales: [...c.languages], scriptRegisterDigest: digest(frozenPack.parameters!.scripts), register, registerDigest: digest(register), delivery: targetedDelivery },
    commercial: { providerId: "quill", providerAwardMinor: pkg.providerAwardMinor, serviceFeeMinor: pkg.serviceFeeMinor, grossMinor: pkg.grossMinor, additionalChargeMinor: 0, commissionTotalMinor: c.packages.reduce((sum, item) => sum + item.grossMinor, 0), capMinor: c.capMinor },
    providerOffer: { issuer: narrationTargetedPolicy.issuer, policyVersion: narrationTargetedPolicy.version, policyDigest: digest(narrationTargetedPolicy), originalPolicyDigest: provider.policyDigest, expiresAt: new Date(Math.min(Date.parse(expiresAt), Date.parse(pkg.narrationCorrection.proposal.providerOffer.expiresAt), Date.parse(pkg.narrationCorrection.proposal.previousApproval.actorExpiresAt))).toISOString(), disclosure: narrationTargetedPolicy.disclosure },
    history, latestVerificationId: latestCheck.id, latestCriteriaDigest: latestCheck.criteria_digest, latestEvaluation: { jobId: evaluation.id, outputDigest: digest(evaluation.output) }, failedRecordingKeys: replacements.map(item => `${item.locale}/${item.key}`),
  };
  const result = { ...proposal, digest: targetedCorrectionDigest(proposal) };
  await validateTargetedOriginals(db, c, result);
  await validateTargetedActors(db, c, result);
  return result;
}

function signature(tenantId: string, agreement: NarrationTargetedCorrectionAgreement) {
  if (!process.env.AUTH_SECRET) throw new Error("AUTH_SECRET required");
  return createHmac("sha256", process.env.AUTH_SECRET).update(canonical({ kind: agreement.providerReceipt.kind, tenantId, agreementId: agreement.id, proposalDigest: agreement.proposal.digest, agreedAt: agreement.agreedAt })).digest("hex");
}

async function validateTargetedActors(db: Db, c: Commission, p: NarrationTargetedCorrectionProposal) {
  if (Date.parse(p.providerOffer.expiresAt) <= Date.now() || Date.parse(p.previousApproval.actorExpiresAt) <= Date.now() || Date.parse(p.authorityCeiling.actorExpiresAt) <= Date.now()) fail("NARRATION_TARGETED_EXPIRED", "The targeted agreement or original approval actor expired. Saved work remains retained; no expiry has been extended.");
  for (const anchor of [p.previousApproval, p.authorityCeiling]) {
    const approval = (await db.query<{ payload: unknown; signature: string }>("SELECT a.payload,a.signature FROM guild_approval_receipts a JOIN guild_sessions s ON s.id=a.actor_id AND s.tenant_id=a.tenant_id WHERE a.id=$1 AND a.tenant_id=$2 AND a.commission_id=$3 AND a.actor_id=$4 AND s.role IN ('judge','owner','operator') AND s.expires_at>now() AND s.revoked_at IS NULL", [anchor.id, c.tenantId, c.id, anchor.actorId])).rows[0];
    if (!approval || digest(approval) !== anchor.receiptDigest) fail("NARRATION_TARGETED_ACTOR", "The original signed approval actor is inactive or its receipt changed. A renewed workspace does not silently renew this agreement.");
  }
}

/** Retained facts are reread at admission and before every production side effect. */
export async function validateTargetedOriginals(db: Db, c: Commission, p: NarrationTargetedCorrectionProposal) {
  const artifacts = (await db.query<{ id: string; content_hash: string; manifest: ArtifactManifest }>("SELECT id,content_hash,manifest FROM guild_artifacts WHERE tenant_id=$1 AND commission_id=$2 AND (package_id=$3 OR id=$4)", [c.tenantId, c.id, p.packageId, p.sourceArtifactId])).rows;
  const source = artifacts.find(item => item.id === p.sourceArtifactId);
  if (!source || source.content_hash !== p.sourceArtifactHash || source.manifest.contentHash !== p.sourceArtifactHash || digest(source.manifest.content) !== p.sourceArtifactHash) bindingFailure();
  const jobs = (await db.query<{ id: string; input: { inputBindings?: unknown }; output: { artifactId?: string } | null; state: string }>("SELECT id,input,output,state FROM guild_jobs WHERE tenant_id=$1 AND commission_id=$2 AND id=ANY($3::uuid[])", [c.tenantId, c.id, p.history.flatMap(item => [item.productionJobId, ...item.evaluations.map(run => run.jobId)])])).rows;
  const checks = (await db.query<{ id: string; artifact_id: string; artifact_hash: string; contract_version: number; criteria_digest: string; result: unknown }>("SELECT id,artifact_id,artifact_hash,contract_version,criteria_digest,result FROM guild_verifications WHERE tenant_id=$1 AND commission_id=$2 AND package_id=$3", [c.tenantId, c.id, p.packageId])).rows;
  for (const prior of p.history) {
    const a = artifacts.find(item => item.id === prior.artifactId), job = jobs.find(item => item.id === prior.productionJobId);
    if (!a || a.content_hash !== prior.artifactHash || a.manifest.contentHash !== prior.artifactHash || digest(a.manifest.content) !== prior.artifactHash || !job || job.state !== "completed" || digest(job.input) !== prior.productionInputDigest || job.output?.artifactId !== prior.artifactId) bindingFailure();
    for (const check of prior.verifications) {
      const saved = checks.find(item => item.id === check.id);
      if (!saved || saved.artifact_id !== prior.artifactId || saved.artifact_hash !== prior.artifactHash || saved.contract_version !== prior.contractVersion || saved.criteria_digest !== check.criteriaDigest || digest(saved.result) !== check.criteriaDigest) bindingFailure();
    }
    for (const report of prior.evaluations) { const saved = jobs.find(item => item.id === report.jobId); if (!saved || saved.state !== "completed" || digest(saved.output) !== report.outputDigest) bindingFailure(); }
  }
  const latest = p.history.at(-1), latestReport = jobs.find(item => item.id === p.latestEvaluation.jobId);
  if (!latest || !latestReport || digest(latestReport.output) !== p.latestEvaluation.outputDigest || !latest.evaluations.some(item => item.jobId === p.latestEvaluation.jobId) || !latest.verifications.some(item => item.id === p.latestVerificationId && item.criteriaDigest === p.latestCriteriaDigest)) bindingFailure();
  const media = (await db.query<{ id: string; job_id: string; state: string; content_hash: string; metadata: { speechRunId?: string; receiptHash?: string; pcmHash?: string } }>("SELECT id,job_id,state,content_hash,metadata FROM guild_media_objects WHERE tenant_id=$1 AND commission_id=$2 AND package_id=$3 AND id=ANY($4::uuid[])", [c.tenantId, c.id, p.packageId, p.scope.register.map(item => item.mediaId)])).rows;
  const speech = (await db.query<{ id: string; job_id: string; state: string; receipt: unknown; receipt_hash: string; pcm_hash: string; input_hash: string; request: SpeechRequest }>("SELECT id,job_id,state,receipt,receipt_hash,pcm_hash,input_hash,request FROM guild_speech_runs WHERE tenant_id=$1 AND commission_id=$2 AND package_id=$3 AND id=ANY($4::uuid[])", [c.tenantId, c.id, p.packageId, p.scope.register.map(item => item.speechRunId)])).rows;
  if (p.scope.register.length !== p.scope.recordings || digest(p.scope.register) !== p.scope.registerDigest || new Set(p.scope.register.map(item => `${item.locale}/${item.key}`)).size !== p.scope.recordings || new Set(p.scope.register.map(item => item.mediaId)).size !== p.scope.recordings || new Set(p.scope.register.map(item => item.speechRunId)).size !== p.scope.recordings) bindingFailure();
  for (const entry of p.scope.register) {
    const a = artifacts.find(item => item.id === entry.artifactId), parsed = narrationArtifactSchema.safeParse(a?.manifest.content);
    const item = parsed.success ? parsed.data.segments.find(item => item.locale === entry.locale && item.key === entry.key) : null;
    const file = media.find(item => item.id === entry.mediaId), run = speech.find(item => item.id === entry.speechRunId);
    if (entry.artifactId !== latest.artifactId || entry.artifactHash !== latest.artifactHash || entry.productionJobId !== latest.productionJobId || entry.contractVersion !== latest.contractVersion || !item || digest(item) !== entry.segmentHash || item.textHash !== entry.textHash || !parsed.success || entry.contractDigest !== parsed.data.contractDigest || entry.inputBindingsDigest !== digest(parsed.data.inputBindings) || digest(entry.correctionAgreement ?? null) !== digest(parsed.data.correctionAgreement ?? null) || !file || file.state !== "ready" || file.job_id !== entry.productionJobId || file.content_hash !== entry.mediaHash || file.metadata.speechRunId !== entry.speechRunId || file.metadata.receiptHash !== entry.receiptHash || file.metadata.pcmHash !== entry.pcmHash || !run || run.state !== "completed" || run.job_id !== entry.productionJobId || run.receipt_hash !== entry.receiptHash || digest(run.receipt) !== entry.receiptHash || run.pcm_hash !== entry.pcmHash) bindingFailure();
    const { audio: _audio, ...segment } = item, { mediaId: _media, url: _url, ...measure } = item.audio;
    const { operationId: _operation, ...request } = run.request;
    const originalJob = jobs.find(item => item.id === entry.productionJobId)!;
    if (digest(file.metadata) !== digest(narrationFileMetadata(entry.contractDigest, source.manifest, segment, measure, entry.correctionAgreement)) || run.input_hash !== digest({ ...request, contractVersion: entry.contractVersion, contractDigest: entry.contractDigest, inputBindings: originalJob.input.inputBindings }) || request.text !== item.text || request.locale !== item.locale || request.model !== narrationStandard.model || request.voice !== narrationStandard.voice) bindingFailure();
  }
}

export async function prepareNarrationTargetedCorrection(db: PoolClient, session: Session, c: Commission, pkg: WorkPackage, expectedVersion: number, expectedDigest: string) {
  if (pkg.contractVersion !== expectedVersion) fail("NARRATION_TARGETED_CHANGED", "Review the targeted agreement for the current contract.");
  const actor = await db.query("SELECT id FROM guild_sessions WHERE id=$1 AND tenant_id=$2 AND role IN ('judge','owner','operator') AND expires_at>now() AND revoked_at IS NULL", [session.id, session.tenantId]);
  if (!actor.rowCount) fail("NARRATION_TARGETED_ACTOR", "An active workspace actor must review this exact scope; expiry and revocation remain in force.");
  const proposal = await narrationTargetedCorrectionProposal(db, c, pkg);
  if (proposal.digest !== expectedDigest) fail("NARRATION_TARGETED_CHANGED", "The report, source, carry-forward register, saved note or price changed. Review the current targeted agreement.");
  const reservation = (await db.query<{ id: string; amount_minor: string; mandate_id: string; state: string }>("SELECT id,amount_minor,mandate_id,state FROM guild_budget_reservations WHERE tenant_id=$1 AND commission_id=$2 AND operation_key=$3 FOR UPDATE", [c.tenantId, c.id, `production:${c.id}:${pkg.id}:${pkg.contractVersion}`])).rows[0];
  if (!reservation || reservation.state !== "reserved" || Number(reservation.amount_minor) !== pkg.grossMinor) fail("AMENDMENT_RESERVATION_MISMATCH", "The exact original unaccepted narration reservation must be released; committed or missing obligations cannot be replaced.");
  const previous = structuredClone(pkg), previousPlan = c.approvedPlanDigest, seen = new Set<string>();
  let page = c.mandates.find(item => item.id === reservation.mandate_id);
  if (!page) fail("AMENDMENT_RESERVATION_MISMATCH", "The original authority page is unavailable.");
  while (page) {
    if (seen.has(page.id) || page.reservedMinor < pkg.grossMinor) fail("AMENDMENT_RESERVATION_MISMATCH", "The reservation cannot be released across its exact original authority chain.");
    seen.add(page.id); page.reservedMinor -= pkg.grossMinor;
    const parentId: string | null = page.parentId; page = c.mandates.find(item => item.id === parentId);
    if (parentId && !page) fail("AMENDMENT_RESERVATION_MISMATCH", "The original parent authority page is unavailable.");
  }
  await db.query("UPDATE guild_budget_reservations SET state='released' WHERE id=$1 AND tenant_id=$2 AND state='reserved'", [reservation.id, c.tenantId]);
  const agreement: NarrationTargetedCorrectionAgreement = { id: randomUUID(), proposal, agreedAt: new Date().toISOString(), providerReceipt: { kind: "guild.controlled-targeted-offer-receipt.v1", algorithm: "HMAC-SHA256", signature: "" } };
  agreement.providerReceipt.signature = signature(c.tenantId, agreement);
  delete pkg.narrationCorrection; // Preserved in previous_contract and its historical receipt.
  pkg.contractVersion = proposal.toVersion; pkg.narrationTargetedCorrection = agreement; pkg.artifactIds = []; pkg.state = "awarded"; pkg.paymentState = "not_eligible"; pkg.progress = null;
  pkg.acceptancePack = { ...pkg.acceptancePack, criteria: pkg.acceptancePack.criteria.map(item => ({ ...item, status: "pending", evidence: null })) };
  pkg.description = `Replace exactly ${proposal.scope.replacementRecordings} failed recordings once and carry forward ${proposal.scope.carriedRecordings} passing originals with their true producing identities. Independently recheck the entire collection under the unchanged measured standard. Human listening and source acceptance remain open.`;
  c.approvedPlanDigest = null; c.state = "awaiting_approval";
  for (const mandate of c.mandates) if (mandate.status === "active") mandate.status = "draft";
  const reason = `Targeted correction: ${proposal.scope.replacementRecordings} exact replacements, one stream each; ${proposal.scope.carriedRecordings} unchanged original recordings. Agreement ${agreement.id} binds every earlier artifact/report and the exact mixed-lineage register. The original reservation is released; a fresh Passport must approve one new job at the same price. No candidates, extra generations, acceptance or payment are included.`;
  await db.query("INSERT INTO guild_contract_amendments(id,tenant_id,commission_id,package_id,from_version,to_version,previous_plan_digest,proposed_plan_digest,previous_contract,proposed_contract,actor_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)", [agreement.id, c.tenantId, c.id, pkg.id, previous.contractVersion, pkg.contractVersion, previousPlan, planDigest(c), previous, pkg, session.id, reason]);
  return { agreement, reason };
}

export async function validateNarrationTargetedCorrection(db: Db, c: Commission, pkg: WorkPackage, job?: { id: string; input: { targetedAgreementId?: string; targetedAgreementDigest?: string; inputBindings?: unknown } }, historical = false) {
  const agreement = pkg.narrationTargetedCorrection;
  if (!agreement) { if (job?.input.targetedAgreementId) bindingFailure(); return; }
  if (historical) c = await readNarrationApprovalHistory(db, c, pkg, bindingFailure, job?.id);
  const p = agreement.proposal, expected = signature(c.tenantId, agreement);
  if (pkg.narrationCorrection || p.version !== "guild.narration-targeted-correction.v1" || p.digest !== targetedCorrectionDigest(p) || p.commissionId !== c.id || p.packageId !== pkg.id || p.toVersion !== pkg.contractVersion || p.acceptancePackDigest !== pkg.acceptancePack.digest || p.scope.maximumProductionJobs !== 1 || p.scope.maximumAttemptsPerRecording !== 1 || p.scope.selectionRule !== narrationTargetedPolicy.selectionRule || p.providerOffer.policyDigest !== digest(narrationTargetedPolicy) || p.providerOffer.originalPolicyDigest !== c.providers.find(item => item.id === pkg.providerId)?.policyDigest || digest(p.scope.delivery) !== digest(targetedDelivery) || p.commercial.providerId !== pkg.providerId || p.commercial.providerAwardMinor !== pkg.providerAwardMinor || p.commercial.serviceFeeMinor !== pkg.serviceFeeMinor || p.commercial.grossMinor !== pkg.grossMinor || p.commercial.additionalChargeMinor !== 0 || p.commercial.commissionTotalMinor !== c.packages.reduce((sum, item) => sum + item.grossMinor, 0) || p.commercial.capMinor !== c.capMinor || p.sourceArtifactId !== pkg.acceptancePack.parameters?.sourceArtifactId || p.sourceArtifactHash !== pkg.acceptancePack.parameters?.sourceArtifactHash || p.scope.scriptRegisterDigest !== digest(pkg.acceptancePack.parameters?.scripts) || !/^[a-f0-9]{64}$/.test(agreement.providerReceipt.signature) || !timingSafeEqual(Buffer.from(expected), Buffer.from(agreement.providerReceipt.signature))) bindingFailure();
  const stored = (await db.query<{ proposed_contract: WorkPackage; previous_contract: WorkPackage }>("SELECT proposed_contract,previous_contract FROM guild_contract_amendments WHERE id=$1 AND tenant_id=$2 AND commission_id=$3 AND package_id=$4 AND to_version=$5", [agreement.id, c.tenantId, c.id, pkg.id, pkg.contractVersion])).rows[0];
  if (!stored || digest(stored.proposed_contract.narrationTargetedCorrection) !== digest(agreement)) bindingFailure();
  const prior = stored.previous_contract.narrationCorrection;
  if (!prior || digest(p.authorityCeiling) !== digest(prior.proposal.previousApproval) || Date.parse(p.providerOffer.expiresAt) > Math.min(Date.parse(prior.proposal.providerOffer.expiresAt), Date.parse(p.authorityCeiling.actorExpiresAt))) bindingFailure();
  await validateTargetedOriginals(db, c, p);
  if (!historical) {
    const currentInputs = await resolveProductionInputs(db, c, pkg);
    if (digest(currentInputs.bindings) !== digest(p.inputBindings)) bindingFailure();
    await validateTargetedActors(db, c, p);
  }
  if (job) {
    const jobs = (await db.query<{ id: string }>("SELECT id FROM guild_jobs WHERE tenant_id=$1 AND commission_id=$2 AND type='produce_package' AND input->>'packageId'=$3 AND input->>'contractVersion'=$4", [c.tenantId, c.id, pkg.id, String(pkg.contractVersion)])).rows;
    if (job.input.targetedAgreementId !== agreement.id || job.input.targetedAgreementDigest !== p.digest || digest(job.input.inputBindings) !== digest(p.inputBindings) || jobs.length !== 1 || jobs[0]!.id !== job.id) bindingFailure();
  }
}

export function authorizeTargetedSpeech(pkg: WorkPackage, operationKey: string, input: { locale: string; text: string; instructions: string; model: string; voice: string }) {
  const agreement = pkg.narrationTargetedCorrection;
  if (!agreement) return;
  const entry = agreement.proposal.scope.register.find(item => operationKey === `narration:${item.locale}:${item.key}`);
  if (!entry || entry.action !== "replace" || input.locale !== entry.locale || digest(input.text) !== entry.textHash || digest(input.instructions) !== entry.replacementInstructionsHash || input.model !== narrationStandard.model || input.voice !== narrationStandard.voice) fail("NARRATION_TARGETED_RECORDING_SCOPE", "This agreement permits only its exact replacement keys, source scripts and reviewed delivery instructions.");
}

export function authorizeTargetedMedia(pkg: WorkPackage, operationKey: string) {
  if (pkg.narrationTargetedCorrection && !pkg.narrationTargetedCorrection.proposal.scope.register.some(item => item.action === "replace" && operationKey === `narration:${item.locale}:${item.key}:mp3`)) fail("NARRATION_TARGETED_RECORDING_SCOPE", "Carried recordings keep their original media objects; only the exact agreed replacements can store new audio.");
}
