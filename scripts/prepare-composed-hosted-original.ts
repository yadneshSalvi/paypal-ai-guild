/** Synthetic storage/transport fixture only. It exercises HTTP access to a
 * fully retained original; it grants no production/browser capability. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadComposedFixture } from "../tests/support/load-composed-fixture";
import { digest } from "../src/domain/primitives";
import type { WebAuditRow } from "../src/server/web/audit-store";

const fixture = await loadComposedFixture(process.argv[2] ?? "missing-http-fixture", "http"), target = resolve(dirname(fixture.fixturePath), "hosted-original.json");
const { getPool } = await import("../src/server/db"), pool = getPool();
try {
  const { hostedWebFixture, SyntheticHostedDriver } = await import("../tests/support/hosted-web");
  const { HostedWebAuditGateway } = await import("../src/server/web/hosted-gateway");
  const { PostgresHostedAttemptStore } = await import("../src/server/web/hosted-store");
  const { recoverOriginalHostedWebAudit } = await import("../src/server/web/hosted-recovery");
  const f = await hostedWebFixture(); f.originalDeadline = new Date(Date.now() + 10_000).toISOString();
  f.row.tenant_id = fixture.owner.tenantId; f.row.commission_id = fixture.commissionId;
  f.input.tenantId = fixture.owner.tenantId;
  await pool.query("INSERT INTO guild_jobs(id,tenant_id,commission_id,business_key,type,state,input,lease_token,lease_until,error) VALUES($1,$2,$3,$4,'produce_package','running',$5,$6,now()+interval '6 minutes',$7)",
    [f.row.job_id, fixture.owner.tenantId, fixture.commissionId, "synthetic-composition-original:" + f.row.id, { packageId: "web", contractVersion: 1, syntheticFixture: true }, f.workerId,
      "SYNTHETIC original hosted transport-boundary fixture. No actual VM, browser, production authority or provider call."]);
  await pool.query("INSERT INTO guild_commands(tenant_id,command_id,commission_id,payload_hash,result) VALUES($1,$2,$3,$4,$5)",
    [fixture.owner.tenantId, randomUUID(), fixture.commissionId, digest({ syntheticHostedOriginal: f.row.id }), { ok: true, jobId: f.row.job_id, syntheticFixture: true, commission: { packages: [{ id: "web", kind: "web" }] } }]);
  f.row = (await pool.query<WebAuditRow>("INSERT INTO guild_web_audit_cases(id,tenant_id,commission_id,package_id,contract_version,job_id,case_key,mode,request_hash,request,state,dispatched_at) VALUES($1,$2,$3,'web',1,$4,$5,'producer',$6,$7,'dispatching',$8) RETURNING *",
    [f.row.id, fixture.owner.tenantId, fixture.commissionId, f.row.job_id, f.row.case_key, f.row.request_hash, f.request, f.row.dispatched_at])).rows[0]!;
  f.input.beforeLaunch = async () => ({ workerId: f.workerId, originalDeadline: f.originalDeadline });
  const driver = new SyntheticHostedDriver(f, { lostBrowserAfterStart: true }), gateway = new HostedWebAuditGateway({ runtime: f.runtime, driver });
  await assert.rejects(gateway.run(f.input));
  await pool.query("UPDATE guild_web_audit_cases SET state='indeterminate',failure_code='SYNTHETIC_ORIGINAL_RESPONSE_LOST' WHERE id=$1", [f.row.id]);
  await pool.query("UPDATE guild_jobs SET state='needs_review',lease_until=NULL WHERE id=$1", [f.row.job_id]);
  const original = await new PostgresHostedAttemptStore().read(fixture.owner.tenantId, f.row.id);
  assert.equal(original.phase, "browser_started"); assert.ok(original.commands.browser);
  const recovered = await recoverOriginalHostedWebAudit(fixture.owner.tenantId, f.row.id, gateway);
  const wait = Date.parse(f.originalDeadline) - Date.now() + 25; if (wait > 0) await new Promise(accept => setTimeout(accept, wait));
  assert.ok(Date.parse(f.originalDeadline) < Date.now());
  const final = await new PostgresHostedAttemptStore().read(fixture.owner.tenantId, f.row.id);
  assert.equal(final.phase, "cleaned"); assert.equal(final.commands.browser!.id, original.commands.browser!.id); assert.equal(final.binding.originalDeadline, original.binding.originalDeadline);
  assert.equal(driver.counts.create, 1); assert.equal(driver.counts.browser, 1); assert.equal(driver.counts.upload, 1); assert.equal(driver.counts.stop, 1);
  const result = { version: "guild.synthetic-composed-hosted-original.v1", disclosure: "Synthetic storage and hosted-transport boundary only. No real VM/browser, production authority, human review or payment.",
    tenantId: fixture.owner.tenantId, jobId: f.row.job_id, caseId: f.row.id, requestHash: f.row.request_hash, originalDeadline: final.binding.originalDeadline,
    originalDispatchedAt: final.binding.originalDispatchedAt, originalSessionId: final.session!.id, originalCommandId: final.commands.browser!.id,
    resultHash: recovered.receipt.resultHash, originalFailureCode: "SYNTHETIC_ORIGINAL_RESPONSE_LOST", syntheticDriverCalls: driver.counts, actualProviderCalls: 0 };
  await writeFile(target, JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ target, jobId: result.jobId, caseId: result.caseId, originalDeadlineAlreadyExpired: true, actualProviderCalls: 0 }));
} finally { await pool.end(); }
