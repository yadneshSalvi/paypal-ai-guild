import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { isolatedPostgres } from "../support/postgres";
import type { Commission } from "../../src/contracts/guild";
import { commissionCommandSchema } from "../../src/contracts/guild";
import { targetedNarrationArtifactSchema, narrationScripts } from "../../src/domain/narration";
import { targetedSpeechInstructions } from "../../src/domain/narration-targeted-correction";

const cleanup = await isolatedPostgres("guild_targeted_test"); after(cleanup);
process.env.AUTH_SECRET = randomBytes(32).toString("base64url");
process.env.JUDGE_SESSION_SECRET = randomBytes(32).toString("base64url");
for (const key of ["OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "BLOB_READ_WRITE_TOKEN", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"]) process.env[key] = "";
const { exhaustedTargetedFixture, code, approve, queue, finish, SyntheticSpeech } = await import("../support/narration-fixture");
const { getCommission, executeCommand, saveCommission } = await import("../../src/server/commissions");
const { getPool, transaction } = await import("../../src/server/db");
const { digest } = await import("../../src/domain/primitives");
const { planDigest } = await import("../../src/domain/fixture");
const { narrationCorrectionProposal } = await import("../../src/server/narration-corrections");
const { narrationTargetedCorrectionProposal, validateNarrationTargetedCorrection, authorizeTargetedSpeech, authorizeTargetedMedia } = await import("../../src/server/narration-targeted-corrections");
const { artifactEvidence } = await import("../../src/server/artifact-evidence");

