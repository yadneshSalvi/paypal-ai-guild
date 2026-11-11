import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { ArtifactInputBinding, CaptionCorrectionAgreement, CaptionCorrectionProposal, Commission, WorkPackage } from "@/contracts/guild";
import { captionAcceptancePack, captionArtifactSchema, captionAuthorityCeilingSchema, captionCommercialPolicy, captionSourcesFromPack } from "@/domain/captions";
import { planDigest } from "@/domain/fixture";
import { canonical, digest, DomainError } from "@/domain/primitives";
import { buildCaptionAuthority, captionApprovalAt, requireCaptionActor, validateCaptionAuthority } from "./authority";
import { buildCaptionSources, captionOwnedArtifact } from "./sources";
import type { Session } from "../session";

type Db = Pool | PoolClient;
function fail(code: string, message: string): never { throw new DomainError(code, message, 422, false); }
export interface CaptionJobInput { packageId?: string; contractVersion?: number; inputBindings?: unknown; captionSourceDigest?: string; captionAttempt?: number; captionCorrectionId?: string; captionCorrectionDigest?: string }
interface ProductionRow { id: string; state: string; input: CaptionJobInput; output: { artifactId?: string } | null; error: string | null; created_at: Date; updated_at: Date }
function packTerms(pkg: WorkPackage) {
  return { ...pkg.acceptancePack, criteria: pkg.acceptancePack.criteria.map(item => ({ ...item, status: "pending", evidence: null })) };
}
export function captionContractTerms(pkg: WorkPackage) {
  return { id: pkg.id, kind: pkg.kind, contractVersion: pkg.contractVersion, providerId: pkg.providerId,
    providerAwardMinor: pkg.providerAwardMinor, serviceFeeMinor: pkg.serviceFeeMinor, grossMinor: pkg.grossMinor,
    dependsOn: pkg.dependsOn, workingHours: pkg.workingHours, inputPolicy: pkg.inputPolicy, pack: packTerms(pkg) };
}
async function attemptedJobs(db: Db, c: Commission, pkg: WorkPackage) {
  return (await db.query<ProductionRow>("SELECT id,state,input,output,error,created_at,updated_at FROM guild_jobs WHERE tenant_id=$1 AND commission_id=$2 AND type='produce_package' AND input->>'packageId'=$3 AND input->>'contractVersion'=$4 ORDER BY created_at,id", [c.tenantId, c.id, pkg.id, String(pkg.contractVersion)])).rows;
}

/** Configuration, unknown outcomes and failed attempts never erase an attempt. */
export async function assertCaptionOutcomesKnown(db: Db, c: Commission, pkg: WorkPackage, jobId?: string) {
  const unresolved = await db.query("SELECT a.id FROM guild_alignment_runs a JOIN guild_jobs j ON j.id=a.job_id AND j.tenant_id=a.tenant_id WHERE a.tenant_id=$1 AND a.commission_id=$2 AND a.package_id=$3 AND j.input->>'contractVersion'=$4 AND ($5::uuid IS NULL OR j.id=$5) AND a.state IN ('dispatching','indeterminate') LIMIT 1", [c.tenantId, c.id, pkg.id, String(pkg.contractVersion), jobId ?? null]);
  const models = await db.query("SELECT m.id FROM guild_model_runs m JOIN guild_jobs j ON j.id=m.job_id AND j.tenant_id=m.tenant_id WHERE j.tenant_id=$1 AND j.commission_id=$2 AND j.input->>'packageId'=$3 AND j.input->>'contractVersion'=$4 AND ($5::uuid IS NULL OR j.id=$5) AND (m.status IN ('dispatching','running','received','indeterminate','unavailable') OR (m.operation_key IS NULL AND m.status<>'completed')) LIMIT 1", [c.tenantId, c.id, pkg.id, String(pkg.contractVersion), jobId ?? null]);
  if (unresolved.rowCount || models.rowCount) fail("CAPTION_ORIGINAL_PENDING", "An original caption alignment or easy-read response is unresolved. Preserve that request and its partial result; no replacement job is permitted.");
}

