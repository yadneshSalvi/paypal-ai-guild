import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import type { Commission, NarrationFollowupCorrectionProposal } from "../../src/contracts/guild";
import { commissionCommandSchema } from "../../src/contracts/guild";
import { followupNarrationArtifactSchema, targetedNarrationArtifactSchema, narrationScripts } from "../../src/domain/narration";
import { followupSpeechInstructions } from "../../src/domain/narration-followup-correction";
import { isolatedPostgres } from "../support/postgres";
import type { StoredBlob } from "../../src/server/media/blob-store";

const cleanup = await isolatedPostgres("guild_followup_test"); after(cleanup);
process.env.AUTH_SECRET = randomBytes(32).toString("base64url");
process.env.JUDGE_SESSION_SECRET = randomBytes(32).toString("base64url");
for (const key of ["OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "BLOB_READ_WRITE_TOKEN", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"]) process.env[key] = "";
const { exhaustedFollowupFixture, code, approve, queue, finish, SyntheticSpeech } = await import("../support/narration-fixture");
const { getCommission, executeCommand, saveCommission } = await import("../../src/server/commissions");
const { getPool, transaction } = await import("../../src/server/db");
const { digest } = await import("../../src/domain/primitives");
const { planDigest } = await import("../../src/domain/fixture");
const { narrationTargetedCorrectionProposal } = await import("../../src/server/narration-targeted-corrections");
const { narrationFollowupCorrectionProposal, validateNarrationFollowupCorrection, authorizeFollowupSpeech, authorizeFollowupMedia } = await import("../../src/server/narration-followup-corrections");
const { artifactEvidence } = await import("../../src/server/artifact-evidence");
type Fixture = Awaited<ReturnType<typeof exhaustedFollowupFixture>>;
const fixtureTables = ["guild_tenants", "guild_sessions", "guild_commissions", "guild_artifacts", "guild_events", "guild_jobs", "guild_commands", "guild_approval_receipts", "guild_verifications", "guild_budget_reservations", "guild_contract_amendments", "guild_artifact_reviews", "guild_media_objects", "guild_speech_runs", "guild_speech_chunks", "guild_transcription_runs", "guild_production_parts"];
let baseline: { fixture: Fixture; rows: Record<string, Record<string, unknown>[]>; media: [string, StoredBlob][] } | undefined;
async function retainBaseline(f: Fixture) {
  const rows: Record<string, Record<string, unknown>[]> = {};
  for (const table of fixtureTables) {
    rows[table] = (await getPool().query(`SELECT * FROM ${table} WHERE ${table === "guild_tenants" ? "id" : "tenant_id"}=$1`, [f.session.tenantId])).rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Buffer.isBuffer(value) ? `\\x${value.toString("hex")}` : value])));
  }
  baseline = { fixture: f, rows, media: [...f.media.files].map(([key, value]) => [key, { ...value, bytes: Buffer.from(value.bytes) }]) };
  if (process.env.GUILD_FOLLOWUP_FIXTURE_EXPORT) await writeFile(process.env.GUILD_FOLLOWUP_FIXTURE_EXPORT, gzipSync(JSON.stringify({ provenance: "Synthetic disposable follow-up fixture; no commissioned speech, original approvals or financial results", session: f.session, commissionId: f.commissionId, authSecret: process.env.AUTH_SECRET, sessionSecret: process.env.JUDGE_SESSION_SECRET, rows, media: [...f.media.files.values()].map(item => ({ ...item, bytes: item.bytes.toString("base64") })) })), { mode: 0o600 });
}
async function restoredFixture(): Promise<Fixture> {
  if (!baseline) { const f = await exhaustedFollowupFixture(); await retainBaseline(f); return f; }
  // Test-only reset inside this file's disposable schema. No retained QA or
  // original workspace is addressed, and every test keeps its own result.
  await transaction(async db => {
    const schema = (await db.query<{ schema: string }>("SELECT current_schema() AS schema")).rows[0]!.schema;
    assert.match(schema, /^guild_followup_test_[a-f0-9]+$/);
    await db.query("TRUNCATE guild_tenants CASCADE");
    for (const table of fixtureTables) await db.query(`INSERT INTO ${table} SELECT * FROM json_populate_recordset(NULL::${table},$1::json)`, [JSON.stringify(baseline!.rows[table])]);
  });
  const f = baseline.fixture;
  f.media.files = new Map(baseline.media.map(([key, value]) => [key, { ...value, bytes: Buffer.from(value.bytes) }]));
  return f;
}
function agreementCommand(c: Commission, p: NarrationFollowupCorrectionProposal) {
  const command = commissionCommandSchema.parse({ type: "agree_narration_followup_correction", commandId: randomUUID(), expectedRevision: c.revision, packageId: p.packageId, contractVersion: p.fromVersion, proposalDigest: p.digest, acknowledgeOneRecording: true });
  assert.equal(command.type, "agree_narration_followup_correction");
  return command as Extract<typeof command, { type: "agree_narration_followup_correction" }>;
}
async function prepare(f: Fixture) {
  const c = await getCommission(f.session, f.commissionId), pkg = c.packages.find(item => item.id === "narration")!;
  const p = await narrationFollowupCorrectionProposal(getPool(), c, pkg);
  assert.ok((await executeCommand(f.session, c.id, agreementCommand(c, p))).ok);
  await approve(f);
  return p;
}

