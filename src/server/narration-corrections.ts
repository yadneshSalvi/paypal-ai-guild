import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { AcceptancePack, ArtifactManifest, Commission, NarrationCorrectionAgreement, NarrationCorrectionEvidence, NarrationCorrectionProposal, WorkPackage } from "@/contracts/guild";
import { checkAuthority } from "@/domain/authority";
import { planDigest } from "@/domain/fixture";
import { narrationAcceptancePack, narrationArtifactSchema } from "@/domain/narration";
import { arabicCorrectionDelivery, narrationCorrectionDigest, narrationCorrectionPolicy, productionJobLimit } from "@/domain/narration-correction";
import { canonical, digest, DomainError } from "@/domain/primitives";
import { qualifiedAudioEngine } from "./media/audio-qualification";
import { resolveProductionInputs } from "./production-inputs";
import type { Session } from "./session";

type Db = Pool | PoolClient;
interface ProductionRow { id: string; state: string; input: { packageId: string; contractVersion: number; inputBindings: unknown }; output: { artifactId?: string } | null }
interface CheckRow { id: string; contract_version: number; artifact_id: string; artifact_hash: string; criteria_digest: string; result: AcceptancePack; created_at: Date }
export interface EvaluationRow { id: string; state: string; input: { artifactId: string; artifactHash: string; contractVersion: number }; output: { pack: AcceptancePack; report: { schemaVersion: string; artifactId: string; artifactHash: string; checks: { locale: string; key: string; mediaId: string; source: boolean; audio: boolean; loudness: boolean; duration: boolean; transcript: boolean; measurement: unknown }[] } } | null; created_at: Date }
function fail(code: string, message: string): never { throw new DomainError(code, message, 422, false); }

function narrationPage(c: Commission, pkg: WorkPackage) {
  return c.mandates.find(item => item.parentId && item.allowedKinds.includes(pkg.kind)) ?? c.mandates.find(item => !item.parentId);
}

