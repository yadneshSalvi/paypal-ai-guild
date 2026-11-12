import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { ArtifactInputBinding, Commission, WebCorrectionAgreement, WebCorrectionProposal, WorkPackage } from "@/contracts/guild";
import { webAcceptancePack, webAuditCapabilitySchema, webAuthoritySchema, webProductionPolicies, webSourcesFromPack } from "@/domain/web-exhibition";
import { webArtifactSchema } from "@/domain/web-audits";
import { planDigest } from "@/domain/fixture";
import { canonical, digest, DomainError } from "@/domain/primitives";
import { captionApprovalAt, originalApproval } from "../captions/authority";
import { captionOwnedArtifact } from "../captions/sources";
import type { Session } from "../session";
import { buildWebAuthority, requireWebActor, validateWebAuthority, validateWebProvider } from "./authority";
import { installedWebRuntime, type WebRuntimeAccess } from "./capability";
import { buildWebSources } from "./sources";
import { normalizedWebSourceTerms } from "./source-history";

type Db = Pool | PoolClient;
function fail(code: string, message: string): never { throw new DomainError(code, message, 422, false); }
export interface WebJobInput { packageId?: string; contractVersion?: number; inputBindings?: unknown; webSourceDigest?: string; webAttempt?: number; webCorrectionId?: string; webCorrectionDigest?: string; webProviderPolicyDigest?: string; webPipelineDigest?: string }
interface ProducingJob { id: string; state: string; input: WebJobInput; output: { artifactId?: string } | null; error: string | null; created_at: Date; updated_at: Date }
export const webContractTerms = normalizedWebSourceTerms;
export function webCommercialTerms(c: Commission, pkg: WorkPackage): WebCorrectionProposal["commercial"] {
  const provider = validateWebProvider(c, pkg), providerId = provider.id as "formwork" | "ostrava";
  return { providerId, providerAwardMinor: pkg.providerAwardMinor, serviceFeeMinor: 1500, grossMinor: pkg.grossMinor, additionalChargeMinor: 0, providerPolicyDigest: provider.policyDigest, pipelineDigest: digest(webProductionPolicies[providerId]) };
}
async function attemptedJobs(db: Db, c: Commission, pkg: WorkPackage) {
  return (await db.query<ProducingJob>("SELECT id,state,input,output,error,created_at,updated_at FROM guild_jobs WHERE tenant_id=$1 AND commission_id=$2 AND type='produce_package' AND input->>'packageId'=$3 AND input->>'contractVersion'=$4 ORDER BY created_at,id", [c.tenantId, c.id, pkg.id, String(pkg.contractVersion)])).rows;
}
/** Unknown earlier awards cannot be erased by a replacement quote or new plan. */
export async function assertWebOutcomesKnown(db: Db, c: Commission, pkg: WorkPackage, jobId?: string) {
  const audits = await db.query("SELECT id FROM guild_web_audit_cases WHERE tenant_id=$1 AND commission_id=$2 AND package_id=$3 AND ($4::uuid IS NULL OR job_id=$4) AND state IN ('dispatching','indeterminate') LIMIT 1", [c.tenantId, c.id, pkg.id, jobId ?? null]);
  const models = await db.query("SELECT m.id FROM guild_model_runs m JOIN guild_jobs j ON j.id=m.job_id AND j.tenant_id=m.tenant_id WHERE j.tenant_id=$1 AND j.commission_id=$2 AND j.input->>'packageId'=$3 AND ($4::uuid IS NULL OR j.id=$4) AND (m.status IN ('dispatching','running','received','indeterminate','unavailable') OR (m.operation_key IS NULL AND m.status<>'completed')) LIMIT 1", [c.tenantId, c.id, pkg.id, jobId ?? null]);
  if (audits.rowCount || models.rowCount) fail("WEB_ORIGINAL_PENDING", "An original design or browser attempt is unresolved. Retain its request and partial evidence; neither a correction nor a replacement award may silently dispatch over it.");
}
async function noConflictingWork(db: Db, c: Commission, pkg: WorkPackage, initial: boolean) {
  if (c.state === "paused" || pkg.acceptedAt || pkg.paymentState !== "not_eligible" || pkg.state === "accepted") fail("WEB_CONTRACT_STATE", "Review the unaccepted web contract before preparing this agreement.");
  if ((await db.query("SELECT id FROM guild_jobs WHERE tenant_id=$1 AND commission_id=$2 AND state IN ('queued','running') LIMIT 1", [c.tenantId, c.id])).rowCount) fail("AMENDMENT_WORK_RUNNING", "Finish the existing saved production and checks before preparing a web agreement.");
  if ((await db.query("SELECT id FROM guild_payment_intents WHERE tenant_id=$1 AND commission_id=$2 LIMIT 1", [c.tenantId, c.id])).rowCount) fail("AMENDMENT_BILLING_STARTED", "This amendment is available before checkout. Existing financial obligations need their separate review.");
  if (initial && (pkg.artifactIds.length || !["draft", "bidding", "awarded"].includes(pkg.state) || (await db.query("SELECT id FROM guild_jobs WHERE tenant_id=$1 AND commission_id=$2 AND type='produce_package' AND input->>'packageId'=$3 LIMIT 1", [c.tenantId, c.id, pkg.id])).rowCount)) fail("WEB_AMENDMENT_STARTED", "An earlier web attempt keeps its original terms. The measured web agreement must precede its first production.");
}
export async function webContractProposal(db: Db, c: Commission, pkg: WorkPackage, runtimeAccess: WebRuntimeAccess = installedWebRuntime) {
  if (pkg.kind !== "web" || pkg.acceptancePack.version !== "1.0.0" || c.mode !== "live") fail("WEB_AMENDMENT_CHANGED", "The measured web agreement is available for the unstarted original web contract.");
  validateWebProvider(c, pkg);
  const sources = await buildWebSources(db, c, pkg), authority = await buildWebAuthority(db, c, pkg), runtime = await runtimeAccess.read();
  return webAcceptancePack(sources, authority, runtime.capability, runtime.authored.capability);
}
export async function prepareWebContract(db: PoolClient, session: Session, c: Commission, pkg: WorkPackage, version: number, expectedDigest: string, runtimeAccess: WebRuntimeAccess = installedWebRuntime) {
  await requireWebActor(db, session);
  if (pkg.contractVersion !== version) fail("WEB_AMENDMENT_CHANGED", "This web agreement belongs to an earlier contract version.");
  await noConflictingWork(db, c, pkg, true);
  const pack = await webContractProposal(db, c, pkg, runtimeAccess);
  if (pack.digest !== expectedDigest) fail("WEB_AMENDMENT_CHANGED", "The exact sources, original authority, renderer or measured audit capability changed. Review the current agreement.");
  await validateWebAuthority(db, c, { ...pkg, acceptancePack: pack }, true);
  if ((await db.query("SELECT id FROM guild_budget_reservations WHERE tenant_id=$1 AND operation_key=$2 AND state IN ('reserved','committed')", [c.tenantId, `production:${c.id}:${pkg.id}:${pkg.contractVersion}`])).rowCount) fail("AMENDMENT_COMMITMENT_EXISTS", "The original web contract already has a reserved obligation. Preserve its terms until that obligation is explicitly resolved.");
  const previous = structuredClone(pkg), previousPlan = c.approvedPlanDigest;
  pkg.contractVersion++; pkg.acceptancePack = pack; pkg.state = "awarded";
  pkg.description = "A complete eight-chapter exhibition from exact original text, images, audio and captions. All 18 browser cases retain their actual findings. One included correction needs an exact note and fresh Passport; original authority remains fixed.";
  c.approvedPlanDigest = null; c.state = "awaiting_approval"; for (const page of c.mandates) if (page.status === "active") page.status = "draft";
  const reason = "Measured web acceptance pack 2.0.0 prepared before production. Exact five-family ancestry, original recordings/captions, historical producing approvals, authored reader, bounded design model and pinned 18-case browser audit are frozen. Formwork has one design pass without self-audit; Studio Ostrava has at most three retained design/audit passes. Each award retains its single included correction, exact price and original authority ceiling. A replacement quote, commercial change or correction needs a fresh Passport. No provider, browser, acceptance or payment action was dispatched by this amendment.";
  await db.query("INSERT INTO guild_contract_amendments(id,tenant_id,commission_id,package_id,from_version,to_version,previous_plan_digest,proposed_plan_digest,previous_contract,proposed_contract,actor_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)", [randomUUID(), c.tenantId, c.id, pkg.id, previous.contractVersion, pkg.contractVersion, previousPlan, planDigest(c), previous, pkg, session.id, reason]);
  return { reason };
}
export async function validateWebContract(db: Db, c: Commission, pkg: WorkPackage, dispatch = true, runtimeAccess: WebRuntimeAccess = installedWebRuntime) {
  if (pkg.kind !== "web") fail("WEB_CONTRACT_REQUIRED", "This producer needs the exact measured web agreement.");
  const sources = webSourcesFromPack(pkg.acceptancePack);
  const rows = (await db.query<{ from_version: number; to_version: number; previous_contract: WorkPackage; proposed_contract: WorkPackage }>("SELECT from_version,to_version,previous_contract,proposed_contract FROM guild_contract_amendments WHERE tenant_id=$1 AND commission_id=$2 AND package_id=$3 AND to_version<=$4 ORDER BY to_version DESC", [c.tenantId, c.id, pkg.id, pkg.contractVersion])).rows;
  let expected = pkg, foundInitial = false;
  for (const row of rows) {
    if (row.to_version !== expected.contractVersion) continue;
    if (row.from_version !== row.previous_contract.contractVersion || row.to_version !== row.proposed_contract.contractVersion || row.to_version !== row.from_version + 1
      || digest(webContractTerms(row.proposed_contract)) !== digest(webContractTerms(expected)) || row.proposed_contract.acceptancePack.digest !== pkg.acceptancePack.digest) fail("WEB_CONTRACT_CHANGED", "The original web amendment or replacement contract chain changed.");
    if (row.previous_contract.acceptancePack.version === "1.0.0") { foundInitial = true; break; }
    if (row.previous_contract.acceptancePack.digest !== pkg.acceptancePack.digest) fail("WEB_STANDARD_CHANGED", "A replacement award cannot silently change the original web acceptance standard.");
    expected = row.previous_contract;
  }
  if (!foundInitial) fail("WEB_CONTRACT_CHANGED", "The exact original web amendment is missing from its retained history.");
  await validateWebAuthority(db, c, pkg, dispatch);
  await buildWebSources(db, c, pkg, sources);
  if (dispatch) { const runtime = await runtimeAccess.read(); if (digest(runtime.capability) !== digest(webAuditCapabilitySchema.parse(pkg.acceptancePack.parameters?.auditCapability))) fail("WEB_CAPABILITY_CHANGED", "The qualified browser or authored reader changed after agreement; a new capability needs a separately reviewed contract."); }
  return sources;
}

