import assert from "node:assert/strict";
import test from "node:test";
import { recoverSavedWork } from "@/server/recovery";

test("a pending original browser read permits payment and webhook recovery to finish independently", async () => {
  let finishOriginal!: (value: unknown) => void;
  const original = new Promise(resolve => { finishOriginal = resolve; }), events: string[] = [];
  const recovery = recoverSavedWork({
    payment: async () => { events.push("payment-start"); await Promise.resolve(); events.push("payment-finish"); return { state: "payment-original-reconciled" }; },
    webhooks: async () => { events.push("webhook-start"); await Promise.resolve(); events.push("webhook-finish"); return { state: "webhook-original-reconciled" }; },
    hostedOriginal: () => { events.push("original-read-start"); return original; },
    production: async () => { events.push("production-start"); return { state: "queued" }; },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ["payment-start", "webhook-start", "original-read-start", "payment-finish", "webhook-finish"]);
  finishOriginal({ state: "received", caseId: "same-original" });
  assert.deepEqual(await recovery, { ok: true, hostedBrowser: { state: "received", caseId: "same-original" }, production: { state: "queued" }, payments: { state: "payment-original-reconciled" }, webhooks: { state: "webhook-original-reconciled" } });
  assert.equal(events.at(-1), "production-start");
});

test("independent recovery failures retain successful financial results and never repeat an original read", async () => {
  let originalReads = 0, paymentReads = 0, webhookReads = 0, productionRuns = 0;
  const result = await recoverSavedWork({ payment: async () => { paymentReads++; return { state: "original-payment-saved" }; },
    webhooks: async () => { webhookReads++; throw Error("Synthetic webhook read failure"); },
    hostedOriginal: async () => { originalReads++; throw Error("Synthetic original result remains held"); },
    production: async () => { productionRuns++; throw Error("Synthetic current authority denial"); } });
  assert.deepEqual(result, { ok: true, hostedBrowser: { state: "held" }, production: { state: "recoverable" }, payments: { state: "original-payment-saved" }, webhooks: { state: "recoverable" } });
  assert.deepEqual([originalReads, paymentReads, webhookReads, productionRuns], [1, 1, 1, 1]);
});
