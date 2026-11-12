import assert from "node:assert/strict";
import test from "node:test";
import { runProviderAccessNextQualification } from "../scripts/check-provider-access-next-http";
test("actual isolated Next provider invitation, separate sessions and bounded agent access", {
  skip: !process.env.GUILD_NEXT_TEST_SCHEMA?.startsWith("guild_access_next_worker_"), timeout: 240_000,
}, async () => {
  const report = await runProviderAccessNextQualification();
  assert.equal(report.passed, true, JSON.stringify({ failures: report.failures, error: report.error, reportPath: report.reportPath }));
  assert.ok(report.checks.length >= 35); assert.equal(report.actualNext, true); assert.equal(report.nativeBrowser, false);
});
