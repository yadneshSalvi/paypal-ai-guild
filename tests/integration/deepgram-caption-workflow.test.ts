import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { locales } from "@/contracts/guild";
import { captionAuthorityCeilingSchema } from "@/domain/captions";
import { deepgramCaptionArtifactSchema, deepgramSourcesFromPack } from "@/domain/deepgram-captions";
import { digest, DomainError } from "@/domain/primitives";
import { planDigest } from "@/domain/fixture";
import { executeCommand, getCommission } from "@/server/commissions";
import { getPool } from "@/server/db";
import type { Session } from "@/server/session";
import { assertDeepgramCaptionAcceptable, deepgramCaptionContractProposal, deepgramCaptionCorrectionProposal } from "@/server/captions/deepgram-contracts";
import { captionReviewTarget, captionReviewTargets, captionReviewWorkspace, readCaptionReviewRevision, saveCaptionReview } from "@/server/captions/review";
import { deepgramCaptionAlignmentEvidence, deepgramCaptionEvidenceIndex, deepgramCaptionJobEvidence } from "@/server/captions/deepgram-evidence";
import { isolatedPostgres } from "../support/postgres";
import { captionFixture, queueCaptions, syntheticEasyReadModel } from "../support/caption-fixture";
import { amendDeepgramCaptions, ControlledDeepgram, finishDeepgram, syntheticMeasuredDraft } from "../support/deepgram-caption-fixture";

let cleanup: () => Promise<void>;
before(async () => { cleanup = await isolatedPostgres("guild_deepgram_review_test"); process.env.DEEPGRAM_API_KEY = ""; process.env.GEMINI_API_KEY = ""; globalThis.fetch = async () => { throw new Error("Real provider network is disabled for this synthetic workflow suite."); }; });
after(async () => { process.env.GUILD_ENABLE_DEEPGRAM_REVIEW = "false"; await cleanup?.(); });
const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;
const jobDetail = async (id: string) => (await getPool().query("SELECT state,error,output FROM guild_jobs WHERE id=$1", [id])).rows[0];