test("follow-up keeps all old signatures, traces 73 full plus four targeted origins and permits one new stream with 78 independent rereads", async () => {
  const f = await exhaustedFollowupFixture(false);
  let before = await getCommission(f.session, f.commissionId), original = before.packages.find(item => item.id === "narration")!;
  await assert.rejects(narrationFollowupCorrectionProposal(getPool(), before, original), code("NARRATION_FOLLOWUP_NOTE"));
  await executeCommand(f.session, before.id, { type: "request_correction", commandId: randomUUID(), expectedRevision: before.revision, packageId: original.id, reason: "Synthetic measured follow-up: ar/loc-det-4a12861 alone still fails duration. Keep 77 passing recordings and their transitive original producing identities. Review one new exact pacing cue and one original stream at the unchanged standard, prices and original expiry. Earlier failed audio and signatures stay immutable." });
  before = await getCommission(f.session, before.id); original = before.packages.find(item => item.id === "narration")!;
  await retainBaseline(f);
  await assert.rejects(narrationTargetedCorrectionProposal(getPool(), before, original), code("NARRATION_TARGETED_REVIEW_REQUIRED"));
  await assert.rejects(queue(f), code("CORRECTION_ALLOWANCE"));
  const p = await narrationFollowupCorrectionProposal(getPool(), before, original);
  assert.equal(p.baseRevision, before.revision); assert.equal(p.history.length, 4);
  assert.equal(p.scope.recordings, 78); assert.equal(p.scope.replacementRecordings, 1); assert.equal(p.scope.carriedRecordings, 77);
  assert.deepEqual(p.failedRecordingKeys, ["ar/loc-det-4a12861"]);
  assert.equal(p.scope.register.filter(item => item.originPath.length === 2).length, 73);
  assert.equal(p.scope.register.filter(item => item.action === "carry_forward" && item.productionJobId === f.targetedJobId).length, 4);
  assert.equal(p.scope.register.filter(item => item.action === "carry_forward" && item.productionJobId !== f.targetedJobId).length, 73);
  assert.equal(p.commercial.grossMinor, 8700); assert.equal(p.commercial.commissionTotalMinor, 54000); assert.equal(p.commercial.capMinor, 64000);
  assert.deepEqual(p.authorityCeiling, original.narrationTargetedCorrection!.proposal.authorityCeiling);
  assert.equal(p.providerOffer.expiresAt, original.narrationTargetedCorrection!.proposal.providerOffer.expiresAt);
  const script = narrationScripts(f.source).find(item => `${item.locale}/${item.key}` === p.failedRecordingKeys[0])!;
  assert.equal(p.scope.replacementCue.instructions, followupSpeechInstructions(script));
  assert.equal(p.scope.replacementCue.hash, digest(p.scope.replacementCue.instructions));
  const command = agreementCommand(before, p);
  assert.equal(commissionCommandSchema.safeParse({ ...command, replacementKeys: ["ar/another-key"] }).success, false);
  const oldArtifacts = (await getPool().query("SELECT id,content_hash,manifest FROM guild_artifacts WHERE tenant_id=$1 ORDER BY id", [f.session.tenantId])).rows;
  const oldChecks = (await getPool().query("SELECT * FROM guild_verifications WHERE tenant_id=$1 ORDER BY id", [f.session.tenantId])).rows;
  const oldReceipts = (await getPool().query("SELECT * FROM guild_approval_receipts WHERE tenant_id=$1 ORDER BY id", [f.session.tenantId])).rows;
  const oldAmendments = (await getPool().query("SELECT * FROM guild_contract_amendments WHERE tenant_id=$1 ORDER BY id", [f.session.tenantId])).rows;
  const oldSpeech = (await getPool().query("SELECT id,job_id,request,input_hash,receipt,receipt_hash,pcm_hash,state FROM guild_speech_runs WHERE tenant_id=$1 ORDER BY id", [f.session.tenantId])).rows;
  const stale = await executeCommand(f.session, before.id, { ...command, commandId: randomUUID(), expectedRevision: before.revision - 1 });
  assert.equal(stale.ok, false); if (!stale.ok) assert.equal(stale.code, "REVISION_CONFLICT");
  await assert.rejects(executeCommand(f.session, before.id, { ...command, commandId: randomUUID(), proposalDigest: "0".repeat(64) }), code("NARRATION_FOLLOWUP_CHANGED"));

  async function mutateSnapshot(change: (c: Commission) => void, expected: string) {
    const copy = structuredClone(before); change(copy); await transaction(db => saveCommission(db, copy));
    try { await assert.rejects(executeCommand(f.session, before.id, { ...command, commandId: randomUUID() }), code(expected)); }
    finally { await transaction(db => saveCommission(db, structuredClone(before))); }
  }
  await mutateSnapshot(c => { c.mandates.find(item => item.id === "passport-localization")!.status = "revoked"; }, "PASSPORT.INACTIVE");
  await mutateSnapshot(c => { c.packages.find(item => item.id === original.id)!.grossMinor++; }, "APPROVAL_REQUIRED");
  await mutateSnapshot(c => { c.events.at(-1)!.detail += " A changed note."; }, "NARRATION_FOLLOWUP_BINDING");
  await getPool().query("UPDATE guild_sessions SET expires_at=expires_at+interval '2 hours' WHERE id=$1", [f.session.id]);
  const renewed = await narrationFollowupCorrectionProposal(getPool(), before, original);
  assert.equal(renewed.providerOffer.expiresAt, p.providerOffer.expiresAt); assert.deepEqual(renewed.authorityCeiling, p.authorityCeiling);
  await getPool().query("UPDATE guild_sessions SET expires_at=$2 WHERE id=$1", [f.session.id, f.session.expiresAt]);
  const targetedOrigin = p.scope.register.find(item => item.action === "carry_forward" && item.productionJobId === f.targetedJobId)!;
  const fullOrigin = p.scope.register.find(item => item.originPath.length === 2)!;
  const originalInput = (await getPool().query("SELECT input_hash FROM guild_speech_runs WHERE id=$1", [targetedOrigin.speechRunId])).rows[0].input_hash;
  await getPool().query("UPDATE guild_speech_runs SET input_hash=$2 WHERE id=$1", [targetedOrigin.speechRunId, "0".repeat(64)]);
  await assert.rejects(executeCommand(f.session, before.id, { ...command, commandId: randomUUID() }), code("NARRATION_FOLLOWUP_BINDING"));
  await getPool().query("UPDATE guild_speech_runs SET input_hash=$2 WHERE id=$1", [targetedOrigin.speechRunId, originalInput]);
  const fullAgreement = oldAmendments.find(item => item.proposed_contract.narrationCorrection);
  const forgedContract = structuredClone(fullAgreement.proposed_contract); forgedContract.narrationCorrection.providerReceipt.signature = "0".repeat(64);
  await getPool().query("UPDATE guild_contract_amendments SET proposed_contract=$2 WHERE id=$1", [fullAgreement.id, forgedContract]);
  await assert.rejects(executeCommand(f.session, before.id, { ...command, commandId: randomUUID() }), code("NARRATION_FOLLOWUP_BINDING"));
  await getPool().query("UPDATE guild_contract_amendments SET proposed_contract=$2 WHERE id=$1", [fullAgreement.id, fullAgreement.proposed_contract]);
  const chunk = (await getPool().query("SELECT sequence,bytes FROM guild_speech_chunks WHERE run_id=$1 ORDER BY sequence LIMIT 1", [targetedOrigin.speechRunId])).rows[0];
  const corrupt = Buffer.from(chunk.bytes); corrupt[0] = corrupt[0]! ^ 1;
  await getPool().query("UPDATE guild_speech_chunks SET bytes=$3 WHERE run_id=$1 AND sequence=$2", [targetedOrigin.speechRunId, chunk.sequence, corrupt]);
  await assert.rejects(executeCommand(f.session, before.id, { ...command, commandId: randomUUID() }), code("NARRATION_FOLLOWUP_BINDING"));
  await getPool().query("UPDATE guild_speech_chunks SET bytes=$3 WHERE run_id=$1 AND sequence=$2", [targetedOrigin.speechRunId, chunk.sequence, chunk.bytes]);
  const latestReport = (await getPool().query("SELECT output FROM guild_jobs WHERE id=$1", [p.latestEvaluation.jobId])).rows[0].output;
  await getPool().query("UPDATE guild_jobs SET output=$2 WHERE id=$1", [p.latestEvaluation.jobId, { ...latestReport, report: { ...latestReport.report, fixtureAnnotation: "new report identity" } }]);
  await assert.rejects(executeCommand(f.session, before.id, { ...command, commandId: randomUUID() }), code("NARRATION_FOLLOWUP_CHANGED"));
  await getPool().query("UPDATE guild_jobs SET output=$2 WHERE id=$1", [p.latestEvaluation.jobId, latestReport]);
  await getPool().query("UPDATE guild_speech_runs SET state='indeterminate' WHERE id=$1", [targetedOrigin.speechRunId]);
  await assert.rejects(executeCommand(f.session, before.id, { ...command, commandId: randomUUID() }), code("ORIGINAL_SPEECH_RESULT_PENDING"));
  await getPool().query("UPDATE guild_speech_runs SET state='completed' WHERE id=$1", [targetedOrigin.speechRunId]);
  const [first, replay] = await Promise.all([executeCommand(f.session, before.id, command), executeCommand(f.session, before.id, command)]);
  assert.deepEqual(first, replay); assert.equal(first.ok, true); assert.equal(first.jobId, null);
  let c = await getCommission(f.session, before.id), pkg = c.packages.find(item => item.id === original.id)!;
  const agreement = pkg.narrationFollowupCorrection!;
  assert.equal(pkg.narrationTargetedCorrection, undefined); assert.equal(pkg.narrationCorrection, undefined); assert.equal(pkg.acceptancePack.digest, original.acceptancePack.digest);
  assert.equal(c.mandates[0]!.reservedMinor, 0); assert.equal(c.approvedPlanDigest, null);
  assert.deepEqual(c.mandates.map(item => item.expiresAt), before.mandates.map(item => item.expiresAt));
  const evidence = await artifactEvidence(f.session, p.reference.artifactId);
  assert.equal(evidence.followupCorrectionAgreements[0]!.id, agreement.id); assert.ok(evidence.targetedCorrectionAgreements.length); assert.ok(evidence.correctionAgreements.length);
  const forged = structuredClone(c); forged.packages.find(item => item.id === pkg.id)!.narrationFollowupCorrection!.proposal.scope.register.find(item => item.locale === fullOrigin.locale && item.key === fullOrigin.key)!.productionJobId = f.targetedJobId;
  assert.notEqual(planDigest(forged), planDigest(c));
  await assert.rejects(validateNarrationFollowupCorrection(getPool(), forged, forged.packages.find(item => item.id === pkg.id)!), code("NARRATION_FOLLOWUP_BINDING"));
  const now = Date.now; Date.now = () => Date.parse(p.providerOffer.expiresAt) + 1;
  try { await assert.rejects(validateNarrationFollowupCorrection(getPool(), c, pkg), code("NARRATION_FOLLOWUP_EXPIRED")); } finally { Date.now = now; }
  await assert.rejects(queue(f), code("APPROVAL_REQUIRED"));
  const expectedSpeech = { model: "gpt-realtime-2.1", voice: "marin", locale: "ar", text: script.text, instructions: p.scope.replacementCue.instructions };
  assert.throws(() => authorizeFollowupSpeech(pkg, `narration:${fullOrigin.locale}:${fullOrigin.key}`, expectedSpeech), code("NARRATION_FOLLOWUP_RECORDING_SCOPE"));
  assert.throws(() => authorizeFollowupSpeech(pkg, "narration:ar:loc-det-4a12861", { ...expectedSpeech, instructions: "read it again" }), code("NARRATION_FOLLOWUP_RECORDING_SCOPE"));
  assert.throws(() => authorizeFollowupMedia(pkg, `narration:${targetedOrigin.locale}:${targetedOrigin.key}:mp3`), code("NARRATION_FOLLOWUP_RECORDING_SCOPE"));
  await approve(f); const jobId = await queue(f), speech = new SyntheticSpeech(), dependencies = { speech, media: f.media, transcription: f.transcription };
  const jobInput = (await getPool().query("SELECT input FROM guild_jobs WHERE id=$1", [jobId])).rows[0].input;
  assert.equal(jobInput.followupAgreementId, agreement.id); assert.equal(jobInput.followupAgreementDigest, p.digest);
  await assert.rejects(validateNarrationFollowupCorrection(getPool(), c, pkg, { id: randomUUID(), input: jobInput }), code("NARRATION_FOLLOWUP_BINDING"));
  const putsBefore = f.media.puts;
  assert.equal((await finish(f, jobId, dependencies))?.state, "completed");
  assert.equal(speech.calls, 1); assert.equal(speech.responses, 1); assert.equal(f.media.puts - putsBefore, 1); assert.equal(speech.inputs[0]!.instructions, p.scope.replacementCue.instructions); assert.equal(speech.inputs[0]!.text, script.text);
  c = await getCommission(f.session, c.id); pkg = c.packages.find(item => item.id === pkg.id)!;
  const artifact = c.artifacts.find(item => item.id === pkg.artifactIds[0])!, content = followupNarrationArtifactSchema.parse(artifact.content);
  const reference = targetedNarrationArtifactSchema.parse(before.artifacts.find(item => item.id === p.reference.artifactId)!.content);
  assert.equal(content.lineage.filter(item => item.mode === "replacement").length, 1);
  for (const entry of p.scope.register.filter(item => item.action === "carry_forward")) {
    const item = content.segments.find(item => item.locale === entry.locale && item.key === entry.key)!, origin = content.lineage.find(item => item.locale === entry.locale && item.key === entry.key)!;
    assert.deepEqual(item, reference.segments.find(item => item.locale === entry.locale && item.key === entry.key));
    assert.equal(digest(item), entry.segmentHash); assert.equal(origin.productionJobId, entry.productionJobId); assert.equal(origin.originalArtifactId, entry.artifactId); assert.equal(origin.originalArtifactHash, entry.artifactHash); assert.equal(origin.contractVersion, entry.contractVersion);
  }
  const readsBefore = f.media.reads, verification = await queue(f, "verify_artifact");
  assert.equal((await finish(f, verification, dependencies))?.state, "completed"); assert.equal(f.media.reads - readsBefore, 78);
  const report = (await getPool().query("SELECT output FROM guild_jobs WHERE id=$1", [verification])).rows[0].output;
  assert.equal(report.report.schemaVersion, "guild.narration-verification.v4"); assert.equal(report.report.mixedLineage.verified, true); assert.equal(report.report.checks.length, 78);
  c = await getCommission(f.session, c.id); pkg = c.packages.find(item => item.id === pkg.id)!;
  assert.ok(pkg.acceptancePack.criteria.filter(item => item.kind === "deterministic").every(item => item.status === "passed"));
  assert.equal(pkg.acceptedAt, null); assert.equal(pkg.paymentState, "not_eligible"); assert.equal(c.payments.capturedMinor, 0); assert.equal(c.payments.providerPaidMinor, 0);
  await assert.rejects(queue(f), code("CORRECTION_ALLOWANCE"));
  await assert.rejects(narrationFollowupCorrectionProposal(getPool(), c, pkg), code("NARRATION_FOLLOWUP_REVIEW_REQUIRED"));
  for (const [table, rows, columns] of [["guild_artifacts", oldArtifacts, "id,content_hash,manifest"], ["guild_verifications", oldChecks, "*"], ["guild_approval_receipts", oldReceipts, "*"], ["guild_contract_amendments", oldAmendments, "*"], ["guild_speech_runs", oldSpeech, "id,job_id,request,input_hash,receipt,receipt_hash,pcm_hash,state"]] as const) {
    assert.deepEqual((await getPool().query(`SELECT ${columns} FROM ${table} WHERE id=ANY($1::uuid[]) ORDER BY id`, [rows.map(item => item.id)])).rows, rows);
  }
  assert.equal((await getPool().query("SELECT count(*)::int n FROM guild_jobs WHERE tenant_id=$1 AND type='produce_package' AND input->>'contractVersion'=$2", [f.session.tenantId, String(pkg.contractVersion)])).rows[0].n, 1);
  assert.deepEqual((await getPool().query("SELECT state,amount_minor FROM guild_budget_reservations WHERE tenant_id=$1 AND operation_key LIKE $2 ORDER BY created_at", [f.session.tenantId, `production:${c.id}:narration:%`])).rows.map(item => [item.state, Number(item.amount_minor)]), [["released", 8700], ["released", 8700], ["released", 8700], ["reserved", 8700]]);
});