/** Read-only: the proposal is stable until a bound source, note, check or term changes. */
export async function readNarrationCorrectionBasis(db: Db, c: Commission, pkg: WorkPackage) {
  if (c.mode !== "live" || pkg.kind !== "narration" || pkg.acceptancePack.version !== "2.0.0" || pkg.state !== "correction_requested" || pkg.acceptedAt || pkg.paymentState !== "not_eligible") fail("NARRATION_CORRECTION_STATE", "An additional round is available only for an unaccepted, checked narration that needs correction.");
  if (["paused", "cancelled"].includes(c.state) || !c.approvedPlanDigest || c.approvedPlanDigest !== planDigest(c)) fail("APPROVAL_REQUIRED", "Keep the current Passport active before preparing a separate correction agreement.");
  const page = narrationPage(c, pkg);
  const authority = page && checkAuthority(c.mandates, { mandateId: page.id, amountMinor: 0, kind: pkg.kind, providerId: pkg.providerId, purpose: page.purpose, now: new Date().toISOString() });
  if (!authority?.allowed) fail(authority ? authority.ruleId : "PASSPORT.NOT_FOUND", authority ? authority.reason : "The narration Passport page is unavailable.");
  const approval = (await db.query<{ id: string; actor_id: string; expires_at: Date; payload: Record<string, unknown>; signature: string }>("SELECT a.id,a.actor_id,s.expires_at,a.payload,a.signature FROM guild_approval_receipts a JOIN guild_sessions s ON s.id=a.actor_id AND s.tenant_id=a.tenant_id WHERE a.tenant_id=$1 AND a.commission_id=$2 AND a.plan_digest=$3 AND s.role IN ('judge','owner','operator') AND s.expires_at>now() AND s.revoked_at IS NULL ORDER BY a.created_at DESC LIMIT 1", [c.tenantId, c.id, c.approvedPlanDigest])).rows[0];
  const expectedApproval = approval && process.env.AUTH_SECRET ? createHmac("sha256", process.env.AUTH_SECRET).update(canonical(approval.payload)).digest("hex") : "";
  if (!approval || !expectedApproval || !/^[a-f0-9]{64}$/.test(approval.signature) || !timingSafeEqual(Buffer.from(approval.signature), Buffer.from(expectedApproval)) || approval.payload.actor !== approval.actor_id || approval.payload.commission !== c.id || approval.payload.digest !== c.approvedPlanDigest) fail("NARRATION_CORRECTION_APPROVAL", "The original contract needs its exact signed approval from an active workspace actor before a further round can be offered.");
  const provider = c.providers.find(item => item.id === pkg.providerId);
  if (!provider || provider.id !== "quill" || provider.policyDigest !== narrationCorrectionPolicy.originalPolicyDigest || pkg.providerAwardMinor < provider.priceFloorMinor || pkg.grossMinor !== pkg.providerAwardMinor + pkg.serviceFeeMinor) fail("NARRATION_CORRECTION_PROVIDER", "The controlled service offer does not match this provider's policy and exact agreed prices.");
  const active = await db.query("SELECT id FROM guild_jobs WHERE tenant_id=$1 AND commission_id=$2 AND state IN ('queued','running') LIMIT 1", [c.tenantId, c.id]);
  if (active.rowCount) fail("AMENDMENT_WORK_RUNNING", "Finish the current saved production and checks before changing the Passport.");
  const billing = await db.query("SELECT id FROM guild_payment_intents WHERE tenant_id=$1 AND commission_id=$2 LIMIT 1", [c.tenantId, c.id]);
  if (billing.rowCount) fail("AMENDMENT_BILLING_STARTED", "This additional round is available before buyer checkout. Existing financial obligations need their separate amendment review.");
  const downstream = new Set<string>([pkg.id]);
  for (let pass = 0; pass < c.packages.length; pass++) for (const candidate of c.packages) if (candidate.dependsOn.some(id => downstream.has(id))) downstream.add(candidate.id);
  downstream.delete(pkg.id);
  const dependent = await db.query("SELECT id FROM guild_jobs WHERE tenant_id=$1 AND commission_id=$2 AND type='produce_package' AND input->>'packageId'=ANY($3::text[]) LIMIT 1", [c.tenantId, c.id, [...downstream]]);
  if (dependent.rowCount || c.packages.some(item => downstream.has(item.id) && (item.artifactIds.length || item.acceptedAt))) fail("NARRATION_DEPENDENTS_STARTED", "A dependent contract already used the narration. Preserve that lineage and resolve its work before agreeing another round.");
  const inputs = await resolveProductionInputs(db, c, pkg), source = inputs.artifacts.find(item => item.packageId === pkg.dependsOn[0]);
  if (!source) fail("NARRATION_CORRECTION_SOURCE", "The exact checked source is unavailable.");
  const frozenPack = narrationAcceptancePack(source, await qualifiedAudioEngine());
  const unmeasured = { ...pkg.acceptancePack, criteria: pkg.acceptancePack.criteria.map(item => ({ ...item, status: "pending", evidence: null })) };
  if (digest(unmeasured) !== digest(frozenPack)) fail("NARRATION_CORRECTION_SOURCE", "The source, voice, engine or acceptance standard changed. This offer preserves all original measured terms.");
  const originalJobs = (await db.query<ProductionRow>("SELECT id,state,input,output FROM guild_jobs WHERE tenant_id=$1 AND commission_id=$2 AND type='produce_package' AND input->>'packageId'=$3 ORDER BY created_at,id", [c.tenantId, c.id, pkg.id])).rows;
  const currentJobs = originalJobs.filter(item => item.input.contractVersion === pkg.contractVersion);
  if (currentJobs.length < productionJobLimit(pkg)) fail("CORRECTION_ALLOWANCE_REMAINS", "Use the existing agreed correction before asking for an additional round.");
  if (originalJobs.some(item => item.state !== "completed" || !item.output?.artifactId)) fail("ORIGINAL_SPEECH_RESULT_PENDING", "Every earlier narration attempt must have a complete retained submission. An unresolved or interrupted original cannot be replaced by this agreement.");
  const unresolved = await db.query("SELECT id FROM guild_speech_runs WHERE tenant_id=$1 AND commission_id=$2 AND package_id=$3 AND state<>'completed' LIMIT 1", [c.tenantId, c.id, pkg.id]);
  if (unresolved.rowCount) fail("ORIGINAL_SPEECH_RESULT_PENDING", "An original narration stream remains incomplete. Its identity and partial bytes must be resolved without commissioning a replacement.");
  // This reader also runs inside the amendment's locked transaction. A single
  // PostgreSQL client must finish each query before it starts another one.
  const checks = await db.query<CheckRow>("SELECT id,contract_version,artifact_id,artifact_hash,criteria_digest,result,created_at FROM guild_verifications WHERE tenant_id=$1 AND commission_id=$2 AND package_id=$3 ORDER BY created_at,id", [c.tenantId, c.id, pkg.id]);
  const evaluations = await db.query<EvaluationRow>("SELECT id,state,input,output,created_at FROM guild_jobs WHERE tenant_id=$1 AND commission_id=$2 AND type='verify_artifact' AND input->>'packageId'=$3 ORDER BY created_at,id", [c.tenantId, c.id, pkg.id]);
  const artifacts = await db.query<{ id: string; content_hash: string; manifest: ArtifactManifest }>("SELECT id,content_hash,manifest FROM guild_artifacts WHERE tenant_id=$1 AND commission_id=$2 AND package_id=$3", [c.tenantId, c.id, pkg.id]);
  const history: NarrationCorrectionEvidence[] = [];
  for (const job of originalJobs) {
    const stored = artifacts.rows.find(item => item.id === job.output!.artifactId), artifact = stored?.manifest;
    if (!artifact || artifact.contentHash !== stored!.content_hash || digest(artifact.content) !== artifact.contentHash || !narrationArtifactSchema.safeParse(artifact.content).success) fail("NARRATION_CORRECTION_HISTORY", "An earlier complete narration no longer matches its immutable retained artifact.");
    const runs = checks.rows.filter(item => item.artifact_id === artifact.id && item.artifact_hash === artifact.contentHash && item.contract_version === job.input.contractVersion);
    const reports = evaluations.rows.filter(item => item.input.artifactId === artifact.id && item.input.artifactHash === artifact.contentHash && item.input.contractVersion === job.input.contractVersion && item.state === "completed" && item.output);
    if (!runs.length || !reports.length) fail("NARRATION_CORRECTION_CHECKS", "Run and finish the agreed checks on every earlier narration before extending the correction allowance.");
    history.push({ artifactId: artifact.id, artifactHash: artifact.contentHash, title: artifact.title, contractVersion: job.input.contractVersion, productionJobId: job.id, productionInputDigest: digest(job.input), verifications: runs.map(item => ({ id: item.id, criteriaDigest: item.criteria_digest, createdAt: item.created_at.toISOString() })), evaluations: reports.map(item => ({ jobId: item.id, outputDigest: digest(item.output), createdAt: item.created_at.toISOString() })) });
  }
  const latest = history.at(-1), currentArtifact = c.artifacts.find(item => item.id === pkg.artifactIds.at(-1));
  if (!latest || !currentArtifact || latest.artifactId !== currentArtifact.id || latest.contractVersion !== pkg.contractVersion || !pkg.artifactIds.every(id => history.some(item => item.artifactId === id && item.contractVersion === pkg.contractVersion))) fail("NARRATION_CORRECTION_HISTORY", "The offered submission changed. Review the current original production history.");
  const latestCheck = checks.rows.filter(item => item.artifact_id === latest.artifactId && item.contract_version === pkg.contractVersion).at(-1);
  const latestReport = evaluations.rows.filter(item => item.input.artifactId === latest.artifactId && item.input.contractVersion === pkg.contractVersion && item.state === "completed").at(-1)?.output;
  const scriptCount = (frozenPack.parameters!.scripts as unknown[]).length;
  if (!latestCheck || latestCheck.criteria_digest !== digest(pkg.acceptancePack) || digest(latestCheck.result) !== latestCheck.criteria_digest || !latestReport || digest(latestReport.pack) !== latestCheck.criteria_digest || latestReport.report.schemaVersion !== "guild.narration-verification.v2" || latestReport.report.artifactId !== latest.artifactId || latestReport.report.artifactHash !== latest.artifactHash || latestReport.report.checks.length !== scriptCount || latestReport.report.checks.some(item => !item.measurement)) fail("NARRATION_CORRECTION_CHECKS", "The complete independent file report must match the exact current narration and displayed check results.");
  const note = c.events.filter(item => item.type === "package.correction_requested" && item.packageId === pkg.id).at(-1);
  if (!note || Date.parse(note.createdAt) < Date.parse(currentArtifact.createdAt)) fail("NARRATION_CORRECTION_NOTE", "Save a correction note for the current recording and its measured failure before preparing another round.");
  const expiresAt = new Date(Math.min(...authority!.ancestorIds.map(id => Date.parse(c.mandates.find(item => item.id === id)!.expiresAt)), approval.expires_at.getTime(), Date.parse(note.createdAt) + 24 * 60 * 60 * 1000)).toISOString();
  if (Date.parse(expiresAt) <= Date.now()) fail("NARRATION_CORRECTION_OFFER_EXPIRED", "This correction offer expired. Review the current findings and save a fresh note before requesting a new offer.");
  return { approval, source, inputs, frozenPack, history, latest, latestCheck, latestReport, evaluations: evaluations.rows, scriptCount, note, expiresAt, provider };
}

