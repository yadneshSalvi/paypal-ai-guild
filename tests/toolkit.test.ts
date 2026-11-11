import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { AxiosStatic } from "axios";
import { createReadToolkit, invokeOwnedOrderTool, normalizeOrderEvidence } from "../src/server/payments/toolkit";

process.env.PAYPAL_ENVIRONMENT = "sandbox";
process.env.PAYPAL_PROJECT_ISOLATED = "true";
process.env.PAYPAL_CLIENT_ID = "fixture-client";
process.env.PAYPAL_CLIENT_SECRET = "fixture-secret";
process.env.PAYPAL_API_BASE_URL = "https://api-m.sandbox.paypal.com";
const orderId = "FIXTUREORDER000001";
const axios = createRequire(createRequire(import.meta.url).resolve("@paypal/agent-toolkit/openai"))("axios") as AxiosStatic;

test("official Toolkit exposes an intact get_order schema and performs bounded sandbox OAuth + GET", async () => {
  const toolkit = createReadToolkit(), tools = toolkit.getTools();
  assert.equal(tools.length, 1); assert.equal(tools[0]!.function.name, "get_order");
  assert.deepEqual(tools[0]!.function.parameters?.required, ["id"]);
  assert.equal(tools[0]!.function.parameters?.type, "object");
  const original = axios.defaults.adapter, seen: { method: string; url: string }[] = [];
  axios.defaults.adapter = async config => {
    assert.equal(config.timeout, 15000); assert.equal(config.maxRedirects, 0); assert.equal(config.maxContentLength, 1024 * 1024);
    seen.push({ method: config.method!, url: config.url! });
    return { data: config.url!.endsWith("/oauth2/token") ? { access_token: "fixture-access", token_type: "Bearer", expires_in: 3600 } : { id: orderId, status: "CREATED", purchase_units: [{}] }, status: 200, statusText: "OK", headers: {}, config };
  };
  try {
    const raw = await invokeOwnedOrderTool(toolkit, { id: "call-fixture", name: "get_order", arguments: JSON.stringify({ id: orderId }) }, orderId);
    assert.equal((raw as { id: string }).id, orderId);
    assert.deepEqual(seen, [{ method: "post", url: "https://api.sandbox.paypal.com/v1/oauth2/token" }, { method: "get", url: `https://api.sandbox.paypal.com/v2/checkout/orders/${orderId}` }]);
    await assert.rejects(invokeOwnedOrderTool(toolkit, { id: "call-forged", name: "create_refund", arguments: "{}" }, orderId));
    await assert.rejects(invokeOwnedOrderTool(toolkit, { id: "call-forged", name: "get_order", arguments: JSON.stringify({ id: "OTHEROWNEDORDER001" }) }, orderId));
    await assert.rejects(invokeOwnedOrderTool(toolkit, { id: "call-forged", name: "get_order", arguments: JSON.stringify({ id: orderId, amount: "640.00" }) }, orderId));
    assert.equal(seen.length, 2, "ungranted tools and IDs made no provider call");
  } finally { axios.defaults.adapter = original; }
});

test("Toolkit evidence keeps exact cents and strips payer and merchant personal data", () => {
  const raw = { id: orderId, status: "COMPLETED", payer: { email_address: "private-fixture@example.test" }, purchase_units: [{ payee: { merchant_id: "private-fixture-merchant" }, payments: { captures: [{ id: "FIXTURECAPTURE001", status: "COMPLETED", amount: { currency_code: "USD", value: "98.00" }, seller_receivable_breakdown: { paypal_fee: { currency_code: "USD", value: "3.91" }, net_amount: { currency_code: "USD", value: "94.09" } } }] } }] };
  const evidence = normalizeOrderEvidence(raw, orderId, "run-fixture", "model-fixture");
  assert.deepEqual(evidence.captures.map(c => [c.amountMinor, c.feeMinor, c.netMinor]), [[9800, 391, 9409]]);
  assert.ok(!JSON.stringify(evidence).includes("private-fixture")); assert.ok(!JSON.stringify(evidence).includes(orderId));
  assert.throws(() => normalizeOrderEvidence(raw, "OTHEROWNEDORDER001", "run-fixture", null));
});