test("fresh exact review agreement → original ledger → attributed correction → independent checks → explicit acceptance (synthetic workflow only)", async t => {
  const f = await captionFixture(), original = await getCommission(f.session, f.commissionId), originalSources = digest(original.artifacts), pkg = original.packages.find(item => item.kind === "captions")!;
  const proposal = await deepgramCaptionContractProposal(getPool(), original, pkg), sources = deepgramSourcesFromPack(proposal), ceiling = captionAuthorityCeilingSchema.parse(proposal.parameters!.authorityCeiling);
  assert.equal(sources.tracks.length, 12); assert.equal(new Set(sources.tracks.map(item => item.locale)).size, 6);
  assert.equal(proposal.criteria.find(item => item.id === "qualification")?.blocking, false);
  assert.equal(proposal.criteria.find(item => item.id === "listening")?.blocking, true);
  await assert.rejects(executeCommand(f.session, original.id, { type: "amend_deepgram_caption_contract", commandId: randomUUID(), expectedRevision: original.revision, packageId: pkg.id, contractVersion: pkg.contractVersion, acceptancePackDigest: "f".repeat(64), acknowledgeReviewOnly: true, acknowledgeNoRecognitionRetry: true }), code("DEEPGRAM_REVIEW_AMENDMENT"));
  await amendDeepgramCaptions(f);
  process.env.GUILD_ENABLE_DEEPGRAM_REVIEW = "false";
  await assert.rejects(queueCaptions(f), code("DEEPGRAM_REVIEW_DISABLED"));
  process.env.GUILD_ENABLE_DEEPGRAM_REVIEW = "true";
  await assert.rejects(queueCaptions(f), code("DEEPGRAM_REVIEW_CONFIGURATION"));
  process.env.DEEPGRAM_API_KEY = "synthetic-test-gateway-key-no-network";
  const model = syntheticEasyReadModel(), gateway = new ControlledDeepgram("disagreements");
  try {
    const firstJob = await queueCaptions(f);
    assert.equal((await finishDeepgram(f, firstJob, gateway))?.state, "completed", JSON.stringify(await jobDetail(firstJob)));
    let c = await getCommission(f.session, f.commissionId), caption = c.packages.find(item => item.kind === "captions")!;
    const first = c.artifacts.find(item => item.id === caption.artifactIds.at(-1))!, firstContent = deepgramCaptionArtifactSchema.parse(first.content);
    await t.test("complete source denominator and failures are retained; worker continuation never re-dispatches", async () => {
      assert.equal(gateway.calls, 12); assert.equal(model.count(), 6); assert.equal(firstContent.attempt, 1);
      assert.equal(firstContent.tracks.length, sources.tracks.length); assert.ok(firstContent.tracks.filter(item => ["ar", "ja"].includes(item.locale)).every(item => item.candidate.status === "withheld" && !item.vtt));
      assert.ok(firstContent.tracks.every(item => !item.reviewRevision && !item.effective.listeningAttested));
      assert.equal(firstContent.automatedQualification, "not-qualified"); assert.equal(firstContent.productionAccepted, false);
      assert.equal((await getPool().query("SELECT count(*)::int AS n FROM guild_alignment_runs WHERE tenant_id=$1 AND job_id=$2", [c.tenantId, firstJob])).rows[0].n, 12);
      const evidence = await deepgramCaptionJobEvidence(f.session, c.id, firstJob); assert.equal(evidence.observations.length, 12); assert.equal(evidence.retryAuthorized, false);
      const raw = await deepgramCaptionAlignmentEvidence(f.session, first.id, firstContent.tracks[0]!.alignmentRunId); assert.equal(raw.request.wire.sourceTextSupplied, false); assert.ok(raw.receipt?.rawBodyBase64); assert.equal(gateway.calls, 12);
      await assert.rejects(deepgramCaptionJobEvidence({ ...f.session, tenantId: randomUUID() }, c.id, firstJob), code("CAPTION_JOB_EVIDENCE"));
    });
    const firstCheck = await queueCaptions(f, "verify_artifact");
    assert.equal((await finishDeepgram(f, firstCheck, gateway))?.state, "completed", JSON.stringify(await jobDetail(firstCheck)));
    c = await getCommission(f.session, c.id); caption = c.packages.find(item => item.kind === "captions")!;
    await t.test("independent first checks cannot turn automatic candidates into a human-reviewed artifact", async () => {
      const report = (await jobDetail(firstCheck)).output.report;
      assert.equal(report.schemaVersion, "guild.caption-verification.v3"); assert.equal(report.checks.length, 12); assert.equal(report.newRecognitionRequests, 0);
      assert.ok(report.sourceVerified && report.producingApprovalVerified, JSON.stringify(report));
      assert.equal(caption.acceptancePack.criteria.find(item => item.id === "listening")?.status, "failed");
      assert.equal(caption.state, "correction_requested"); assert.equal(caption.paymentState, "not_eligible");
      await assert.rejects(deepgramCaptionCorrectionProposal(getPool(), c, caption), code("DEEPGRAM_REVIEW_INCOMPLETE"));
      assert.equal(gateway.calls, 12); assert.equal(model.count(), 6);
    });

    const operator: Session = { ...f.session, id: randomUUID(), role: "operator" };
    await getPool().query("INSERT INTO guild_sessions(id,tenant_id,token_hash,role,expires_at) VALUES($1,$2,$3,'operator',$4)", [operator.id, operator.tenantId, digest(operator.id), operator.expiresAt]);
    let firstRevisionId = "";
    await t.test("draft identity, parent concurrency, actor separation and append-only persistence", async () => {
      for (const [index, source] of sources.tracks.entries()) {
        const workspace = await captionReviewWorkspace(f.session, first.id, source.locale, source.key), draft = syntheticMeasuredDraft(source, workspace.initialUnits);
        assert.equal(workspace.history.length, 0); assert.equal(workspace.authorityExpired, false);
        const command = { action: "save" as const, requestId: randomUUID(), parentRevisionId: null, locale: source.locale, key: source.key, artifactHash: first.contentHash, draft };
        const author = index === 0 ? operator : f.session;
        const revision = await saveCaptionReview(author, first.id, command);
        assert.equal(revision.evaluation.status, "ready-for-review", `${source.locale}: ${revision.evaluation.codes.join()}`); assert.equal(revision.attestation, null); assert.equal(revision.evaluation.humanReviewed, false);
        const attestation = { action: "attest" as const, requestId: randomUUID(), parentRevisionId: revision.id, locale: source.locale, key: source.key, artifactHash: first.contentHash,
          reviewerName: "SYNTHETIC TEST ACTOR — no real listening occurred", completeRecordingListened: true as const, completeSourceHeard: true as const, everyTimingChecked: true as const, acknowledgeNotFluentReview: true as const };
        if (!index) {
          firstRevisionId = revision.id;
          assert.equal((await captionReviewWorkspace(operator, first.id, source.locale, source.key)).canAttest, false);
          assert.equal((await saveCaptionReview(author, first.id, command)).id, revision.id);
          await assert.rejects(saveCaptionReview(author, first.id, { ...command, draft: { ...draft, note: "Changed the request payload without a new identity." } }), code("CAPTION_REVIEW_REQUEST_CHANGED"));
          await assert.rejects(saveCaptionReview(f.session, first.id, { ...command, requestId: randomUUID() }), code("CAPTION_REVIEW_CONFLICT"));
          await assert.rejects(saveCaptionReview(operator, first.id, attestation), code("CAPTION_REVIEW_ATTESTATION"));
          await assert.rejects(readCaptionReviewRevision(getPool(), randomUUID(), revision.id), code("CAPTION_REVIEW_MISSING"));
          await assert.rejects(getPool().query("UPDATE guild_caption_review_revisions SET revision_digest=$1 WHERE id=$2", ["a".repeat(64), revision.id]), /append-only/);
          await assert.rejects(getPool().query("DELETE FROM guild_caption_review_revisions WHERE id=$1", [revision.id]), /append-only/);
        }
        const declared = await saveCaptionReview(f.session, first.id, attestation);
        assert.ok(declared.attestation?.humanDeclaredListening); assert.equal(declared.attestation!.fluentReviewed, false);
        assert.equal(declared.parentRevisionId, revision.id); assert.equal(digest(declared.draft), digest(revision.draft));
      }
    });

    c = await getCommission(f.session, c.id); caption = c.packages.find(item => item.kind === "captions")!;
    await t.test("one-operation track validation preserves exact single-track evidence and rereads signed receipts without borrowing another operation", async () => {
      const db = await getPool().connect();
      try {
        const targetFor = await captionReviewTargets(db, c.tenantId, first.id);
        for (const source of sources.tracks) assert.deepEqual(await targetFor(source.locale, source.key), await captionReviewTarget(db, c.tenantId, first.id, source.locale, source.key));
        const observed = firstContent.tracks.find(track => track.locale === "ar")!, source = sources.tracks.find(track => track.locale === "ar" && track.key === observed.key)!;
        await db.query("BEGIN");
        try {
          const row = (await db.query("SELECT receipt FROM guild_alignment_observations WHERE run_id=$1", [observed.alignmentRunId])).rows[0];
          const changed = structuredClone(row.receipt); changed.receipt.latencyMs += 1;
          await db.query("UPDATE guild_alignment_observations SET receipt=$1,receipt_hash=$2 WHERE run_id=$3", [changed, digest(changed), observed.alignmentRunId]);
          await assert.rejects(targetFor(source.locale, source.key), code("DEEPGRAM_EVIDENCE_CHANGED"));
          await assert.rejects(captionReviewTarget(db, c.tenantId, first.id, source.locale, source.key), code("DEEPGRAM_EVIDENCE_CHANGED"));
        } finally { await db.query("ROLLBACK"); }
        assert.deepEqual(await targetFor(source.locale, source.key), await captionReviewTarget(db, c.tenantId, first.id, source.locale, source.key));
        await db.query("BEGIN");
        try {
          await db.query("UPDATE guild_artifacts SET content_hash=$1 WHERE id=$2", ["0".repeat(64), first.id]);
          await assert.rejects(captionReviewTargets(db, c.tenantId, first.id), code("CAPTION_REVIEW_ARTIFACT"));
        } finally { await db.query("ROLLBACK"); }
        await assert.rejects(captionReviewTargets(db, randomUUID(), first.id), code("CAPTION_REVIEW_ARTIFACT"));
      } finally { db.release(); }
      assert.equal(gateway.calls, 12); assert.equal(model.count(), 6);
    });
    const correction = await deepgramCaptionCorrectionProposal(getPool(), c, caption);
    assert.equal(correction.revisions.length, sources.tracks.length); assert.equal(correction.recognitionRequests, 0); assert.equal(correction.easyReadRequests, 0); assert.equal(correction.additionalChargeMinor, 0);
    const agreed = await executeCommand(f.session, c.id, { type: "agree_deepgram_caption_review", commandId: randomUUID(), expectedRevision: c.revision, packageId: caption.id, contractVersion: caption.contractVersion, proposalDigest: correction.digest, acknowledgeExactRevisions: true });
    assert.ok(agreed.ok); assert.equal(agreed.commission.approvedPlanDigest, null);
    await assert.rejects(queueCaptions(f));
    await executeCommand(f.session, c.id, { type: "approve_plan", commandId: randomUUID(), expectedRevision: agreed.revision, planDigest: planDigest(agreed.commission) });
    process.env.GUILD_ENABLE_DEEPGRAM_REVIEW = "false"; process.env.OPENAI_API_KEY = "";
    const correctionJob = await queueCaptions(f);
    assert.equal((await finishDeepgram(f, correctionJob, gateway))?.state, "completed", JSON.stringify(await jobDetail(correctionJob)));
    c = await getCommission(f.session, c.id); caption = c.packages.find(item => item.kind === "captions")!;
    const corrected = c.artifacts.find(item => item.id === caption.artifactIds.at(-1))!, content = deepgramCaptionArtifactSchema.parse(corrected.content);
    await t.test("correction uses zero ASR/model calls and preserves exact original failures, source and authority", async () => {
      assert.notEqual(corrected.id, first.id); assert.equal(content.attempt, 2); assert.equal(content.correction?.baseArtifactId, first.id); assert.equal(content.originalProductionJobId, firstJob);
      assert.ok(content.tracks.every(item => item.effective.status === "ready-for-review" && item.effective.listeningAttested && item.reviewRevision && item.vtt));
      assert.equal(digest(content.tracks.map(item => item.candidate)), digest(firstContent.tracks.map(item => item.candidate)));
      assert.equal(digest(content.easyRead), digest(firstContent.easyRead)); assert.equal(digest(content.sources), digest(firstContent.sources));
      assert.equal(digest(c.artifacts.filter(item => item.packageId !== "captions")), originalSources);
      assert.equal(c.artifacts.find(item => item.id === first.id)!.contentHash, first.contentHash);
      assert.equal(captionAuthorityCeilingSchema.parse(caption.acceptancePack.parameters!.authorityCeiling).expiresAt, ceiling.expiresAt);
      assert.equal(gateway.calls, 12); assert.equal(model.count(), 6);
      await assert.rejects(queueCaptions(f), code("DEEPGRAM_REVIEW_ALLOWANCE"));
      assert.equal((await getPool().query("SELECT count(*)::int AS n FROM guild_alignment_runs WHERE job_id=$1", [correctionJob])).rows[0].n, 0);
      const evidence = await deepgramCaptionEvidenceIndex(f.session, corrected.id); assert.equal(evidence.producingApproval.verified, true); assert.equal(evidence.automatedQualification, "not-qualified");
    });

    await t.test("independent verification catches changed actual VTT and a rehashed but unsigned raw observation", async () => {
      const en = content.tracks.find(item => item.locale === "en")!, ar = content.tracks.find(item => item.locale === "ar")!;
      const media = (await getPool().query("SELECT blob_pathname FROM guild_media_objects WHERE id=$1", [en.vtt!.mediaId])).rows[0];
      const originalFile = f.media.files.get(media.blob_pathname)!; f.media.files.set(media.blob_pathname, { ...originalFile, bytes: Buffer.from("WEBVTT\n\nChanged actual private bytes") });
      let vttFailure: string | null = null;
      try {
        vttFailure = await queueCaptions(f, "verify_artifact");
        assert.equal((await finishDeepgram(f, vttFailure, gateway))?.state, "completed", JSON.stringify(await jobDetail(vttFailure)));
        const report = (await jobDetail(vttFailure)).output.report;
        assert.ok(report.checks.some((item: { locale: string; vtt: boolean }) => item.locale === "en" && !item.vtt), JSON.stringify(report));
      } finally { f.media.files.set(media.blob_pathname, originalFile); }
      assert.equal((await jobDetail(vttFailure!)).output.report.checks.length, 12, "the failed VTT report remains retained");
      const observation = (await getPool().query("SELECT receipt_hash,receipt FROM guild_alignment_observations WHERE run_id=$1", [ar.alignmentRunId])).rows[0], changed = structuredClone(observation.receipt); changed.receipt.latencyMs += 1;
      await getPool().query("UPDATE guild_alignment_observations SET receipt=$1,receipt_hash=$2 WHERE run_id=$3", [changed, digest(changed), ar.alignmentRunId]);
      try {
        const failed = await queueCaptions(f, "verify_artifact");
        assert.equal((await finishDeepgram(f, failed, gateway))?.state, "completed", JSON.stringify(await jobDetail(failed)));
        const report = (await jobDetail(failed)).output.report;
        assert.equal(report.sourceVerified, false); assert.match(report.evidence.join(" "), /DEEPGRAM_EVIDENCE_CHANGED/);
      } finally { await getPool().query("UPDATE guild_alignment_observations SET receipt=$1,receipt_hash=$2 WHERE run_id=$3", [observation.receipt, observation.receipt_hash, ar.alignmentRunId]); }

    });
    const finalCheck = await queueCaptions(f, "verify_artifact");
    assert.equal((await finishDeepgram(f, finalCheck, gateway))?.state, "completed", JSON.stringify(await jobDetail(finalCheck)));
    c = await getCommission(f.session, c.id); caption = c.packages.find(item => item.kind === "captions")!;
    await t.test("complete human correction can pass its contract without asserting automatic qualification", async () => {
      assert.ok(caption.acceptancePack.criteria.every(item => item.kind !== "deterministic" || item.status === "passed"), JSON.stringify(caption.acceptancePack.criteria));
      assert.equal(caption.acceptancePack.criteria.find(item => item.id === "qualification")?.status, "review"); assert.equal(caption.state, "awaiting_acceptance");
      const report = (await jobDetail(finalCheck)).output.report; assert.equal(report.checks.filter((item: { listeningAttested: boolean }) => item.listeningAttested).length, 12); assert.equal(report.newRecognitionRequests, 0); assert.equal(report.automatedQualification, "not-qualified");
      assert.equal(gateway.calls, 12); assert.equal(model.count(), 6);
      const db = await getPool().connect();
      try {
        await db.query("BEGIN");
        const changed = structuredClone(corrected), body = deepgramCaptionArtifactSchema.parse(changed.content);
        body.tracks[0]!.reviewRevision = body.tracks[1]!.reviewRevision;
        changed.content = body; changed.contentHash = digest(body);
        await db.query("UPDATE guild_artifacts SET content_hash=$1,manifest=$2 WHERE tenant_id=$3 AND id=$4", [changed.contentHash, changed, c.tenantId, changed.id]);
        await assert.rejects(assertDeepgramCaptionAcceptable(db, c, caption, changed), code("CAPTION_COMPLETE_LISTENING_REQUIRED"));
      } finally { await db.query("ROLLBACK"); db.release(); }
      const decision = { type: "accept_package" as const, commandId: randomUUID(), expectedRevision: c.revision, packageId: caption.id, artifactId: corrected.id, contractVersion: caption.contractVersion, acknowledgeReview: true as const, acknowledgeCaptionListeningAndLanguageDisclosure: true as const };
      await assert.rejects(executeCommand(operator, c.id, decision), code("CAPTION_HUMAN_ACCEPTANCE_REQUIRED"));
      await assert.rejects(executeCommand(f.session, c.id, decision), code("INPUT_ACCEPTANCE_REQUIRED"));
      for (const packageId of ["research", "translation", "narration"]) {
        const current = await getCommission(f.session, c.id), upstream = current.packages.find(item => item.id === packageId)!;
        await executeCommand(f.session, c.id, { type: "accept_package", commandId: randomUUID(), expectedRevision: current.revision, packageId, artifactId: upstream.artifactIds.at(-1)!, contractVersion: upstream.contractVersion, acknowledgeReview: true });
      }
      const current = await getCommission(f.session, c.id);
      const accepted = await executeCommand(f.session, c.id, { ...decision, commandId: randomUUID(), expectedRevision: current.revision });
      assert.ok(accepted.ok); assert.equal(accepted.commission.packages.find(item => item.id === caption.id)!.state, "accepted");
      const stored = (await getPool().query("SELECT review_disclosures FROM guild_acceptance_decisions WHERE artifact_id=$1", [corrected.id])).rows[0].review_disclosures;
      assert.equal(stored.captionListening.automatedQualification, "not-qualified"); assert.equal(stored.captionListening.declarations.length, 12);
      assert.ok(locales.every(locale => stored.languages[locale].fluentReviewed === false && stored.languages[locale].curatorAcknowledged));
      assert.equal((await getPool().query("SELECT count(*)::int AS n FROM guild_payment_intents WHERE tenant_id=$1", [c.tenantId])).rows[0].n, 0);
    });
    await t.test("retained draft history remains readable after production expiry and grants no renewal", async () => {
      const now = Date.now; Date.now = () => Date.parse(ceiling.expiresAt) + 1000;
      try {
        const source = sources.tracks[0]!, workspace = await captionReviewWorkspace(f.session, first.id, source.locale, source.key);
        assert.equal(workspace.authorityExpired, true); assert.match(workspace.nextAction, /separate successor commission/); assert.equal(workspace.history.length, 2);
        assert.equal((await readCaptionReviewRevision(getPool(), c.tenantId, firstRevisionId)).artifactHash, first.contentHash);
        assert.equal((await deepgramCaptionAlignmentEvidence(f.session, first.id, firstContent.tracks[0]!.alignmentRunId)).receiptHash, firstContent.tracks[0]!.receiptHash);
        assert.equal(gateway.calls, 12);
      } finally { Date.now = now; }
    });
  } finally { model.restore(); }
});