/** The original Arabic-only, complete-round policy remains unchanged. */
export async function narrationCorrectionProposal(db: Db, c: Commission, pkg: WorkPackage): Promise<NarrationCorrectionProposal> {
  const { approval, source, inputs, frozenPack, history, latestCheck, latestReport, scriptCount, note, expiresAt, provider } = await readNarrationCorrectionBasis(db, c, pkg);
  const failed = latestReport.report.checks.filter(item => !item.duration);
  if (!failed.length || failed.some(item => item.locale !== "ar") || pkg.acceptancePack.criteria.some(item => item.kind === "deterministic" && item.blocking && (item.id === "duration" ? item.status !== "failed" : item.status !== "passed"))) fail("NARRATION_CORRECTION_SCOPE", "This controlled offer addresses Arabic pacing after all other deterministic checks passed. A different failure needs its own reviewed agreement.");
  const proposal: Omit<NarrationCorrectionProposal, "digest"> = {
    version: "guild.narration-correction.v1", commissionId: c.id, packageId: pkg.id, fromVersion: pkg.contractVersion, toVersion: pkg.contractVersion + 1, previousPlanDigest: c.approvedPlanDigest!, acceptancePackDigest: pkg.acceptancePack.digest,
    previousApproval: { id: approval.id, actorId: approval.actor_id, actorExpiresAt: approval.expires_at.toISOString(), receiptDigest: digest({ payload: approval.payload, signature: approval.signature }) },
    sourceArtifactId: source.id, sourceArtifactHash: source.contentHash, inputBindings: inputs.bindings,
    correction: { eventId: note.id, eventHash: note.hash, note: note.detail },
    scope: { maximumProductionJobs: 1, recordings: scriptCount, locales: [...c.languages], scriptRegisterDigest: digest(frozenPack.parameters!.scripts), arabicDelivery: arabicCorrectionDelivery },
    commercial: { providerId: "quill", providerAwardMinor: pkg.providerAwardMinor, serviceFeeMinor: pkg.serviceFeeMinor, grossMinor: pkg.grossMinor, additionalChargeMinor: 0, commissionTotalMinor: c.packages.reduce((sum, item) => sum + item.grossMinor, 0), capMinor: c.capMinor },
    providerOffer: { issuer: narrationCorrectionPolicy.issuer, policyVersion: narrationCorrectionPolicy.version, policyDigest: digest(narrationCorrectionPolicy), originalPolicyDigest: provider.policyDigest, expiresAt, disclosure: narrationCorrectionPolicy.disclosure },
    history, latestVerificationId: latestCheck.id, latestCriteriaDigest: latestCheck.criteria_digest, failedRecordingKeys: failed.map(item => `${item.locale}/${item.key}`),
  };
  return { ...proposal, digest: narrationCorrectionDigest(proposal) };
}

