import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { digest } from "@/domain/primitives";
import { getPool } from "@/server/db";
import { validateWebEvidence } from "@/server/web/audit-evidence";
import { SyntheticWebAudit } from "./support/synthetic-web";
import { webAuditFixture } from "./helpers/web-audit-fixture";

test("synthetic browser fixture emits a complete internally consistent report after its test intent", async () => {
  // Pure fixture qualification: no database or browser connection is made.
  process.env.DATABASE_URL = "postgresql://unused@127.0.0.1:1/unused_fixture";
  const pool = getPool(), original = pool.query;
  const f = await webAuditFixture(); let launched = false;
  pool.query = (async () => { assert.equal(launched, true); return { rows: [{ state: "dispatching", dispatched_at: new Date(), request_hash: digest(f.request) }] }; }) as unknown as typeof pool.query;
  try {
    const gateway = new SyntheticWebAudit(), output = await gateway.run({ id: randomUUID(), tenantId: randomUUID(), jobId: randomUUID(), bundleId: randomUUID(), request: f.request,
      manifest: f.rendered.bundle, read: async file => { const bytes = f.rendered.authored.get(file.path); assert.ok(bytes, file.path); return bytes; }, beforeLaunch: async () => { launched = true; } });
    assert.equal(gateway.calls, 1); assert.equal(output.result.axe.length, 6); assert.equal(output.result.interactions.length, 17);
    assert.deepEqual(validateWebEvidence(f.request, output.result, output.files), output.result);
  } finally { pool.query = original; await pool.end(); delete process.env.DATABASE_URL; }
});
