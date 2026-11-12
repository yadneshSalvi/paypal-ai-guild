import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import type { Pool, PoolClient } from "pg";
import { planDigest } from "@/domain/fixture";
import { DomainError } from "@/domain/primitives";
import { isolatedPostgres } from "../support/postgres";

const cleanup = await isolatedPostgres("guild_web_composition_test"); after(cleanup);
const { getPool } = await import("@/server/db");
const { executeCommand, getCommission } = await import("@/server/commissions");
const { fullWebFixture } = await import("../support/web-production-fixture");
const { syntheticWebRuntime, syntheticDesignFor, SyntheticWebAudit } = await import("../support/synthetic-web");
const { webContractProposal } = await import("@/server/web/contracts");
const { renderWebFiles } = await import("@/exhibition/generated/render");
const { saveWebBundle } = await import("@/server/web/bundles");
const { createWebAuditRequest } = await import("@/server/web/audit-request");
const { runWebAudit } = await import("@/server/web/audits");

/** Fill the real six-client pool before letting application transactions begin.
 * Ordinary Pool.query callback acquisitions are untouched. A nested pool read
 * inside caseAuthority therefore cannot accidentally pass on a spare client. */
async function withFullApplicationPool<T>(run: () => Promise<T>) {
  const pool = getPool(), originalConnect = pool.connect.bind(pool);
  let acquired = 0, maxClients = 0, maxWaiting = 0, release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const sampler = setInterval(() => { maxClients = Math.max(maxClients, pool.totalCount); maxWaiting = Math.max(maxWaiting, pool.waitingCount); }, 1);
  pool.connect = function (callback?: (error: Error | undefined, client: PoolClient | undefined, done: (release?: unknown) => void) => void) {
    if (callback) return originalConnect(callback);
    return originalConnect().then(async client => {
      acquired++;
      if (acquired <= 6) {
        if (acquired === 6) { maxClients = Math.max(maxClients, pool.totalCount); release(); }
        await ready;
      }
      return client;
    });
  } as Pool["connect"];
  try {
    const result = await run();
    assert.ok(acquired >= 6, "Six actual application transactions must reach the saturated pool.");
    assert.equal(maxClients, 6);
    return { result, acquired, maxClients, maxWaiting };
  } finally { clearInterval(sampler); pool.connect = originalConnect; release(); }
}

