import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { digest, DomainError } from "@/domain/primitives";
import { planDigest } from "@/domain/fixture";
import { isolatedPostgres } from "../support/postgres";
const cleanup = await isolatedPostgres("guild_hosted_original_test"); after(cleanup);
const { getPool } = await import("@/server/db");
const { fresh } = await import("../support/narration-fixture");
const { hostedWebFixture, SyntheticHostedDriver } = await import("../support/hosted-web");
const { HostedWebAuditGateway } = await import("@/server/web/hosted-gateway");
const { PostgresHostedAttemptStore } = await import("@/server/web/hosted-store");
const { saveWebAuditObservation, readWebAuditCaseDetails, retainWebAuditFiles } = await import("@/server/web/audit-store");
const { recoverOriginalHostedWebAudit } = await import("@/server/web/hosted-recovery");
import type { WebAuditRow } from "@/server/web/audit-store";
import type { HostedAttemptStart } from "@/server/web/hosted-store";
import type { FakeHostedOptions } from "../support/hosted-web";
const hasCode = (code: string) => (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === code;

async function storageFixture(options: FakeHostedOptions = {}) {
  const f = await hostedWebFixture(), owner = await fresh();
  f.row.tenant_id = owner.session.tenantId; f.row.commission_id = owner.commissionId;
  f.input.tenantId = f.row.tenant_id;
  // Storage/transport boundary fixture only. This seeded browser row grants no
  // real commission approval, accessibility qualification or acceptance.
  await getPool().query("INSERT INTO guild_jobs(id,tenant_id,commission_id,business_key,type,state,input,lease_token,lease_until) VALUES($1,$2,$3,$4,'produce_package','running',$5,$6,now()+interval '6 minutes')", [f.row.job_id, f.row.tenant_id, f.row.commission_id, "synthetic-hosted:" + f.row.id, { packageId: "web", contractVersion: 1, syntheticFixture: true }, f.workerId]);
  f.row = (await getPool().query<WebAuditRow>("INSERT INTO guild_web_audit_cases(id,tenant_id,commission_id,package_id,contract_version,job_id,case_key,mode,request_hash,request,state,dispatched_at) VALUES($1,$2,$3,'web',1,$4,$5,'producer',$6,$7,'dispatching',$8) RETURNING *", [f.row.id, f.row.tenant_id, f.row.commission_id, f.row.job_id, f.row.case_key, f.row.request_hash, f.request, f.row.dispatched_at])).rows[0]!;
  f.input.beforeLaunch = async () => ({ workerId: f.workerId, originalDeadline: f.originalDeadline });
  const store = new PostgresHostedAttemptStore(), driver = new SyntheticHostedDriver(f, options), gateway = new HostedWebAuditGateway({ runtime: f.runtime, store, driver });
  const start: HostedAttemptStart = { caseId: f.row.id, tenantId: f.row.tenant_id, jobId: f.row.job_id, bundleId: f.input.bundleId, request: f.request, workerId: f.workerId, originalDeadline: f.originalDeadline, configuration: f.configuration };
  return { f, owner, store, driver, gateway, start };
}

test("PostgreSQL serializes competing creation intents and preserves one exact original worker/name", async () => {
  const { f, store, start } = await storageFixture();
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => store.begin(start)));
  assert.equal(results.filter(item => item.status === "fulfilled").length, 1); assert.equal(results.filter(item => item.status === "rejected").length, 7);
  const attempt = await store.read(f.row.tenant_id, f.row.id);
  assert.equal(attempt.binding.workerId, f.workerId); assert.equal(attempt.binding.originalDeadline, f.originalDeadline);
  const count = (await getPool().query("SELECT (SELECT count(*) FROM guild_web_hosted_attempts WHERE case_id=$1)::int AS attempts,(SELECT count(*) FROM guild_web_hosted_events WHERE case_id=$1)::int AS events", [f.row.id])).rows[0];
  assert.deepEqual(count, { attempts: 1, events: 1 });
  await assert.rejects(store.read(randomUUID(), f.row.id), hasCode("WEB_HOSTED_IDENTITY_CHANGED"));
  await assert.rejects(store.change(attempt, { phase: "browser_intent" }, "synthetic_illegal_skip"), hasCode("WEB_HOSTED_IDENTITY_CHANGED"));
});