function receiptPayload(tenantId: string, agreement: NarrationCorrectionAgreement) {
  return { kind: agreement.providerReceipt.kind, tenantId, agreementId: agreement.id, proposalDigest: agreement.proposal.digest, agreedAt: agreement.agreedAt };
}
function receiptSignature(tenantId: string, agreement: NarrationCorrectionAgreement) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET required");
  return createHmac("sha256", secret).update(canonical(receiptPayload(tenantId, agreement))).digest("hex");
}

export async function prepareNarrationCorrection(db: PoolClient, session: Session, c: Commission, pkg: WorkPackage, expectedVersion: number, expectedDigest: string) {
  if (pkg.contractVersion !== expectedVersion) fail("NARRATION_CORRECTION_CHANGED", "This agreement belongs to an earlier contract. Review the current proposal.");
  const actor = await db.query("SELECT id FROM guild_sessions WHERE id=$1 AND tenant_id=$2 AND role IN ('judge','owner','operator') AND expires_at>now() AND revoked_at IS NULL", [session.id, session.tenantId]);
  if (!actor.rowCount) fail("NARRATION_CORRECTION_ACTOR", "An active workspace actor must agree to this correction. Session expiry and revocation remain in force.");
  const proposal = await narrationCorrectionProposal(db, c, pkg);
  if (proposal.digest !== expectedDigest) fail("NARRATION_CORRECTION_CHANGED", "The source, note, measured report, price or original work changed. Review the exact current agreement.");
  const reservation = (await db.query<{ id: string; amount_minor: string; mandate_id: string; state: string }>("SELECT id,amount_minor,mandate_id,state FROM guild_budget_reservations WHERE tenant_id=$1 AND commission_id=$2 AND operation_key=$3 FOR UPDATE", [c.tenantId, c.id, `production:${c.id}:${pkg.id}:${pkg.contractVersion}`])).rows[0];
  if (!reservation || reservation.state !== "reserved" || Number(reservation.amount_minor) !== pkg.grossMinor) fail("AMENDMENT_RESERVATION_MISMATCH", "This additional round must explicitly release the exact unaccepted original reservation. Committed or missing obligations cannot be replaced.");
  const previous = structuredClone(pkg), previousPlan = c.approvedPlanDigest;
  let page = c.mandates.find(item => item.id === reservation.mandate_id);
  if (!page) fail("AMENDMENT_RESERVATION_MISMATCH", "The original reserved authority page is unavailable.");
  const seen = new Set<string>();
  while (page) {
    if (seen.has(page.id) || page.reservedMinor < pkg.grossMinor) fail("AMENDMENT_RESERVATION_MISMATCH", "The existing reservation cannot be safely released across its original Passport pages.");
    seen.add(page.id); page.reservedMinor -= pkg.grossMinor;
    const parentId: string | null = page.parentId; page = c.mandates.find(item => item.id === parentId);
    if (parentId && !page) fail("AMENDMENT_RESERVATION_MISMATCH", "The original reservation's parent authority page is unavailable.");
  }
  await db.query("UPDATE guild_budget_reservations SET state='released' WHERE id=$1 AND tenant_id=$2 AND state='reserved'", [reservation.id, c.tenantId]);
  const agreement: NarrationCorrectionAgreement = { id: randomUUID(), proposal, agreedAt: new Date().toISOString(), providerReceipt: { kind: "guild.controlled-provider-offer-receipt.v1", algorithm: "HMAC-SHA256", signature: "" } };
  agreement.providerReceipt.signature = receiptSignature(c.tenantId, agreement);
  pkg.contractVersion = proposal.toVersion; pkg.narrationCorrection = agreement; pkg.artifactIds = []; pkg.state = "awarded"; pkg.paymentState = "not_eligible"; pkg.progress = null;
  pkg.acceptancePack = { ...pkg.acceptancePack, criteria: pkg.acceptancePack.criteria.map(item => ({ ...item, status: "pending", evidence: null })) };
  pkg.description = "One additional complete narration round under the original measured acceptance pack, exact source scripts, voice and audio treatment. Arabic delivery follows the agreed pacing correction. All prior recordings and reports retain their original contracts; human listening and source acceptance remain required.";
  c.approvedPlanDigest = null; c.state = "awaiting_approval";
  for (const mandate of c.mandates) if (mandate.status === "active") mandate.status = "draft";
  const reason = `One additional complete ${proposal.scope.recordings}-recording correction round, with unchanged acceptance pack ${proposal.acceptancePackDigest}. The controlled Quill & Echo service offers no additional charge; original work, reports and correction note are bound to agreement ${agreement.id}. The old unaccepted reservation is released; a fresh Passport must approve the successor before its same price is reserved once. No human acceptance, recording or financial action is created by this agreement.`;
  await db.query("INSERT INTO guild_contract_amendments(id,tenant_id,commission_id,package_id,from_version,to_version,previous_plan_digest,proposed_plan_digest,previous_contract,proposed_contract,actor_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)", [agreement.id, c.tenantId, c.id, pkg.id, previous.contractVersion, pkg.contractVersion, previousPlan, planDigest(c), previous, pkg, session.id, reason]);
  return { agreement, reason };
}