async function noConflictingWork(db: Db, c: Commission, pkg: WorkPackage, initial: boolean) {
  if (c.state === "paused" || pkg.acceptedAt || pkg.paymentState !== "not_eligible" || pkg.state === "accepted") fail("CAPTION_CONTRACT_STATE", "Review the unaccepted caption contract before preparing a new agreement.");
  if ((await db.query("SELECT id FROM guild_jobs WHERE tenant_id=$1 AND commission_id=$2 AND state IN ('queued','running') LIMIT 1", [c.tenantId, c.id])).rowCount) fail("AMENDMENT_WORK_RUNNING", "Finish the saved production and checks before preparing the caption agreement.");
  if ((await db.query("SELECT id FROM guild_payment_intents WHERE tenant_id=$1 AND commission_id=$2 LIMIT 1", [c.tenantId, c.id])).rowCount) fail("AMENDMENT_BILLING_STARTED", "This caption agreement is available before checkout. Existing financial obligations need their own review.");
  if (initial && (pkg.artifactIds.length || !["draft", "bidding", "awarded"].includes(pkg.state)
    || (await db.query("SELECT id FROM guild_jobs WHERE tenant_id=$1 AND commission_id=$2 AND type='produce_package' AND input->>'packageId'=$3 LIMIT 1", [c.tenantId, c.id, pkg.id])).rowCount)) fail("CAPTION_AMENDMENT_STARTED", "An earlier caption attempt keeps its original terms. The measured acceptance pack must precede production.");
  const descendants = new Set([pkg.id]);
  for (let i = 0; i < c.packages.length; i++) for (const item of c.packages) if (item.dependsOn.some(id => descendants.has(id))) descendants.add(item.id);
  descendants.delete(pkg.id);
  if ((await db.query("SELECT id FROM guild_jobs WHERE tenant_id=$1 AND commission_id=$2 AND type='produce_package' AND input->>'packageId'=ANY($3::text[]) LIMIT 1", [c.tenantId, c.id, [...descendants]])).rowCount) fail("CAPTION_DEPENDENTS_STARTED", "Dependent work already used this caption contract. Preserve its lineage and review that work before preparing a correction.");
}

export async function captionContractProposal(db: Db, c: Commission, pkg: WorkPackage) {
  if (pkg.kind !== "captions" || pkg.acceptancePack.version !== "1.0.0" || c.mode !== "live") fail("CAPTION_AMENDMENT_CHANGED", "The measured caption agreement is available for the unstarted original caption contract.");
  const sources = await buildCaptionSources(db, c, pkg), authority = await buildCaptionAuthority(db, c, pkg);
  return captionAcceptancePack(sources, authority);
}