test("PostgreSQL retains a lost original command, recovers after deadline and revocation, and permits only identical duplicate observation bytes", async () => {
  const { f, owner, store, driver, gateway } = await storageFixture({ lostBrowserAfterStart: true });
  f.originalDeadline = new Date(Date.now() + 500).toISOString();
  await assert.rejects(gateway.run(f.input));
  const dispatchedAt = f.row.dispatched_at!.toISOString(), original = await store.read(f.row.tenant_id, f.row.id), originalCommand = original.commands.browser!.id;
  assert.equal(original.phase, "browser_started"); assert.ok(original.firstUnknownAt); assert.equal(driver.counts.browser, 1);
  await getPool().query("UPDATE guild_web_audit_cases SET state='indeterminate',failure_code='SYNTHETIC_ORIGINAL_RESPONSE_LOST' WHERE id=$1", [f.row.id]);
  await getPool().query("UPDATE guild_jobs SET state='needs_review',lease_until=NULL WHERE id=$1", [f.row.job_id]);
  await getPool().query("UPDATE guild_sessions SET revoked_at=now(),expires_at=now()-interval '1 second' WHERE id=$1", [owner.session.id]);
  await delay(550);
  assert.ok(Date.parse(original.binding.originalDeadline) < Date.now());
  const recoveredRaw = await gateway.recover({ ...f.row, state: "indeterminate" });
  await assert.rejects(saveWebAuditObservation(f.row, recoveredRaw.result, recoveredRaw.files), /exact original committed dispatch/);
  await assert.rejects(saveWebAuditObservation(f.row, recoveredRaw.result, recoveredRaw.files, { ...recoveredRaw.recovery, commandId: "synthetic_foreign_original" }), /exact original signed hosted session/);
  const recovered = await recoverOriginalHostedWebAudit(f.row.tenant_id, f.row.id, gateway);
  assert.equal(recovered.state, "received"); assert.equal(recovered.receipt.resultHash, digest(recoveredRaw.result));
  const saved = await readWebAuditCaseDetails(f.row.tenant_id, f.row.id);
  assert.equal(saved.row.dispatched_at!.toISOString(), dispatchedAt); assert.equal(saved.row.original_failure_code, "SYNTHETIC_ORIGINAL_RESPONSE_LOST"); assert.ok(saved.row.recovered_at);
  const heldJob = (await getPool().query("SELECT state,lease_until FROM guild_jobs WHERE id=$1", [f.row.job_id])).rows[0]; assert.equal(heldJob.state, "needs_review"); assert.equal(heldJob.lease_until, null);
  const final = await store.read(f.row.tenant_id, f.row.id); assert.equal(final.commands.browser!.id, originalCommand); assert.equal(final.binding.workerId, f.workerId);
  assert.equal(final.binding.originalDeadline, original.binding.originalDeadline); assert.equal(final.firstUnknownAt, original.firstUnknownAt); assert.equal(final.phase, "cleaned");
  const replay = await recoverOriginalHostedWebAudit(f.row.tenant_id, f.row.id, gateway); assert.deepEqual(replay.receipt, recovered.receipt);
  const changed = { ...recoveredRaw.result, complete: false, errors: [{ code: "SYNTHETIC_CHANGED_LATE_RESULT", message: "A deliberately changed late observation must not overwrite the first original." }] };
  await assert.rejects(saveWebAuditObservation(f.row, changed, recoveredRaw.files, recoveredRaw.recovery), /exact native evidence/);
  assert.equal((await getPool().query("SELECT count(*)::int AS n FROM guild_web_audit_observations WHERE case_id=$1", [f.row.id])).rows[0].n, 1);
  assert.equal(driver.counts.create, 1); assert.equal(driver.counts.browser, 1); assert.equal(driver.counts.upload, 1); assert.equal(driver.counts.stop, 1);
});

