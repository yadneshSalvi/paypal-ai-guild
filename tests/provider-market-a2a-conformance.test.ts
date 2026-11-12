import assert from "node:assert/strict";
import test from "node:test";
import { runProviderMarketA2AConformanceQualification } from "../scripts/check-provider-market-a2a-conformance";

test("A2A 1.0.1 Guild JSON-RPC profile: independent official SDK HTTP negatives and scoped pagination", { skip: !process.env.GUILD_A2A_CONFORMANCE_SCHEMA, timeout: 90_000 }, async () => {
  const result = await runProviderMarketA2AConformanceQualification();
  assert.equal(result.passed, true, JSON.stringify({ failures: result.failures, error: result.error, reportPath: result.reportPath }));
  assert.ok(result.checks.length >= 81); assert.ok(result.checks.every(check => check.passed));
  assert.deepEqual(result.changedSources, []); assert.deepEqual(result.bridgeErrors, []);
  assert.equal(result.sourceSpecification, "1.0.1"); assert.equal(result.sdkSpecification, "1.0.0"); assert.equal(result.wireVersion, "1.0");
  assert.equal(result.conformance, "not-qualified");
  assert.ok(result.wire.some(event => event.contentType?.includes("text/event-stream") && (event.chunks ?? 0) > 0));
  for (const count of Object.values(result.sideEffects)) assert.equal(count, 0);
});
