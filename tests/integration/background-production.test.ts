import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isolatedPostgres } from "../support/postgres";
import type { Commission } from "../../src/contracts/guild";
import type { ResearchDraft, ResearchSourceSpan } from "../../src/domain/research";

const cleanup = await isolatedPostgres("guild_background_test"); after(cleanup);
process.env.OPENAI_API_KEY = "fixture-key-never-used-on-network";
process.env.OPENAI_MODEL = "fixture-producing-model"; process.env.OPENAI_PLANNER_MODEL = "fixture-planning-model";
const { createSession } = await import("../../src/server/session");
const { createCommission, executeCommand, getCommission, saveCommission } = await import("../../src/server/commissions");
const { getPool, transaction } = await import("../../src/server/db");
const { planDigest } = await import("../../src/domain/fixture");
const { museumSources } = await import("../../src/exhibition/museum");
const { runNextJob } = await import("../../src/server/jobs");
const { pollSavedModelResponse } = await import("../../src/server/models");
const { DomainError } = await import("../../src/domain/primitives");
const originalFetch = globalThis.fetch; afterEach(() => { globalThis.fetch = originalFetch; });
const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;

async function fresh(sourceCount = 1) {
  const { session } = await createSession(), sources = museumSources.slice(0, sourceCount);
  let c = await createCommission(session, { commandId: randomUUID(), title: "Background production fixture", museum: "Fixture museum", objective: "Test saved provider identities, full source context and recovery without any real model or payment request.", capMinor: 64000, languages: ["en", "pt", "es", "fr", "ja", "ar"], sourceIds: sources.map(source => source.id) }, sources);
  await executeCommand(session, c.id, { type: "approve_plan", commandId: randomUUID(), expectedRevision: c.revision, planDigest: planDigest(c) });
  c = await getCommission(session, c.id);
  const queued = await executeCommand(session, c.id, { type: "produce_package", commandId: randomUUID(), expectedRevision: c.revision, packageId: "research" });
  assert.ok(queued.ok && queued.jobId);
  return { session, commissionId: c.id, jobId: queued.jobId, sources };
}
type Fixture = Awaited<ReturnType<typeof fresh>>;
async function ready(f: Fixture) {
  await getPool().query("UPDATE guild_jobs SET available_at=now() WHERE id=$1", [f.jobId]);
  await getPool().query("UPDATE guild_model_runs SET poll_after=now() WHERE job_id=$1", [f.jobId]);
}
async function change(f: Fixture, update: (c: Commission) => void) {
  await transaction(async db => {
    const c = (await db.query<{ snapshot: Commission }>("SELECT snapshot FROM guild_commissions WHERE id=$1 FOR UPDATE", [f.commissionId])).rows[0]!.snapshot;
    update(c); c.revision++; await saveCommission(db, c);
  });
}
function draft(ids: string[], spans: ResearchSourceSpan[]): ResearchDraft {
  return { labels: ids.map(id => {
    const span = spans.find(item => id === "welcome" ? item.sourceId === "note-purpose" : item.sourceId === id && item.field === "title")!;
    const first = id === "welcome" ? span.text : `The archive calls this photograph “${span.text}”.`;
    const invitation: string[] = [];
    while (`${first} ${invitation.join(" ")}`.trim().split(/\s+/).length < 80) invitation.push("Look slowly and consider what the record leaves unknown.");
    return { id, title: "Synthetic verifier fixture", segments: [{ kind: id === "welcome" ? "fictional_context" as const : "fact" as const, text: first, citations: [{ spanId: span.id, quote: span.text }] }, { kind: "invitation" as const, text: invitation.join(" "), citations: [] }] };
  }), limitations: ["Synthetic integration fixture; not actual generated work or human review."] };
}
function fixtureTransport(pendingReads = 0) {
  const calls: { method: string; url: string; input?: Record<string, unknown> }[] = [];
  const saved = new Map<string, { draft: ResearchDraft; reads: number }>();
  globalThis.fetch = async (input, init) => {
    const url = String(input), method = init?.method ?? "GET";
    assert.ok(url.startsWith("https://api.openai.com/v1/responses"));
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-key-never-used-on-network");
    if (method === "POST") {
      assert.equal(url, "https://api.openai.com/v1/responses");
      const request = JSON.parse(String(init?.body));
      assert.equal(request.background, true); assert.equal(request.store, false); assert.equal(request.reasoning.effort, "max");
      const data = JSON.parse(request.input[1].content) as { requestedLabelIds: string[]; sourceSpans: ResearchSourceSpan[]; collectionLabelIds: string[]; contract: { digest: string } };
      const id = `resp_fixture_${randomUUID().replaceAll("-", "")}`;
      calls.push({ method, url, input: data }); saved.set(id, { draft: draft(data.requestedLabelIds, data.sourceSpans), reads: 0 });
      return Response.json({ id, status: "queued", output: [] });
    }
    calls.push({ method, url });
    const id = url.split("/").at(-1)!, result = saved.get(id); assert.ok(result, "GET must use a previously returned response identity");
    result.reads++;
    return result.reads <= pendingReads ? Response.json({ id, status: "in_progress", output: [] }) : Response.json({ id, status: "completed", usage: { total_tokens: 1 }, output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(result.draft) }] }] });
  };
  return { calls, saved };
}

