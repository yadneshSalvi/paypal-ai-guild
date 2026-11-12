import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { ArtifactManifest, Commission, WorkPackage } from "@/contracts/guild";
import { captionAuthorityCeilingSchema, captionCommercialPolicy, easyReadStandard } from "@/domain/captions";
import { deepgramCaptionAcceptancePack, deepgramCaptionArtifactSchema, deepgramCaptionCorrectionDigest, deepgramSourcesFromPack, type DeepgramCaptionCorrectionAgreement, type DeepgramCaptionCorrectionProposal } from "@/domain/deepgram-captions";
import { planDigest } from "@/domain/fixture";
import { canonical, digest, DomainError } from "@/domain/primitives";
import type { Session } from "../session";
import { buildCaptionAuthority, captionApprovalAt, requireCaptionActor, validateCaptionAuthority } from "./authority";
import { assertCaptionOutcomesKnown, captionContractTerms, type CaptionJobInput } from "./contracts";
import { buildCaptionSources, captionOwnedArtifact } from "./sources";
import { captionReviewTargets, readCaptionReviewRevision } from "./review";

type Db = Pool | PoolClient;
function fail(code: string, message: string): never { throw new DomainError(code, message, 422, false); }
export interface DeepgramCaptionJobInput extends CaptionJobInput { deepgramReviewCorrectionId?: string; deepgramReviewCorrectionDigest?: string }
interface Job { id: string; state: string; input: DeepgramCaptionJobInput; output: { artifactId?: string } | null; created_at: Date }
const attemptedJobs = async (db: Db, c: Commission, pkg: WorkPackage) => (await db.query<Job>("SELECT id,state,input,output,created_at FROM guild_jobs WHERE tenant_id=$1 AND commission_id=$2 AND type='produce_package' AND input->>'packageId'=$3 AND input->>'contractVersion'=$4 ORDER BY created_at,id", [c.tenantId, c.id, pkg.id, String(pkg.contractVersion)])).rows;

async function noConflictingWork(db: Db, c: Commission, pkg: WorkPackage, initial: boolean) {
  if (c.state === "paused" || pkg.acceptedAt || pkg.paymentState !== "not_eligible" || pkg.state === "accepted") fail("DEEPGRAM_REVIEW_STATE", "Review the unaccepted caption package before preparing a new review agreement.");
  if ((await db.query("SELECT id FROM guild_jobs WHERE tenant_id=$1 AND commission_id=$2 AND state IN ('queued','running') LIMIT 1", [c.tenantId, c.id])).rowCount)
    fail("DEEPGRAM_WORK_RUNNING", "Let the current saved work finish before changing this review agreement.");
  if ((await db.query("SELECT id FROM guild_payment_intents WHERE tenant_id=$1 AND commission_id=$2 LIMIT 1", [c.tenantId, c.id])).rowCount)
    fail("DEEPGRAM_BILLING_STARTED", "A billed agreement keeps its original terms. Open a separately scoped successor commission.");
  if (initial && (pkg.artifactIds.length || (await db.query("SELECT id FROM guild_jobs WHERE tenant_id=$1 AND commission_id=$2 AND type='produce_package' AND input->>'packageId'=$3 LIMIT 1", [c.tenantId, c.id, pkg.id])).rowCount))
    fail("DEEPGRAM_SUCCESSOR_REQUIRED", "The original caption work already has its own agreement. Keep its evidence and review drafts here; commission new provider work in a separate successor with fresh bounded authority.");
  const descendants = new Set([pkg.id]);
  for (let i = 0; i < c.packages.length; i++) for (const item of c.packages) if (item.dependsOn.some(id => descendants.has(id))) descendants.add(item.id);
  descendants.delete(pkg.id);
  if ((await db.query("SELECT id FROM guild_jobs WHERE tenant_id=$1 AND commission_id=$2 AND type='produce_package' AND input->>'packageId'=ANY($3::text[]) LIMIT 1", [c.tenantId, c.id, [...descendants]])).rowCount)
    fail("DEEPGRAM_DEPENDENTS_STARTED", "Dependent work keeps its original source lineage. Review that work before preparing a corrected caption edition.");
}