export async function prepareCaptionContract(db: PoolClient, session: Session, c: Commission, pkg: WorkPackage, version: number, expectedDigest: string) {
  await requireCaptionActor(db, session);
  if (pkg.contractVersion !== version) fail("CAPTION_AMENDMENT_CHANGED", "This caption agreement belongs to an earlier contract version.");
  await noConflictingWork(db, c, pkg, true);
  const pack = await captionContractProposal(db, c, pkg);
  if (pack.digest !== expectedDigest) fail("CAPTION_AMENDMENT_CHANGED", "The exact source, prompt excerpt, timings, original authority or provider terms changed. Review the current agreement.");
  const proposed = { ...pkg, acceptancePack: pack };
  await validateCaptionAuthority(db, c, proposed, true);
  if ((await db.query("SELECT id FROM guild_budget_reservations WHERE tenant_id=$1 AND operation_key=$2 AND state IN ('reserved','committed')", [c.tenantId, `production:${c.id}:${pkg.id}:${pkg.contractVersion}`])).rowCount) fail("AMENDMENT_COMMITMENT_EXISTS", "The original caption contract already has a reserved obligation. Preserve its terms until that obligation is explicitly resolved.");
  const previous = structuredClone(pkg), previousPlan = c.approvedPlanDigest, amendmentId = randomUUID();
  pkg.contractVersion++; pkg.acceptancePack = pack; pkg.state = "awarded";
  pkg.description = "Timed captions from exact original audio and a disclosed bounded source-script prompt, plus six source-linked easy-read files. Full-script timing checks and meaning review remain separate. One included correction requires an exact note and fresh Passport; the original work deadline is unchanged.";
  c.approvedPlanDigest = null; c.state = "awaiting_approval";
  for (const page of c.mandates) if (page.status === "active") page.status = "draft";
  const reason = "Original-audio caption acceptance pack 2.0.0, prepared before production. Exact original audio, scripts, transitive provenance, source reviews, timestamp model, bounded prompt/tokenizer, normalization, cue limits, easy-read concepts and original authority ceiling are frozen. Northlight's $35 award, $5 fee and one included correction remain unchanged. Prompted alignment is not blind transcription or fluent human review. A fresh Passport and any explicit schedule reconciliation are still required; no provider or financial action was dispatched.";
  await db.query("INSERT INTO guild_contract_amendments(id,tenant_id,commission_id,package_id,from_version,to_version,previous_plan_digest,proposed_plan_digest,previous_contract,proposed_contract,actor_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)", [amendmentId, c.tenantId, c.id, pkg.id, previous.contractVersion, pkg.contractVersion, previousPlan, planDigest(c), previous, pkg, session.id, reason]);
  return { reason };
}

export async function validateCaptionContract(db: Db, c: Commission, pkg: WorkPackage, dispatch = true) {
  if (pkg.kind !== "captions" || pkg.providerId !== captionCommercialPolicy.providerId) fail("CAPTION_CONTRACT_REQUIRED", "This producer needs Northlight's exact measured caption agreement.");
  const sources = captionSourcesFromPack(pkg.acceptancePack);
  const original = (await db.query<{ proposed_contract: WorkPackage }>("SELECT proposed_contract FROM guild_contract_amendments WHERE tenant_id=$1 AND commission_id=$2 AND package_id=$3 AND to_version=$4", [c.tenantId, c.id, pkg.id, pkg.contractVersion])).rows;
  if (original.length !== 1 || digest(captionContractTerms(original[0]!.proposed_contract)) !== digest(captionContractTerms(pkg))) fail("CAPTION_CONTRACT_CHANGED", "The retained original caption amendment is missing or differs from the current measured agreement.");
  await validateCaptionAuthority(db, c, pkg, dispatch);
  await buildCaptionSources(db, c, pkg, sources);
  return sources;
}