/** Checked again immediately before every new speech/storage side effect. */
export async function validateNarrationCorrection(db: Db, c: Commission, pkg: WorkPackage, job?: { id: string; input: { correctionAgreementId?: string; correctionAgreementDigest?: string; inputBindings?: unknown } }) {
  const agreement = pkg.narrationCorrection;
  if (!agreement) {
    if (job?.input.correctionAgreementId) fail("NARRATION_CORRECTION_BINDING", "This saved job's correction agreement is no longer attached to the current contract.");
    return;
  }
  const p = agreement.proposal, expected = receiptSignature(c.tenantId, agreement);
  if (pkg.kind !== "narration" || p.version !== "guild.narration-correction.v1" || p.digest !== narrationCorrectionDigest(p) || p.commissionId !== c.id || p.packageId !== pkg.id || p.toVersion !== pkg.contractVersion || p.acceptancePackDigest !== pkg.acceptancePack.digest || p.scope.maximumProductionJobs !== 1 || p.providerOffer.policyDigest !== digest(narrationCorrectionPolicy) || p.providerOffer.originalPolicyDigest !== c.providers.find(item => item.id === pkg.providerId)?.policyDigest || digest(p.scope.arabicDelivery) !== digest(arabicCorrectionDelivery) || p.commercial.providerId !== pkg.providerId || p.commercial.providerAwardMinor !== pkg.providerAwardMinor || p.commercial.serviceFeeMinor !== pkg.serviceFeeMinor || p.commercial.grossMinor !== pkg.grossMinor || p.commercial.additionalChargeMinor !== 0 || p.sourceArtifactId !== pkg.acceptancePack.parameters?.sourceArtifactId || p.sourceArtifactHash !== pkg.acceptancePack.parameters?.sourceArtifactHash || p.scope.scriptRegisterDigest !== digest(pkg.acceptancePack.parameters?.scripts) || !/^[a-f0-9]{64}$/.test(agreement.providerReceipt.signature) || !timingSafeEqual(Buffer.from(expected), Buffer.from(agreement.providerReceipt.signature))) fail("NARRATION_CORRECTION_BINDING", "The supplemental correction no longer matches its exact signed source, scope, provider offer and original standard.");
  if (Date.parse(p.providerOffer.expiresAt) <= Date.now()) fail("NARRATION_CORRECTION_OFFER_EXPIRED", "The agreed additional round expired before this dispatch. Its completed work remains saved; no expiry was extended.");
  const stored = (await db.query<{ proposed_contract: WorkPackage }>("SELECT proposed_contract FROM guild_contract_amendments WHERE id=$1 AND tenant_id=$2 AND commission_id=$3 AND package_id=$4 AND to_version=$5", [agreement.id, c.tenantId, c.id, pkg.id, pkg.contractVersion])).rows[0];
  if (!stored || digest(stored.proposed_contract.narrationCorrection) !== digest(agreement)) fail("NARRATION_CORRECTION_BINDING", "The original correction agreement is unavailable or differs from this authority page.");
  if (job) {
    const jobs = (await db.query<{ id: string }>("SELECT id FROM guild_jobs WHERE tenant_id=$1 AND commission_id=$2 AND type='produce_package' AND input->>'packageId'=$3 AND input->>'contractVersion'=$4", [c.tenantId, c.id, pkg.id, String(pkg.contractVersion)])).rows;
    if (job.input.correctionAgreementId !== agreement.id || job.input.correctionAgreementDigest !== p.digest || digest(job.input.inputBindings) !== digest(p.inputBindings) || jobs.length !== 1 || jobs[0]!.id !== job.id) fail("NARRATION_CORRECTION_BINDING", "Only the one original job bound to this correction agreement may dispatch. A second run needs another explicit agreement.");
  }
}
