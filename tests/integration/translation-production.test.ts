import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ArtifactManifest, Locale } from "../../src/contracts/guild";
import { isolatedPostgres } from "../support/postgres";
import { exhibitionCopy } from "../../src/exhibition/locales";
import { backTranslationSchema, translationAcceptancePack } from "../../src/domain/translation";
import { parseBatchObservation, VerifierBatchError, type VerifierBatchGateway, type VerifierBatchRequest } from "../../src/server/localization/gemini-batch-gateway";

const cleanup = await isolatedPostgres("guild_translation_test"); after(cleanup);
process.env.OPENAI_API_KEY = "fixture-translation-key-no-network"; process.env.OPENAI_MODEL = "fixture-translation-model";
const { createSession } = await import("../../src/server/session");
const { createCommission, executeCommand, getCommission, saveCommission } = await import("../../src/server/commissions");
const { getPool, transaction } = await import("../../src/server/db");
const { collectionNotes, planDigest } = await import("../../src/domain/fixture");
const { materializeResearch, researchSourceSpans } = await import("../../src/domain/research");
const { digest, DomainError } = await import("../../src/domain/primitives");
const { museumSources } = await import("../../src/exhibition/museum");
const { runNextJob } = await import("../../src/server/jobs");
const { artifactEvidence } = await import("../../src/server/artifact-evidence");
const originalFetch = globalThis.fetch; afterEach(() => { globalThis.fetch = originalFetch; });
const code = (value: string) => (error: unknown) => error instanceof DomainError && error.code === value;
async function fresh() {
  const { session } = await createSession(), sources = museumSources.slice(0, 1);
  let c = await createCommission(session, { commandId: randomUUID(), title: "Translation contract fixture", museum: "Fixture museum", objective: "Test full successor language terms and blind independent review with synthetic transport outputs, never actual provider work or payment.", capMinor: 64000, languages: ["en", "pt", "es", "fr", "ja", "ar"], sourceIds: sources.map(item => item.id) }, sources);
  await executeCommand(session, c.id, { type: "approve_plan", commandId: randomUUID(), expectedRevision: c.revision, planDigest: planDigest(c) }); c = await getCommission(session, c.id);
  const spans = researchSourceSpans(sources, collectionNotes);
  const content = materializeResearch({ labels: ["welcome", sources[0]!.id].map(id => {
    const span = spans.find(item => id === "welcome" ? item.sourceId === "note-purpose" : item.sourceId === id && item.field === "title")!;
    const words: string[] = []; while (`${span.text} ${words.join(" ")}`.trim().split(/\s+/).length < 80) words.push("You are invited to look carefully at the photograph. Consider which questions the catalogue answers and which remain uncertain. Before adding a story, think about the evidence that would support it. Ask what another record could help you understand about the picture and its original description.");
    return { id, title: "Synthetic source fixture", segments: [{ kind: id === "welcome" ? "fictional_context" as const : "fact" as const, text: span.text, citations: [{ spanId: span.id, quote: span.text }] }, { kind: "invitation" as const, text: words.join(" "), citations: [] }] };
  }), limitations: ["Synthetic integration fixture only, with no actual production or human review claim."] }, spans);
  const source: ArtifactManifest = { id: randomUUID(), packageId: "research", title: "Synthetic research fixture", mediaType: "application/json", contentHash: digest(content), downloadUrl: "/fixture", previewUrl: null, sourceIds: sources.map(item => item.id), createdAt: new Date().toISOString(), provenance: { mode: "live", label: "Synthetic fixture; not external production", sourceId: randomUUID(), observedAt: new Date().toISOString(), sandbox: false }, reviewStatus: "Fixture only", content };
  await transaction(async db => { c.artifacts.push(source); const pkg = c.packages.find(item => item.id === "research")!; pkg.artifactIds.push(source.id); pkg.state = "submitted"; c.revision++; await saveCommission(db, c); });
  await executeCommand(session, c.id, { type: "verify_artifact", commandId: randomUUID(), expectedRevision: c.revision, packageId: "research", artifactId: source.id }); c = await getCommission(session, c.id);
  // This explicit acceptance concerns only synthetic fixtures in an isolated schema.
  await executeCommand(session, c.id, { type: "accept_package", commandId: randomUUID(), expectedRevision: c.revision, packageId: "research", artifactId: source.id, contractVersion: 1, acknowledgeReview: true });
  return { session, commissionId: c.id, source };
}
type Fixture = Awaited<ReturnType<typeof fresh>>;
function modelTransport(f: Fixture) {
  const responses = new Map<string, unknown>(); let count = 0;
  globalThis.fetch = async (input, init) => {
    count++; assert.ok(String(input).startsWith("https://api.openai.com/v1/responses"));
    if (init?.method === "POST") {
      const request = JSON.parse(String(init.body)), data = JSON.parse(request.input[1].content), locale = data.targetLocale as Locale;
      const keys = data.english ? Object.keys(data.english) : data.labels.map((item: { id: string }) => item.id);
      const label = exhibitionCopy[locale].chapters.arrival;
      const result = { locale, labels: Object.fromEntries(keys.map((key: string) => [key, { title: label.title, body: label.body + " (Harbor Street; Detroit Publishing Co.; Library of Congress.)" }])), limitations: ["Synthetic transport fixture; linguistic meaning is not qualified."] };
      const responseId = `resp_fixture_${randomUUID().replaceAll("-", "")}`; responses.set(responseId, result);
      return Response.json({ id: responseId, status: "queued", output: [] });
    }
    const responseId = String(input).split("/").at(-1)!; assert.ok(responses.has(responseId));
    return Response.json({ id: responseId, status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(responses.get(responseId)) }] }] });
  };
  return () => count;
}
async function queue(f: Fixture, type: "produce_package" | "verify_artifact" = "produce_package") {
  const c = await getCommission(f.session, f.commissionId), pkg = c.packages.find(item => item.id === "translation")!;
  const result = await executeCommand(f.session, c.id, type === "produce_package" ? { type, commandId: randomUUID(), expectedRevision: c.revision, packageId: pkg.id } : { type, commandId: randomUUID(), expectedRevision: c.revision, packageId: pkg.id, artifactId: pkg.artifactIds.at(-1)! });
  assert.ok(result.ok && result.jobId); return result.jobId;
}
async function runnable(jobId: string) { await getPool().query("UPDATE guild_jobs SET available_at=now() WHERE id=$1", [jobId]); await getPool().query("UPDATE guild_model_runs SET poll_after=now() WHERE job_id=$1", [jobId]); await getPool().query("UPDATE guild_verifier_batches SET poll_after=now() WHERE job_id=$1", [jobId]); }
async function finish(f: Fixture, jobId: string, gateway?: VerifierBatchGateway) {
  let result: Awaited<ReturnType<typeof runNextJob>> = null;
  for (let step = 0; step < 16; step++) { await runnable(jobId); result = await runNextJob(f.session.tenantId, { verifier: gateway }); if (result?.state !== "queued") return result; }
  return result;
}
async function previousDraft(f: Fixture) {
  modelTransport(f); const jobId = await queue(f); assert.equal((await finish(f, jobId))?.state, "completed");
  const c = await getCommission(f.session, f.commissionId), pkg = c.packages.find(item => item.id === "translation")!, artifact = c.artifacts.find(item => item.id === pkg.artifactIds[0])!;
  await executeCommand(f.session, c.id, { type: "verify_artifact", commandId: randomUUID(), expectedRevision: c.revision, packageId: pkg.id, artifactId: artifact.id });
  return artifact;
}
async function amend(f: Fixture, prior: ArtifactManifest | null) {
  const c = await getCommission(f.session, f.commissionId), pkg = c.packages.find(item => item.id === "translation")!;
  return executeCommand(f.session, c.id, { type: "amend_translation_contract", commandId: randomUUID(), expectedRevision: c.revision, packageId: pkg.id, contractVersion: pkg.contractVersion, acceptancePackDigest: translationAcceptancePack(f.source).digest, priorArtifactId: prior?.id ?? null, priorArtifactHash: prior?.contentHash ?? null, acknowledgeSuccessor: true });
}
async function approvedSuccessor(f: Fixture) { const prior = await previousDraft(f); await amend(f, prior); const c = await getCommission(f.session, f.commissionId); await executeCommand(f.session, c.id, { type: "approve_plan", commandId: randomUUID(), expectedRevision: c.revision, planDigest: planDigest(c) }); return prior; }

