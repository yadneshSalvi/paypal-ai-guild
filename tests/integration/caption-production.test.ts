import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { captionArtifactSchema, captionAuthorityCeilingSchema, captionSourcesFromPack, easyReadStandard } from "@/domain/captions";
import { digest, DomainError } from "@/domain/primitives";
import { getPool } from "@/server/db";
import { executeCommand, getCommission } from "@/server/commissions";
import { captionContractProposal } from "@/server/captions/contracts";
import { isolatedPostgres } from "../support/postgres";
import { captionFixture, amendCaptions, queueCaptions, finishCaptions, SyntheticAlignment, syntheticEasyReadModel } from "../support/caption-fixture";
let cleanup: () => Promise<void>;
before(async () => { cleanup = await isolatedPostgres("guild_caption_production_test"); });
after(async () => { await cleanup?.(); });
const code = (value: string) => (error: unknown) => error instanceof DomainError && error.code === value;

test("exact original audio becomes bounded caption files and six easy-read responses; independent checks make no model or ASR call", async () => {
  const f = await captionFixture(), before = await getCommission(f.session, f.commissionId), pkg = before.packages.find(item => item.kind === "captions")!;
  const previousNarration = before.artifacts.find(item => item.packageId === "narration")!, sourcesHash = digest(before.artifacts.filter(item => item.packageId !== "captions"));
  const proposed = await captionContractProposal(getPool(), before, pkg), sources = captionSourcesFromPack(proposed), anchor = captionAuthorityCeilingSchema.parse(proposed.parameters!.authorityCeiling);
  assert.equal(sources.tracks.length, 12); assert.equal(proposed.correctionAllowance, 1); assert.equal(proposed.parameters!.easyRead && (proposed.parameters!.easyRead as typeof easyReadStandard).model, "gpt-6.1-sol");
  await assert.rejects(executeCommand(f.session, before.id, { type: "amend_caption_contract", commandId: randomUUID(), expectedRevision: before.revision, packageId: pkg.id, contractVersion: pkg.contractVersion, acceptancePackDigest: "f".repeat(64), acknowledgePromptedAlignment: true, acknowledgeOneCorrection: true }), code("CAPTION_AMENDMENT_CHANGED"));
  await amendCaptions(f);
  const model = syntheticEasyReadModel(), alignment = new SyntheticAlignment();
  try {
    const producing = await queueCaptions(f), result = await finishCaptions(f, producing, alignment);
    assert.equal(result?.state, "completed", JSON.stringify((await getPool().query("SELECT error FROM guild_jobs WHERE id=$1", [producing])).rows));
    const produced = await getCommission(f.session, f.commissionId), caption = produced.packages.find(item => item.kind === "captions")!, artifact = produced.artifacts.find(item => item.id === caption.artifactIds.at(-1))!, content = captionArtifactSchema.parse(artifact.content);
    assert.equal(alignment.calls, 12); assert.equal(model.count(), 6); assert.equal(content.attempt, 1); assert.equal(content.correction, null);
    assert.equal(content.tracks.filter(item => item.alignment.status === "aligned").length, 12, JSON.stringify(content.tracks.filter(item => item.alignment.status === "failed")));
    const priorAsr = f.transcription.calls, verified = await finishCaptions(f, await queueCaptions(f, "verify_artifact"), alignment);
    assert.equal(verified?.state, "completed"); assert.equal(alignment.calls, 12); assert.equal(model.count(), 6); assert.equal(f.transcription.calls, priorAsr);
    const final = await getCommission(f.session, f.commissionId), finalPackage = final.packages.find(item => item.kind === "captions")!;
    assert.ok(finalPackage.acceptancePack.criteria.every(item => item.kind !== "deterministic" || item.status === "passed"), JSON.stringify(finalPackage.acceptancePack.criteria));
    assert.equal(finalPackage.state, "awaiting_acceptance"); assert.equal(finalPackage.paymentState, "not_eligible"); assert.equal(finalPackage.acceptedAt, null);
    assert.equal(captionAuthorityCeilingSchema.parse(finalPackage.acceptancePack.parameters!.authorityCeiling).expiresAt, anchor.expiresAt);
    assert.equal(digest(final.artifacts.filter(item => item.packageId !== "captions")), sourcesHash); assert.equal(final.artifacts.find(item => item.id === previousNarration.id)!.contentHash, previousNarration.contentHash);
    assert.equal(Number((await getPool().query("SELECT count(*) FROM guild_alignment_runs WHERE tenant_id=$1", [f.session.tenantId])).rows[0].count), 12);
    assert.equal(Number((await getPool().query("SELECT count(*) FROM guild_budget_reservations WHERE tenant_id=$1 AND operation_key LIKE '%:captions:%' AND state='reserved' AND amount_minor=4000", [f.session.tenantId])).rows[0].count), 1);
    assert.equal(Number((await getPool().query("SELECT count(*) FROM guild_acceptance_decisions WHERE tenant_id=$1", [f.session.tenantId])).rows[0].count), 0);
  } finally { model.restore(); }
});
