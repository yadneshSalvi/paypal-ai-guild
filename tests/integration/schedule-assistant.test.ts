import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isolatedPostgres } from "../support/postgres";
import { assistantToolDefinitions, startAssistantSchema, type AssistantHistory, type AssistantRunView } from "../../src/scheduling/assistant";

const cleanup = await isolatedPostgres("guild_schedule_ai_test"); after(cleanup);
for (const key of ["GEMINI_API_KEY", "BLOB_READ_WRITE_TOKEN", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"]) process.env[key] = "";
process.env.OPENAI_API_KEY = "fixture-planner-key-not-a-provider-credential";
const originalFetch = globalThis.fetch; after(() => { globalThis.fetch = originalFetch; });
globalThis.fetch = async () => { throw new Error("No external network is permitted in this test."); };
const { createSession } = await import("../../src/server/session");
const { seedCommission, getCommission, executeCommand, saveCommission } = await import("../../src/server/commissions");
const { getPool, transaction } = await import("../../src/server/db");
const { planDigest } = await import("../../src/domain/fixture");
const { executeScheduleCommand, schedulingWorkspace } = await import("../../src/server/scheduling");
const { startScheduleAssistant, readScheduleAssistant, executeScheduleAssistantTool } = await import("../../src/server/schedule-assistant");
const code = (wanted: string) => (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === wanted;
async function fixture() {
  const { session } = await createSession(), c = await seedCommission(session);
  await executeCommand(session, c.id, { type: "approve_plan", commandId: randomUUID(), expectedRevision: c.revision, planDigest: planDigest(c) });
  const current = await getCommission(session, c.id);
  await executeScheduleCommand(session, c.id, { type: "initialize_schedule", commandId: randomUUID(), expectedRevision: current.revision });
  return { session, id: c.id };
}
const request = () => startAssistantSchema.parse({ requestId: randomUUID(), conversationId: randomUUID(), messages: [{ role: "user", content: "Read the opening plan and prepare a safe proposal if needed." }], toolNames: assistantToolDefinitions.map(tool => tool.name) });
function completed(id: string, name: string, args: unknown, callId = "call_fixture") {
  return Response.json({ id, status: "completed", output: [{ type: "function_call", call_id: callId, name, arguments: JSON.stringify(args) }], usage: { input_tokens: 25, output_tokens: 10, total_tokens: 35 } });
}

test("one uncertain planner create is quarantined across replay and new conversation identities", async () => {
  const f = await fixture(), input = request(); let creates = 0;
  globalThis.fetch = async (_url, init) => { assert.equal(init?.method, "POST"); creates++; throw new Error("Synthetic dropped response, no identity"); };
  const first = await startScheduleAssistant(f.session, f.id, input); assert.equal(first.state, "indeterminate");
  const replay = await startScheduleAssistant(f.session, f.id, input); assert.equal(replay.id, first.id); assert.equal(creates, 1);
  await assert.rejects(startScheduleAssistant(f.session, f.id, { ...input, messages: [{ role: "user", content: "Different input" }] }), code("ASSISTANT_REQUEST_CHANGED"));
  await assert.rejects(startScheduleAssistant(f.session, f.id, request()), code("ASSISTANT_PENDING")); assert.equal(creates, 1);
  assert.equal(Number((await getPool().query("SELECT count(*) FROM guild_jobs WHERE tenant_id=$1", [f.session.tenantId])).rows[0].count), 0);
});

test("background responses use one original ID, max reasoning and the canonical tool allowlist", async () => {
  const f = await fixture(); let creates = 0, reads = 0;
  globalThis.fetch = async (url, init) => {
    if (init?.method === "POST") {
      creates++; assert.equal(String(url), "https://api.openai.com/v1/responses"); const body = JSON.parse(String(init.body));
      assert.equal(body.model, "gpt-6.1-sol"); assert.deepEqual(body.reasoning, { effort: "max" }); assert.equal(body.background, true); assert.equal(body.store, true); assert.equal("temperature" in body, false);
      assert.deepEqual(body.tools.map((tool: { name: string }) => tool.name).sort(), assistantToolDefinitions.map(tool => tool.name).sort());
      assert.equal(body.tools.some((tool: { name: string }) => /updateTask|approve|pay|renew/.test(tool.name)), false);
      return Response.json({ id: "resp_fixture_saved", status: "queued" });
    }
    assert.equal(String(url), "https://api.openai.com/v1/responses/resp_fixture_saved"); reads++;
    return completed("resp_fixture_saved", "getOpeningPlan", {});
  };
  const input = request(), [first, replay] = await Promise.all([startScheduleAssistant(f.session, f.id, input), startScheduleAssistant(f.session, f.id, input)]);
  assert.equal(first.id, replay.id); assert.equal(creates, 1);
  await getPool().query("UPDATE guild_schedule_ai_runs SET poll_after=NULL WHERE id=$1", [first.id]);
  const saved = await readScheduleAssistant(f.session, f.id, { id: first.id }) as AssistantRunView;
  assert.equal(saved.state, "completed"); assert.equal(reads, 1); assert.equal(saved.result!.choices[0].message.tool_calls![0]!.function.name, "getOpeningPlan");
  const tool = { runId: first.id, callId: "call_fixture", name: "getOpeningPlan" as const, args: {} };
  const result = await executeScheduleAssistantTool(f.session, f.id, tool), again = await executeScheduleAssistantTool(f.session, f.id, tool);
  assert.deepEqual(result, again); assert.equal((result as { ok: boolean }).ok, true);
  await assert.rejects(executeScheduleAssistantTool(f.session, f.id, { ...tool, callId: "call_invented" }), code("ASSISTANT_TOOL_BINDING"));
  await assert.rejects(executeScheduleAssistantTool(f.session, f.id, { ...tool, name: "compareRecoveryQuotes" }), code("ASSISTANT_TOOL_BINDING"));
  assert.equal(Number((await getPool().query("SELECT count(*) FROM guild_schedule_ai_tool_results WHERE run_id=$1", [first.id])).rows[0].count), 1);
  const c = await getCommission(f.session, f.id); assert.equal(c.payments.capturedMinor, 0); assert.equal(c.packages.filter(item => item.acceptedAt).length, 0);
});

test("an exact assistant call saves one proposal while preserving the active schedule and financial state", async () => {
  const f = await fixture(), before = await schedulingWorkspace(f.session, f.id), c = await getCommission(f.session, f.id); let creates = 0;
  const args = { patch: { type: "move_task", taskId: "images", notBefore: "2026-11-12T16:00:00.000Z" } };
  globalThis.fetch = async () => { creates++; return completed("resp_fixture_proposal", "proposeOpeningChange", args); };
  const run = await startScheduleAssistant(f.session, f.id, request());
  const tool = { runId: run.id, callId: "call_fixture", name: "proposeOpeningChange" as const, args };
  const [first, replay] = await Promise.all([executeScheduleAssistantTool(f.session, f.id, tool), executeScheduleAssistantTool(f.session, f.id, tool)]);
  assert.deepEqual(first, replay); assert.equal(creates, 1);
  const after = await schedulingWorkspace(f.session, f.id); assert.equal(after.schedule!.digest, before.schedule!.digest); assert.equal(after.proposals.length, 1);
  const current = await getCommission(f.session, f.id); assert.equal(planDigest(current), planDigest(c)); assert.equal(current.payments.capturedMinor, 0);
  assert.equal(Number((await getPool().query("SELECT count(*) FROM guild_jobs WHERE tenant_id=$1", [f.session.tenantId])).rows[0].count), 0);
  await assert.rejects(executeScheduleAssistantTool(f.session, f.id, { ...tool, args: { patch: { ...args.patch, notBefore: "2026-11-19T16:00:00.000Z" } } }), code("ASSISTANT_TOOL_BINDING"));
});

test("generic mutation tools, empty output, stale source and revoked actors cannot reach proposals", async () => {
  const f = await fixture(); let creates = 0;
  globalThis.fetch = async () => { creates++; return completed("resp_fixture_forbidden", "updateTask", { priceMinor: 1 }); };
  const forbidden = await startScheduleAssistant(f.session, f.id, request()); assert.equal(forbidden.state, "failed"); assert.equal(forbidden.result, null); assert.equal(creates, 1);
  globalThis.fetch = async () => { creates++; return Response.json({ id: "resp_fixture_empty", status: "completed", output: [] }); };
  assert.equal((await startScheduleAssistant(f.session, f.id, request())).state, "failed"); assert.equal(creates, 2);
  globalThis.fetch = async () => { creates++; return completed("resp_fixture_stale", "proposeOpeningChange", { patch: { type: "reconcile_source" } }); };
  const stale = await startScheduleAssistant(f.session, f.id, request());
  const c = await getCommission(f.session, f.id); c.revision++; await transaction(db => saveCommission(db, c));
  await assert.rejects(executeScheduleAssistantTool(f.session, f.id, { runId: stale.id, callId: "call_fixture", name: "proposeOpeningChange", args: { patch: { type: "reconcile_source" } } }), code("ASSISTANT_SOURCE_CHANGED"));
  const foreign = await fixture(); await assert.rejects(readScheduleAssistant(foreign.session, f.id, { id: stale.id }), code("NOT_FOUND"));
  await getPool().query("UPDATE guild_sessions SET revoked_at=now() WHERE id=$1", [f.session.id]);
  await assert.rejects(startScheduleAssistant(f.session, f.id, request()), code("ASSISTANT_ACTOR")); assert.equal(creates, 3);
  assert.equal((await schedulingWorkspace(foreign.session, foreign.id)).proposals.length, 0);
});

test("known response reads retain evidence after authority expiry while new dispatch and tools remain held", async () => {
  const f = await fixture(); let creates = 0, reads = 0;
  globalThis.fetch = async (_url, init) => { if (init?.method === "POST") { creates++; return Response.json({ id: "resp_fixture_expiry", status: "queued" }); } reads++; return completed("resp_fixture_expiry", "proposeOpeningChange", { patch: { type: "reconcile_source" } }); };
  const run = await startScheduleAssistant(f.session, f.id, request());
  const c = await getCommission(f.session, f.id); for (const page of c.mandates) page.expiresAt = "2026-01-01T00:00:00.000Z";
  await transaction(db => saveCommission(db, c)); await getPool().query("UPDATE guild_schedule_ai_runs SET poll_after=NULL WHERE id=$1", [run.id]);
  const saved = await readScheduleAssistant(f.session, f.id, { id: run.id }) as AssistantRunView;
  assert.equal(saved.state, "completed"); assert.equal(reads, 1);
  await assert.rejects(startScheduleAssistant(f.session, f.id, request()), code("SCHEDULE_AUTHORITY_EXPIRED"));
  await assert.rejects(executeScheduleAssistantTool(f.session, f.id, { runId: run.id, callId: "call_fixture", name: "proposeOpeningChange", args: { patch: { type: "reconcile_source" } } }), code("SCHEDULE_AUTHORITY_EXPIRED"));
  assert.equal(creates, 1);
});

test("the response allowlist follows each native plan phase and saved history retains every original request", async () => {
  const f = await fixture(); let creates = 0;
  globalThis.fetch = async () => { creates++; return completed(`resp_fixture_phase_${creates}`, "completePlanSteps", { stepIds: [1] }); };
  const invalid = await startScheduleAssistant(f.session, f.id, { ...request(), toolNames: ["getOpeningPlan", "createPlan"] });
  assert.equal(invalid.state, "failed"); assert.equal(invalid.result, null);
  globalThis.fetch = async () => { creates++; return completed(`resp_fixture_history_${creates}`, "getOpeningPlan", {}); };
  for (let i = 0; i < 25; i++) await startScheduleAssistant(f.session, f.id, request());
  const page = await readScheduleAssistant(f.session, f.id) as AssistantHistory;
  assert.equal(page.total, 26); assert.equal(page.runs.length, 24); assert.ok(page.nextBefore); assert.equal(page.pending, false);
  const older = await readScheduleAssistant(f.session, f.id, { before: page.nextBefore! }) as AssistantHistory;
  assert.equal(older.total, 26); assert.equal(older.runs.length, 2); assert.equal(older.nextBefore, null);
  assert.equal(new Set([...page.runs, ...older.runs].map(run => run.id)).size, 26); assert.equal(creates, 26);
  assert.ok(older.runs.some(run => run.id === invalid.id));
  assert.equal(Number((await getPool().query("SELECT count(*) FROM guild_jobs WHERE tenant_id=$1", [f.session.tenantId])).rows[0].count), 0);
});