class BatchFixture implements VerifierBatchGateway {
  creates = 0; reads = 0; request: VerifierBatchRequest | null = null;
  constructor(readonly source: ArtifactManifest, readonly mode: "ok" | "unknown" | "known_malformed" = "ok") {}
  async create(request: VerifierBatchRequest) {
    this.creates++; this.request = request;
    assert.equal(request.temperature, 1); assert.ok(request.requests.every(item => item.schemaFormat === "response_schema"));
    const english = Object.fromEntries((this.source.content.labels as { id: string; title: string; body: string }[]).map(item => [item.id, { title: item.title, body: item.body }]));
    assert.equal(request.requests.length, 5); for (const item of request.requests) { assert.ok(!Object.keys(item.input as object).includes("english")); assert.ok(!JSON.stringify(item.input).includes(english.welcome!.body)); assert.deepEqual(item.schema, z.toJSONSchema(backTranslationSchema(Object.keys(english)))); }
    if (this.mode === "unknown") throw new VerifierBatchError("FIXTURE_LOST_CREATE", false);
    if (this.mode === "known_malformed") throw new VerifierBatchError("VERIFIER_RESPONSE_FORMAT", false, `batches/fixture-${request.operationId}`, { name: `batches/fixture-${request.operationId}`, metadata: { state: "FUTURE_STATE" } });
    return parseBatchObservation({ name: `batches/fixture-${request.operationId}`, metadata: { state: "BATCH_STATE_RUNNING" } });
  }
  async get(name: string) {
    this.reads++; assert.equal(name, `batches/fixture-${this.request!.operationId}`);
    const labels = Object.fromEntries((this.source.content.labels as { id: string; title: string; body: string }[]).map(item => [item.id, { title: item.title, body: item.body }]));
    return parseBatchObservation({ name, metadata: { state: "BATCH_STATE_SUCCEEDED" }, done: true, response: { inlinedResponses: { inlinedResponses: this.request!.requests.map(item => ({ metadata: { key: item.key }, response: { modelVersion: "gemini-3.8-flash", responseId: `fixture-${item.key}`, candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ labels, limitations: ["Synthetic independent transport output."] }) }] } }] } })) } } });
  }
}

