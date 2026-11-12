import assert from "node:assert/strict";
import test from "node:test";
import { runProviderMarketNextHttpQualification } from "../scripts/check-provider-market-next-http";
test("actual isolated Next market, compiled DOM, MCP and A2A HTTP", { skip: !process.env.GUILD_NEXT_TEST_SCHEMA, timeout: 180_000 }, async () => {
  const report = await runProviderMarketNextHttpQualification();
  assert.equal(report.passed, true, JSON.stringify({ failures: report.failures, error: report.error, reportPath: report.reportPath }));
  assert.ok(report.checks.length >= 16); assert.equal(report.actualNext, true); assert.equal(report.compiledClientDom, true); assert.equal(report.nativeBrowser, false); assert.deepEqual(report.sourceDrift, []);
});