export async function deepgramCaptionContractProposal(db: Db, c: Commission, pkg: WorkPackage) {
  if (c.mode !== "live" || pkg.kind !== "captions" || pkg.acceptancePack.version !== "1.0.0")
    fail("DEEPGRAM_REVIEW_AMENDMENT", "The new review capability belongs to a fresh, unstarted caption agreement. Earlier editions remain unchanged.");
  await noConflictingWork(db, c, pkg, true);
  return deepgramCaptionAcceptancePack(await buildCaptionSources(db, c, pkg), await buildCaptionAuthority(db, c, pkg));
}

export async function prepareDeepgramCaptionContract(db: PoolClient, session: Session, c: Commission, pkg: WorkPackage, version: number, expectedDigest: string) {
  await requireCaptionActor(db, session);
  if (pkg.contractVersion !== version) fail("DEEPGRAM_REVIEW_AMENDMENT", "The displayed review agreement belongs to an earlier package version.");
  const pack = await deepgramCaptionContractProposal(db, c, pkg);
  if (pack.digest !== expectedDigest) fail("DEEPGRAM_REVIEW_AMENDMENT", "The exact provider, source, timing, review policy or authority changed. Reopen the current terms.");
  await validateCaptionAuthority(db, c, { ...pkg, acceptancePack: pack }, true);
  if ((await db.query("SELECT id FROM guild_budget_reservations WHERE tenant_id=$1 AND operation_key=$2 AND state IN ('reserved','committed')", [c.tenantId, `production:${c.id}:${pkg.id}:${pkg.contractVersion}`])).rowCount)
    fail("DEEPGRAM_COMMITMENT_EXISTS", "The earlier agreement has a reserved obligation. Preserve it for separate review.");
  const previous = structuredClone(pkg), previousPlan = c.approvedPlanDigest;
  pkg.contractVersion++; pkg.acceptancePack = pack; pkg.state = "awarded";
  pkg.description = "Six-language Deepgram-assisted caption review, exact original audio and source-linked easy read. One original request per recording; one separately agreed assembly of attributed listening corrections makes no recognition requests. Qualification and acceptance remain open.";
  c.approvedPlanDigest = null; c.state = "awaiting_approval";
  for (const page of c.mandates) if (page.status === "active") page.status = "draft";
  const reason = "Deepgram-assisted review pack 3.0.0. The exact Nova models, blind binary transport, unchanged full sources, raw and rounded timings, six-language cue limits, manual attribution policy, $35 award + $5 fee and original authority ceiling are frozen. One original request per recording and one separately agreed zero-recognition correction assembly. Development-only automatic capability; no qualification, human listening, fluent review, acceptance or payment is implied. A fresh exact Passport is required.";
  await db.query("INSERT INTO guild_contract_amendments(id,tenant_id,commission_id,package_id,from_version,to_version,previous_plan_digest,proposed_plan_digest,previous_contract,proposed_contract,actor_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
    [randomUUID(), c.tenantId, c.id, pkg.id, previous.contractVersion, pkg.contractVersion, previousPlan, planDigest(c), previous, pkg, session.id, reason]);
  return { reason };
}

export async function validateDeepgramCaptionContract(db: Db, c: Commission, pkg: WorkPackage, dispatch = true) {
  if (pkg.kind !== "captions" || pkg.providerId !== captionCommercialPolicy.providerId) fail("DEEPGRAM_REVIEW_CONTRACT", "The exact controlled Northlight review agreement is required.");
  const sources = deepgramSourcesFromPack(pkg.acceptancePack);
  const amendments = (await db.query<{ proposed_contract: WorkPackage }>("SELECT proposed_contract FROM guild_contract_amendments WHERE tenant_id=$1 AND commission_id=$2 AND package_id=$3 AND to_version=$4", [c.tenantId, c.id, pkg.id, pkg.contractVersion])).rows;
  if (amendments.length !== 1 || digest(captionContractTerms(amendments[0]!.proposed_contract)) !== digest(captionContractTerms(pkg)))
    fail("DEEPGRAM_REVIEW_CONTRACT_CHANGED", "The current review terms differ from their exact original amendment.");
  await validateCaptionAuthority(db, c, pkg, dispatch); await buildCaptionSources(db, c, pkg, sources);
  return sources;
}

