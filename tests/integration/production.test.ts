import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isolatedPostgres } from "../support/postgres";
const cleanup = await isolatedPostgres("guild_production_test"); after(cleanup);
const { createSession } = await import("../../src/server/session");
const { createCommission, executeCommand, getCommission, saveCommission, seedCommission } = await import("../../src/server/commissions");
const { planDigest } = await import("../../src/domain/fixture");
const { DomainError } = await import("../../src/domain/primitives");
const { getPool, transaction } = await import("../../src/server/db");
const { museumSources } = await import("../../src/exhibition/museum");
const { produce } = await import("../../src/server/production");
const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;
async function fresh() {
  const { session } = await createSession();
  const c = await createCommission(session, { commandId: randomUUID(), title: "Full source production fixture", museum: "Fixture museum", objective: "Test the exact source-grounded production contract without any model or payment call.", capMinor: 64000, languages: ["en", "pt", "es", "fr", "ja", "ar"], sourceIds: museumSources.map(source => source.id) }, museumSources);
  return { session, c };
}

test("new live research freezes source spans while existing sample contracts remain unchanged", async () => {
  const { session, c } = await fresh(), sample = await seedCommission(session);
  assert.equal(c.packages[0]!.acceptancePack.version, "2.0.0"); assert.equal(sample.packages[0]!.acceptancePack.version, "1.0.0");
  assert.equal(c.sourceAssets.length, 12); assert.equal(c.artifacts.length, 0);
  const frozen = c.packages[0]!.acceptancePack.digest;
  await executeCommand(session, c.id, { type: "approve_plan", commandId: randomUUID(), expectedRevision: 0, planDigest: planDigest(c) });
  await executeCommand(session, c.id, { type: "produce_package", commandId: randomUUID(), expectedRevision: 1, packageId: "research" });
  const saved = await getCommission(session, c.id);
  assert.equal(saved.packages[0]!.acceptancePack.digest, frozen); assert.equal(saved.packages[0]!.acceptancePack.version, "2.0.0");
  assert.equal(saved.mandates[0]!.reservedMinor, 9800);
});
test("source metadata changes stop production before model dispatch", async () => {
  const { session, c } = await fresh(); c.sourceAssets[0]!.date = "Changed catalogue text";
  await assert.rejects(produce({ tenantId: session.tenantId, jobId: randomUUID() }, c, "research"), code("SOURCE_CONTRACT_CHANGED"));
  const runs = await getPool().query("SELECT count(*)::int AS count FROM guild_model_runs WHERE tenant_id=$1", [session.tenantId]);
  assert.equal(runs.rows[0].count, 0);
});
test("one agreed correction survives reload without changing criteria or reserving twice", async () => {
  const { session, c } = await fresh();
  await executeCommand(session, c.id, { type: "approve_plan", commandId: randomUUID(), expectedRevision: 0, planDigest: planDigest(c) });
  const frozen = c.packages[0]!.acceptancePack.digest;
  for (let submission = 0; submission < 2; submission++) {
    const current = await getCommission(session, c.id);
    const result = await executeCommand(session, c.id, { type: "produce_package", commandId: randomUUID(), expectedRevision: current.revision, packageId: "research" });
    assert.equal(result.ok, true);
    // This models completed attempts in a disposable schema, never a provider submission or acceptance.
    await transaction(async db => {
      await db.query("UPDATE guild_jobs SET state='completed' WHERE commission_id=$1 AND type='produce_package'", [c.id]);
      const saved = (await db.query("SELECT snapshot FROM guild_commissions WHERE id=$1 FOR UPDATE", [c.id])).rows[0].snapshot;
      saved.packages[0].state = "correction_requested"; await saveCommission(db, saved);
    });
  }
  const current = await getCommission(session, c.id);
  await assert.rejects(executeCommand(session, c.id, { type: "produce_package", commandId: randomUUID(), expectedRevision: current.revision, packageId: "research" }), code("CORRECTION_ALLOWANCE"));
  const saved = await getCommission(session, c.id);
  assert.equal(saved.packages[0]!.acceptancePack.digest, frozen); assert.equal(saved.mandates[0]!.reservedMinor, 9800);
  const rows = await getPool().query("SELECT count(*)::int AS count FROM guild_jobs WHERE commission_id=$1", [c.id]); assert.equal(rows.rows[0].count, 2);
});