async function originalResult(db: Db, c: Commission, pkg: WorkPackage, job: ProductionRow, frozen?: CaptionCorrectionProposal["previous"]): Promise<CaptionCorrectionProposal["previous"]> {
  if (!["completed", "failed", "needs_review"].includes(job.state)) fail("CAPTION_ORIGINAL_PENDING", "Finish the original caption job and retain its complete outcome before reviewing the included correction.");
  await assertCaptionOutcomesKnown(db, c, pkg, job.id);
  const alignments = (await db.query("SELECT a.id,a.media_id,a.capability_version,a.operation_key,a.input_hash,a.request,a.state,a.failure_code,a.dispatched_at,o.receipt_hash,o.receipt FROM guild_alignment_runs a LEFT JOIN guild_alignment_observations o ON o.run_id=a.id AND o.tenant_id=a.tenant_id WHERE a.tenant_id=$1 AND a.job_id=$2 ORDER BY a.operation_key", [c.tenantId, job.id])).rows;
  const models = (await db.query("SELECT id,operation_key,model,input_hash,status,output,output_hash,provider_response_id,provider_output_text,provider_status,failure_code FROM guild_model_runs WHERE tenant_id=$1 AND job_id=$2 ORDER BY operation_key,id", [c.tenantId, job.id])).rows;
  if (alignments.some(row => row.receipt && digest(row.receipt) !== row.receipt_hash) || models.some(row => row.status === "completed" && digest(row.output) !== row.output_hash)) fail("CAPTION_ORIGINAL_CHANGED", "A retained original output no longer matches its hash.");
  let artifact: CaptionCorrectionProposal["previous"]["artifact"] = null;
  if (job.output?.artifactId) {
    const original = await captionOwnedArtifact(db, c, job.output.artifactId), parsed = captionArtifactSchema.safeParse(original.content);
    if (!parsed.success || parsed.data.productionJobId !== job.id || original.packageId !== pkg.id || parsed.data.contractDigest !== pkg.acceptancePack.digest || parsed.data.sourceDigest !== digest(captionSourcesFromPack(pkg.acceptancePack))) fail("CAPTION_ORIGINAL_CHANGED", "The original caption result differs from its exact job, full source or measured agreement.");
    await (await import("./approval-history")).readCaptionApprovalHistory(db, c, pkg, original);
    const checks = (await db.query<{ id: string; criteria_digest: string; result: WorkPackage["acceptancePack"] }>("SELECT id,criteria_digest,result FROM guild_verifications WHERE tenant_id=$1 AND commission_id=$2 AND package_id=$3 AND contract_version=$4 AND artifact_id=$5 AND artifact_hash=$6 AND ($7::uuid IS NULL OR id=$7) ORDER BY created_at DESC,id DESC LIMIT 1", [c.tenantId, c.id, pkg.id, pkg.contractVersion, original.id, original.contentHash, frozen?.artifact?.verificationId ?? null])).rows[0];
    const report = (await db.query<{ id: string; output: { pack: WorkPackage["acceptancePack"] } }>("SELECT id,output FROM guild_jobs WHERE tenant_id=$1 AND commission_id=$2 AND type='verify_artifact' AND state='completed' AND input->>'artifactId'=$3 AND input->>'artifactHash'=$4 AND ($5::uuid IS NULL OR id=$5) ORDER BY created_at DESC,id DESC LIMIT 1", [c.tenantId, c.id, original.id, original.contentHash, frozen?.artifact?.reportJobId ?? null])).rows[0];
    if (!checks || !report || digest(checks.result) !== checks.criteria_digest || digest(report.output.pack) !== checks.criteria_digest || digest(pkg.acceptancePack) !== checks.criteria_digest) fail("CAPTION_CHECKS_REQUIRED", "Finish the exact independent caption checks before reviewing the included correction.");
    artifact = { id: original.id, contentHash: original.contentHash, verificationId: checks.id, verificationHash: checks.criteria_digest, reportJobId: report.id, reportHash: digest(report.output) };
  } else if (job.state === "completed") fail("CAPTION_ORIGINAL_CHANGED", "The completed original job has no retained artifact.");
  return { jobId: job.id, state: job.state, inputHash: digest(job.input), outputHash: digest(job.output), error: job.error,
    operationsHash: digest(JSON.parse(JSON.stringify({ alignments, models }))), artifact };
}

export function captionCorrectionDigest(proposal: CaptionCorrectionProposal | Omit<CaptionCorrectionProposal, "digest">) { const { digest: _digest, ...body } = proposal as CaptionCorrectionProposal; return digest(body); }
function correctionSignature(c: Commission, agreement: CaptionCorrectionAgreement) {
  if (!process.env.AUTH_SECRET) throw new Error("AUTH_SECRET required");
  return createHmac("sha256", process.env.AUTH_SECRET).update(canonical({ kind: agreement.receipt.kind, tenantId: c.tenantId, commissionId: c.id, agreementId: agreement.id, proposalDigest: agreement.proposal.digest, actorId: agreement.actorId, agreedAt: agreement.agreedAt })).digest("hex");
}