test("actual worker authorizer rechecks revocation between durable preparation and dispatch", async () => {
  process.env.GUILD_ENABLE_DEEPGRAM_REVIEW = "true"; process.env.OPENAI_MODEL = "gpt-6.1-sol"; process.env.OPENAI_API_KEY = "synthetic-unused-test-key"; process.env.DEEPGRAM_API_KEY = "synthetic-unused-test-key";
  const f = await captionFixture(); await amendDeepgramCaptions(f);
  const gateway = new ControlledDeepgram("ok", async () => { await getPool().query("UPDATE guild_sessions SET revoked_at=now() WHERE id=$1", [f.session.id]); });
  const job = await queueCaptions(f), result = await finishDeepgram(f, job, gateway);
  assert.equal(result?.state, "needs_review", JSON.stringify(await jobDetail(job))); assert.equal(gateway.calls, 0);
  const retained = (await getPool().query("SELECT state,dispatched_at FROM guild_alignment_runs WHERE job_id=$1", [job])).rows;
  assert.equal(retained.length, 1); assert.equal(retained[0].state, "prepared"); assert.equal(retained[0].dispatched_at, null);
});

test("lost and partial original requests hold the real workflow and remain inspectable without a complete artifact", async () => {
  process.env.GUILD_ENABLE_DEEPGRAM_REVIEW = "true"; process.env.OPENAI_MODEL = "gpt-6.1-sol"; process.env.OPENAI_API_KEY = "synthetic-unused-test-key"; process.env.DEEPGRAM_API_KEY = "synthetic-unused-test-key";
  for (const mode of ["lost", "partial"] as const) {
    const f = await captionFixture(); await amendDeepgramCaptions(f);
    const gateway = new ControlledDeepgram(mode), job = await queueCaptions(f), result = await finishDeepgram(f, job, gateway);
    assert.equal(result?.state, "needs_review", JSON.stringify(await jobDetail(job))); assert.equal(gateway.calls, 1);
    const evidence = await deepgramCaptionJobEvidence(f.session, f.commissionId, job); assert.equal(evidence.observations.length, 1); assert.equal(evidence.observations[0]!.state, "indeterminate"); assert.equal(evidence.retryAuthorized, false);
    const raw = await deepgramCaptionJobEvidence(f.session, f.commissionId, job, evidence.observations[0]!.runId); assert.equal(raw.observations[0]!.bodyComplete, false);
    await assert.rejects(queueCaptions(f));
    assert.equal(gateway.calls, 1); assert.equal((await getCommission(f.session, f.commissionId)).packages.find(item => item.kind === "captions")!.artifactIds.length, 0);
  }
});