test("six real application authority checks share transaction clients and preserve one original dispatch under saturation and revocation", { timeout: 1_800_000 }, async () => {
  const source = await fullWebFixture({ webProvider: "ostrava" }), runtime = await syntheticWebRuntime();
  let commission = await getCommission(source.session, source.commissionId), pkg = commission.packages.find(item => item.kind === "web")!;
  const pack = await webContractProposal(getPool(), commission, pkg, runtime);
  const amended = await executeCommand(source.session, commission.id, { type: "amend_web_contract", commandId: randomUUID(), expectedRevision: commission.revision, packageId: pkg.id,
    contractVersion: pkg.contractVersion, acceptancePackDigest: pack.digest, acknowledgeOriginalSources: true, acknowledgePipelineAndLimits: true }, { webRuntime: runtime });
  assert.ok(amended.ok);
  const approved = await executeCommand(source.session, commission.id, { type: "approve_plan", commandId: randomUUID(), expectedRevision: amended.revision, planDigest: planDigest(amended.commission) }, { webRuntime: runtime });
  assert.ok(approved.ok);
  const queued = await executeCommand(source.session, commission.id, { type: "produce_package", commandId: randomUUID(), expectedRevision: approved.revision, packageId: pkg.id }, { webRuntime: runtime });
  assert.ok(queued.ok && queued.jobId);
  const context = { tenantId: source.session.tenantId, jobId: queued.jobId, leaseToken: randomUUID(), externalCalls: 0, webRuntime: runtime };
  await getPool().query("UPDATE guild_jobs SET state='running',lease_token=$1,lease_until=now()+interval '6 minutes' WHERE id=$2", [context.leaseToken, queued.jobId]);
  const rendered = renderWebFiles(source.source, syntheticDesignFor(source.source), (await runtime.read()).authored);
  const bundleId = await saveWebBundle(context, pkg.id, 1, rendered.bundle, rendered.authored);
  commission = await getCommission(source.session, source.commissionId); pkg = commission.packages.find(item => item.kind === "web")!;
  const deadline = (pkg.acceptancePack.parameters!.authority as { expiresAt: string }).expiresAt;
  const request = await createWebAuditRequest(context, commission, pkg, bundleId, "producer", "en", { width: 390, height: 844 });
  const audit = new SyntheticWebAudit();
  const competing = await withFullApplicationPool(() => Promise.allSettled(Array.from({ length: 6 }, () => runWebAudit({ ...context }, pkg.id, bundleId, source.source, request, { storage: source.media, audit }))));
  assert.equal(competing.result.filter(result => result.status === "fulfilled").length, 1);
  for (const result of competing.result.filter(result => result.status === "rejected")) {
    assert.ok(result.reason instanceof DomainError); assert.equal(result.reason.code, "WEB_AUDIT_OUTCOME_UNKNOWN");
  }
  assert.equal(audit.calls, 1);
  const original = (await getPool().query("SELECT id,state,request_hash,dispatched_at,failure_code FROM guild_web_audit_cases WHERE tenant_id=$1 AND job_id=$2", [context.tenantId, context.jobId])).rows;
  assert.equal(original.length, 1); assert.equal(original[0].state, "received"); assert.equal(original[0].failure_code, null); assert.ok(original[0].dispatched_at);
  assert.equal((await getPool().query("SELECT count(*)::int AS n FROM guild_web_audit_observations WHERE tenant_id=$1", [context.tenantId])).rows[0].n, 1);
  const next = await createWebAuditRequest(context, commission, pkg, bundleId, "producer", "ar", { width: 768, height: 1024 });
  await getPool().query("UPDATE guild_sessions SET revoked_at=now() WHERE id=$1", [source.session.id]);
  const denied = await withFullApplicationPool(() => Promise.allSettled(Array.from({ length: 6 }, () => runWebAudit({ ...context }, pkg.id, bundleId, source.source, next, { storage: source.media, audit }))));
  assert.equal(denied.result.filter(result => result.status === "fulfilled").length, 0);
  for (const result of denied.result) if (result.status === "rejected") {
    assert.ok(result.reason instanceof DomainError); assert.ok(["PRODUCTION_APPROVAL_REQUIRED", "WEB_ACTOR_REQUIRED"].includes(result.reason.code), result.reason.code);
  }
  assert.equal(audit.calls, 1);
  assert.deepEqual((await getPool().query("SELECT id,state,request_hash,dispatched_at,failure_code FROM guild_web_audit_cases WHERE tenant_id=$1 AND job_id=$2", [context.tenantId, context.jobId])).rows, original);
  assert.equal(getPool().waitingCount, 0);
  const retained = (await getPool().query("SELECT snapshot FROM guild_commissions WHERE id=$1", [commission.id])).rows[0].snapshot;
  assert.equal(retained.packages.find((item: { id: string }) => item.id === pkg.id).acceptancePack.parameters.authority.expiresAt, deadline);
  assert.equal(retained.payments.capturedMinor, 0); assert.equal(retained.payments.providerPaidMinor, 0);
  console.log(JSON.stringify({ syntheticApplicationConcurrency: true, originalDispatches: audit.calls, successfulContenders: 1, deniedCompeting: 5, revokedDenials: 6,
    first: { acquired: competing.acquired, maxClients: competing.maxClients, maxWaiting: competing.maxWaiting }, revoked: { acquired: denied.acquired, maxClients: denied.maxClients, maxWaiting: denied.maxWaiting }, providerCalls: 0 }));
});
