import assert from "node:assert/strict";
import test from "node:test";
import { runProviderMarketA2aQualification } from "../scripts/check-provider-market-a2a-http";
test("independent official A2A1.3 provider-market real HTTP and restricted-schema qualification", { skip: !process.env.GUILD_A2A_TEST_SCHEMA, timeout: 90_000 }, async () => {
  const result = await runProviderMarketA2aQualification();
  assert.equal(result.passed, true, JSON.stringify({ failures: result.failures, error: result.error, reportPath: result.reportPath }));
  assert.ok(result.checks.length >= 49); assert.ok(result.checks.every(check => check.passed)); assert.equal(result.changedSources.length, 0);
  assert.equal(result.conformance, "pending"); assert.equal(result.sourceSpecification, "1.0.1"); assert.equal(result.sdkSpecification, "1.0.0"); assert.equal(result.wireVersion, "1.0"); assert.equal(result.nativeBrowserClaimed, false); assert.equal(result.actualNextClaimed, false); assert.equal(result.peakPoolConnections, 6);
  assert.ok(result.wire.some(event => event.dropped)); assert.ok(result.wire.some(event => event.credentialMode === "operation-read")); assert.ok(result.wire.some(event => event.contentType?.includes("text/event-stream") && (event.chunks ?? 0) > 0));
});
