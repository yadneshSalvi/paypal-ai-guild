import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { captionArtifactSchema, captionAuthorityCeilingSchema, captionSourcesFromPack } from "@/domain/captions";
import { planDigest } from "@/domain/fixture";
import { digest } from "@/domain/primitives";
import { getPool, transaction } from "@/server/db";
import { executeCommand, getCommission, saveCommission } from "@/server/commissions";
import { isolatedPostgres } from "../support/postgres";
import { captionFixture, amendCaptions, queueCaptions, finishCaptions, SyntheticAlignment, syntheticEasyReadModel } from "../support/caption-fixture";
let cleanup: () => Promise<void>;
before(async () => { cleanup = await isolatedPostgres("guild_caption_full_collection_test"); });
after(async () => { await cleanup?.(); });

test("all 78 files and six complete easy-read languages retain historical $540 narration inside a later $580 caption plan", async () => {
  const f = await captionFixture(12), before = await getCommission(f.session, f.commissionId), originalPlan = before.approvedPlanDigest;
  const originalArtifacts = digest(before.artifacts), originalDeadline = f.session.expiresAt;
  // A synthetic later commercial snapshot isolates the cross-plan approval
  // boundary. Real quote preparation is qualified by the scheduling suite.
  const web = before.packages.find(item => item.kind === "web")!;
  web.providerId = "ostrava"; web.providerAwardMinor += 4000; web.grossMinor += 4000; web.contractVersion++;
  before.approvedPlanDigest = null; before.state = "awaiting_approval";
  for (const page of before.mandates) page.status = "draft";
  await transaction(async db => { before.revision++; await saveCommission(db, before); });
  await executeCommand(f.session, before.id, { type: "approve_plan", commandId: randomUUID(), expectedRevision: before.revision, planDigest: planDigest(before) });
  const pack = await amendCaptions(f), sources = captionSourcesFromPack(pack);
  assert.equal(sources.tracks.length, 78); assert.equal(sources.requiredKeys.length, 13); assert.equal(sources.narration.approvalPlanDigest, originalPlan);
  assert.ok(sources.tracks.every(item => item.origin.approvalPlanDigest === originalPlan));
  assert.equal(captionAuthorityCeilingSchema.parse(pack.parameters!.authorityCeiling).expiresAt, originalDeadline);
  const alignment = new SyntheticAlignment(), model = syntheticEasyReadModel();
  try {
    const job = await queueCaptions(f); assert.equal((await finishCaptions(f, job, alignment))?.state, "completed");
    assert.equal((await finishCaptions(f, await queueCaptions(f, "verify_artifact"), alignment))?.state, "completed");
    const c = await getCommission(f.session, before.id), pkg = c.packages.find(item => item.kind === "captions")!, artifact = c.artifacts.find(item => item.id === pkg.artifactIds.at(-1))!, content = captionArtifactSchema.parse(artifact.content);
    assert.equal(content.tracks.length, 78);
    assert.equal(content.tracks.filter(item => item.alignment.status === "aligned" && item.vtt).length, 78,
      JSON.stringify(content.tracks.filter(item => item.alignment.status !== "aligned" || !item.vtt).map(item => ({ locale: item.locale, key: item.key, alignment: item.alignment }))));
    assert.equal(content.easyRead.length, 6); assert.ok(content.easyRead.every(item => Object.keys(item.labels).length === 13));
    assert.ok(pkg.acceptancePack.criteria.every(item => item.kind !== "deterministic" || item.status === "passed"), JSON.stringify(pkg.acceptancePack.criteria));
    assert.equal(alignment.calls, 78); assert.equal(model.count(), 6); assert.equal(f.speech.calls, 78); assert.equal(f.transcription.calls, 78);
    assert.equal(c.packages.reduce((sum, item) => sum + item.grossMinor, 0), 58000); assert.equal(pkg.grossMinor, 4000);
    assert.equal(digest(c.artifacts.filter(item => item.packageId !== "captions")), originalArtifacts);
    assert.equal(pkg.acceptedAt, null); assert.equal(c.payments.capturedMinor, 0);
    assert.ok(Buffer.byteLength(JSON.stringify(c)) < 4_000_000, "this complete synthetic workspace stays within the declared local response-size check");
    const report = (await getPool().query("SELECT output->'report' AS report FROM guild_jobs WHERE commission_id=$1 AND type='verify_artifact' AND input->>'artifactId'=$2", [c.id, artifact.id])).rows[0].report;
    assert.equal(report.checks.length, 78); assert.equal(report.newRecognitionRequests, 0); assert.equal(report.producingApprovalVerified, true);
  } finally { model.restore(); }
});