test("the explicit successor retains original contract/checks and releases only the unaccepted reservation before fresh approval", async () => {
  const f = await fresh(), prior = await previousDraft(f), before = await getCommission(f.session, f.commissionId), old = structuredClone(before.packages.find(item => item.id === "translation")!), oldRoot = before.mandates[0]!.reservedMinor;
  await amend(f, prior); let c = await getCommission(f.session, f.commissionId), pkg = c.packages.find(item => item.id === "translation")!;
  assert.equal(pkg.contractVersion, old.contractVersion + 1); assert.equal(pkg.acceptancePack.version, "2.0.0"); assert.equal(pkg.grossMinor, old.grossMinor); assert.deepEqual(pkg.artifactIds, []); assert.equal(c.approvedPlanDigest, null);
  assert.equal(c.artifacts.find(item => item.id === prior.id)!.contentHash, prior.contentHash); assert.equal(c.mandates[0]!.reservedMinor, oldRoot - old.grossMinor);
  const evidence = await artifactEvidence(f.session, prior.id); assert.deepEqual(evidence.earlierContracts[0]!.contract, old); assert.equal(evidence.checkReports.length, 1); assert.equal(evidence.currentContract, null);
  await assert.rejects(queue(f), code("APPROVAL_REQUIRED"));
  await executeCommand(f.session, c.id, { type: "approve_plan", commandId: randomUUID(), expectedRevision: c.revision, planDigest: planDigest(c) });
  await queue(f); c = await getCommission(f.session, c.id); assert.equal(c.mandates[0]!.reservedMinor, oldRoot);
  const reservations = (await getPool().query("SELECT state,amount_minor FROM guild_budget_reservations WHERE tenant_id=$1 AND operation_key LIKE $2 ORDER BY created_at", [f.session.tenantId, `production:${c.id}:translation:%`])).rows;
  assert.deepEqual(reservations.map(item => item.state), ["released", "reserved"]); assert.equal(c.payments.capturedMinor, 0);
  const other = (await createSession()).session; await assert.rejects(artifactEvidence(other, prior.id), code("ARTIFACT_NOT_FOUND"));
});

test("a new full submission receives every deterministic language check and separate durable blind advisory without human acceptance", async () => {
  const f = await fresh(); await approvedSuccessor(f); const jobId = await queue(f); assert.equal((await finish(f, jobId))?.state, "completed");
  let c = await getCommission(f.session, f.commissionId), pkg = c.packages.find(item => item.id === "translation")!, artifact = c.artifacts.find(item => item.id === pkg.artifactIds[0])!;
  assert.equal(artifact.content.schemaVersion, "guild.translation.v2"); assert.equal(artifact.content.contractDigest, pkg.acceptancePack.digest);
  const verifier = new BatchFixture(f.source), verification = await queue(f, "verify_artifact"); assert.equal((await finish(f, verification, verifier))?.state, "completed");
  c = await getCommission(f.session, f.commissionId); pkg = c.packages.find(item => item.id === "translation")!;
  assert.ok(pkg.acceptancePack.criteria.filter(item => item.kind === "deterministic").every(item => item.status === "passed"), JSON.stringify(pkg.acceptancePack.criteria));
  assert.equal(pkg.acceptancePack.criteria.find(item => item.id === "back_translation")!.status, "review"); assert.equal(pkg.acceptancePack.criteria.find(item => item.id === "meaning")!.status, "review"); assert.equal(pkg.acceptedAt, null); assert.equal(pkg.paymentState, "not_eligible"); assert.equal(verifier.creates, 1); assert.equal(verifier.reads, 1);
  const second = await queue(f, "verify_artifact"); assert.equal((await finish(f, second, verifier))?.state, "completed"); assert.equal(verifier.creates, 1); assert.equal(verifier.reads, 1, "a repeat check reuses its immutable advisory");
  const evidence = await artifactEvidence(f.session, artifact.id); assert.equal(evidence.independentReports.length, 2); assert.equal(c.payments.capturedMinor, 0);
});