test("targeted agreement retains three full originals, replaces exactly five of 78 once and independently checks 73 carried origins", async () => {
  const f = await exhaustedTargetedFixture(), before = await getCommission(f.session, f.commissionId), original = before.packages.find(item => item.id === "narration")!;
  await assert.rejects(narrationCorrectionProposal(getPool(), before, original), code("NARRATION_CORRECTION_SCOPE"));
  await assert.rejects(queue(f), code("CORRECTION_ALLOWANCE"));
  const p = await narrationTargetedCorrectionProposal(getPool(), before, original);
  assert.equal(p.history.length, 3); assert.equal(p.scope.recordings, 78); assert.equal(p.scope.replacementRecordings, 5); assert.equal(p.scope.carriedRecordings, 73);
  assert.equal(p.scope.maximumProductionJobs, 1); assert.equal(p.scope.maximumAttemptsPerRecording, 1); assert.equal(p.scope.selectionRule, "one_original_stream_per_replacement_no_candidates");
  assert.deepEqual(p.failedRecordingKeys, ["en/loc-det-4a25770", "ar/loc-det-4a12861", "ar/loc-det-4a16836", "ar/loc-det-4a20344", "ar/loc-det-4a25770"]);
  assert.deepEqual(p.scope.register.filter(item => item.cue === "duration_cue").map(item => `${item.locale}/${item.key}`), ["ar/loc-det-4a12861"]);
  assert.equal(p.commercial.grossMinor, 8700); assert.equal(p.commercial.commissionTotalMinor, 54000); assert.equal(p.commercial.capMinor, 64000); assert.equal(p.commercial.additionalChargeMinor, 0);
  assert.ok(Date.parse(p.providerOffer.expiresAt) <= Date.parse(f.session.expiresAt));
  assert.deepEqual(p.authorityCeiling, original.narrationCorrection!.proposal.previousApproval);
  await getPool().query("UPDATE guild_sessions SET expires_at=expires_at+interval '2 hours' WHERE id=$1", [f.session.id]);
  const renewed = await narrationTargetedCorrectionProposal(getPool(), before, original);
  assert.equal(renewed.providerOffer.expiresAt, p.providerOffer.expiresAt); assert.deepEqual(renewed.authorityCeiling, p.authorityCeiling);
  await getPool().query("UPDATE guild_sessions SET expires_at=$2 WHERE id=$1", [f.session.id, f.session.expiresAt]);
  const command = commissionCommandSchema.parse({ type: "agree_narration_targeted_correction", commandId: randomUUID(), expectedRevision: before.revision, packageId: original.id, contractVersion: original.contractVersion, proposalDigest: p.digest, acknowledgeExactScope: true });
  assert.equal(commissionCommandSchema.safeParse({ ...command, replacementKeys: [] }).success, false);
  const originals = (await getPool().query("SELECT id,content_hash,manifest FROM guild_artifacts WHERE tenant_id=$1 AND package_id='narration' ORDER BY id", [f.session.tenantId])).rows;
  const originalChecks = (await getPool().query("SELECT * FROM guild_verifications WHERE tenant_id=$1 AND package_id='narration' ORDER BY id", [f.session.tenantId])).rows;
  const originalStreams = (await getPool().query("SELECT id,job_id,input_hash,receipt,receipt_hash,pcm_hash,state FROM guild_speech_runs WHERE tenant_id=$1 ORDER BY id", [f.session.tenantId])).rows;
  async function mutateSnapshot(change: (c: Commission) => void, expected: string) {
    const copy = structuredClone(before); change(copy); await transaction(db => saveCommission(db, copy));
    try { await assert.rejects(executeCommand(f.session, before.id, { ...command, commandId: randomUUID() }), code(expected)); }
    finally { await transaction(db => saveCommission(db, structuredClone(before))); }
  }
  await mutateSnapshot(c => { c.mandates.find(item => item.parentId)!.status = "revoked"; c.mandates.find(item => item.id === "passport-localization")!.status = "revoked"; }, "PASSPORT.INACTIVE");
  await mutateSnapshot(c => { c.packages.find(item => item.id === original.id)!.grossMinor++; }, "NARRATION_CORRECTION_BINDING");
  await mutateSnapshot(c => { c.packages.find(item => item.id === original.id)!.acceptancePack.parameters!.sourceArtifactHash = "0".repeat(64); }, "NARRATION_CORRECTION_BINDING");
  await mutateSnapshot(c => { c.packages.find(item => item.id === original.id)!.acceptancePack.criteria[0]!.evidence = "Tampered report fixture"; }, "NARRATION_CORRECTION_CHECKS");
  const latestCheck = originalChecks.find(item => item.id === p.latestVerificationId)!;
  await getPool().query("UPDATE guild_verifications SET criteria_digest=$2 WHERE id=$1", [latestCheck.id, "0".repeat(64)]);
  await assert.rejects(executeCommand(f.session, before.id, { ...command, commandId: randomUUID() }), code("NARRATION_CORRECTION_CHECKS"));
  await getPool().query("UPDATE guild_verifications SET criteria_digest=$2 WHERE id=$1", [latestCheck.id, latestCheck.criteria_digest]);
  const carried = p.scope.register.find(item => item.action === "carry_forward")!;
  await getPool().query("UPDATE guild_media_objects SET content_hash=$2 WHERE id=$1", [carried.mediaId, "0".repeat(64)]);
  await assert.rejects(executeCommand(f.session, before.id, { ...command, commandId: randomUUID() }), code("NARRATION_TARGETED_BINDING"));
  await getPool().query("UPDATE guild_media_objects SET content_hash=$2 WHERE id=$1", [carried.mediaId, carried.mediaHash]);
  const evaluation = (await getPool().query("SELECT output FROM guild_jobs WHERE id=$1", [p.latestEvaluation.jobId])).rows[0].output;
  await getPool().query("UPDATE guild_jobs SET output=$2 WHERE id=$1", [p.latestEvaluation.jobId, { ...evaluation, report: { ...evaluation.report, changedFixtureAnnotation: true } }]);
  await assert.rejects(executeCommand(f.session, before.id, { ...command, commandId: randomUUID() }), code("NARRATION_TARGETED_CHANGED"));
  await getPool().query("UPDATE guild_jobs SET output=$2 WHERE id=$1", [p.latestEvaluation.jobId, evaluation]);
  await getPool().query("UPDATE guild_speech_runs SET state='indeterminate' WHERE id=$1", [carried.speechRunId]);
  await assert.rejects(executeCommand(f.session, before.id, { ...command, commandId: randomUUID() }), code("ORIGINAL_SPEECH_RESULT_PENDING"));
  await getPool().query("UPDATE guild_speech_runs SET state='completed' WHERE id=$1", [carried.speechRunId]);
  await getPool().query("UPDATE guild_sessions SET revoked_at=now() WHERE id=$1", [f.session.id]);
  await assert.rejects(executeCommand(f.session, before.id, { ...command, commandId: randomUUID() }), code("NARRATION_TARGETED_ACTOR"));
  await getPool().query("UPDATE guild_sessions SET revoked_at=NULL WHERE id=$1", [f.session.id]);
  const [first, replay] = await Promise.all([executeCommand(f.session, before.id, command), executeCommand(f.session, before.id, command)]);
  assert.deepEqual(first, replay); assert.ok(first.ok); assert.equal(first.jobId, null);
  let c = await getCommission(f.session, before.id), pkg = c.packages.find(item => item.id === original.id)!;
  const agreement = pkg.narrationTargetedCorrection!;
  assert.equal(pkg.contractVersion, original.contractVersion + 1); assert.equal(pkg.narrationCorrection, undefined); assert.equal(pkg.acceptancePack.digest, original.acceptancePack.digest); assert.equal(pkg.acceptancePack.correctionAllowance, 1);
  assert.deepEqual(c.artifacts, before.artifacts); assert.deepEqual(c.events.slice(0, before.events.length), before.events); assert.deepEqual(c.mandates.map(item => item.expiresAt), before.mandates.map(item => item.expiresAt));
  assert.equal(c.mandates[0]!.reservedMinor, 0); assert.equal(c.approvedPlanDigest, null);
  const amendment = (await getPool().query("SELECT previous_contract FROM guild_contract_amendments WHERE id=$1", [agreement.id])).rows[0]; assert.deepEqual(amendment.previous_contract, original);
  const evidence = await artifactEvidence(f.session, original.artifactIds[0]!); assert.equal(evidence.targetedCorrectionAgreements[0]!.id, agreement.id); assert.ok(evidence.correctionAgreements.length);
  const tampered = structuredClone(c); tampered.packages.find(item => item.id === pkg.id)!.narrationTargetedCorrection!.proposal.scope.register[0]!.action = "replace";
  assert.notEqual(planDigest(tampered), planDigest(c)); await assert.rejects(validateNarrationTargetedCorrection(getPool(), tampered, tampered.packages.find(item => item.id === pkg.id)!), code("NARRATION_TARGETED_BINDING"));
  const now = Date.now; Date.now = () => Date.parse(p.providerOffer.expiresAt) + 1;
  try { await assert.rejects(validateNarrationTargetedCorrection(getPool(), c, pkg), code("NARRATION_TARGETED_EXPIRED")); } finally { Date.now = now; }
  await assert.rejects(queue(f), code("APPROVAL_REQUIRED"));
  await approve(f); const jobId = await queue(f), speech = new SyntheticSpeech(), dependencies = { speech, media: f.media, transcription: f.transcription };
  const jobInput = (await getPool().query("SELECT input FROM guild_jobs WHERE id=$1", [jobId])).rows[0].input;
  assert.equal(jobInput.targetedAgreementId, agreement.id); assert.equal(jobInput.targetedAgreementDigest, p.digest);
  await assert.rejects(validateNarrationTargetedCorrection(getPool(), c, pkg, { id: randomUUID(), input: jobInput }), code("NARRATION_TARGETED_BINDING"));
  assert.throws(() => authorizeTargetedSpeech(pkg, `narration:${carried.locale}:${carried.key}`, { model: "gpt-realtime-2.1", voice: "marin", locale: carried.locale, text: "unauthorized replacement", instructions: "" }), code("NARRATION_TARGETED_RECORDING_SCOPE"));
  assert.throws(() => authorizeTargetedMedia(pkg, `narration:${carried.locale}:${carried.key}:mp3`), code("NARRATION_TARGETED_RECORDING_SCOPE"));
  const putsBefore = f.media.puts;
  assert.equal((await finish(f, jobId, dependencies))?.state, "completed"); assert.equal(speech.calls, 5); assert.equal(f.media.puts - putsBefore, 5);
  for (const [index, request] of speech.inputs.entries()) { const entry = p.scope.register.filter(item => item.action === "replace")[index]!; const script = narrationScripts(f.source).find(item => item.locale === entry.locale && item.key === entry.key)!; assert.equal(request.text, script.text); assert.equal(request.instructions, targetedSpeechInstructions(script)); }
  c = await getCommission(f.session, c.id); pkg = c.packages.find(item => item.id === original.id)!;
  const artifact = c.artifacts.find(item => item.id === pkg.artifactIds[0])!, content = targetedNarrationArtifactSchema.parse(artifact.content);
  assert.equal(content.lineage.filter(item => item.mode === "replacement").length, 5); assert.equal(content.lineage.filter(item => item.mode === "carried").length, 73);
  for (const origin of content.lineage) { const entry = p.scope.register.find(item => item.locale === origin.locale && item.key === origin.key)!; const segment = content.segments.find(item => item.locale === origin.locale && item.key === origin.key)!; assert.equal(origin.productionJobId, origin.mode === "carried" ? entry.productionJobId : jobId); assert.equal(origin.contractVersion, origin.mode === "carried" ? original.contractVersion : pkg.contractVersion); if (origin.mode === "carried") { assert.equal(digest(segment), entry.segmentHash); assert.equal(segment.audio.mediaId, entry.mediaId); } }
  const readsBefore = f.media.reads, checking = await queue(f, "verify_artifact");
  assert.equal((await finish(f, checking, dependencies))?.state, "completed"); assert.equal(f.media.reads - readsBefore, 78);
  const report = (await getPool().query("SELECT output FROM guild_jobs WHERE id=$1", [checking])).rows[0].output;
  assert.equal(report.report.schemaVersion, "guild.narration-verification.v3"); assert.equal(report.report.checks.length, 78); assert.equal(report.report.mixedLineage.verified, true);
  c = await getCommission(f.session, c.id); pkg = c.packages.find(item => item.id === original.id)!;
  assert.ok(pkg.acceptancePack.criteria.filter(item => item.kind === "deterministic").every(item => item.status === "passed"), JSON.stringify(pkg.acceptancePack.criteria));
  assert.equal(pkg.acceptedAt, null); assert.equal(pkg.paymentState, "not_eligible"); assert.equal(c.payments.capturedMinor, 0); assert.equal(c.payments.providerPaidMinor, 0);
  await assert.rejects(queue(f), code("CORRECTION_ALLOWANCE"));
  assert.deepEqual((await getPool().query("SELECT id,content_hash,manifest FROM guild_artifacts WHERE id=ANY($1::uuid[]) ORDER BY id", [originals.map(item => item.id)])).rows, originals);
  assert.deepEqual((await getPool().query("SELECT * FROM guild_verifications WHERE id=ANY($1::uuid[]) ORDER BY id", [originalChecks.map(item => item.id)])).rows, originalChecks);
  assert.deepEqual((await getPool().query("SELECT id,job_id,input_hash,receipt,receipt_hash,pcm_hash,state FROM guild_speech_runs WHERE id=ANY($1::uuid[]) ORDER BY id", [originalStreams.map(item => item.id)])).rows, originalStreams);
  assert.equal((await getPool().query("SELECT count(*)::int n FROM guild_jobs WHERE tenant_id=$1 AND type='produce_package' AND input->>'contractVersion'=$2", [f.session.tenantId, String(pkg.contractVersion)])).rows[0].n, 1);
  assert.deepEqual((await getPool().query("SELECT state,amount_minor FROM guild_budget_reservations WHERE tenant_id=$1 AND operation_key LIKE $2 ORDER BY created_at", [f.session.tenantId, `production:${c.id}:narration:%`])).rows.map(item => [item.state, Number(item.amount_minor)]), [["released", 8700], ["released", 8700], ["reserved", 8700]]);
  // Explicitly forged fixture: even a changed manifest/hash cannot claim that
  // the old 73 were produced by the new job. No genuine evidence is edited.
  const forged = structuredClone(artifact), forgedContent = targetedNarrationArtifactSchema.parse(forged.content);
  forgedContent.lineage.find(item => item.mode === "carried")!.productionJobId = jobId;
  forged.content = forgedContent; forged.contentHash = digest(forgedContent);
  c.artifacts[c.artifacts.findIndex(item => item.id === artifact.id)] = forged;
  await transaction(async db => { await db.query("UPDATE guild_artifacts SET manifest=$2,content_hash=$3 WHERE id=$1 AND tenant_id=$4", [forged.id, forged, forged.contentHash, f.session.tenantId]); await saveCommission(db, c); });
  const forgedCheck = await queue(f, "verify_artifact"); assert.equal((await finish(f, forgedCheck, dependencies))?.state, "completed");
  const refused = (await getPool().query("SELECT output FROM guild_jobs WHERE id=$1", [forgedCheck])).rows[0].output;
  assert.equal(refused.report.mixedLineage.verified, false); assert.equal(refused.pack.criteria.find((item: { id: string }) => item.id === "source").status, "failed");
  const failed = await getCommission(f.session, c.id), failedPackage = failed.packages.find(item => item.id === pkg.id)!;
  await assert.rejects(narrationTargetedCorrectionProposal(getPool(), failed, failedPackage), code("NARRATION_TARGETED_REVIEW_REQUIRED"));
  await assert.rejects(queue(f), code("CORRECTION_ALLOWANCE")); assert.equal(speech.calls, 5);
});

