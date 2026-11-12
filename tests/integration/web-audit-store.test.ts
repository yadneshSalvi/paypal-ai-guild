import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { digest } from "@/domain/primitives";
import { isolatedPostgres } from "../support/postgres";
const cleanup = await isolatedPostgres("guild_web_audit_store_test"); after(cleanup);
const { fresh } = await import("../support/narration-fixture");
const { getPool } = await import("@/server/db");
const { webAuditFixture } = await import("../helpers/web-audit-fixture");
const { SyntheticWebAudit } = await import("../support/synthetic-web");
const { readWebAuditCaseDetails, saveWebAuditObservation } = await import("@/server/web/audit-store");
import type { WebAuditRow } from "@/server/web/audit-store";

test("original browser evidence stores its complete JSON file register, round-trips, replays without replacement and rejects changed bytes", async () => {
  const owner = await fresh(), fixture = await webAuditFixture(), request = fixture.request;
  request.mode = "producer"; request.caseId = "producer:1:en:390";
  const jobId = randomUUID(), id = randomUUID(), bundleId = randomUUID();
  // Storage-boundary fixture only. No actual authority, browser launch, source
  // qualification, model work or acceptance is represented by these seeded rows.
  await getPool().query("INSERT INTO guild_jobs(id,tenant_id,commission_id,business_key,type,state,input) VALUES($1,$2,$3,$4,'produce_package','running',$5)", [jobId, owner.session.tenantId, owner.commissionId, "synthetic-audit-storage:" + id, { packageId: "web", contractVersion: 1, syntheticFixture: true }]);
  const row = (await getPool().query<WebAuditRow>("INSERT INTO guild_web_audit_cases(id,tenant_id,commission_id,package_id,contract_version,job_id,case_key,mode,request_hash,request,state,dispatched_at) VALUES($1,$2,$3,'web',1,$4,$5,'producer',$6,$7,'dispatching',now()) RETURNING *", [id, owner.session.tenantId, owner.commissionId, jobId, request.caseId, digest(request), request])).rows[0]!;
  const gateway = new SyntheticWebAudit();
  const measured = await gateway.run({ id, tenantId: owner.session.tenantId, jobId, bundleId, request, manifest: fixture.rendered.bundle,
    read: async file => { const bytes = fixture.rendered.authored.get(file.path); assert.ok(bytes); return bytes; }, beforeLaunch: async () => {} });
  const receipt = await saveWebAuditObservation(row, measured.result, measured.files);
  assert.equal(receipt.result.files.length, measured.files.size);
  assert.deepEqual(await saveWebAuditObservation(row, measured.result, measured.files), receipt);
  const saved = await readWebAuditCaseDetails(owner.session.tenantId, id);
  assert.deepEqual(saved.receipt, receipt); assert.equal(saved.files.size, measured.files.size);
  await assert.rejects(readWebAuditCaseDetails(randomUUID(), id));
  await getPool().query("UPDATE guild_web_audit_files SET bytes=decode(repeat('00',byte_length),'hex') WHERE case_id=$1 AND path=$2", [id, measured.result.files[0]!.path]);
  await assert.rejects(readWebAuditCaseDetails(owner.session.tenantId, id), /retained bytes/);
});
