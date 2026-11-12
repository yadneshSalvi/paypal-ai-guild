import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ArtifactManifest } from "../../src/contracts/guild";
import { isolatedPostgres } from "../support/postgres";
const cleanup = await isolatedPostgres("guild_web_history_test"); after(cleanup);
const { createSession } = await import("../../src/server/session");
const { createCommission, executeCommand, getCommission, saveCommission } = await import("../../src/server/commissions");
const { planDigest } = await import("../../src/domain/fixture");
const { digest, DomainError } = await import("../../src/domain/primitives");
const { getPool, transaction } = await import("../../src/server/db");
const { museumSources } = await import("../../src/exhibition/museum");
const { readWebSourceApproval } = await import("../../src/server/web/source-history");
const denied = (error: unknown) => error instanceof DomainError && ["WEB_SOURCE_APPROVAL", "CAPTION_AUTHORITY_BINDING"].includes(error.code);

/** Real create/approval/produce commands with one explicitly synthetic completed
 * artifact. No model, payment, accepted output or browser qualification. */
async function historyFixture() {
  const { session } = await createSession();
  const created = await createCommission(session, { commandId: randomUUID(), title: "Synthetic history boundary", museum: "Disposable local test museum", objective: "Verify retained producing authority and original terms without making external calls or asserting commissioned production.", capMinor: 64000, languages: ["en", "pt", "es", "fr", "ja", "ar"], sourceIds: museumSources.map(source => source.id) }, museumSources);
  await executeCommand(session, created.id, { type: "approve_plan", commandId: randomUUID(), expectedRevision: created.revision, planDigest: planDigest(created) });
  const approved = await getCommission(session, created.id), commandId = randomUUID();
  const result = await executeCommand(session, created.id, { type: "produce_package", commandId, expectedRevision: approved.revision, packageId: "research" });
  assert.ok(result.ok && result.jobId);
  const c = await getCommission(session, created.id), now = new Date().toISOString();
  const content = { schemaVersion: "guild.synthetic-history-fixture.v1", statement: "A deliberately synthetic artifact for historical authorization tests only." };
  const artifact: ArtifactManifest = { id: randomUUID(), packageId: "research", title: "Synthetic history fixture", mediaType: "application/json", contentHash: digest(content), downloadUrl: "/fixture", previewUrl: null, sourceIds: c.sourceAssets.map(source => source.id), createdAt: now,
    provenance: { mode: "live", label: "Synthetic isolated fixture; no commissioned output", sourceId: result.jobId, observedAt: now, sandbox: false }, reviewStatus: "No human review or acceptance", content };
  await transaction(async db => {
    c.artifacts.push(artifact); c.packages.find(pkg => pkg.id === "research")!.artifactIds = [artifact.id];
    await saveCommission(db, c);
    await db.query("UPDATE guild_jobs SET state='completed',output=$1 WHERE id=$2 AND tenant_id=$3", [{ artifactId: artifact.id }, result.jobId, c.tenantId]);
  });
  return { c, artifact, session, commandId, jobId: result.jobId };
}

test("the actual producing command and signed original approval authorize historical reads after later terms and workspace changes", async () => {
  const f = await historyFixture(), original = await readWebSourceApproval(getPool(), f.c, null, f.artifact);
  assert.equal(original.job.id, f.jobId); assert.equal(original.package.grossMinor, 9800);
  const later = structuredClone(f.c), current = later.packages.find(pkg => pkg.id === "research")!;
  current.grossMinor += 100; current.providerAwardMinor += 100; current.contractVersion++;
  later.approvedPlanDigest = null; later.revision += 4;
  // A later expiry/revocation must not erase valid historical work. It cannot
  // authorize fresh dispatch; that check belongs to the current actor gateway.
  await getPool().query("UPDATE guild_sessions SET revoked_at=now(),expires_at=$1 WHERE id=$2", [new Date(original.job.created_at.getTime() + 1), f.session.id]);
  const historical = await readWebSourceApproval(getPool(), later, null, f.artifact);
  assert.equal(historical.package.grossMinor, 9800);
  assert.equal(historical.receiptHash, original.receiptHash);
  await assert.rejects(readWebSourceApproval(getPool(), later, current, f.artifact), denied);
});

test("status and evidence annotations do not rewrite original commercial terms", async () => {
  const f = await historyFixture(), pkg = structuredClone(f.c.packages.find(item => item.id === "research")!);
  for (const criterion of pkg.acceptancePack.criteria) { criterion.status = "passed"; criterion.evidence = "Later synthetic annotation, not a new agreement."; }
  const value = await readWebSourceApproval(getPool(), f.c, pkg, f.artifact);
  assert.equal(value.job.id, f.jobId);
});

for (const mutation of ["missing-job", "job-after-artifact", "pending-job", "changed-artifact", "changed-command", "changed-snapshot", "changed-signature", "missing-approval", "expired-before-job", "other-tenant"] as const) {
  test("historical provenance refuses " + mutation, async () => {
    const f = await historyFixture();
    switch (mutation) {
      case "missing-job": await getPool().query("UPDATE guild_jobs SET output='{}'::jsonb WHERE id=$1", [f.jobId]); break;
      case "job-after-artifact": f.artifact.createdAt = new Date(0).toISOString(); break;
      case "pending-job": await getPool().query("UPDATE guild_jobs SET state='queued' WHERE id=$1", [f.jobId]); break;
      case "changed-artifact": f.artifact.content.statement = "Changed after hashing"; break;
      case "changed-command": await getPool().query("UPDATE guild_commands SET payload_hash=$1 WHERE tenant_id=$2 AND command_id=$3", ["0".repeat(64), f.c.tenantId, f.commandId]); break;
      case "changed-snapshot": await getPool().query("UPDATE guild_commands SET result=jsonb_set(result,'{commission,packages,0,grossMinor}','1'::jsonb) WHERE tenant_id=$1 AND command_id=$2", [f.c.tenantId, f.commandId]); break;
      case "changed-signature": await getPool().query("UPDATE guild_approval_receipts SET signature=$1 WHERE commission_id=$2", ["0".repeat(64), f.c.id]); break;
      case "missing-approval": await getPool().query("DELETE FROM guild_approval_receipts WHERE commission_id=$1", [f.c.id]); break;
      case "expired-before-job": await getPool().query("UPDATE guild_sessions SET expires_at='2000-01-01'::timestamptz WHERE id=$1", [f.session.id]); break;
      case "other-tenant": f.c.tenantId = randomUUID(); break;
    }
    await assert.rejects(readWebSourceApproval(getPool(), f.c, null, f.artifact), denied);
  });
}