test("an uncertain follow-up retains its only stream and partial bytes; recovery cannot regenerate", async () => {
  const f = await restoredFixture(); await prepare(f);
  const jobId = await queue(f), speech = new SyntheticSpeech("lost"), dependencies = { speech, media: f.media, transcription: f.transcription };
  const putsBefore = f.media.puts;
  assert.equal((await finish(f, jobId, dependencies))?.state, "needs_review"); assert.equal(speech.calls, 1); assert.equal(f.media.puts, putsBefore);
  const original = (await getPool().query("SELECT id,state,provider_response_id FROM guild_speech_runs WHERE job_id=$1", [jobId])).rows[0];
  assert.equal(original.state, "indeterminate"); assert.ok(original.provider_response_id);
  assert.ok((await getPool().query("SELECT count(*)::int n FROM guild_speech_chunks WHERE run_id=$1", [original.id])).rows[0].n > 0);
  await assert.rejects(queue(f), code("ORIGINAL_SPEECH_RESULT_PENDING"));
  await getPool().query("UPDATE guild_jobs SET state='queued',available_at=now() WHERE id=$1", [jobId]);
  assert.equal((await finish(f, jobId, dependencies))?.state, "needs_review"); assert.equal(speech.calls, 1);
  assert.equal((await getPool().query("SELECT count(*)::int n FROM guild_speech_runs WHERE job_id=$1", [jobId])).rows[0].n, 1);
  const c = await getCommission(f.session, f.commissionId);
  assert.deepEqual(c.packages.find(item => item.id === "narration")!.artifactIds, []); assert.equal(c.payments.capturedMinor, 0);
});

