import test, { after, before, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { captionArtifactSchema, captionAuthorityCeilingSchema } from "@/domain/captions";
import { planDigest } from "@/domain/fixture";
import { digest, DomainError } from "@/domain/primitives";
import { getPool, transaction } from "@/server/db";
import { executeCommand, getCommission, saveCommission } from "@/server/commissions";
import { captionCorrectionProposal, validateCaptionJob } from "@/server/captions/contracts";
import { readAlignmentRecord } from "@/server/captions/alignment-runs";
import { isolatedPostgres } from "../support/postgres";
import { captionFixture, amendCaptions, queueCaptions, finishCaptions, SyntheticAlignment, syntheticEasyReadModel, type CaptionFixture } from "../support/caption-fixture";

let cleanup: () => Promise<void>;
before(async () => { cleanup = await isolatedPostgres("guild_caption_controls_test"); });
after(async () => { await cleanup?.(); });
const code = (value: string) => (error: unknown) => error instanceof DomainError && error.code === value;
async function current(f: CaptionFixture) { const c = await getCommission(f.session, f.commissionId); return { c, pkg: c.packages.find(item => item.kind === "captions")! }; }
async function note(f: CaptionFixture, reason = "Keep the exact original audio and source. Correct the failed alignment from the retained first attempt under the single included correction.") {
  const { c, pkg } = await current(f);
  await executeCommand(f.session, c.id, { type: "request_correction", commandId: randomUUID(), expectedRevision: c.revision, packageId: pkg.id, reason });
}
async function agree(f: CaptionFixture) {
  const { c, pkg } = await current(f), proposal = await captionCorrectionProposal(getPool(), c, pkg);
  const result = await executeCommand(f.session, c.id, { type: "agree_caption_correction", commandId: randomUUID(), expectedRevision: c.revision, packageId: pkg.id, contractVersion: pkg.contractVersion, proposalDigest: proposal.digest, acknowledgeExactCorrection: true });
  assert.ok(result.ok); return { result, proposal };
}
async function revoke(f: CaptionFixture) {
  const { c } = await current(f);
  await executeCommand(f.session, c.id, { type: "revoke_mandate", commandId: randomUUID(), expectedRevision: c.revision, mandateId: "passport-localization" });
}

test("an uncertain alignment is retained once, cannot be replayed, and blocks a correction", async () => {
  const f = await captionFixture(); await amendCaptions(f);
  const alignment = new SyntheticAlignment("lost"), job = await queueCaptions(f);
  assert.equal((await finishCaptions(f, job, alignment))?.state, "needs_review"); assert.equal(alignment.calls, 1);
  const row = (await getPool().query("SELECT id,state,dispatched_at FROM guild_alignment_runs WHERE job_id=$1", [job])).rows[0];
  assert.equal(row.state, "indeterminate"); assert.ok(row.dispatched_at);
  await assert.rejects(queueCaptions(f), code("CAPTION_ORIGINAL_PENDING"));
  await note(f); let state = await current(f);
  await assert.rejects(captionCorrectionProposal(getPool(), state.c, state.pkg), code("CAPTION_ORIGINAL_PENDING"));
  // Simulate recovery of the same durable job, never a new producing request.
  await transaction(async db => { state = await current(f); state.pkg.state = "producing"; state.c.revision++; await saveCommission(db, state.c); await db.query("UPDATE guild_jobs SET state='queued',available_at=now() WHERE id=$1", [job]); });
  assert.equal((await finishCaptions(f, job, alignment))?.state, "needs_review"); assert.equal(alignment.calls, 1);
  assert.equal(Number((await getPool().query("SELECT count(*) FROM guild_alignment_runs WHERE job_id=$1", [job])).rows[0].count), 1);
  assert.equal((await current(f)).pkg.artifactIds.length, 0);
});

test("dispatch rechecks revocation, and a late original response is retained without publishing", async () => {
  for (const timing of ["before", "after"] as const) {
    const f = await captionFixture(); await amendCaptions(f);
    const alignment = new SyntheticAlignment("ok", timing === "before" ? async () => revoke(f) : undefined, timing === "after" ? async () => revoke(f) : undefined), job = await queueCaptions(f);
    const result = await finishCaptions(f, job, alignment);
    assert.ok(["needs_review", "failed"].includes(result!.state)); assert.equal(alignment.calls, timing === "before" ? 0 : 1);
    const row = (await getPool().query("SELECT id,state,dispatched_at FROM guild_alignment_runs WHERE job_id=$1", [job])).rows[0];
    assert.equal(row.state, timing === "before" ? "prepared" : "received"); assert.equal(!!row.dispatched_at, timing === "after");
    if (timing === "after") { const saved = await readAlignmentRecord(f.session.tenantId, row.id); assert.equal(saved.receipt.bodyComplete, true); }
    assert.equal((await current(f)).pkg.artifactIds.length, 0);
    assert.equal(Number((await getPool().query("SELECT count(*) FROM guild_media_objects WHERE tenant_id=$1 AND package_id='captions'", [f.session.tenantId])).rows[0].count), 0);
  }
});

test("provider unavailability is a persistent capability hold and the failed original still counts", async () => {
  const f = await captionFixture(); await amendCaptions(f);
  const alignment = new SyntheticAlignment("unavailable"), first = await queueCaptions(f);
  assert.equal((await finishCaptions(f, first, alignment))?.state, "needs_review"); assert.equal(alignment.calls, 1);
  assert.equal(Number((await getPool().query("SELECT count(*) FROM guild_caption_capability_holds WHERE tenant_id=$1", [f.session.tenantId])).rows[0].count), 1);
  await note(f, "The exact first response returned 404. Preserve its request and capability hold; review the included correction without changing the frozen adapter or original authority.");
  const { result } = await agree(f);
  await assert.rejects(queueCaptions(f), code("APPROVAL_REQUIRED"));
  await executeCommand(f.session, f.commissionId, { type: "approve_plan", commandId: randomUUID(), expectedRevision: result.revision, planDigest: planDigest(result.commission) });
  const second = await queueCaptions(f); assert.equal((await finishCaptions(f, second, alignment))?.state, "needs_review"); assert.equal(alignment.calls, 1, "a fresh Passport cannot silently replace or revive a held capability");
  await assert.rejects(queueCaptions(f), code("CAPTION_CORRECTION_ALLOWANCE"));
});

test("the original expiry remains binding even when the current workspace and Passport would otherwise allow work", async () => {
  const f = await captionFixture(), pack = await amendCaptions(f), deadline = captionAuthorityCeilingSchema.parse(pack.parameters!.authorityCeiling).expiresAt;
  const clock = mock.method(Date, "now", () => Date.parse(deadline) + 1);
  try { await assert.rejects(queueCaptions(f), code("CAPTION_AUTHORITY_EXPIRED")); } finally { clock.mock.restore(); }
  assert.equal(Number((await getPool().query("SELECT count(*) FROM guild_jobs WHERE tenant_id=$1 AND type='produce_package' AND input->>'packageId'='captions'", [f.session.tenantId])).rows[0].count), 0);
});

test("one exact correction retains the failed denominator and original approvals, then blocks a third attempt", async () => {
  const f = await captionFixture(); await amendCaptions(f);
  const model = syntheticEasyReadModel(), original = new SyntheticAlignment("wrong_word"), correction = new SyntheticAlignment();
  try {
    const first = await queueCaptions(f); assert.equal((await finishCaptions(f, first, original))?.state, "completed");
    assert.equal((await finishCaptions(f, await queueCaptions(f, "verify_artifact"), original))?.state, "completed");
    const initial = await current(f), firstArtifact = initial.c.artifacts.find(item => item.id === initial.pkg.artifactIds.at(-1))!, firstContent = captionArtifactSchema.parse(firstArtifact.content);
    assert.equal(firstContent.tracks.length, 12); assert.equal(firstContent.tracks.filter(item => item.alignment.status === "failed").length, 1);
    assert.equal(initial.pkg.acceptancePack.criteria.find(item => item.id === "alignment")!.status, "failed");
    const report = await getPool().query("SELECT output FROM guild_jobs WHERE commission_id=$1 AND type='verify_artifact' AND input->>'artifactId'=$2", [initial.c.id, firstArtifact.id]), originalReportHash = digest(report.rows[0].output), otherArtifactsHash = digest(initial.c.artifacts.filter(item => item.packageId !== "captions"));
    await assert.rejects(queueCaptions(f), code("CAPTION_CORRECTION_REQUIRED")); await note(f);
    const proposed = await current(f), stale = await captionCorrectionProposal(getPool(), proposed.c, proposed.pkg);
    await note(f, "Replace only the failed source/timestamp match under the exact retained audio, scripts, cue limits, one correction and unchanged deadline. Preserve the full first report.");
    const renamed = await current(f);
    await assert.rejects(executeCommand(f.session, renamed.c.id, { type: "agree_caption_correction", commandId: randomUUID(), expectedRevision: renamed.c.revision, packageId: renamed.pkg.id, contractVersion: renamed.pkg.contractVersion, proposalDigest: stale.digest, acknowledgeExactCorrection: true }), code("CAPTION_CORRECTION_CHANGED"));
    const { result, proposal } = await agree(f); assert.equal(proposal.previous.jobId, first); assert.equal(proposal.commercial.additionalChargeMinor, 0);
    await assert.rejects(queueCaptions(f), code("APPROVAL_REQUIRED"));
    await executeCommand(f.session, f.commissionId, { type: "approve_plan", commandId: randomUUID(), expectedRevision: result.revision, planDigest: planDigest(result.commission) });
    const approved = await current(f);
    // A tampered prior receipt must fail even with a fresh valid current Passport.
    const receipt = (await getPool().query("SELECT signature FROM guild_approval_receipts WHERE id=$1", [proposal.previousApproval.id])).rows[0];
    await getPool().query("UPDATE guild_approval_receipts SET signature=$1 WHERE id=$2", ["0".repeat(64), proposal.previousApproval.id]);
    await assert.rejects(queueCaptions(f), code("CAPTION_AUTHORITY_BINDING"));
    await getPool().query("UPDATE guild_approval_receipts SET signature=$1 WHERE id=$2", [receipt.signature, proposal.previousApproval.id]);
    assert.equal((await current(f)).c.revision, approved.c.revision);
    const second = await queueCaptions(f); assert.equal((await finishCaptions(f, second, correction))?.state, "completed");
    assert.equal((await finishCaptions(f, await queueCaptions(f, "verify_artifact"), correction))?.state, "completed");
    const final = await current(f), secondArtifact = final.c.artifacts.find(item => item.id === final.pkg.artifactIds.at(-1))!, content = captionArtifactSchema.parse(secondArtifact.content);
    assert.equal(content.attempt, 2); assert.equal(content.correction!.id, final.pkg.captionCorrection!.id); assert.equal(content.tracks.length, 12);
    assert.ok(final.pkg.acceptancePack.criteria.every(item => item.kind !== "deterministic" || item.status === "passed"), JSON.stringify(final.pkg.acceptancePack.criteria));
    assert.equal(original.calls, 12); assert.equal(correction.calls, 12); assert.equal(model.count(), 12);
    assert.equal(digest(final.c.artifacts.filter(item => item.packageId !== "captions")), otherArtifactsHash);
    assert.equal(final.c.artifacts.find(item => item.id === firstArtifact.id)!.contentHash, firstArtifact.contentHash);
    assert.equal(digest((await getPool().query("SELECT output FROM guild_jobs WHERE commission_id=$1 AND type='verify_artifact' AND input->>'artifactId'=$2", [final.c.id, firstArtifact.id])).rows[0].output), originalReportHash);
    await assert.rejects(queueCaptions(f), code("CAPTION_CORRECTION_ALLOWANCE"));
    const oldJob = (await getPool().query("SELECT id,input FROM guild_jobs WHERE id=$1", [first])).rows[0];
    await assert.rejects(validateCaptionJob(getPool(), final.c, final.pkg, oldJob), code("CAPTION_JOB_BINDING"));
    assert.equal(Number((await getPool().query("SELECT count(*) FROM guild_budget_reservations WHERE tenant_id=$1 AND operation_key LIKE '%:captions:%'", [f.session.tenantId])).rows[0].count), 1);
    assert.equal(final.pkg.grossMinor, 4000); assert.equal(final.pkg.acceptedAt, null); assert.equal(final.c.payments.capturedMinor, 0);
  } finally { model.restore(); }
});
