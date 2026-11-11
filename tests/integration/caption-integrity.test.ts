import test, { after, before, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { captionArtifactSchema, captionAuthorityCeilingSchema, captionSourcesFromPack } from "@/domain/captions";
import { digest, DomainError } from "@/domain/primitives";
import { getPool } from "@/server/db";
import { getCommission } from "@/server/commissions";
import { createSession } from "@/server/session";
import { captionAlignmentEvidence, captionEvidenceIndex } from "@/server/captions/evidence";
import { validateCaptionContract } from "@/server/captions/contracts";
import { isolatedPostgres } from "../support/postgres";
import { captionFixture, amendCaptions, queueCaptions, finishCaptions, SyntheticAlignment, syntheticEasyReadModel } from "../support/caption-fixture";

let cleanup: () => Promise<void>;
before(async () => { cleanup = await isolatedPostgres("guild_caption_integrity_test"); });
after(async () => { await cleanup?.(); });
const code = (value: string) => (error: unknown) => error instanceof DomainError && error.code === value;

test("caption evidence remains owner-bound, independently detects tampered bytes and reads historical results after expiry", async () => {
  const f = await captionFixture(), pack = await amendCaptions(f), alignment = new SyntheticAlignment(), model = syntheticEasyReadModel();
  try {
    const job = await queueCaptions(f); assert.equal((await finishCaptions(f, job, alignment))?.state, "completed");
    const c = await getCommission(f.session, f.commissionId), pkg = c.packages.find(item => item.kind === "captions")!, artifact = c.artifacts.find(item => item.id === pkg.artifactIds.at(-1))!, content = captionArtifactSchema.parse(artifact.content), first = content.tracks[0]!, source = content.sources.tracks.find(item => item.locale === first.locale && item.key === first.key)!;
    const before = { alignment: alignment.calls, model: model.count(), asr: f.transcription.calls };
    const index = await captionEvidenceIndex(f.session, artifact.id), raw = await captionAlignmentEvidence(f.session, artifact.id, first.alignmentRunId);
    assert.equal(index.producingApproval.verified, true); assert.equal(index.producingContract!.captionCorrection, undefined);
    assert.equal(index.alignmentResponses.length, 12); assert.ok(index.alignmentResponses.every(item => item.available && item.receiptHashMatchesArtifact));
    assert.equal(raw.originalAudio.audioHash, source.audioHash); assert.equal(raw.receiptHash, first.receiptHash); assert.equal(raw.request.prompt.text, source.prompt.text);
    const other = (await createSession()).session;
    await assert.rejects(captionAlignmentEvidence(other, artifact.id, first.alignmentRunId), code("ARTIFACT_NOT_FOUND"));
    await assert.rejects(captionAlignmentEvidence({ ...f.session, role: "provider" }, artifact.id, first.alignmentRunId), code("ROLE_REQUIRED"));
    await assert.rejects(captionAlignmentEvidence(f.session, artifact.id, randomUUID()), code("CAPTION_RESPONSE_NOT_FOUND"));

    const changedPack = structuredClone(pkg.acceptancePack); (changedPack.parameters!.limits as Record<string, { maximumGraphemesPerSecond: number }>).ja!.maximumGraphemesPerSecond = 40;
    assert.throws(() => captionSourcesFromPack(changedPack), code("CAPTION_CONTRACT_CHANGED"));
    const reviewed = content.sources.reviews.find(item => item.reviewKind === "automated_review")!, review = (await getPool().query("SELECT findings FROM guild_artifact_reviews WHERE id=$1", [reviewed.reviewId])).rows[0];
    await getPool().query("UPDATE guild_artifact_reviews SET findings=$1 WHERE id=$2", ["Tampered synthetic source annotation", reviewed.reviewId]);
    try { await assert.rejects(validateCaptionContract(getPool(), c, pkg, false), code("CAPTION_SOURCE_BINDING")); }
    finally { await getPool().query("UPDATE guild_artifact_reviews SET findings=$1 WHERE id=$2", [review.findings, reviewed.reviewId]); }

    const observation = (await getPool().query("SELECT receipt_hash,receipt FROM guild_alignment_observations WHERE run_id=$1", [first.alignmentRunId])).rows[0], changed = structuredClone(observation.receipt);
    changed.parsed.words[0].end += 0.001; // Parsed claim no longer equals its retained raw body.
    await getPool().query("UPDATE guild_alignment_observations SET receipt=$1,receipt_hash=$2 WHERE run_id=$3", [changed, digest(changed), first.alignmentRunId]);
    try { await assert.rejects(captionAlignmentEvidence(f.session, artifact.id, first.alignmentRunId), code("ALIGNMENT_OBSERVATION_CHANGED")); }
    finally { await getPool().query("UPDATE guild_alignment_observations SET receipt=$1,receipt_hash=$2 WHERE run_id=$3", [observation.receipt, observation.receipt_hash, first.alignmentRunId]); }

    const vtt = (await getPool().query("SELECT blob_pathname FROM guild_media_objects WHERE id=$1", [first.vtt!.mediaId])).rows[0], file = f.media.files.get(vtt.blob_pathname)!;
    assert.ok(file); f.media.files.set(vtt.blob_pathname, { ...file, bytes: Buffer.concat([file.bytes, Buffer.from("\nTampered caption bytes\n")]) });
    try {
      assert.equal((await finishCaptions(f, await queueCaptions(f, "verify_artifact"), alignment))?.state, "completed");
      const measured = await getCommission(f.session, c.id), checked = measured.packages.find(item => item.kind === "captions")!;
      assert.equal(checked.acceptancePack.criteria.find(item => item.id === "vtt")!.status, "failed");
      const report = (await getPool().query("SELECT output->'report' AS report FROM guild_jobs WHERE commission_id=$1 AND type='verify_artifact' ORDER BY created_at DESC LIMIT 1", [c.id])).rows[0].report;
      assert.equal(report.checks.length, 12); assert.equal(report.checks.filter((item: { vtt: boolean }) => item.vtt).length, 11);
    } finally { f.media.files.set(vtt.blob_pathname, file); }

    const easy = content.easyRead[0]!, originalModel = (await getPool().query("SELECT provider_output_text FROM guild_model_runs WHERE id=$1", [easy.modelRunId])).rows[0];
    await getPool().query("UPDATE guild_model_runs SET provider_output_text=$1 WHERE id=$2", ['{"forged":"not the actual complete saved response"}', easy.modelRunId]);
    try {
      assert.equal((await finishCaptions(f, await queueCaptions(f, "verify_artifact"), alignment))?.state, "completed");
      const measured = await getCommission(f.session, c.id), checked = measured.packages.find(item => item.kind === "captions")!;
      assert.equal(checked.acceptancePack.criteria.find(item => item.id === "easy_read")!.status, "failed");
    } finally { await getPool().query("UPDATE guild_model_runs SET provider_output_text=$1 WHERE id=$2", [originalModel.provider_output_text, easy.modelRunId]); }

    const clock = mock.method(Date, "now", () => Date.parse(captionAuthorityCeilingSchema.parse(pack.parameters!.authorityCeiling).expiresAt) + 1);
    try {
      assert.equal((await captionEvidenceIndex(f.session, artifact.id)).producingApproval.verified, true);
      assert.equal((await captionAlignmentEvidence(f.session, artifact.id, first.alignmentRunId)).receiptHash, first.receiptHash);
      assert.equal((await finishCaptions(f, await queueCaptions(f, "verify_artifact"), alignment))?.state, "completed");
      const measured = await getCommission(f.session, c.id), checked = measured.packages.find(item => item.kind === "captions")!;
      assert.ok(checked.acceptancePack.criteria.every(item => item.kind !== "deterministic" || item.status === "passed"), JSON.stringify(checked.acceptancePack.criteria));
      await assert.rejects(queueCaptions(f), code("CAPTION_AUTHORITY_EXPIRED"));
    } finally { clock.mock.restore(); }
    assert.deepEqual({ alignment: alignment.calls, model: model.count(), asr: f.transcription.calls }, before);
    assert.equal((await getCommission(f.session, c.id)).payments.capturedMinor, 0);
  } finally { model.restore(); }
});