test("a failed targeted stream retains its original bytes, blocks replay and never uses another production identity", async () => {
  const f = await exhaustedTargetedFixture(1), c = await getCommission(f.session, f.commissionId), pkg = c.packages.find(item => item.id === "narration")!;
  const p = await narrationTargetedCorrectionProposal(getPool(), c, pkg);
  await executeCommand(f.session, c.id, { type: "agree_narration_targeted_correction", commandId: randomUUID(), expectedRevision: c.revision, packageId: pkg.id, contractVersion: pkg.contractVersion, proposalDigest: p.digest, acknowledgeExactScope: true });
  await approve(f); const jobId = await queue(f), speech = new SyntheticSpeech("lost_second"), dependencies = { speech, media: f.media, transcription: f.transcription };
  assert.equal((await finish(f, jobId, dependencies))?.state, "needs_review"); assert.equal(speech.calls, 2);
  const stream = (await getPool().query("SELECT id,state,provider_response_id FROM guild_speech_runs WHERE job_id=$1 AND state='indeterminate'", [jobId])).rows[0]; assert.equal(stream.state, "indeterminate"); assert.ok(stream.provider_response_id);
  await assert.rejects(queue(f), code("ORIGINAL_SPEECH_RESULT_PENDING"));
  await getPool().query("UPDATE guild_jobs SET state='queued',available_at=now() WHERE id=$1", [jobId]); await finish(f, jobId, dependencies); assert.equal(speech.calls, 2);
  assert.equal((await getPool().query("SELECT count(*)::int n FROM guild_production_parts WHERE job_id=$1", [jobId])).rows[0].n, 1);
  const current = await getCommission(f.session, c.id); assert.deepEqual(current.packages.find(item => item.id === pkg.id)!.artifactIds, []); assert.equal(current.payments.capturedMinor, 0);
});

