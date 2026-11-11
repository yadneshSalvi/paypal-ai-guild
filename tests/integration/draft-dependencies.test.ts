import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ArtifactManifest, Commission } from "../../src/contracts/guild";
import { isolatedPostgres } from "../support/postgres";

const cleanup = await isolatedPostgres("guild_draft_inputs_test"); after(cleanup);
process.env.OPENAI_API_KEY = "fixture-draft-key-no-network"; process.env.OPENAI_MODEL = "fixture-draft-model";
const { createSession } = await import("../../src/server/session");
const { createCommission, executeCommand, getCommission, saveCommission } = await import("../../src/server/commissions");
const { getPool, transaction } = await import("../../src/server/db");
const { collectionNotes, planDigest } = await import("../../src/domain/fixture");
const { materializeResearch, researchSourceSpans } = await import("../../src/domain/research");
const { draftDependencyProposal } = await import("../../src/domain/draft-dependencies");
const { digest, DomainError } = await import("../../src/domain/primitives");
const { museumSources } = await import("../../src/exhibition/museum");
const { runNextJob } = await import("../../src/server/jobs");
const originalFetch = globalThis.fetch; afterEach(() => { globalThis.fetch = originalFetch; });
const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;

async function fresh(checked = true) {
  const { session } = await createSession(), sources = museumSources.slice(0, 1);
  let c = await createCommission(session, { commandId: randomUUID(), title: "Draft lineage fixture", museum: "Fixture museum", objective: "Test explicitly amended draft production and separate human acceptance gates using synthetic artifacts only.", capMinor: 64000, languages: ["en", "pt", "es", "fr", "ja", "ar"], sourceIds: sources.map(source => source.id) }, sources);
  await executeCommand(session, c.id, { type: "approve_plan", commandId: randomUUID(), expectedRevision: c.revision, planDigest: planDigest(c) }); c = await getCommission(session, c.id);
  const spans = researchSourceSpans(sources, collectionNotes);
  const content = materializeResearch({ labels: ["welcome", sources[0]!.id].map(id => {
    const span = spans.find(span => id === "welcome" ? span.sourceId === "note-purpose" : span.sourceId === id && span.field === "title")!;
    const first = span.text, words: string[] = [];
    while (`${first} ${words.join(" ")}`.trim().split(/\s+/).length < 80) words.push("Look slowly and consider what the record leaves unknown.");
    return { id, title: "Synthetic lineage fixture", segments: [{ kind: id === "welcome" ? "fictional_context" as const : "fact" as const, text: first, citations: [{ spanId: span.id, quote: span.text }] }, { kind: "invitation" as const, text: words.join(" "), citations: [] }] };
  }), limitations: ["Synthetic integration fixture only; no actual provider or human review evidence."] }, spans);
  const artifact: ArtifactManifest = { id: randomUUID(), packageId: "research", title: "Synthetic input fixture", mediaType: "application/json", contentHash: digest(content), downloadUrl: "/fixture", previewUrl: null, sourceIds: sources.map(source => source.id), createdAt: new Date().toISOString(), provenance: { mode: "live", label: "Synthetic integration transport fixture; not external production", sourceId: randomUUID(), observedAt: new Date().toISOString(), sandbox: false }, reviewStatus: "Fixture only", content };
  await transaction(async db => { c.artifacts.push(artifact); const pkg = c.packages.find(pkg => pkg.id === "research")!; pkg.artifactIds.push(artifact.id); pkg.state = "submitted"; c.revision++; await saveCommission(db, c); });
  if (checked) await executeCommand(session, c.id, { type: "verify_artifact", commandId: randomUUID(), expectedRevision: c.revision, packageId: "research", artifactId: artifact.id });
  c = await getCommission(session, c.id);
  await executeCommand(session, c.id, { type: "record_automated_review", commandId: randomUUID(), expectedRevision: c.revision, packageId: "research", artifactId: artifact.id, artifactHash: artifact.contentHash, contractVersion: 1, findings: "Synthetic automated findings for a disposable test. No human review, actual generated work or payment is represented.", acknowledgeLimitations: true });
  return { session, commissionId: c.id, source: artifact };
}
type Fixture = Awaited<ReturnType<typeof fresh>>;
async function amended(f: Fixture) {
  let c = await getCommission(f.session, f.commissionId), proposal = draftDependencyProposal(c)!;
  await executeCommand(f.session, c.id, { type: "amend_draft_dependencies", commandId: randomUUID(), expectedRevision: c.revision, proposalDigest: proposal.digest });
  c = await getCommission(f.session, c.id);
  await executeCommand(f.session, c.id, { type: "approve_plan", commandId: randomUUID(), expectedRevision: c.revision, planDigest: planDigest(c) });
  return await getCommission(f.session, c.id);
}
async function queue(f: Fixture) {
  const c = await getCommission(f.session, f.commissionId), result = await executeCommand(f.session, c.id, { type: "produce_package", commandId: randomUUID(), expectedRevision: c.revision, packageId: "translation" });
  assert.ok(result.ok && result.jobId); return result.jobId;
}
function translationTransport(f: Fixture) {
  let requests = 0; const responses = new Map<string, unknown>();
  const labels = f.source.content.labels as { id: string; title: string; body: string }[];
  globalThis.fetch = async (input, init) => {
    requests++; const url = String(input); assert.ok(url.startsWith("https://api.openai.com/v1/responses"));
    if (init?.method === "POST") {
      const request = JSON.parse(String(init.body)), data = JSON.parse(request.input[1].content);
      assert.equal(data.inputBindings[0].artifactHash, f.source.contentHash); assert.equal(data.inputBindings[0].reviewKind, "automated_review");
      assert.equal(data.labels.length, labels.length, "each language receives the complete collection"); assert.equal(data.requiredLocales.length, 6);
      const responseId = `resp_translation_lineage_${data.targetLocale}`;
      responses.set(responseId, { locale: data.targetLocale, labels: Object.fromEntries(labels.map(label => [label.id, { title: label.title, body: label.body }])), limitations: ["Synthetic translation fixture; no linguistic quality claim."] });
      return Response.json({ id: responseId, status: "queued", output: [] });
    }
    const responseId = url.split("/").at(-1)!; assert.ok(responses.has(responseId));
    return Response.json({ id: responseId, status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(responses.get(responseId)) }] }] });
  };
  return () => requests;
}
async function runnable(jobId: string) { await getPool().query("UPDATE guild_jobs SET available_at=now() WHERE id=$1", [jobId]); await getPool().query("UPDATE guild_model_runs SET poll_after=now() WHERE job_id=$1", [jobId]); }