test("revocation after connection blocks the follow-up's single response before dispatch", async () => {
  const f = await restoredFixture(); await prepare(f);
  const jobId = await queue(f), speech = new SyntheticSpeech("ok", async () => { await getPool().query("UPDATE guild_sessions SET revoked_at=now() WHERE id=$1", [f.session.id]); });
  assert.equal((await finish(f, jobId, { speech, media: f.media }))?.state, "needs_review");
  assert.equal(speech.calls, 1); assert.equal(speech.responses, 0);
  const stream = (await getPool().query("SELECT dispatched_at,provider_response_id FROM guild_speech_runs WHERE job_id=$1", [jobId])).rows[0];
  assert.equal(stream.dispatched_at, null); assert.equal(stream.provider_response_id, null);
});

test("expiry after connection blocks dispatch even when the workspace session was renewed", async () => {
  const f = await restoredFixture(), p = await prepare(f);
  await getPool().query("UPDATE guild_sessions SET expires_at=expires_at+interval '2 hours' WHERE id=$1", [f.session.id]);
  const jobId = await queue(f), now = Date.now;
  const speech = new SyntheticSpeech("ok", async () => { Date.now = () => Date.parse(p.providerOffer.expiresAt) + 1; });
  try { assert.equal((await finish(f, jobId, { speech, media: f.media }))?.state, "needs_review"); }
  finally { Date.now = now; }
  assert.equal(speech.calls, 1); assert.equal(speech.responses, 0);
  const stream = (await getPool().query("SELECT dispatched_at,provider_response_id FROM guild_speech_runs WHERE job_id=$1", [jobId])).rows[0];
  assert.equal(stream.dispatched_at, null); assert.equal(stream.provider_response_id, null);
});