export async function captionCorrectionProposal(db: Db, c: Commission, pkg: WorkPackage): Promise<CaptionCorrectionProposal> {
  const sources = await validateCaptionContract(db, c, pkg);
  await noConflictingWork(db, c, pkg, false);
  const jobs = await attemptedJobs(db, c, pkg);
  if (jobs.length !== 1 || pkg.captionCorrection) fail("CAPTION_CORRECTION_ALLOWANCE", "This contract includes exactly one original job and one explicitly approved correction. Every saved attempt counts.");
  if (!c.approvedPlanDigest || c.approvedPlanDigest !== planDigest(c)) fail("APPROVAL_REQUIRED", "The current Passport must match the caption contract before reviewing its correction.");
  const previous = await originalResult(db, c, pkg, jobs[0]!), note = c.events.filter(item => item.type === "package.correction_requested" && item.packageId === pkg.id).at(-1);
  if (!note || note.createdAt < jobs[0]!.updated_at.toISOString() || pkg.state !== "correction_requested") fail("CAPTION_CORRECTION_NOTE", "Save a correction note for this exact original result before preparing the one included correction.");
  const approval = (await db.query<{ id: string; actor_id: string; payload: Record<string, unknown>; signature: string }>("SELECT a.id,a.actor_id,a.payload,a.signature FROM guild_approval_receipts a JOIN guild_sessions s ON s.id=a.actor_id AND s.tenant_id=a.tenant_id WHERE a.tenant_id=$1 AND a.commission_id=$2 AND a.plan_digest=$3 AND s.expires_at>now() AND s.revoked_at IS NULL ORDER BY a.created_at DESC,a.id DESC LIMIT 1", [c.tenantId, c.id, c.approvedPlanDigest])).rows[0];
  if (!approval || !process.env.AUTH_SECRET || !/^[a-f0-9]{64}$/.test(approval.signature) || approval.signature !== createHmac("sha256", process.env.AUTH_SECRET).update(canonical(approval.payload)).digest("hex")) fail("CAPTION_APPROVAL_REQUIRED", "The correction needs the current exact signed Passport and active approving workspace.");
  const proposal: Omit<CaptionCorrectionProposal, "digest"> = { version: "guild.caption-correction.v1", commissionId: c.id, packageId: pkg.id, contractVersion: pkg.contractVersion,
    acceptancePackDigest: pkg.acceptancePack.digest, sourceDigest: digest(sources), previousPlanDigest: c.approvedPlanDigest,
    previousApproval: { id: approval.id, actorId: approval.actor_id, receiptHash: digest({ payload: approval.payload, signature: approval.signature }) }, previous,
    note: { eventId: note.id, eventHash: note.hash, text: note.detail }, maximumProductionJobs: 2, correctionAllowance: 1, attempt: 2,
    commercial: { providerId: "northlight", providerAwardMinor: 3500, serviceFeeMinor: 500, grossMinor: 4000, additionalChargeMinor: 0 },
    authorityCeiling: captionAuthorityCeilingSchema.parse(pkg.acceptancePack.parameters?.authorityCeiling).expiresAt,
    disclosure: "One included correction from Guild's controlled Northlight service. This permits one second job under the same source, timestamp model, prompt policy, limits, $35 + $5 terms and original work deadline. Every attempted job remains in the denominator. Fresh Passport approval is required; no human review or new provider request is created here." };
  return { ...proposal, digest: captionCorrectionDigest(proposal) };
}