test("automated review cannot relax original dependencies; the explicit versioned amendment needs fresh approval", async () => {
  const f = await fresh(); let c = await getCommission(f.session, f.commissionId), proposal = draftDependencyProposal(c)!;
  await assert.rejects(queue(f), code("DEPENDENCIES_PENDING"));
  const old = structuredClone(c.packages), originalHash = c.artifacts[0]!.contentHash;
  await executeCommand(f.session, c.id, { type: "amend_draft_dependencies", commandId: randomUUID(), expectedRevision: c.revision, proposalDigest: proposal.digest }); c = await getCommission(f.session, c.id);
  assert.equal(c.approvedPlanDigest, null); await assert.rejects(queue(f), code("APPROVAL_REQUIRED"));
  assert.equal(c.artifacts[0]!.contentHash, originalHash); assert.equal(c.packages.find(pkg => pkg.kind === "research")!.state, "awaiting_acceptance");
  for (const pkg of c.packages) { const prior = old.find(item => item.id === pkg.id)!; assert.equal(pkg.grossMinor, prior.grossMinor); assert.deepEqual(pkg.acceptancePack, prior.acceptancePack); assert.equal(pkg.contractVersion, prior.contractVersion + Number(pkg.dependsOn.length > 0)); }
  const history = await getPool().query("SELECT count(*)::int AS count FROM guild_contract_amendments WHERE commission_id=$1", [c.id]); assert.equal(history.rows[0].count, 4);
  await executeCommand(f.session, c.id, { type: "approve_plan", commandId: randomUUID(), expectedRevision: c.revision, planDigest: planDigest(c) });
  const jobId = await queue(f), input = (await getPool().query("SELECT input FROM guild_jobs WHERE id=$1", [jobId])).rows[0].input;
  assert.equal(input.inputBindings[0].artifactId, f.source.id); assert.equal(input.inputBindings[0].artifactHash, originalHash); assert.equal(input.inputBindings[0].reviewKind, "automated_review");
});

test("a downstream draft preserves exact lineage and cannot be accepted until that same upstream work receives curator acceptance", async () => {
  const f = await fresh(); await amended(f); const jobId = await queue(f), count = translationTransport(f);
  let result: Awaited<ReturnType<typeof runNextJob>> = null;
  for (let step = 0; step < 12; step++) { await runnable(jobId); const before = count(); result = await runNextJob(f.session.tenantId); assert.ok(count() - before <= 1); if (result?.state === "completed") break; assert.equal(result?.state, "queued"); const current = await getCommission(f.session, f.commissionId); assert.equal(current.packages.find(pkg => pkg.id === "translation")!.artifactIds.length, 0); }
  assert.equal(result?.state, "completed"); assert.equal(count(), 10);
  let c = await getCommission(f.session, f.commissionId), pkg = c.packages.find(pkg => pkg.id === "translation")!, artifact = c.artifacts.find(item => item.id === pkg.artifactIds[0])!;
  assert.equal(artifact.content.sourceReviewKind, "automated_review"); assert.equal((artifact.content.modelRuns as unknown[]).length, 5); assert.equal(Object.keys(artifact.content.translations as object).length, 6); assert.equal((artifact.content.inputBindings as { artifactHash: string }[])[0]!.artifactHash, f.source.contentHash); assert.equal(artifact.content.fluentHumanReviewed, false);
  await executeCommand(f.session, c.id, { type: "verify_artifact", commandId: randomUUID(), expectedRevision: c.revision, packageId: pkg.id, artifactId: artifact.id }); c = await getCommission(f.session, c.id);
  const accept = () => executeCommand(f.session, c.id, { type: "accept_package", commandId: randomUUID(), expectedRevision: c.revision, packageId: pkg.id, artifactId: artifact.id, contractVersion: pkg.contractVersion, acknowledgeReview: true });
  await assert.rejects(accept(), code("INPUT_ACCEPTANCE_REQUIRED"));
  assert.equal(c.packages.find(pkg => pkg.id === "research")!.acceptedAt, null); assert.equal(c.payments.capturedMinor, 0);
  // Explicit acceptance below is confined to synthetic artifacts in this disposable test schema.
  await executeCommand(f.session, c.id, { type: "accept_package", commandId: randomUUID(), expectedRevision: c.revision, packageId: "research", artifactId: f.source.id, contractVersion: 1, acknowledgeReview: true }); c = await getCommission(f.session, c.id);
  assert.equal((await accept()).ok, true); c = await getCommission(f.session, c.id);
  assert.equal(c.packages.find(pkg => pkg.id === "translation")!.state, "accepted"); assert.equal(c.payments.capturedMinor, 0);
});

