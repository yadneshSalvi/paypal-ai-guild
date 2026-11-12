import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { captionArtifactSchema, captionAuthorityCeilingSchema } from "@/domain/captions";
import { digest, DomainError } from "@/domain/primitives";
import { getPool } from "@/server/db";
import { getCommission } from "@/server/commissions";
import { captionReviewWorkspace, readCaptionReviewRevision, saveCaptionReview } from "@/server/captions/review";
import { deepgramCaptionContractProposal } from "@/server/captions/deepgram-contracts";
import { captionAlignmentEvidence } from "@/server/captions/evidence";
import { isolatedPostgres } from "../support/postgres";
import { captionFixture, amendCaptions, queueCaptions, finishCaptions, SyntheticAlignment, syntheticEasyReadModel } from "../support/caption-fixture";
import { syntheticMeasuredDraft } from "../support/deepgram-caption-fixture";

let cleanup: () => Promise<void>;
before(async () => { cleanup = await isolatedPostgres("guild_retained_caption_review_test"); globalThis.fetch = async () => { throw new Error("Real provider network is disabled in this retained-review test."); }; });
after(async () => { await cleanup?.(); });
test("expired historical Whisper artifacts retain original evidence and accept attributed drafts without becoming a Deepgram edition", async () => {
  const f = await captionFixture(); await amendCaptions(f);
  const model = syntheticEasyReadModel(), alignment = new SyntheticAlignment("wrong_word");
  try {
    assert.equal((await finishCaptions(f, await queueCaptions(f), alignment))?.state, "completed");
    const c = await getCommission(f.session, f.commissionId), pkg = c.packages.find(item => item.kind === "captions")!, artifact = c.artifacts.find(item => item.id === pkg.artifactIds.at(-1))!, content = captionArtifactSchema.parse(artifact.content), source = content.sources.tracks[0]!, track = content.tracks[0]!;
    const originalEvidence = await captionAlignmentEvidence(f.session, artifact.id, track.alignmentRunId), originalHash = digest(artifact), deadline = captionAuthorityCeilingSchema.parse(pkg.acceptancePack.parameters!.authorityCeiling).expiresAt;
    const now = Date.now; Date.now = () => Date.parse(deadline) + 1;
    try {
      process.env.OPENAI_API_KEY = ""; process.env.DEEPGRAM_API_KEY = "";
      const workspace = await captionReviewWorkspace(f.session, artifact.id, source.locale, source.key);
      assert.equal(workspace.authorityExpired, true); assert.match(workspace.provider, /Whisper/); assert.match(workspace.nextAction, /separate successor/);
      assert.ok(workspace.initialUnits.every(unit => unit.origin === "unassigned" && unit.startMs === null && unit.endMs === null));
      const draft = syntheticMeasuredDraft(source, workspace.initialUnits); draft.disposition = "source_audio_disagreement"; draft.units[0] = { ...draft.units[0]!, heard: "not_heard", startMs: null, endMs: null };
      const saved = await saveCaptionReview(f.session, artifact.id, { action: "save", requestId: randomUUID(), parentRevisionId: null, locale: source.locale, key: source.key, artifactHash: artifact.contentHash, draft });
      assert.equal(saved.attestation, null); assert.equal(saved.evaluation.status, "incomplete"); assert.equal(saved.evaluation.vtt, null);
      assert.equal((await readCaptionReviewRevision(getPool(), c.tenantId, saved.id)).originalReceiptHash, track.receiptHash);
      await assert.rejects(deepgramCaptionContractProposal(getPool(), c, pkg), error => error instanceof DomainError && error.code === "DEEPGRAM_REVIEW_AMENDMENT");
      const unchanged = await getCommission(f.session, f.commissionId);
      assert.equal(digest(unchanged.artifacts.find(item => item.id === artifact.id)), originalHash); assert.equal(unchanged.packages.find(item => item.id === pkg.id)!.acceptancePack.version, "2.0.0");
      assert.equal(captionAuthorityCeilingSchema.parse(unchanged.packages.find(item => item.id === pkg.id)!.acceptancePack.parameters!.authorityCeiling).expiresAt, deadline);
      assert.equal(digest(await captionAlignmentEvidence(f.session, artifact.id, track.alignmentRunId)), digest(originalEvidence));
      assert.equal(alignment.calls, 12); assert.equal(model.count(), 6);
    } finally { Date.now = now; }
  } finally { model.restore(); }
});