async function originalResult(db: Db, c: Commission, pkg: WorkPackage, job: ProducingJob, frozen?: WebCorrectionProposal["previous"]): Promise<WebCorrectionProposal["previous"]> {
  if (!["completed", "failed", "needs_review"].includes(job.state)) fail("WEB_ORIGINAL_PENDING", "Finish the original web job and retain its complete outcome before reviewing its one correction.");
  await assertWebOutcomesKnown(db, c, pkg, job.id);
  const audits = (await db.query("SELECT a.id,a.case_key,a.request_hash,a.request,a.state,a.failure_code,a.dispatched_at,o.result_hash,o.result,o.evidence_manifest,o.signature FROM guild_web_audit_cases a LEFT JOIN guild_web_audit_observations o ON o.case_id=a.id AND o.tenant_id=a.tenant_id WHERE a.tenant_id=$1 AND a.job_id=$2 ORDER BY a.case_key,a.id", [c.tenantId, job.id])).rows;
  const models = (await db.query("SELECT id,operation_key,model,input_hash,status,output,output_hash,provider_response_id,provider_output_text,provider_status,failure_code FROM guild_model_runs WHERE tenant_id=$1 AND job_id=$2 ORDER BY operation_key,id", [c.tenantId, job.id])).rows;
  if (audits.some(row => row.result && digest(row.result) !== row.result_hash || digest(row.request) !== row.request_hash) || models.some(row => row.status === "completed" && digest(row.output) !== row.output_hash)) fail("WEB_ORIGINAL_CHANGED", "A retained original design or browser report no longer matches its hash.");
  let artifact: WebCorrectionProposal["previous"]["artifact"] = null;
  if (job.output?.artifactId) {
    const original = await captionOwnedArtifact(db, c, job.output.artifactId), parsed = webArtifactSchema.safeParse(original.content);
    if (!parsed.success || parsed.data.productionJobId !== job.id || original.packageId !== pkg.id || parsed.data.contractDigest !== pkg.acceptancePack.digest || parsed.data.sourceDigest !== digest(webSourcesFromPack(pkg.acceptancePack))) fail("WEB_ORIGINAL_CHANGED", "The retained web artifact differs from its exact original job, source or agreement.");
    await (await import("./approval-history")).readWebApprovalHistory(db, c, pkg, original);
    const checks = (await db.query<{ id: string; criteria_digest: string; result: WorkPackage["acceptancePack"] }>("SELECT id,criteria_digest,result FROM guild_verifications WHERE tenant_id=$1 AND commission_id=$2 AND package_id=$3 AND contract_version=$4 AND artifact_id=$5 AND artifact_hash=$6 AND ($7::uuid IS NULL OR id=$7) ORDER BY created_at DESC,id DESC LIMIT 1", [c.tenantId, c.id, pkg.id, pkg.contractVersion, original.id, original.contentHash, frozen?.artifact?.verificationId ?? null])).rows[0];
    const report = (await db.query<{ id: string; output: { pack: WorkPackage["acceptancePack"] } }>("SELECT id,output FROM guild_jobs WHERE tenant_id=$1 AND commission_id=$2 AND type='verify_artifact' AND state='completed' AND input->>'artifactId'=$3 AND input->>'artifactHash'=$4 AND ($5::uuid IS NULL OR id=$5) ORDER BY created_at DESC,id DESC LIMIT 1", [c.tenantId, c.id, original.id, original.contentHash, frozen?.artifact?.reportJobId ?? null])).rows[0];
    if (!checks || !report || digest(checks.result) !== checks.criteria_digest || digest(report.output.pack) !== checks.criteria_digest || digest(pkg.acceptancePack) !== checks.criteria_digest) fail("WEB_CHECKS_REQUIRED", "Finish the exact independent 18-case web checks before reviewing a correction.");
    artifact = { id: original.id, contentHash: original.contentHash, verificationId: checks.id, verificationHash: checks.criteria_digest, reportJobId: report.id, reportHash: digest(report.output) };
  } else if (job.state === "completed") fail("WEB_ORIGINAL_CHANGED", "The completed original web job has no retained artifact.");
  return { jobId: job.id, state: job.state, inputHash: digest(job.input), outputHash: digest(job.output), error: job.error, operationsHash: digest(JSON.parse(JSON.stringify({ audits, models }))), artifact };
}
export function webCorrectionDigest(proposal: WebCorrectionProposal | Omit<WebCorrectionProposal, "digest">) { const { digest: _digest, ...body } = proposal as WebCorrectionProposal; return digest(body); }
function correctionSignature(c: Commission, agreement: WebCorrectionAgreement) {
  if (!process.env.AUTH_SECRET) throw new Error("AUTH_SECRET required");
  return createHmac("sha256", process.env.AUTH_SECRET).update(canonical({ kind: agreement.receipt.kind, tenantId: c.tenantId, commissionId: c.id, agreementId: agreement.id, proposalDigest: agreement.proposal.digest, actorId: agreement.actorId, agreedAt: agreement.agreedAt })).digest("hex");
}
export async function webCorrectionProposal(db: Db, c: Commission, pkg: WorkPackage, runtimeAccess: WebRuntimeAccess = installedWebRuntime): Promise<WebCorrectionProposal> {
  const sources = await validateWebContract(db, c, pkg, true, runtimeAccess);
  await noConflictingWork(db, c, pkg, false); await assertWebOutcomesKnown(db, c, pkg);
  const jobs = await attemptedJobs(db, c, pkg);
  if (jobs.length !== 1 || pkg.webCorrection) fail("WEB_CORRECTION_ALLOWANCE", "This award includes one original job and one explicitly approved correction. Every attempted job counts.");
  const previous = await originalResult(db, c, pkg, jobs[0]!), note = c.events.filter(item => item.type === "package.correction_requested" && item.packageId === pkg.id).at(-1);
  if (!note || note.createdAt < jobs[0]!.updated_at.toISOString() || pkg.state !== "correction_requested") fail("WEB_CORRECTION_NOTE", "Save a correction note for this exact original result before preparing the included correction.");
  const approved = await originalApproval(db, c);
  await requireWebActor(db, { id: approved.receipt.actor_id, tenantId: c.tenantId, role: approved.receipt.role, expiresAt: approved.actorExpiresAt });
  const proposal: Omit<WebCorrectionProposal, "digest"> = { version: "guild.web-correction.v1", commissionId: c.id, packageId: pkg.id, contractVersion: pkg.contractVersion,
    acceptancePackDigest: pkg.acceptancePack.digest, sourceDigest: digest(sources), previousPlanDigest: approved.receipt.plan_digest,
    previousApproval: { id: approved.receipt.id, actorId: approved.receipt.actor_id, receiptHash: digest({ payload: approved.receipt.payload, signature: approved.receipt.signature }) }, previous,
    note: { eventId: note.id, eventHash: note.hash, text: note.detail }, maximumProductionJobs: 2, correctionAllowance: 1, attempt: 2, commercial: webCommercialTerms(c, pkg),
    authorityCeiling: webAuthoritySchema.parse(pkg.acceptancePack.parameters?.authority).expiresAt,
    disclosure: "One included correction from this controlled web provider. One second job retains the exact source, authored reader, unchanged 18-case standard, declared producer pipeline, award, $15 fee and original work deadline. Every attempt and prior finding remains in the denominator. Fresh Passport approval is required. No new design, browser run, human review, acceptance or payment is created here." };
  return { ...proposal, digest: webCorrectionDigest(proposal) };
}
export async function prepareWebCorrection(db: PoolClient, session: Session, c: Commission, pkg: WorkPackage, version: number, expectedDigest: string, runtimeAccess: WebRuntimeAccess = installedWebRuntime) {
  await requireWebActor(db, session);
  if (pkg.contractVersion !== version) fail("WEB_CORRECTION_CHANGED", "This correction belongs to an earlier web award.");
  const proposal = await webCorrectionProposal(db, c, pkg, runtimeAccess);
  if (proposal.digest !== expectedDigest) fail("WEB_CORRECTION_CHANGED", "The exact original attempt, note, report, pipeline or authority changed. Review the current correction.");
  const agreement: WebCorrectionAgreement = { id: randomUUID(), proposal, actorId: session.id, agreedAt: new Date().toISOString(), receipt: { kind: "guild.controlled-web-correction.v1", algorithm: "HMAC-SHA256", signature: "" } };
  agreement.receipt.signature = correctionSignature(c, agreement);
  await db.query("INSERT INTO guild_web_corrections(id,tenant_id,commission_id,package_id,contract_version,previous_job_id,actor_id,agreement_digest,agreement) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [agreement.id, c.tenantId, c.id, pkg.id, pkg.contractVersion, proposal.previous.jobId, session.id, proposal.digest, agreement]);
  pkg.webCorrection = agreement; pkg.state = "awarded"; pkg.progress = null; c.approvedPlanDigest = null; c.state = "awaiting_approval";
  for (const page of c.mandates) if (page.status === "active") page.status = "draft";
  return { agreement, reason: proposal.disclosure };
}
async function validateCorrection(db: Db, c: Commission, pkg: WorkPackage, first: ProducingJob) {
  const agreement = pkg.webCorrection, sources = webSourcesFromPack(pkg.acceptancePack);
  if (!agreement) fail("WEB_CORRECTION_REQUIRED", "Review the exact correction note and original report, then approve a fresh Passport for the one included second job.");
  const proposal = agreement.proposal;
  if (proposal.version !== "guild.web-correction.v1" || proposal.digest !== webCorrectionDigest(proposal) || proposal.commissionId !== c.id || proposal.packageId !== pkg.id || proposal.contractVersion !== pkg.contractVersion
    || proposal.acceptancePackDigest !== pkg.acceptancePack.digest || proposal.sourceDigest !== digest(sources) || proposal.maximumProductionJobs !== 2 || proposal.correctionAllowance !== 1 || proposal.attempt !== 2
    || proposal.previous.jobId !== first.id || proposal.authorityCeiling !== webAuthoritySchema.parse(pkg.acceptancePack.parameters?.authority).expiresAt || digest(proposal.commercial) !== digest(webCommercialTerms(c, pkg))
    || agreement.receipt.kind !== "guild.controlled-web-correction.v1" || agreement.receipt.algorithm !== "HMAC-SHA256" || !/^[a-f0-9]{64}$/.test(agreement.receipt.signature)
    || !timingSafeEqual(Buffer.from(agreement.receipt.signature), Buffer.from(correctionSignature(c, agreement)))) fail("WEB_CORRECTION_CHANGED", "The correction differs from its exact signed scope, price, pipeline, prior result or unchanged standard.");
  const saved = (await db.query<{ agreement: WebCorrectionAgreement; agreement_digest: string }>("SELECT agreement,agreement_digest FROM guild_web_corrections WHERE id=$1 AND tenant_id=$2 AND commission_id=$3 AND package_id=$4 AND contract_version=$5 AND previous_job_id=$6 AND actor_id=$7", [agreement.id, c.tenantId, c.id, pkg.id, pkg.contractVersion, first.id, agreement.actorId])).rows[0];
  const note = (await db.query<{ event: Commission["events"][number] }>("SELECT event FROM guild_events WHERE id=$1 AND tenant_id=$2 AND commission_id=$3 AND event_hash=$4", [proposal.note.eventId, c.tenantId, c.id, proposal.note.eventHash])).rows[0]?.event;
  if (!saved || saved.agreement_digest !== proposal.digest || digest(saved.agreement) !== digest(agreement) || !note || note.packageId !== pkg.id || note.detail !== proposal.note.text || digest({ ...note, hash: undefined }) !== proposal.note.eventHash) fail("WEB_CORRECTION_CHANGED", "The original signed agreement or exact saved correction note is missing.");
  const previous = await captionApprovalAt(db, c, proposal.previousPlanDigest, new Date(agreement.agreedAt)), oldPackage = previous.command.result.commission.packages.find(item => item.id === pkg.id);
  if (previous.receipt.id !== proposal.previousApproval.id || previous.receipt.actor_id !== proposal.previousApproval.actorId || digest({ payload: previous.receipt.payload, signature: previous.receipt.signature }) !== proposal.previousApproval.receiptHash
    || !oldPackage || oldPackage.webCorrection || digest(webContractTerms(oldPackage)) !== digest(webContractTerms(pkg))) fail("WEB_CORRECTION_CHANGED", "The original correction review has no exact signed historical Passport snapshot.");
  const historical = structuredClone(pkg);
  if (proposal.previous.artifact) historical.acceptancePack = (await db.query<{ result: WorkPackage["acceptancePack"] }>("SELECT result FROM guild_verifications WHERE id=$1 AND tenant_id=$2 AND commission_id=$3", [proposal.previous.artifact.verificationId, c.tenantId, c.id])).rows[0]?.result ?? pkg.acceptancePack;
  if (digest(await originalResult(db, c, historical, first, proposal.previous)) !== digest(proposal.previous)) fail("WEB_ORIGINAL_CHANGED", "The first attempt differs from the exact retained outcome reviewed for this correction.");
  return agreement;
}
export async function webAdmission(db: Db, c: Commission, pkg: WorkPackage, runtimeAccess: WebRuntimeAccess = installedWebRuntime) {
  const sources = await validateWebContract(db, c, pkg, true, runtimeAccess), jobs = await attemptedJobs(db, c, pkg), commercial = webCommercialTerms(c, pkg);
  await assertWebOutcomesKnown(db, c, pkg);
  if (jobs.length >= 2) fail("WEB_CORRECTION_ALLOWANCE", "Both permitted producing jobs are retained. Failed and interrupted attempts also count; this award cannot dispatch another job.");
  const common = { webSourceDigest: digest(sources), inputBindings: sources.inputBindings, webProviderPolicyDigest: commercial.providerPolicyDigest, webPipelineDigest: commercial.pipelineDigest };
  if (!jobs.length) { if (pkg.webCorrection) fail("WEB_CORRECTION_CHANGED", "A correction cannot precede its original job."); return { ...common, webAttempt: 1 }; }
  const agreement = await validateCorrection(db, c, pkg, jobs[0]!);
  return { ...common, webAttempt: 2, webCorrectionId: agreement.id, webCorrectionDigest: agreement.proposal.digest };
}
export async function validateWebJob(db: Db, c: Commission, pkg: WorkPackage, job: { id: string; input: WebJobInput }, dispatch = true, runtimeAccess: WebRuntimeAccess = installedWebRuntime) {
  const sources = await validateWebContract(db, c, pkg, dispatch, runtimeAccess), jobs = await attemptedJobs(db, c, pkg), ordinal = jobs.findIndex(item => item.id === job.id) + 1, commercial = webCommercialTerms(c, pkg);
  if (!ordinal || ordinal > 2 || jobs.length > 2 || job.input.webAttempt !== ordinal || job.input.webSourceDigest !== digest(sources) || digest(job.input.inputBindings) !== digest(sources.inputBindings)
    || job.input.contractVersion !== pkg.contractVersion || job.input.webProviderPolicyDigest !== commercial.providerPolicyDigest || job.input.webPipelineDigest !== commercial.pipelineDigest) fail("WEB_JOB_BINDING", "This job differs from its exact attempt, original inputs, provider pipeline or commercial agreement.");
  if (ordinal === 1) {
    if (job.input.webCorrectionId || job.input.webCorrectionDigest || dispatch && (pkg.webCorrection || jobs.length !== 1)) fail("WEB_JOB_BINDING", "An original job cannot borrow later correction authority.");
  } else {
    const agreement = await validateCorrection(db, c, pkg, jobs[0]!);
    if (job.input.webCorrectionId !== agreement.id || job.input.webCorrectionDigest !== agreement.proposal.digest) fail("WEB_JOB_BINDING", "Only the one exact second job bound to the reviewed correction may dispatch.");
  }
  return { sources, attempt: ordinal as 1 | 2, correction: ordinal === 2 ? { id: pkg.webCorrection!.id, digest: pkg.webCorrection!.proposal.digest } : null,
    inputBindings: sources.inputBindings as ArtifactInputBinding[], commercial, pipeline: webProductionPolicies[commercial.providerId] };
}