test("an automated note without passing exact saved checks cannot unlock a dependent draft", async () => {
  const f = await fresh(false); await amended(f);
  await assert.rejects(queue(f), code("DEPENDENCIES_PENDING"));
  const c = await getCommission(f.session, f.commissionId); assert.equal(c.jobs.length, 0); assert.equal(c.payments.capturedMinor, 0);
});

test("an upstream correction during a background run retains its original result without substituting sources", async () => {
  const f = await fresh(); await amended(f); const jobId = await queue(f), count = translationTransport(f);
  await runNextJob(f.session.tenantId);
  const c = await getCommission(f.session, f.commissionId);
  await executeCommand(f.session, c.id, { type: "request_correction", commandId: randomUUID(), expectedRevision: c.revision, packageId: "research", reason: "Synthetic test correction to the upstream draft after downstream dispatch." });
  await runnable(jobId); assert.equal((await runNextJob(f.session.tenantId))?.state, "needs_review"); assert.equal(count(), 2);
  const current = await getCommission(f.session, c.id); assert.equal(current.packages.find(pkg => pkg.id === "translation")!.artifactIds.length, 0);
  const run = (await getPool().query("SELECT status,provider_response_id,provider_output_text FROM guild_model_runs WHERE job_id=$1", [jobId])).rows[0]; assert.equal(run.status, "received"); assert.ok(run.provider_response_id); assert.ok(run.provider_output_text);
  await assert.rejects(queue(f), code("DEPENDENCIES_PENDING"));
});

test("an automated review survives unrelated revisions but refuses a changed check report or artifact", async () => {
  const f = await fresh(), before = await getCommission(f.session, f.commissionId), pkg = before.packages.find(item => item.id === "research")!;
  const command = { type: "record_automated_review" as const, commandId: randomUUID(), expectedRevision: before.revision, packageId: pkg.id, artifactId: f.source.id, artifactHash: f.source.contentHash, contractVersion: pkg.contractVersion, criteriaDigest: digest(pkg.acceptancePack), findings: "Synthetic review binding fixture. Only the exact saved artifact and checks were inspected; no human or payment decision.", acknowledgeLimitations: true as const };
  await transaction(async db => { const c = await getCommission(f.session, f.commissionId); c.revision += 20; await saveCommission(db, c); });
  const recorded = await executeCommand(f.session, before.id, command); assert.equal(recorded.ok, true);
  assert.deepEqual(await executeCommand(f.session, before.id, command), recorded, "the exact command remains idempotent after further revisions");
  let current = await getCommission(f.session, before.id); assert.equal(current.artifactReviews!.length, 2); assert.equal(current.packages.find(item => item.id === pkg.id)!.acceptedAt, null);
  await transaction(async db => { current.packages.find(item => item.id === pkg.id)!.acceptancePack.criteria[0]!.evidence = "A different check report."; current.revision++; await saveCommission(db, current); });
  const stale = await executeCommand(f.session, before.id, { ...command, commandId: randomUUID() }); assert.equal(stale.ok, false); if(!stale.ok)assert.equal(stale.code, "REVISION_CONFLICT");
  current = await getCommission(f.session, before.id);
  await assert.rejects(executeCommand(f.session, before.id, { ...command, commandId: randomUUID(), expectedRevision: current.revision }), code("REVIEW_CHECKS_CHANGED"));
  const wrongArtifact = await executeCommand(f.session, before.id, { ...command, commandId: randomUUID(), artifactHash: "0".repeat(64), criteriaDigest: digest(current.packages.find(item => item.id === pkg.id)!.acceptancePack) }); assert.equal(wrongArtifact.ok, false);
  assert.equal((await getCommission(f.session, before.id)).artifactReviews!.length, 2);
});
