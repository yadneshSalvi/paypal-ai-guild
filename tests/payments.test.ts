import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createSampleCommission, planDigest } from "../src/domain/fixture";
import { assertAcceptedPayment, assertClosable, assertFinancialPlan, finalCaptureEligible, type EarnedWorkEvidence } from "../src/domain/payments";
import { digest, DomainError } from "../src/domain/primitives";
import type { Commission, PaymentOperationView } from "../src/contracts/guild";

const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;
const approved = (): Commission => { const c = createSampleCommission(randomUUID()); c.mode = "live"; c.state = "producing"; c.mandates.forEach(m => m.status = "active"); c.approvedPlanDigest = planDigest(c); return c; };
const accepted = () => {
  const c = approved(), p = c.packages[0]!, artifact = c.artifacts[0]!, actor = randomUUID();
  p.state = "accepted"; p.acceptedAt = new Date().toISOString(); p.acceptedBy = actor; p.paymentState = "eligible";
  p.provenance = artifact.provenance = { mode: "live", label: "Unit fixture only", sourceId: null, observedAt: null, sandbox: false };
  p.acceptancePack.criteria.forEach(check => check.status = "passed");
  const evidence: EarnedWorkEvidence = { id: randomUUID(), packageId: p.id, contractVersion: p.contractVersion, artifactId: artifact.id, artifactHash: artifact.contentHash, criteriaDigest: p.acceptancePack.digest, actorId: actor, review: { humanReviewed: true, actorKind: "judge", mode: "live" } };
  return { c, p, artifact, evidence };
};

test("sample and unsigned plans cannot arrange financial execution", () => {
  assert.throws(() => assertFinancialPlan(createSampleCommission(randomUUID())), code("SAMPLE_NOT_PAYABLE"));
  const c = approved(); c.approvedPlanDigest = null;
  assert.throws(() => assertFinancialPlan(c), code("APPROVAL_REQUIRED"));
});
test("approval binds fee allocation, provider, source and delegated authority", () => {
  for (const change of [
    (c: Commission) => { c.packages[0]!.providerAwardMinor -= 100; c.packages[0]!.serviceFeeMinor += 100; },
    (c: Commission) => { c.packages[0]!.providerId = "formwork"; },
    (c: Commission) => { c.sourceAssets.push({ id: "changed", contentHash: digest("changed") } as never); },
    (c: Commission) => { c.mandates[1]!.capMinor += 100; },
    (c: Commission) => { c.packages[0]!.dependsOn = ["images"]; },
  ]) { const c = approved(); change(c); assert.throws(() => assertFinancialPlan(c), code("PLAN_CHANGED")); }
});
test("artifact substitution, system acceptance and missing meaning review cannot earn payment", () => {
  const a = accepted(); assert.doesNotThrow(() => assertAcceptedPayment(a.c, a.p, a.evidence));
  a.artifact.content = { substituted: true }; assert.throws(() => assertAcceptedPayment(a.c, a.p, a.evidence), code("ARTIFACT_BINDING"));
  const b = accepted(); b.evidence.review = { humanReviewed: false, actorKind: "operator", mode: "live" }; assert.throws(() => assertAcceptedPayment(b.c, b.p, b.evidence), code("ACCEPTANCE_NOT_PAYABLE"));
  const d = accepted(); d.p.acceptancePack.criteria.find(check => check.kind === "human")!.status = "review"; assert.throws(() => assertAcceptedPayment(d.c, d.p, d.evidence), code("ACCEPTANCE_CHECKS"));
});
test("only the last fully accepted and otherwise paid package can close with final capture", () => {
  const c = approved(); c.packages.forEach(p => { p.state = "accepted"; p.paymentState = p.id === "web" ? "eligible" : "paid"; });
  assert.equal(finalCaptureEligible(c, "web", [], false), true);
  assert.equal(finalCaptureEligible(c, "web", [], true), false);
  c.packages[0]!.state = "correction_requested"; assert.equal(finalCaptureEligible(c, "web", [], false), false);
  c.packages[0]!.state = "accepted";
  assert.equal(finalCaptureEligible(c, "web", [{ kind: "capture_authorization", state: "pending_reconciliation" } as PaymentOperationView], false), false);
});
test("billing fallback preserves unpaid obligations and still refuses uncertain captures", () => {
  const { c } = accepted();
  assert.throws(() => assertClosable(c, [], false), code("ACCEPTED_WORK_UNPAID"));
  assert.doesNotThrow(() => assertClosable(c, [], false, true));
  assert.throws(() => assertClosable(c, [{ kind: "capture_authorization", state: "pending_reconciliation" } as PaymentOperationView], false, true), code("CAPTURE_UNCERTAIN"));
  assert.throws(() => assertClosable(c, [], true, true), code("RECOURSE_OPEN"));
});

test("payment commands reject client-selected amounts, recipients and final-capture authority", async () => {
  const { paymentCommandSchema } = await import("../src/contracts/payments");
  assert.equal(paymentCommandSchema.safeParse({ type: "pay_provider", expectedRevision: 1, packageId: "research", receiver: "injected@example.invalid" }).success, false);
  assert.equal(paymentCommandSchema.safeParse({ type: "capture_package", expectedRevision: 1, packageId: "research", amountMinor: 1, finalCapture: true }).success, false);
  assert.equal(paymentCommandSchema.safeParse({ type: "prepare_checkout", expectedRevision: 1, route: "authorization", amountMinor: 999999 }).success, false);
});