function correctionSignature(c: Commission, agreement: DeepgramCaptionCorrectionAgreement) {
  if (!process.env.AUTH_SECRET) fail("DEEPGRAM_REVIEW_CONFIGURATION", "Private correction signing is not configured.");
  return createHmac("sha256", process.env.AUTH_SECRET!).update(canonical({ kind: "guild.deepgram-caption-correction.v1", tenantId: c.tenantId, commissionId: c.id,
    agreementId: agreement.id, digest: agreement.proposal.digest, actorId: agreement.actorId, agreedAt: agreement.agreedAt })).digest("hex");
}

async function originalArtifact(db: Db, c: Commission, pkg: WorkPackage, first: Job) {
  if (first.state !== "completed" || !first.output?.artifactId) fail("DEEPGRAM_REVIEW_ORIGINAL", "Retain the complete original review edition before assembling corrections. Unknown provider outcomes are never retried.");
  const artifact = await captionOwnedArtifact(db, c, first.output.artifactId), content = deepgramCaptionArtifactSchema.parse(artifact.content);
  if (artifact.packageId !== pkg.id || content.attempt !== 1 || content.correction || content.productionJobId !== first.id || content.originalProductionJobId !== first.id
    || content.contractDigest !== pkg.acceptancePack.digest || content.sourceDigest !== digest(deepgramSourcesFromPack(pkg.acceptancePack))) fail("DEEPGRAM_REVIEW_ORIGINAL", "The first review edition differs from the frozen original job and source.");
  await readDeepgramCaptionApprovalHistory(db, c, pkg, artifact);
  return { artifact, content };
}

export async function deepgramCaptionCorrectionProposal(db: Db, c: Commission, pkg: WorkPackage): Promise<DeepgramCaptionCorrectionProposal> {
  const sources = await validateDeepgramCaptionContract(db, c, pkg);
  await noConflictingWork(db, c, pkg, false); await assertCaptionOutcomesKnown(db, c, pkg);
  const jobs = await attemptedJobs(db, c, pkg);
  if (jobs.length !== 1 || pkg.deepgramCaptionCorrection) fail("DEEPGRAM_REVIEW_ALLOWANCE", "The review agreement permits one original recognition job and one separately agreed correction assembly. Every attempted job counts.");
  if (!c.approvedPlanDigest || planDigest(c) !== c.approvedPlanDigest) fail("DEEPGRAM_REVIEW_PASSPORT", "Review the current exact Passport before preparing the corrected edition.");
  const { artifact } = await originalArtifact(db, c, pkg, jobs[0]!);
  const report = (await db.query<{ id: string; criteria_digest: string; result: WorkPackage["acceptancePack"] }>("SELECT id,criteria_digest,result FROM guild_verifications WHERE tenant_id=$1 AND commission_id=$2 AND artifact_id=$3 AND artifact_hash=$4 AND package_id=$5 AND contract_version=$6 ORDER BY created_at DESC,id DESC LIMIT 1", [c.tenantId, c.id, artifact.id, artifact.contentHash, pkg.id, pkg.contractVersion])).rows[0];
  if (!report || digest(report.result) !== report.criteria_digest) fail("DEEPGRAM_REVIEW_REPORT_REQUIRED", "Run and retain the independent checks on the original review edition before preparing corrections.");
  const revisions: DeepgramCaptionCorrectionProposal["revisions"] = [];
  const targetFor = await captionReviewTargets(db, c.tenantId, artifact.id);
  for (const source of sources.tracks) {
    const leaf = (await db.query<{ id: string }>("SELECT r.id FROM guild_caption_review_revisions r WHERE r.tenant_id=$1 AND r.artifact_id=$2 AND r.locale=$3 AND r.track_key=$4 AND NOT EXISTS(SELECT 1 FROM guild_caption_review_revisions n WHERE n.parent_revision_id=r.id) LIMIT 1", [c.tenantId, artifact.id, source.locale, source.key])).rows[0];
    if (!leaf) fail("DEEPGRAM_REVIEW_INCOMPLETE", `Listen and save an attributed review for ${source.locale}/${source.key}. Every registered recording is required.`);
    const revision = await readCaptionReviewRevision(db, c.tenantId, leaf.id, await targetFor(source.locale, source.key));
    if (!revision.attestation || revision.evaluation.status !== "ready-for-review") fail("DEEPGRAM_REVIEW_INCOMPLETE", `${source.locale}/${source.key} still needs a separate complete listening attestation. Drafts and uncertain words cannot enter the corrected edition.`);
    revisions.push({ locale: source.locale, key: source.key, id: revision.id, digest: revision.digest });
  }
  const body: Omit<DeepgramCaptionCorrectionProposal, "digest"> = { version: "guild.deepgram-caption-correction.v1", commissionId: c.id, packageId: pkg.id, contractVersion: pkg.contractVersion,
    contractDigest: pkg.acceptancePack.digest, sourceDigest: digest(sources), previousPlanDigest: c.approvedPlanDigest, baseArtifactId: artifact.id, baseArtifactHash: artifact.contentHash,
    originalProductionJobId: jobs[0]!.id, originalVerificationId: report.id, originalVerificationHash: report.criteria_digest, revisions,
    authorityExpiresAt: captionAuthorityCeilingSchema.parse(pkg.acceptancePack.parameters?.authorityCeiling).expiresAt, recognitionRequests: 0, easyReadRequests: 0, additionalChargeMinor: 0,
    disclosure: "Assemble these exact attributed listening revisions against the unchanged original source, audio, signed recognition and easy-read responses. This second job sends zero recognition, narration or model requests and adds no charge. Every original failure remains inspectable. A fresh Passport is required under the original deadline. Automatic qualification, fluent review, source acceptance and payment remain separate." };
  return { ...body, digest: deepgramCaptionCorrectionDigest(body) };
}