test("all thirteen labels survive repeated short polls with one create per saved batch", async () => {
  const f = await fresh(12), transport = fixtureTransport(1);
  let outcome: Awaited<ReturnType<typeof runNextJob>> = null;
  for (let step = 0; step < 20; step++) {
    await ready(f); const before = transport.calls.length; outcome = await runNextJob(f.session.tenantId);
    assert.ok(transport.calls.length - before <= 1, "one provider HTTP request per worker invocation");
    const c = await getCommission(f.session, f.commissionId);
    if (outcome?.state === "completed") break;
    assert.equal(outcome?.state, "queued"); assert.equal(c.artifacts.length, 0, "partial drafts are not submitted as a full artifact");
    assert.equal(c.packages[0]!.state, "producing"); assert.equal(c.jobs[0]!.error, null);
  }
  assert.equal(outcome?.state, "completed");
  const c = await getCommission(f.session, f.commissionId), artifact = c.artifacts[0]!;
  assert.equal((artifact.content.labels as unknown[]).length, 13); assert.equal((artifact.content.modelRuns as unknown[]).length, 5);
  assert.equal(transport.calls.filter(call => call.method === "POST").length, 5);
  assert.equal(transport.calls.filter(call => call.method === "GET").length, 10);
  for (const call of transport.calls.filter(item => item.method === "POST")) {
    assert.equal((call.input!.collectionLabelIds as unknown[]).length, 13);
    assert.equal((call.input!.sourceSpans as unknown[]).length, 63, "every batch carries the complete frozen source context");
    assert.equal((call.input!.contract as { digest: string }).digest, c.packages[0]!.acceptancePack.digest);
  }
  assert.ok(c.jobs[0]!.attempts > 3, "continuations are not mistaken for three failed attempts");
  assert.equal(c.packages[0]!.paymentState, "not_eligible"); assert.equal(c.packages[0]!.acceptedAt, null);
  const decisions = await getPool().query("SELECT count(*)::int AS count FROM guild_acceptance_decisions WHERE commission_id=$1", [c.id]); assert.equal(decisions.rows[0].count, 0);
});

test("a crash after receipt storage resumes the original job without another provider request", async () => {
  const f = await fresh(), transport = fixtureTransport();
  assert.equal((await runNextJob(f.session.tenantId))?.state, "queued"); await ready(f);
  await pollSavedModelResponse({ jobId: f.jobId, tenantId: f.session.tenantId, externalCalls: 0 });
  await getPool().query("UPDATE guild_jobs SET state='running',lease_until=now()-interval '1 minute',attempts=7 WHERE id=$1", [f.jobId]);
  const before = transport.calls.length;
  assert.equal((await runNextJob(f.session.tenantId))?.state, "completed"); assert.equal(transport.calls.length, before);
  const c = await getCommission(f.session, f.commissionId); assert.equal(c.artifacts.length, 1); assert.equal(c.jobs[0]!.attempts, 8);
});

test("an ambiguous create is retained and neither a duplicate click nor a worker recovery can replace it", async () => {
  const f = await fresh(); let calls = 0;
  globalThis.fetch = async () => { calls++; throw new TypeError("fixture transport lost after possible dispatch"); };
  assert.equal((await runNextJob(f.session.tenantId))?.state, "needs_review");
  const row = (await getPool().query("SELECT status,provider_response_id FROM guild_model_runs WHERE job_id=$1", [f.jobId])).rows[0];
  assert.equal(row.status, "indeterminate"); assert.equal(row.provider_response_id, null);
  let c = await getCommission(f.session, f.commissionId); assert.equal(c.artifacts.length, 0); assert.equal(c.jobs[0]!.blocksNewProduction, true);
  await assert.rejects(executeCommand(f.session, c.id, { type: "produce_package", commandId: randomUUID(), expectedRevision: c.revision, packageId: "research" }), code("ORIGINAL_MODEL_RESULT_PENDING"));
  await change(f, current => { current.packages[0]!.state = "producing"; });
  await getPool().query("UPDATE guild_jobs SET state='queued',available_at=now() WHERE id=$1", [f.jobId]);
  assert.equal((await runNextJob(f.session.tenantId))?.state, "needs_review"); assert.equal(calls, 1);
  c = await getCommission(f.session, f.commissionId); assert.equal(c.artifacts.length, 0);
});

test("an unresolved foreground run cannot be replaced by the new background protocol", async () => {
  const f = await fresh(); let calls = 0; globalThis.fetch = async () => { calls++; throw new Error("must not dispatch"); };
  await getPool().query("INSERT INTO guild_model_runs(id,tenant_id,job_id,provider,model,prompt_version,input_hash,status) VALUES($1,$2,$3,'openai','old-fixture-model','museum_research_spans_v2.v1','old-fixture-hash','failed')", [randomUUID(), f.session.tenantId, f.jobId]);
  assert.equal((await runNextJob(f.session.tenantId))?.state, "needs_review"); assert.equal(calls, 0);
  const c = await getCommission(f.session, f.commissionId);
  await assert.rejects(executeCommand(f.session, c.id, { type: "produce_package", commandId: randomUUID(), expectedRevision: c.revision, packageId: "research" }), code("ORIGINAL_MODEL_RESULT_PENDING"));
});