test("PostgreSQL prevents original session/command replacement and detects record/native-proof tampering", async () => {
  const { f, store, gateway } = await storageFixture();
  const measured = await gateway.run(f.input), original = await store.read(f.row.tenant_id, f.row.id);
  await assert.rejects(getPool().query("UPDATE guild_web_hosted_attempts SET original_session_id='synthetic_replacement_session' WHERE case_id=$1", [f.row.id]), /identity is immutable/);
  await assert.rejects(getPool().query("UPDATE guild_web_hosted_attempts SET original_command_id='synthetic_replacement_command' WHERE case_id=$1", [f.row.id]), /identity is immutable/);
  await getPool().query("UPDATE guild_web_hosted_attempts SET record=jsonb_set(record,'{session,id}',to_jsonb('synthetic_substituted_record'::text)) WHERE case_id=$1", [f.row.id]);
  await assert.rejects(store.read(f.row.tenant_id, f.row.id), hasCode("WEB_HOSTED_IDENTITY_CHANGED"));
  await getPool().query("UPDATE guild_web_hosted_attempts SET record=$1 WHERE case_id=$2", [original, f.row.id]);
  await saveWebAuditObservation(f.row, measured.result, measured.files);
  const evidence = (await getPool().query("SELECT bytes FROM guild_web_hosted_files WHERE case_id=$1 AND path='hosted-runtime-verification.json'", [f.row.id])).rows[0].bytes as Buffer;
  const changed = Buffer.from(evidence); changed[0] = changed[0] === 32 ? 9 : 32;
  await getPool().query("UPDATE guild_web_hosted_files SET bytes=$1 WHERE case_id=$2 AND path='hosted-runtime-verification.json'", [changed, f.row.id]);
  await assert.rejects(store.files(original), hasCode("WEB_HOSTED_IDENTITY_CHANGED"));
  // The separately HMAC-bound native observation still reads its own unchanged
  // files; corrupt hosted proof cannot be substituted for original native bytes.
  assert.equal((await readWebAuditCaseDetails(f.row.tenant_id, f.row.id)).receipt.resultHash, digest(measured.result));
});

test("PostgreSQL keeps cleanup uncertainty separate from a saved observation and never redelivers the original stop", async () => {
  const { f, store, driver, gateway } = await storageFixture({ lostStop: true });
  const measured = await gateway.run(f.input); await saveWebAuditObservation(f.row, measured.result, measured.files); await measured.afterSave?.();
  assert.equal(driver.counts.stop, 1); assert.equal((await store.read(f.row.tenant_id, f.row.id)).phase, "cleanup_intent");
  await recoverOriginalHostedWebAudit(f.row.tenant_id, f.row.id, gateway);
  assert.equal(driver.counts.stop, 1); assert.equal((await store.read(f.row.tenant_id, f.row.id)).phase, "cleaned");
});

test("new creation under an expired original deadline is denied by the durable boundary", async () => {
  const { f, store, start } = await storageFixture();
  await assert.rejects(store.begin({ ...start, originalDeadline: new Date(Date.now() - 1).toISOString() }), hasCode("WEB_HOSTED_AUTHORITY_EXPIRED"));
  assert.equal((await getPool().query("SELECT count(*)::int AS n FROM guild_web_hosted_attempts WHERE case_id=$1", [f.row.id])).rows[0].n, 0);
});

test("unknown original command ID retains closed original native files without manufacturing an observation", async () => {
  const { f, store, driver, gateway } = await storageFixture({ lostBrowserBeforeStart: true });
  await assert.rejects(gateway.run(f.input));
  await getPool().query("UPDATE guild_web_audit_cases SET state='indeterminate',failure_code='WEB_HOSTED_OUTCOME_UNKNOWN' WHERE id=$1", [f.row.id]);
  await assert.rejects(recoverOriginalHostedWebAudit(f.row.tenant_id, f.row.id, gateway), hasCode("WEB_HOSTED_COMMAND_UNKNOWN"));
  const record = await store.read(f.row.tenant_id, f.row.id);
  assert.equal(record.commands.browser, null); assert.equal(record.evidence, null);
  assert.ok((await store.files(record)).has("result.json"));
  assert.equal((await getPool().query("SELECT count(*)::int AS n FROM guild_web_audit_files WHERE case_id=$1", [f.row.id])).rows[0].n, f.values.size);
  assert.equal((await getPool().query("SELECT count(*)::int AS n FROM guild_web_audit_observations WHERE case_id=$1", [f.row.id])).rows[0].n, 0);
  assert.equal(driver.counts.browser, 1); assert.equal(driver.counts.create, 1); assert.equal(driver.counts.readonly, 0);
});

test("partial native evidence respects unchanged global file/count bounds before inserting any bytes", async () => {
  const { f } = await storageFixture(), client = await getPool().connect();
  try {
    const tooMany = new Map(Array.from({ length: 201 }, (_, index) => [`synthetic-${index}.json`, Buffer.from("{}") ]));
    await assert.rejects(retainWebAuditFiles(client, f.row, tooMany), /fixed file\/count retention bounds/);
    const sixteenMiB = Buffer.alloc(16 * 1024 * 1024, 32), tooLarge = new Map(Array.from({ length: 5 }, (_, index) => [`synthetic-${index}.json`, sixteenMiB]));
    await assert.rejects(retainWebAuditFiles(client, f.row, tooLarge), /fixed file\/count retention bounds/);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM guild_web_audit_files WHERE case_id=$1", [f.row.id])).rows[0].n, 0);
  } finally { client.release(); }
});