test("revoking the original approval actor after connection prevents targeted response dispatch", async () => {
  const f = await exhaustedTargetedFixture(1), c = await getCommission(f.session, f.commissionId), pkg = c.packages.find(item => item.id === "narration")!;
  const p = await narrationTargetedCorrectionProposal(getPool(), c, pkg);
  await executeCommand(f.session, c.id, { type: "agree_narration_targeted_correction", commandId: randomUUID(), expectedRevision: c.revision, packageId: pkg.id, contractVersion: pkg.contractVersion, proposalDigest: p.digest, acknowledgeExactScope: true });
  await approve(f); const jobId = await queue(f);
  const speech = new SyntheticSpeech("ok", async () => { await getPool().query("UPDATE guild_sessions SET revoked_at=now() WHERE id=$1", [f.session.id]); });
  assert.equal((await finish(f, jobId, { speech, media: f.media }))?.state, "needs_review");
  assert.equal(speech.calls, 1); assert.equal(speech.responses, 0);
  const stream = (await getPool().query("SELECT dispatched_at,provider_response_id FROM guild_speech_runs WHERE job_id=$1", [jobId])).rows[0];
  assert.equal(stream.dispatched_at, null); assert.equal(stream.provider_response_id, null);
  const current = await getCommission(f.session, c.id); assert.deepEqual(current.packages.find(item => item.id === pkg.id)!.artifactIds, []); assert.equal(current.payments.capturedMinor, 0);
});