test("transient status-read failures only re-read the retained response identity", async () => {
  const f = await fresh(), transport = fixtureTransport();
  await runNextJob(f.session.tenantId); const api = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError("fixture GET connection loss"); };
  for (let index = 0; index < 4; index++) { await ready(f); assert.equal((await runNextJob(f.session.tenantId))?.state, "queued"); }
  globalThis.fetch = api; await ready(f);
  assert.equal((await runNextJob(f.session.tenantId))?.state, "completed");
  assert.equal(transport.calls.filter(call => call.method === "POST").length, 1);
  const runs = await getPool().query("SELECT status,poll_count FROM guild_model_runs WHERE job_id=$1", [f.jobId]);
  assert.equal(runs.rows.length, 1); assert.equal(runs.rows[0].status, "completed"); assert.equal(runs.rows[0].poll_count, 5);
});

test("a changed objective cannot borrow the identity or cached output of an older model request", async () => {
  const f = await fresh(), transport = fixtureTransport(); await runNextJob(f.session.tenantId);
  await change(f, c => { c.objective += " A materially different objective after dispatch."; }); await ready(f);
  assert.equal((await runNextJob(f.session.tenantId))?.state, "needs_review");
  const row = (await getPool().query("SELECT status,provider_output_text FROM guild_model_runs WHERE job_id=$1", [f.jobId])).rows[0];
  assert.equal(row.status, "received"); assert.ok(row.provider_output_text);
  assert.equal(transport.calls.filter(call => call.method === "POST").length, 1);
  assert.equal((await getCommission(f.session, f.commissionId)).artifacts.length, 0);
});

test("revocation still saves an in-flight result but prevents the next batch and submission", async () => {
  const f = await fresh(12), transport = fixtureTransport(); await runNextJob(f.session.tenantId);
  const c = await getCommission(f.session, f.commissionId);
  await executeCommand(f.session, c.id, { type: "revoke_mandate", commandId: randomUUID(), expectedRevision: c.revision, mandateId: "passport-root" }); await ready(f);
  assert.equal((await runNextJob(f.session.tenantId))?.state, "needs_review");
  const row = (await getPool().query("SELECT status,provider_output_text FROM guild_model_runs WHERE job_id=$1", [f.jobId])).rows[0];
  assert.equal(row.status, "received"); assert.ok(row.provider_output_text);
  assert.equal(transport.calls.filter(call => call.method === "POST").length, 1); assert.equal((await getCommission(f.session, f.commissionId)).artifacts.length, 0);
});

test("pause retains a known response and resume completes from it without a second create", async () => {
  const f = await fresh(), transport = fixtureTransport(); await runNextJob(f.session.tenantId);
  let c = await getCommission(f.session, f.commissionId);
  await executeCommand(f.session, c.id, { type: "pause", commandId: randomUUID(), expectedRevision: c.revision }); await ready(f);
  assert.equal((await runNextJob(f.session.tenantId))?.state, "queued");
  c = await getCommission(f.session, f.commissionId); assert.equal(c.state, "paused"); assert.equal(c.artifacts.length, 0);
  await executeCommand(f.session, c.id, { type: "resume", commandId: randomUUID(), expectedRevision: c.revision }); await ready(f);
  assert.equal((await runNextJob(f.session.tenantId))?.state, "completed"); assert.equal(transport.calls.length, 2);
});

test("an expired or mismatched response stops with its original identity and no new create", async () => {
  for (const outcome of ["expired", "mismatched"] as const) {
    const f = await fresh(), transport = fixtureTransport(); await runNextJob(f.session.tenantId);
    const originalId = [...transport.saved.keys()][0]!;
    globalThis.fetch = async (_input, init) => { assert.equal(init?.method, "GET"); return outcome === "expired" ? new Response(null, { status: 404 }) : Response.json({ id: "resp_foreign_fixture", status: "completed", output: [] }); };
    await ready(f); assert.equal((await runNextJob(f.session.tenantId))?.state, "needs_review");
    const row = (await getPool().query("SELECT status,provider_response_id FROM guild_model_runs WHERE job_id=$1", [f.jobId])).rows[0];
    assert.equal(row.status, "unavailable"); assert.equal(row.provider_response_id, originalId); assert.equal(transport.calls.length, 1);
  }
});

test("concurrent worker recovery claims a job once and creates only one provider response", async () => {
  const f = await fresh(), transport = fixtureTransport();
  const results = await Promise.all([runNextJob(f.session.tenantId), runNextJob(f.session.tenantId), runNextJob(f.session.tenantId)]);
  assert.equal(results.filter(result => result?.state === "queued").length, 1); assert.equal(results.filter(result => result === null).length, 2);
  assert.equal(transport.calls.length, 1);
});
