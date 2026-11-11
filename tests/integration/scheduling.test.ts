import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ArtifactManifest } from "../../src/contracts/guild";
import { scheduleCommandSchema, type ScheduleCommand } from "../../src/scheduling/persisted";
import { isolatedPostgres } from "../support/postgres";

const cleanup = await isolatedPostgres("guild_schedule_test"); after(cleanup);
for (const key of ["OPENAI_API_KEY", "GEMINI_API_KEY", "BLOB_READ_WRITE_TOKEN", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"]) process.env[key] = "";
const { createSession } = await import("../../src/server/session");
const { seedCommission, getCommission, executeCommand, saveCommission } = await import("../../src/server/commissions");
const { executeScheduleCommand, schedulingWorkspace, validateScheduleAuthority } = await import("../../src/server/scheduling");
const { getPool, transaction } = await import("../../src/server/db");
const { digest } = await import("../../src/domain/primitives");
const { planDigest } = await import("../../src/domain/fixture");
const { readAuthorityDeadline } = await import("../../src/server/schedule-quotes");
const code = (wanted: string) => (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === wanted;

async function fixture() {
  const { session } = await createSession(), c = await seedCommission(session);
  const web = c.packages.find(item => item.kind === "web")!;
  const content = { provenance: "Synthetic verifier mutation fixture, never observed provider output", defect: "contrast test fixture" };
  const artifact: ArtifactManifest = { id: randomUUID(), packageId: web.id, title: "Synthetic failed design", mediaType: "application/json", contentHash: digest(content), downloadUrl: "", previewUrl: null, sourceIds: [], createdAt: new Date().toISOString(), provenance: { mode: "sample", label: "Synthetic mutation fixture", sourceId: null, observedAt: null, sandbox: false }, reviewStatus: "Synthetic failed check", content };
  c.artifacts.push(artifact); web.artifactIds = [artifact.id]; web.state = "correction_requested";
  web.acceptancePack.criteria[0]!.status = "failed"; web.acceptancePack.criteria[0]!.evidence = "Synthetic fixture; no genuine provider failure claimed";
  await transaction(async db => {
    await saveCommission(db, c);
    await db.query("INSERT INTO guild_verifications(id,tenant_id,commission_id,package_id,contract_version,artifact_id,artifact_hash,criteria_digest,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [randomUUID(), c.tenantId, c.id, web.id, web.contractVersion, artifact.id, artifact.contentHash, digest(web.acceptancePack), web.acceptancePack]);
  });
  await executeCommand(session, c.id, { type: "approve_plan", commandId: randomUUID(), expectedRevision: c.revision, planDigest: planDigest(c) });
  const refreshed = await getCommission(session, c.id);
  refreshed.mandates.find(item => !item.parentId)!.reservedMinor = web.grossMinor;
  refreshed.mandates.find(item => item.id === "passport-design")!.reservedMinor = web.grossMinor;
  await transaction(async db => { await saveCommission(db, refreshed); await db.query("INSERT INTO guild_budget_reservations(id,tenant_id,commission_id,mandate_id,operation_key,amount_minor,currency,state) VALUES($1,$2,$3,'passport-design',$4,$5,'USD','reserved')", [randomUUID(), c.tenantId, c.id, `production:${c.id}:web:1`, web.grossMinor]); });
  return { session, commissionId: c.id, artifact };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Action = ScheduleCommand extends infer C ? C extends ScheduleCommand ? Omit<C, "commandId" | "expectedRevision"> : never : never;
async function command(f: Fixture, action: Action) {
  const c = await getCommission(f.session, f.commissionId);
  return executeScheduleCommand(f.session, c.id, scheduleCommandSchema.parse({ ...action, commandId: randomUUID(), expectedRevision: c.revision }));
}
async function offers(f: Fixture) {
  await command(f, { type: "initialize_schedule" });
  await command(f, { type: "request_recovery_offers", scheduleRevision: 1 });
  return schedulingWorkspace(f.session, f.commissionId);
}
async function preparedOffer(f: Fixture) {
  const w = await offers(f), quote = w.quotes.find(item => item.offer === "accessible")!;
  const result = await command(f, { type: "propose_schedule", scheduleRevision: 1, patch: { type: "quote", quoteId: quote.id } });
  const p = (await schedulingWorkspace(f.session, f.commissionId)).proposals.find(item => item.id === result.proposalId)!;
  await command(f, { type: "prepare_schedule_passport", scheduleRevision: 1, proposalId: p.id, proposalDigest: p.digest, acknowledge: true });
  const c = await getCommission(f.session, f.commissionId);
  await executeCommand(f.session, c.id, { type: "approve_plan", commandId: randomUUID(), expectedRevision: c.revision, planDigest: planDigest(c) });
  return { quote, c: await getCommission(f.session, c.id) };
}

test("native recovery retains the late offer, binds the feasible quote and needs a fresh $580 Passport", async () => {
  const f = await fixture(), before = await getCommission(f.session, f.commissionId), oldDigest = planDigest(before);
  const w = await offers(f); assert.equal(w.schedule?.schemaVersion, "guild.schedule.v2"); assert.equal(w.quotes.length, 2);
  assert.equal(planDigest(await getCommission(f.session, f.commissionId)), oldDigest);
  const economy = w.quotes.find(item => item.offer === "economy")!, accessible = w.quotes.find(item => item.offer === "accessible")!;
  assert.equal(economy.providerAwardMinor, 13000); assert.equal(accessible.providerAwardMinor, 16000);
  assert.equal(accessible.provenance.kind, "controlled_provider_offer"); assert.equal(accessible.provenance.environment, "sample");
  const late = await command(f, { type: "propose_schedule", scheduleRevision: 1, patch: { type: "quote", quoteId: economy.id } });
  let workspace = await schedulingWorkspace(f.session, f.commissionId), p = workspace.proposals.find(item => item.id === late.proposalId)!;
  assert.equal(p.evaluation.completionAt, "2026-11-23T16:00:00.000Z"); assert.deepEqual(p.evaluation.reasons, ["opening_missed"]);
  await assert.rejects(command(f, { type: "prepare_schedule_passport", scheduleRevision: 1, proposalId: p.id, proposalDigest: p.digest, acknowledge: true }), code("SCHEDULE_INFEASIBLE"));
  const fast = await command(f, { type: "propose_schedule", scheduleRevision: 1, patch: { type: "quote", quoteId: accessible.id } });
  workspace = await schedulingWorkspace(f.session, f.commissionId); p = workspace.proposals.find(item => item.id === fast.proposalId)!;
  assert.equal(p.evaluation.completionAt, "2026-11-19T16:00:00.000Z"); assert.equal(p.evaluation.openingSlack.wallClockHours, 23); assert.equal(p.evaluation.openingSlack.workingHours, 7);
  assert.deepEqual(p.evaluation.criticalPaths, [["web", "curator"]]); assert.equal(p.commercial.proposedTotalMinor, 58000);
  const originalArtifact = (await getPool().query("SELECT manifest FROM guild_artifacts WHERE id=$1", [f.artifact.id])).rows[0];
  await command(f, { type: "prepare_schedule_passport", scheduleRevision: 1, proposalId: p.id, proposalDigest: p.digest, acknowledge: true });
  let current = await getCommission(f.session, f.commissionId); const web = current.packages.find(item => item.id === "web")!;
  assert.equal(web.contractVersion, 2); assert.equal(web.providerId, "ostrava"); assert.equal(web.grossMinor, 17500); assert.equal(web.acceptancePack.digest, before.packages.find(item => item.id === "web")!.acceptancePack.digest);
  assert.equal(current.approvedPlanDigest, null); assert.equal(current.mandates.find(item => !item.parentId)!.reservedMinor, 0);
  assert.equal(current.schedule!.revision, 2); assert.notEqual(planDigest(current), oldDigest);
  assert.deepEqual((await getPool().query("SELECT manifest FROM guild_artifacts WHERE id=$1", [f.artifact.id])).rows[0], originalArtifact);
  assert.equal(Number((await getPool().query("SELECT count(*) FROM guild_jobs WHERE tenant_id=$1", [f.session.tenantId])).rows[0].count), 0);
  await executeCommand(f.session, current.id, { type: "approve_plan", commandId: randomUUID(), expectedRevision: current.revision, planDigest: planDigest(current) });
  current = await getCommission(f.session, current.id); await validateScheduleAuthority(getPool(), current, "production");
  const now = Date.now; Date.now = () => Date.parse(accessible.expiresAt) + 1;
  try { await validateScheduleAuthority(getPool(), current, "production"); } finally { Date.now = now; }
  assert.equal(current.payments.capturedMinor, 0); assert.equal(current.payments.providerPaidMinor, 0); assert.equal(current.packages.filter(item => item.acceptedAt).length, 0);
});

test("revision, replay and tenant controls protect schedule and offer commands", async () => {
  const f = await fixture(), c = await getCommission(f.session, f.commissionId);
  const initialize = scheduleCommandSchema.parse({ type: "initialize_schedule", commandId: randomUUID(), expectedRevision: c.revision });
  const [first, replay] = await Promise.all([executeScheduleCommand(f.session, c.id, initialize), executeScheduleCommand(f.session, c.id, initialize)]);
  assert.deepEqual(first, replay);
  await assert.rejects(executeScheduleCommand(f.session, c.id, { ...initialize, commandId: randomUUID() }), code("REVISION_CONFLICT"));
  await assert.rejects(command(f, { type: "request_recovery_offers", scheduleRevision: 2 }), code("SCHEDULE_REVISION"));
  assert.equal(scheduleCommandSchema.safeParse({ type: "propose_schedule", commandId: randomUUID(), expectedRevision: 0, scheduleRevision: 1, patch: { type: "quote", quoteId: randomUUID(), priceMinor: 1 } }).success, false);
  const foreign = await fixture(); await assert.rejects(schedulingWorkspace(foreign.session, c.id), code("NOT_FOUND"));
  await getPool().query("UPDATE guild_sessions SET revoked_at=now() WHERE id=$1", [f.session.id]);
  await assert.rejects(command(f, { type: "request_recovery_offers", scheduleRevision: 1 }), code("SCHEDULE_ACTOR"));
});

test("expired or changed offers and a stale proposal cannot prepare a new contract", async () => {
  const f = await fixture(), w = await offers(f), q = w.quotes.find(item => item.offer === "accessible")!;
  const now = Date.now; Date.now = () => Date.parse(q.expiresAt) + 1;
  try { await assert.rejects(command(f, { type: "propose_schedule", scheduleRevision: 1, patch: { type: "quote", quoteId: q.id } }), code("QUOTE_EXPIRED")); } finally { Date.now = now; }
  await getPool().query("UPDATE guild_schedule_quotes SET terms=$2 WHERE id=$1", [q.id, { ...q, providerAwardMinor: 1 }]);
  await assert.rejects(command(f, { type: "propose_schedule", scheduleRevision: 1, patch: { type: "quote", quoteId: q.id } }), code("QUOTE_CHANGED"));
  await getPool().query("UPDATE guild_schedule_quotes SET terms=$2 WHERE id=$1", [q.id, q]);
  await command(f, { type: "propose_schedule", scheduleRevision: 1, patch: { type: "quote", quoteId: q.id } });
  const p = (await schedulingWorkspace(f.session, f.commissionId)).proposals[0]!;
  const c = await getCommission(f.session, f.commissionId); c.revision++; await transaction(db => saveCommission(db, c));
  await assert.rejects(command(f, { type: "prepare_schedule_passport", scheduleRevision: 1, proposalId: p.id, proposalDigest: p.digest, acknowledge: true }), code("SCHEDULE_PROPOSAL_CHANGED"));
  c.providers.find(item => item.id === "formwork")!.capacity = 1; await transaction(db => saveCommission(db, c));
  assert.equal((await schedulingWorkspace(f.session, f.commissionId)).sourceCurrent, false);
  await assert.rejects(command(f, { type: "propose_schedule", scheduleRevision: 1, patch: { type: "quote", quoteId: q.id } }), code("SCHEDULE_SOURCE_CHANGED"));
});

test("an expired prepared offer needs a distinct retained renewal and cannot extend original authority", async () => {
  const f = await fixture(), w = await offers(f), q = w.quotes.find(item => item.offer === "accessible")!;
  await command(f, { type: "propose_schedule", scheduleRevision: 1, patch: { type: "quote", quoteId: q.id } });
  const p = (await schedulingWorkspace(f.session, f.commissionId)).proposals[0]!;
  await command(f, { type: "prepare_schedule_passport", scheduleRevision: 1, proposalId: p.id, proposalDigest: p.digest, acknowledge: true });
  const now = Date.now; Date.now = () => Date.parse(q.expiresAt) + 1000;
  try {
    let c = await getCommission(f.session, f.commissionId);
    await assert.rejects(executeCommand(f.session, c.id, { type: "approve_plan", commandId: randomUUID(), expectedRevision: c.revision, planDigest: planDigest(c) }), code("QUOTE_EXPIRED"));
    await assert.rejects(validateScheduleAuthority(getPool(), c, "production"), code("QUOTE_APPROVAL_EXPIRED"));
    const oldTerms = (await getPool().query("SELECT terms,digest FROM guild_schedule_quotes WHERE id=$1", [q.id])).rows[0];
    const renewalCommand = scheduleCommandSchema.parse({ type: "renew_recovery_offer", commandId: randomUUID(), expectedRevision: c.revision, scheduleRevision: 2, quoteId: q.id });
    const [first, replay] = await Promise.all([executeScheduleCommand(f.session, c.id, renewalCommand), executeScheduleCommand(f.session, c.id, renewalCommand)]);
    assert.deepEqual(first, replay);
    const renewed = (await schedulingWorkspace(f.session, f.commissionId)).quotes.find(item => item.renewal?.quoteId === q.id)!;
    assert.notEqual(renewed.id, q.id); assert.equal(renewed.renewal!.quoteDigest, q.digest);
    assert.equal(renewed.contractVersion, 2); assert.equal(renewed.authorityExpiresAt, q.authorityExpiresAt);
    assert.deepEqual(renewed.failedSubmission, q.failedSubmission);
    await command(f, { type: "propose_schedule", scheduleRevision: 2, patch: { type: "quote", quoteId: renewed.id } });
    const proposed = (await schedulingWorkspace(f.session, f.commissionId)).proposals[0]!;
    await command(f, { type: "prepare_schedule_passport", scheduleRevision: 2, proposalId: proposed.id, proposalDigest: proposed.digest, acknowledge: true });
    c = await getCommission(f.session, f.commissionId); assert.equal(c.packages.find(item => item.id === "web")!.contractVersion, 3);
    assert.equal(c.schedule!.revision, 3); assert.equal(c.approvedPlanDigest, null);
    await assert.rejects(validateScheduleAuthority(getPool(), c, "production"), code("QUOTE_APPROVAL_EXPIRED"));
    await executeCommand(f.session, c.id, { type: "approve_plan", commandId: randomUUID(), expectedRevision: c.revision, planDigest: planDigest(c) });
    c = await getCommission(f.session, c.id); await validateScheduleAuthority(getPool(), c, "production");
    assert.deepEqual((await getPool().query("SELECT terms,digest FROM guild_schedule_quotes WHERE id=$1", [q.id])).rows[0], oldTerms);
    assert.equal(Number((await getPool().query("SELECT count(*) FROM guild_contract_amendments WHERE commission_id=$1", [c.id])).rows[0].count), 2);
    Date.now = () => Date.parse(q.authorityExpiresAt) + 1;
    await assert.rejects(command(f, { type: "renew_recovery_offer", scheduleRevision: 3, quoteId: renewed.id }), code("SCHEDULE_AUTHORITY_EXPIRED"));
    await assert.rejects(validateScheduleAuthority(getPool(), c, "production"), code("SCHEDULE_AUTHORITY_EXPIRED"));
    assert.equal(Number((await getPool().query("SELECT count(*) FROM guild_jobs WHERE tenant_id=$1", [f.session.tenantId])).rows[0].count), 0);
  } finally { Date.now = now; }
});

test("drag and source reconciliation remain previews until a new revision and Passport are reviewed", async () => {
  const f = await fixture(); await command(f, { type: "initialize_schedule" });
  const before = await schedulingWorkspace(f.session, f.commissionId), c = await getCommission(f.session, f.commissionId);
  await command(f, { type: "propose_schedule", scheduleRevision: 1, patch: { type: "move_task", taskId: "images", notBefore: "2026-11-12T16:00:00.000Z" } });
  let w = await schedulingWorkspace(f.session, f.commissionId);
  assert.equal(w.schedule!.digest, before.schedule!.digest); assert.equal(planDigest(await getCommission(f.session, c.id)), planDigest(c));
  assert.notEqual(w.proposals[0]!.candidate.digest, w.schedule!.digest);
  const current = await getCommission(f.session, c.id); current.providers.find(item => item.id === "formwork")!.capacity = 1; current.revision++;
  await transaction(db => saveCommission(db, current));
  w = await schedulingWorkspace(f.session, c.id); assert.equal(w.sourceCurrent, false);
  await command(f, { type: "propose_schedule", scheduleRevision: 1, patch: { type: "reconcile_source" } });
  w = await schedulingWorkspace(f.session, c.id); const p = w.proposals[0]!;
  assert.equal(w.schedule!.digest, before.schedule!.digest); assert.equal(p.candidate.source.contracts.find(item => item.packageId === "web")!.providerCapacity, 1);
  assert.equal(p.evaluation.scheduleFeasible, true);
  await command(f, { type: "prepare_schedule_passport", scheduleRevision: 1, proposalId: p.id, proposalDigest: p.digest, acknowledge: true });
  w = await schedulingWorkspace(f.session, c.id); assert.equal(w.sourceCurrent, true); assert.equal(w.schedule!.revision, 2);
  const prepared = await getCommission(f.session, c.id); assert.equal(prepared.approvedPlanDigest, null);
  assert.equal(Number((await getPool().query("SELECT count(*) FROM guild_schedule_revisions WHERE commission_id=$1", [c.id])).rows[0].count), 2);
  assert.equal(Number((await getPool().query("SELECT count(*) FROM guild_jobs WHERE tenant_id=$1", [f.session.tenantId])).rows[0].count), 0);
});

test("a quote's approval must prove its exact immutable snapshot and the deadline projection cannot extend it", async () => {
  const f = await fixture(), { quote, c } = await preparedOffer(f), db = getPool();
  const deadline = await readAuthorityDeadline(db, c, { ...f.session, expiresAt: new Date(Date.parse(f.session.expiresAt) + 7 * 86_400_000).toISOString() });
  assert.equal(deadline.effectiveUntil, quote.authorityExpiresAt);
  const accepted = (await db.query("SELECT approval_id,approved_at FROM guild_schedule_quotes WHERE id=$1", [quote.id])).rows[0];
  const old = (await db.query("SELECT id,created_at FROM guild_approval_receipts WHERE commission_id=$1 ORDER BY created_at LIMIT 1", [c.id])).rows[0];
  const now = Date.now; Date.now = () => Date.parse(quote.expiresAt) + 1;
  try {
    await validateScheduleAuthority(db, c, "production");
    await db.query("UPDATE guild_schedule_quotes SET approval_id=$2,approved_at=$3 WHERE id=$1", [quote.id, old.id, old.created_at]);
    await assert.rejects(validateScheduleAuthority(db, c, "production"), code("QUOTE_APPROVAL_EXPIRED"));
    await db.query("UPDATE guild_schedule_quotes SET approval_id=$2,approved_at=$3 WHERE id=$1", [quote.id, accepted.approval_id, accepted.approved_at]);
    const snapshots = (await db.query("SELECT command_id,result FROM guild_commands WHERE commission_id=$1 AND result->'commission'->>'approvedPlanDigest'=$2", [c.id, c.approvedPlanDigest])).rows;
    assert.ok(snapshots.length);
    for (const row of snapshots) await db.query("UPDATE guild_commands SET result=$2 WHERE command_id=$1", [row.command_id, { ...row.result, commission: { ...row.result.commission, capMinor: 1 } }]);
    await assert.rejects(validateScheduleAuthority(db, c, "production"), code("QUOTE_APPROVAL_EXPIRED"));
    for (const row of snapshots) await db.query("UPDATE guild_commands SET result=$2 WHERE command_id=$1", [row.command_id, row.result]);
    await validateScheduleAuthority(db, c, "production");
    await db.query("UPDATE guild_schedule_quotes SET terms=$2 WHERE id=$1", [quote.id, { ...quote, authorityExpiresAt: "2035-01-01T00:00:00.000Z" }]);
    const held = await readAuthorityDeadline(db, c, f.session); assert.equal(held.effectiveUntil, null); assert.ok(held.unavailable);
    await assert.rejects(validateScheduleAuthority(db, c, "production"), code("QUOTE_CHANGED"));
    await db.query("UPDATE guild_schedule_quotes SET terms=$2 WHERE id=$1", [quote.id, quote]);
    assert.equal((await readAuthorityDeadline(db, c, f.session)).effectiveUntil, quote.authorityExpiresAt);
  } finally { Date.now = now; }
});

test("queued production stops before provider dispatch when its schedule, source or original deadline changes", async () => {
  const { runNextJob } = await import("../../src/server/jobs");
  const fetch = globalThis.fetch, key = process.env.OPENAI_API_KEY, now = Date.now; let external = 0;
  process.env.OPENAI_API_KEY = "synthetic-unused-key";
  globalThis.fetch = async () => { external++; throw new Error("External requests are forbidden in this test."); };
  try {
    for (const change of ["job_binding", "provider_capacity", "original_expiry"] as const) {
      const f = await fixture(), { quote, c } = await preparedOffer(f);
      const queued = await executeCommand(f.session, c.id, { type: "produce_package", packageId: "research", commandId: randomUUID(), expectedRevision: c.revision });
      assert.ok(queued.ok);
      assert.ok(queued.jobId);
      if (change === "job_binding") await getPool().query("UPDATE guild_jobs SET input=input-'scheduleBinding' WHERE id=$1", [queued.jobId]);
      if (change === "provider_capacity") { const current = await getCommission(f.session, c.id); current.providers.find(provider => provider.id === "ostrava")!.capacity++; await transaction(db => saveCommission(db, current)); }
      if (change === "original_expiry") Date.now = () => Date.parse(quote.authorityExpiresAt) + 1;
      const result = await runNextJob(f.session.tenantId); assert.equal(result?.state, "needs_review", change);
      Date.now = now;
      assert.equal(external, 0, change);
      assert.equal(Number((await getPool().query("SELECT count(*) FROM guild_model_runs WHERE tenant_id=$1", [f.session.tenantId])).rows[0].count), 0);
      const saved = await getCommission(f.session, c.id); assert.equal(saved.payments.capturedMinor, 0); assert.equal(saved.packages.filter(pkg => pkg.acceptedAt).length, 0);
    }
  } finally { globalThis.fetch = fetch; process.env.OPENAI_API_KEY = key; Date.now = now; }
});