export async function prepareCaptionCorrection(db: PoolClient, session: Session, c: Commission, pkg: WorkPackage, version: number, expectedDigest: string) {
  await requireCaptionActor(db, session);
  if (pkg.contractVersion !== version) fail("CAPTION_CORRECTION_CHANGED", "This correction belongs to an earlier contract.");
  const proposal = await captionCorrectionProposal(db, c, pkg);
  if (proposal.digest !== expectedDigest) fail("CAPTION_CORRECTION_CHANGED", "The exact original job, note, report or current authority changed. Review the current correction.");
  const agreement: CaptionCorrectionAgreement = { id: randomUUID(), proposal, actorId: session.id, agreedAt: new Date().toISOString(), receipt: { kind: "guild.controlled-caption-correction.v1", algorithm: "HMAC-SHA256", signature: "" } };
  agreement.receipt.signature = correctionSignature(c, agreement);
  await db.query("INSERT INTO guild_caption_corrections(id,tenant_id,commission_id,package_id,contract_version,previous_job_id,actor_id,agreement_digest,agreement) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [agreement.id, c.tenantId, c.id, pkg.id, pkg.contractVersion, proposal.previous.jobId, session.id, proposal.digest, agreement]);
  pkg.captionCorrection = agreement; pkg.state = "awarded"; pkg.progress = null;
  c.approvedPlanDigest = null; c.state = "awaiting_approval";
  for (const page of c.mandates) if (page.status === "active") page.status = "draft";
  return { agreement, reason: proposal.disclosure };
}

async function validateCorrection(db: Db, c: Commission, pkg: WorkPackage, first: ProductionRow) {
  const agreement = pkg.captionCorrection, sources = captionSourcesFromPack(pkg.acceptancePack);
  if (!agreement) fail("CAPTION_CORRECTION_REQUIRED", "Review the exact correction note and original result, then approve a fresh Passport before using the one included second job.");
  const p = agreement.proposal;
  if (p.version !== "guild.caption-correction.v1" || p.digest !== captionCorrectionDigest(p) || p.commissionId !== c.id || p.packageId !== pkg.id || p.contractVersion !== pkg.contractVersion || p.acceptancePackDigest !== pkg.acceptancePack.digest || p.sourceDigest !== digest(sources)
    || p.maximumProductionJobs !== 2 || p.correctionAllowance !== 1 || p.attempt !== 2 || p.previous.jobId !== first.id || p.authorityCeiling !== captionAuthorityCeilingSchema.parse(pkg.acceptancePack.parameters?.authorityCeiling).expiresAt
    || digest(p.commercial) !== digest({ providerId: "northlight", providerAwardMinor: 3500, serviceFeeMinor: 500, grossMinor: 4000, additionalChargeMinor: 0 })
    || agreement.receipt.kind !== "guild.controlled-caption-correction.v1" || agreement.receipt.algorithm !== "HMAC-SHA256" || !/^[a-f0-9]{64}$/.test(agreement.receipt.signature)
    || !timingSafeEqual(Buffer.from(agreement.receipt.signature), Buffer.from(correctionSignature(c, agreement)))) fail("CAPTION_CORRECTION_CHANGED", "The correction no longer matches its exact signed source, prior outcome, note, scope or unchanged terms.");
  const saved = (await db.query<{ agreement: CaptionCorrectionAgreement; agreement_digest: string }>("SELECT agreement,agreement_digest FROM guild_caption_corrections WHERE id=$1 AND tenant_id=$2 AND commission_id=$3 AND package_id=$4 AND contract_version=$5 AND previous_job_id=$6 AND actor_id=$7", [agreement.id, c.tenantId, c.id, pkg.id, pkg.contractVersion, first.id, agreement.actorId])).rows[0];
  const note = (await db.query<{ event: Commission["events"][number] }>("SELECT event FROM guild_events WHERE id=$1 AND tenant_id=$2 AND commission_id=$3 AND event_hash=$4", [p.note.eventId, c.tenantId, c.id, p.note.eventHash])).rows[0]?.event;
  if (!saved || saved.agreement_digest !== p.digest || digest(saved.agreement) !== digest(agreement) || !note || note.detail !== p.note.text || note.packageId !== pkg.id || digest({ ...note, hash: undefined }) !== p.note.eventHash) fail("CAPTION_CORRECTION_CHANGED", "The original signed correction or its exact saved note is unavailable.");
  const priorApproval = await captionApprovalAt(db, c, p.previousPlanDigest, new Date(agreement.agreedAt));
  const priorPackage = priorApproval.command.result.commission.packages.find(item => item.id === pkg.id);
  if (priorApproval.receipt.id !== p.previousApproval.id || priorApproval.receipt.actor_id !== p.previousApproval.actorId
    || digest({ payload: priorApproval.receipt.payload, signature: priorApproval.receipt.signature }) !== p.previousApproval.receiptHash
    || !priorPackage || priorPackage.captionCorrection || digest(captionContractTerms(priorPackage)) !== digest(captionContractTerms(pkg)))
    fail("CAPTION_CORRECTION_CHANGED", "The exact Passport retained with the original correction review is missing or no longer matches its signed snapshot.");
  // The displayed check state may be reset by job two; the retained first report
  // remains the evidence. Never rewrite it to the successor's pending criteria.
  const historicalPackage = structuredClone(pkg);
  if (p.previous.artifact) historicalPackage.acceptancePack = (await db.query<{ result: WorkPackage["acceptancePack"] }>("SELECT result FROM guild_verifications WHERE id=$1 AND tenant_id=$2 AND commission_id=$3", [p.previous.artifact.verificationId, c.tenantId, c.id])).rows[0]?.result ?? pkg.acceptancePack;
  if (digest(await originalResult(db, c, historicalPackage, first, p.previous)) !== digest(p.previous)) fail("CAPTION_ORIGINAL_CHANGED", "The retained first attempt differs from the exact outcome reviewed for this correction.");
  return agreement;
}

export async function captionAdmission(db: Db, c: Commission, pkg: WorkPackage) {
  const sources = await validateCaptionContract(db, c, pkg), jobs = await attemptedJobs(db, c, pkg);
  await assertCaptionOutcomesKnown(db, c, pkg);
  if (jobs.length >= 2) fail("CAPTION_CORRECTION_ALLOWANCE", "Both permitted caption jobs are retained. Failed or interrupted attempts also count; this agreement cannot dispatch another job.");
  if (!jobs.length) {
    if (pkg.captionCorrection) fail("CAPTION_CORRECTION_CHANGED", "A correction cannot precede its original producing job.");
    return { captionAttempt: 1, captionSourceDigest: digest(sources), inputBindings: sources.inputBindings };
  }
  const agreement = await validateCorrection(db, c, pkg, jobs[0]!);
  return { captionAttempt: 2, captionSourceDigest: digest(sources), captionCorrectionId: agreement.id, captionCorrectionDigest: agreement.proposal.digest, inputBindings: sources.inputBindings };
}

/** Validates the exact current job before each new provider side effect. */
export async function validateCaptionJob(db: Db, c: Commission, pkg: WorkPackage, job: { id: string; input: CaptionJobInput }, dispatch = true) {
  const sources = await validateCaptionContract(db, c, pkg, dispatch), jobs = await attemptedJobs(db, c, pkg), ordinal = jobs.findIndex(item => item.id === job.id) + 1;
  if (!ordinal || ordinal > 2 || jobs.length > 2 || job.input.captionAttempt !== ordinal || job.input.captionSourceDigest !== digest(sources)
    || digest(job.input.inputBindings) !== digest(sources.inputBindings) || job.input.contractVersion !== pkg.contractVersion) fail("CAPTION_JOB_BINDING", "This job no longer matches its exact attempt, source bindings and measured caption agreement.");
  if (ordinal === 1) {
    if (job.input.captionCorrectionId || job.input.captionCorrectionDigest || dispatch && (pkg.captionCorrection || jobs.length !== 1)) fail("CAPTION_JOB_BINDING", "The original caption attempt cannot borrow later correction authority.");
  } else {
    const agreement = await validateCorrection(db, c, pkg, jobs[0]!);
    if (job.input.captionCorrectionId !== agreement.id || job.input.captionCorrectionDigest !== agreement.proposal.digest) fail("CAPTION_JOB_BINDING", "Only the one second job bound to the reviewed correction may dispatch.");
  }
  return { sources, attempt: ordinal as 1 | 2, correction: ordinal === 2 ? { id: pkg.captionCorrection!.id, digest: pkg.captionCorrection!.proposal.digest } : null, inputBindings: sources.inputBindings as ArtifactInputBinding[] };
}
