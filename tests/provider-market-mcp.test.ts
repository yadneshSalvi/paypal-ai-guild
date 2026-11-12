import assert from "node:assert/strict";
import test from "node:test";
import { runProviderMarketMcpQualification } from "../scripts/check-provider-market-mcp-http";

test("official MCP2.4 real-loopback tools and owner-bound one-use approval continuation", { skip: !process.env.GUILD_MCP_TEST_SCHEMA, timeout: 60_000 }, async () => {
  const report = await runProviderMarketMcpQualification();
  assert.equal(report.passed, true, report.error?.message);
  assert.ok(report.checks.length >= 30);
  assert.equal(report.actualNextClaimed, false);
  assert.equal(report.nativeBrowserClaimed, false);
});
