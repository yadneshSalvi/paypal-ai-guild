import test from "node:test";
import assert from "node:assert/strict";
import { createSampleCommission, planDigest } from "../src/domain/fixture";
import { scheduleSnapshotSchema } from "../src/scheduling/contracts";
import { openingRecoveryFixture } from "../src/scheduling/opening-fixture";
import { assistantToolSchemas, nativePlanSteps, planningStepsHaveEvidence } from "../src/scheduling/assistant";

test("unscheduled legacy plans retain the exact c9468 digest", () => {
  const c = createSampleCommission("11111111-1111-4111-8111-111111111111");
  c.id = "22222222-2222-4222-8222-222222222222";
  for (const page of c.mandates) page.expiresAt = "2026-11-11T11:45:29.435Z";
  // Computed from the frozen c9468 implementation, before schedule.v2 existed.
  assert.equal(planDigest(c), "6cb1d1cd1c323f6ccd97f0029c9c905934944601e3bcd8d46f92c5198d4b1fad");
});

test("native plan steps require their matching evidence and cannot imply approval or payment", () => {
  const steps = nativePlanSteps.map((description, i) => ({ id: i + 1, description }));
  const evidence = new Map([["getOpeningPlan", "read-proof"]]);
  assert.equal(planningStepsHaveEvidence(steps, [1], evidence), true);
  assert.equal(planningStepsHaveEvidence(steps, [1, 3], evidence), false);
  assert.equal(planningStepsHaveEvidence(steps, [4], evidence), false);
  assert.equal(assistantToolSchemas.createPlan.safeParse({ steps: ["Approve the Passport and pay"] }).success, false);
  evidence.set("proposeOpeningChange", "saved-proposal-proof");
  assert.equal(planningStepsHaveEvidence(steps, [3], evidence), true);
  assert.equal(planningStepsHaveEvidence(steps, [2], evidence), false);
});

test("the v1 engine snapshot still rejects unreviewed production and quote fields", () => {
  const fixture = openingRecoveryFixture("accessible");
  assert.equal(scheduleSnapshotSchema.safeParse({ ...fixture, quoteBindings: [] }).success, false);
  assert.equal(scheduleSnapshotSchema.safeParse({ ...fixture, provenance: { ...fixture.provenance, mode: "live" } }).success, false);
});