test("actual application authority is rechecked after hosted provisioning and upload, with the original deadline unchanged", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Unstubbed network denied in hosted source integration"); };
  try {
    const { fullWebFixture } = await import("../support/web-production-fixture");
    const { getCommission, executeCommand } = await import("@/server/commissions");
    const { webContractProposal } = await import("@/server/web/contracts");
    const { renderWebFiles } = await import("@/exhibition/generated/render");
    const { syntheticDesignFor } = await import("../support/synthetic-web");
    const { saveWebBundle } = await import("@/server/web/bundles");
    const { createWebAuditRequest } = await import("@/server/web/audit-request");
    const { runWebAudit } = await import("@/server/web/audits");
    const source = await fullWebFixture({ webProvider: "ostrava" }), f = await hostedWebFixture();
    let commission = await getCommission(source.session, source.commissionId), pkg = commission.packages.find(item => item.kind === "web")!;
    const pack = await webContractProposal(getPool(), commission, pkg, f.runtime);
    const amendment = await executeCommand(source.session, commission.id, { type: "amend_web_contract", commandId: randomUUID(), expectedRevision: commission.revision, packageId: pkg.id, contractVersion: pkg.contractVersion, acceptancePackDigest: pack.digest, acknowledgeOriginalSources: true, acknowledgePipelineAndLimits: true }, { webRuntime: f.runtime }); assert.ok(amendment.ok);
    const approval = await executeCommand(source.session, commission.id, { type: "approve_plan", commandId: randomUUID(), expectedRevision: amendment.revision, planDigest: planDigest(amendment.commission) }, { webRuntime: f.runtime }); assert.ok(approval.ok);
    const queued = await executeCommand(source.session, commission.id, { type: "produce_package", commandId: randomUUID(), expectedRevision: approval.revision, packageId: pkg.id }, { webRuntime: f.runtime }); assert.ok(queued.ok && queued.jobId);
    const context = { tenantId: source.session.tenantId, jobId: queued.jobId, leaseToken: randomUUID(), externalCalls: 0, webRuntime: f.runtime };
    await getPool().query("UPDATE guild_jobs SET state='running',lease_token=$1,lease_until=now()+interval '6 minutes' WHERE id=$2", [context.leaseToken, queued.jobId]);
    const rendered = renderWebFiles(source.source, syntheticDesignFor(source.source), f.assets), bundleId = await saveWebBundle(context, pkg.id, 1, rendered.bundle, rendered.authored);
    commission = await getCommission(source.session, source.commissionId); pkg = commission.packages.find(item => item.kind === "web")!;
    const originalDeadline = (pkg.acceptancePack.parameters!.authority as { expiresAt: string }).expiresAt;
    const request = await createWebAuditRequest(context, commission, pkg, bundleId, "producer", "en", { width: 390, height: 844 });
    f.request = { ...request, mode: "producer" };
    const driver = new SyntheticHostedDriver(f, { afterUploadVerified: async () => { await getPool().query("UPDATE guild_sessions SET revoked_at=now() WHERE id=$1", [source.session.id]); } });
    const gateway = new HostedWebAuditGateway({ runtime: f.runtime, driver });
    await assert.rejects(runWebAudit(context, pkg.id, bundleId, source.source, request, { storage: source.media, audit: gateway }), error => error instanceof DomainError && ["PRODUCTION_APPROVAL_REQUIRED", "WEB_ACTOR_REQUIRED"].includes(error.code));
    assert.equal(driver.counts.create, 1); assert.equal(driver.counts.uploadVerify, 1); assert.equal(driver.counts.browser, 0); assert.equal(context.externalCalls, 1);
    const row = (await getPool().query<WebAuditRow>("SELECT * FROM guild_web_audit_cases WHERE tenant_id=$1 AND job_id=$2", [context.tenantId, context.jobId])).rows[0]!;
    const record = await new PostgresHostedAttemptStore().read(context.tenantId, row.id);
    assert.equal(row.state, "indeterminate"); assert.equal(record.phase, "browser_intent"); assert.equal(record.binding.originalDeadline, originalDeadline); assert.ok(row.dispatched_at); assert.equal(record.commands.browser, null);
    assert.equal((await getCommission(source.session, source.commissionId)).payments.capturedMinor, 0);
  } finally { globalThis.fetch = previousFetch; process.env.OPENAI_API_KEY = ""; }
});