test("an ambiguous independent create is retained and never resubmitted by a repeated verification", async () => {
  const f = await fresh(); await approvedSuccessor(f); await finish(f, await queue(f));
  const verifier = new BatchFixture(f.source, "unknown"); await finish(f, await queue(f, "verify_artifact"), verifier); await finish(f, await queue(f, "verify_artifact"), verifier);
  assert.equal(verifier.creates, 1); assert.equal(verifier.reads, 0);
  const row = (await getPool().query("SELECT state,provider_batch_id,request,failure_code FROM guild_verifier_batches WHERE tenant_id=$1", [f.session.tenantId])).rows[0]; assert.equal(row.state, "indeterminate"); assert.equal(row.provider_batch_id, null); assert.ok(row.request); assert.equal(row.failure_code, "FIXTURE_LOST_CREATE");
  const c = await getCommission(f.session, f.commissionId); assert.equal(c.packages.find(item => item.id === "translation")!.acceptancePack.criteria.find(item => item.id === "back_translation")!.status, "review"); assert.equal(c.payments.capturedMinor, 0);
});

test("a known batch survives malformed create metadata and a paused commission using only its original read identity", async () => {
  const f = await fresh(); await approvedSuccessor(f); await finish(f, await queue(f));
  const verifier = new BatchFixture(f.source, "known_malformed"), jobId = await queue(f, "verify_artifact"); assert.equal((await runNextJob(f.session.tenantId, { verifier }))?.state, "queued");
  let c = await getCommission(f.session, f.commissionId); await executeCommand(f.session, c.id, { type: "pause", commandId: randomUUID(), expectedRevision: c.revision });
  await runnable(jobId); assert.equal((await runNextJob(f.session.tenantId, { verifier }))?.state, "queued"); assert.equal(verifier.creates, 1); assert.equal(verifier.reads, 1);
  c = await getCommission(f.session, c.id); assert.equal(c.state, "paused"); await executeCommand(f.session, c.id, { type: "resume", commandId: randomUUID(), expectedRevision: c.revision });
  assert.equal((await finish(f, jobId, verifier))?.state, "completed"); assert.equal(verifier.creates, 1); assert.equal(verifier.reads, 1);
});

test("active work and accepted original work cannot be silently moved to the successor standard", async () => {
  const f = await fresh(), prior = await previousDraft(f); let c = await getCommission(f.session, f.commissionId);
  const runningJob = await queue(f); await assert.rejects(amend(f, prior), code("TRANSLATION_AMENDMENT_ACCEPTED")); await finish(f, runningJob);
  c = await getCommission(f.session, f.commissionId); const pkg = c.packages.find(item => item.id === "translation")!, artifactId = pkg.artifactIds.at(-1)!;
  await executeCommand(f.session, c.id, { type: "verify_artifact", commandId: randomUUID(), expectedRevision: c.revision, packageId: pkg.id, artifactId }); c = await getCommission(f.session, c.id);
  await executeCommand(f.session, c.id, { type: "accept_package", commandId: randomUUID(), expectedRevision: c.revision, packageId: pkg.id, artifactId, contractVersion: pkg.contractVersion, acknowledgeReview: true });
  await assert.rejects(amend(f, c.artifacts.find(item => item.id === artifactId)!), code("TRANSLATION_AMENDMENT_ACCEPTED"));
});

test("a changed stored verifier generation configuration cannot be consumed or dispatched again", async () => {
  const f = await fresh(); await approvedSuccessor(f); await finish(f, await queue(f));
  const verifier = new BatchFixture(f.source); await finish(f, await queue(f, "verify_artifact"), verifier);
  await getPool().query("UPDATE guild_verifier_batches SET request=jsonb_set(request,'{temperature}','0.2'::jsonb) WHERE tenant_id=$1", [f.session.tenantId]);
  const outcome = await finish(f, await queue(f, "verify_artifact"), verifier);
  assert.equal(outcome?.state, "needs_review"); assert.equal(verifier.creates, 1); assert.equal(verifier.reads, 1);
  const c = await getCommission(f.session, f.commissionId); assert.equal(c.packages.find(item => item.id === "translation")!.acceptedAt, null); assert.equal(c.payments.capturedMinor, 0);
});