export async function prepareDeepgramCaptionCorrection(db: PoolClient, session: Session, c: Commission, pkg: WorkPackage, version: number, expectedDigest: string) {
  await requireCaptionActor(db, session);
  if (version !== pkg.contractVersion) fail("DEEPGRAM_REVIEW_CORRECTION_CHANGED", "The correction belongs to an earlier review agreement.");
  const proposal = await deepgramCaptionCorrectionProposal(db, c, pkg);
  if (proposal.digest !== expectedDigest) fail("DEEPGRAM_REVIEW_CORRECTION_CHANGED", "The displayed review revisions, original report or authority changed. Reopen the exact correction proposal.");
  const agreement: DeepgramCaptionCorrectionAgreement = { id: randomUUID(), proposal, actorId: session.id, agreedAt: new Date().toISOString(), signature: "" };
  agreement.signature = correctionSignature(c, agreement);
  await db.query("INSERT INTO guild_deepgram_caption_corrections(id,tenant_id,commission_id,package_id,contract_version,base_artifact_id,actor_id,agreement_digest,agreement) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [agreement.id, c.tenantId, c.id, pkg.id, version, proposal.baseArtifactId, session.id, proposal.digest, agreement]);
  pkg.deepgramCaptionCorrection = agreement; pkg.state = "awarded"; pkg.progress = null; c.approvedPlanDigest = null; c.state = "awaiting_approval";
  for (const page of c.mandates) if (page.status === "active") page.status = "draft";
  return { reason: proposal.disclosure };
}

async function validateCorrection(db: Db, c: Commission, pkg: WorkPackage, first: Job) {
  const agreement = pkg.deepgramCaptionCorrection, sources = deepgramSourcesFromPack(pkg.acceptancePack);
  if (!agreement) fail("DEEPGRAM_REVIEW_CORRECTION_REQUIRED", "Complete the per-track listening reviews, agree the exact correction assembly, then approve its fresh Passport. Recognition will not run again.");
  const p = agreement.proposal;
  if (p.digest !== deepgramCaptionCorrectionDigest(p) || p.version !== "guild.deepgram-caption-correction.v1" || p.commissionId !== c.id || p.packageId !== pkg.id || p.contractVersion !== pkg.contractVersion
    || p.contractDigest !== pkg.acceptancePack.digest || p.sourceDigest !== digest(sources) || p.originalProductionJobId !== first.id || p.recognitionRequests !== 0 || p.easyReadRequests !== 0 || p.additionalChargeMinor !== 0
    || p.authorityExpiresAt !== captionAuthorityCeilingSchema.parse(pkg.acceptancePack.parameters?.authorityCeiling).expiresAt
    || !/^[a-f0-9]{64}$/.test(agreement.signature) || !timingSafeEqual(Buffer.from(agreement.signature), Buffer.from(correctionSignature(c, agreement))))
    fail("DEEPGRAM_REVIEW_CORRECTION_CHANGED", "The signed correction differs from its exact source, original outcome and zero-recognition scope.");
  const saved = (await db.query<{ agreement: DeepgramCaptionCorrectionAgreement; agreement_digest: string }>("SELECT agreement,agreement_digest FROM guild_deepgram_caption_corrections WHERE tenant_id=$1 AND commission_id=$2 AND id=$3 AND package_id=$4 AND contract_version=$5", [c.tenantId, c.id, agreement.id, pkg.id, pkg.contractVersion])).rows[0];
  const { artifact } = await originalArtifact(db, c, pkg, first);
  const report = (await db.query<{ criteria_digest: string; result: WorkPackage["acceptancePack"] }>("SELECT criteria_digest,result FROM guild_verifications WHERE tenant_id=$1 AND commission_id=$2 AND id=$3 AND artifact_id=$4 AND artifact_hash=$5", [c.tenantId, c.id, p.originalVerificationId, artifact.id, artifact.contentHash])).rows[0];
  if (!saved || saved.agreement_digest !== p.digest || digest(saved.agreement) !== digest(agreement) || artifact.id !== p.baseArtifactId || artifact.contentHash !== p.baseArtifactHash
    || !report || report.criteria_digest !== p.originalVerificationHash || digest(report.result) !== p.originalVerificationHash)
    fail("DEEPGRAM_REVIEW_CORRECTION_CHANGED", "The original artifact, independent report or correction receipt changed.");
  const prior = await captionApprovalAt(db, c, p.previousPlanDigest, new Date(agreement.agreedAt)), priorPkg = prior.command.result.commission.packages.find(item => item.id === pkg.id);
  if (!priorPkg || priorPkg.deepgramCaptionCorrection || digest(captionContractTerms(priorPkg)) !== digest(captionContractTerms(pkg))) fail("DEEPGRAM_REVIEW_CORRECTION_CHANGED", "The exact prior signed Passport does not match this correction.");
  if (p.revisions.length !== sources.tracks.length || new Set(p.revisions.map(item => `${item.locale}/${item.key}`)).size !== sources.tracks.length) fail("DEEPGRAM_REVIEW_COVERAGE", "Every original recording must have one exact reviewed correction.");
  const targetFor = await captionReviewTargets(db, c.tenantId, artifact.id);
  const reviewedTracks = new Map<string, { target: Awaited<ReturnType<typeof targetFor>>; revision: Awaited<ReturnType<typeof readCaptionReviewRevision>> }>();
  for (const source of sources.tracks) {
    const reference = p.revisions.find(item => item.locale === source.locale && item.key === source.key);
    if (!reference) fail("DEEPGRAM_REVIEW_COVERAGE", "A registered source track is missing from the correction agreement.");
    const target = await targetFor(source.locale, source.key), revision = await readCaptionReviewRevision(db, c.tenantId, reference.id, target);
    if (revision.digest !== reference.digest || revision.artifactId !== artifact.id || revision.artifactHash !== artifact.contentHash || revision.sourceTrackDigest !== digest(source)
      || !revision.attestation || revision.evaluation.status !== "ready-for-review") fail("DEEPGRAM_REVIEW_COVERAGE", "The exact complete listening review is no longer available for this source track.");
    reviewedTracks.set(`${source.locale}/${source.key}`, { target, revision });
  }
  return { agreement, reviewedTracks };
}

export async function deepgramCaptionAdmission(db: Db, c: Commission, pkg: WorkPackage) {
  const sources = await validateDeepgramCaptionContract(db, c, pkg), jobs = await attemptedJobs(db, c, pkg);
  await assertCaptionOutcomesKnown(db, c, pkg);
  if (jobs.length >= 2) fail("DEEPGRAM_REVIEW_ALLOWANCE", "Both bounded jobs are retained. No recognition retry or third correction assembly is authorized.");
  if (!jobs.length) {
    if (pkg.deepgramCaptionCorrection) fail("DEEPGRAM_REVIEW_CORRECTION_CHANGED", "A correction cannot precede its original review job.");
    if (process.env.GUILD_ENABLE_DEEPGRAM_REVIEW !== "true") fail("DEEPGRAM_REVIEW_DISABLED", "The server has not enabled this separately agreed review capability. Draft review remains available; no provider request was sent.");
    if (!process.env.DEEPGRAM_API_KEY || !process.env.OPENAI_API_KEY || process.env.OPENAI_MODEL !== easyReadStandard.model)
      fail("DEEPGRAM_REVIEW_CONFIGURATION", "Configure the exact agreed Deepgram transport and easy-read model before reserving the original job. No attempt or provider request has been created.");
    return { captionAttempt: 1, captionSourceDigest: digest(sources), inputBindings: sources.inputBindings };
  }
  const { agreement: correction } = await validateCorrection(db, c, pkg, jobs[0]!);
  return { captionAttempt: 2, captionSourceDigest: digest(sources), inputBindings: sources.inputBindings, deepgramReviewCorrectionId: correction.id, deepgramReviewCorrectionDigest: correction.proposal.digest };
}

export async function validateDeepgramCaptionJob(db: Db, c: Commission, pkg: WorkPackage, job: { id: string; input: DeepgramCaptionJobInput }, dispatch = true) {
  const sources = await validateDeepgramCaptionContract(db, c, pkg, dispatch), jobs = await attemptedJobs(db, c, pkg), attempt = jobs.findIndex(item => item.id === job.id) + 1;
  if (!attempt || attempt > 2 || jobs.length > 2 || job.input.captionAttempt !== attempt || job.input.captionSourceDigest !== digest(sources)
    || digest(job.input.inputBindings) !== digest(sources.inputBindings) || job.input.contractVersion !== pkg.contractVersion) fail("DEEPGRAM_REVIEW_JOB_BINDING", "The job differs from its exact source register, current agreement and bounded attempt.");
  if (attempt === 1) {
    if (job.input.deepgramReviewCorrectionId || job.input.deepgramReviewCorrectionDigest || dispatch && (pkg.deepgramCaptionCorrection || jobs.length !== 1 || process.env.GUILD_ENABLE_DEEPGRAM_REVIEW !== "true"))
      fail("DEEPGRAM_REVIEW_JOB_BINDING", "The original recognition job cannot borrow later correction authority or bypass the server capability gate.");
    return { sources, attempt: 1 as const, correction: null, reviewedTracks: undefined };
  }
  const { agreement, reviewedTracks } = await validateCorrection(db, c, pkg, jobs[0]!);
  if (job.input.deepgramReviewCorrectionId !== agreement.id || job.input.deepgramReviewCorrectionDigest !== agreement.proposal.digest)
    fail("DEEPGRAM_REVIEW_JOB_BINDING", "Only the one exact agreed correction assembly can create this successor edition.");
  // These signed receipts/revisions are valid only within this operation. A new
  // request or lease calls this function again, including current authority.
  return { sources, attempt: 2 as const, correction: agreement, reviewedTracks };
}

export async function readDeepgramCaptionApprovalHistory(db: Db, c: Commission, pkg: WorkPackage, artifact: ArtifactManifest) {
  const content = deepgramCaptionArtifactSchema.parse(artifact.content);
  if (digest(artifact.content) !== artifact.contentHash || artifact.packageId !== pkg.id || content.contractDigest !== pkg.acceptancePack.digest) fail("DEEPGRAM_APPROVAL_HISTORY", "The retained artifact differs from its original review contract.");
  const job = (await db.query<Job>("SELECT id,state,input,output,created_at FROM guild_jobs WHERE tenant_id=$1 AND commission_id=$2 AND id=$3 AND type='produce_package'", [c.tenantId, c.id, content.productionJobId])).rows[0];
  if (!job || job.state !== "completed" || job.output?.artifactId !== artifact.id || job.input.packageId !== pkg.id || job.input.contractVersion !== pkg.contractVersion
    || job.input.captionAttempt !== content.attempt || job.input.captionSourceDigest !== content.sourceDigest || digest(job.input.inputBindings) !== digest(content.inputBindings))
    fail("DEEPGRAM_APPROVAL_HISTORY", "The retained artifact has no exact matching completed producing job.");
  const queued = (await db.query<{ command_id: string; payload_hash: string; created_at: Date; result: { ok: boolean; commandId: string; revision: number; jobId: string; commission: Commission } }>("SELECT command_id,payload_hash,created_at,result FROM guild_commands WHERE tenant_id=$1 AND commission_id=$2 AND result->>'jobId'=$3", [c.tenantId, c.id, job.id])).rows;
  if (queued.length !== 1) fail("DEEPGRAM_APPROVAL_HISTORY", "The original producing command is missing or ambiguous.");
  const command = queued[0]!, snapshot = command.result.commission, saved = snapshot?.packages.find(item => item.id === pkg.id);
  if (!snapshot?.approvedPlanDigest || !saved || snapshot.id !== c.id || snapshot.tenantId !== c.tenantId || planDigest(snapshot) !== snapshot.approvedPlanDigest
    || digest(captionContractTerms(saved)) !== digest(captionContractTerms(pkg)) || !command.result.ok || command.result.commandId !== command.command_id || command.result.revision !== snapshot.revision
    || command.created_at.getTime() !== job.created_at.getTime() || command.payload_hash !== digest({ commissionId: c.id, command: { type: "produce_package", packageId: pkg.id, commandId: command.command_id, expectedRevision: command.result.revision - 1 } }))
    fail("DEEPGRAM_APPROVAL_HISTORY", "The producing command no longer matches the exact original approved snapshot.");
  const approved = await captionApprovalAt(db, c, snapshot.approvedPlanDigest, job.created_at), original = approved.command.result.commission.packages.find(item => item.id === pkg.id);
  const expectedCorrection = content.attempt === 2 && original?.deepgramCaptionCorrection ? { id: original.deepgramCaptionCorrection.id, digest: original.deepgramCaptionCorrection.proposal.digest,
    baseArtifactId: original.deepgramCaptionCorrection.proposal.baseArtifactId, baseArtifactHash: original.deepgramCaptionCorrection.proposal.baseArtifactHash } : null;
  if (!original || digest(captionContractTerms(original)) !== digest(captionContractTerms(saved)) || digest(original.deepgramCaptionCorrection ?? null) !== digest(saved.deepgramCaptionCorrection ?? null)
    || digest(content.correction) !== digest(expectedCorrection) || content.attempt === 1 && original.deepgramCaptionCorrection
    || job.created_at.getTime() >= Date.parse(captionAuthorityCeilingSchema.parse(original.acceptancePack.parameters?.authorityCeiling).expiresAt))
    fail("DEEPGRAM_APPROVAL_HISTORY", "The exact original signed Passport or its authority ceiling differs from the retained edition.");
  return { job, snapshot: approved.command.result.commission, package: original };
}

/** Human acceptance is possible for a genuinely reviewed complete correction;
 * it never asserts the blind recognizer was automatically qualified. */
export async function assertDeepgramCaptionAcceptable(db: Db, c: Commission, pkg: WorkPackage, artifact: ArtifactManifest) {
  const retained = await captionOwnedArtifact(db, c, artifact.id, artifact.contentHash), content = deepgramCaptionArtifactSchema.parse(retained.content);
  if (content.attempt !== 2 || !content.correction || !pkg.deepgramCaptionCorrection || content.correction.id !== pkg.deepgramCaptionCorrection.id
    || content.tracks.length !== content.sources.tracks.length || content.tracks.some(track => !track.reviewRevision || track.effective.status !== "ready-for-review" || !track.effective.listeningAttested || !track.vtt))
    fail("CAPTION_COMPLETE_LISTENING_REQUIRED", "Every original track needs its exact attributed human listening correction and independently checked VTT before this contract can be accepted.");
  const history = await readDeepgramCaptionApprovalHistory(db, c, pkg, retained);
  const bound = await validateDeepgramCaptionJob(db, c, pkg, history.job, false);
  const declarations = [];
  for (const track of content.tracks) {
    const revision = bound.reviewedTracks?.get(`${track.locale}/${track.key}`)?.revision;
    if (!revision || revision.id !== track.reviewRevision!.id || !revision.attestation || !["judge", "owner"].includes(revision.actorRole) || revision.digest !== track.reviewRevision!.digest || revision.evaluation.status !== "ready-for-review")
      fail("CAPTION_COMPLETE_LISTENING_REQUIRED", "A system annotation, changed review or incomplete recording cannot stand in for human listening.");
    declarations.push({ locale: track.locale, key: track.key, revisionId: revision.id, revisionDigest: revision.digest, actorId: revision.actorId,
      reviewerName: revision.attestation.reviewerName, recordedAt: revision.createdAt, humanDeclaredListening: true, fluentReviewed: false });
  }
  return { version: "guild.caption-acceptance-disclosures.v1", automatedQualification: "not-qualified", declarations,
    disclosure: "Accepted under the explicitly reviewed human-correction contract. Named listening declarations and independent structural checks do not establish automatic ASR qualification or fluent-language review. The curator explicitly acknowledges each language’s review limits." };
}
