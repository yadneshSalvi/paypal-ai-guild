import test, { after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import { SandboxCommerceRestGateway, SandboxPayPalProvider } from "@fracture/paypal-core";
import type { Commission } from "../../src/contracts/guild";
import { PayPalWireFixture } from "../support/paypal-fixture";
import { CommerceWireFixture } from "../support/commerce-fixture";

try { process.loadEnvFile(".env"); } catch { /* CI injects its own database. */ }
const originalUrl = process.env.DATABASE_URL!;
assert.ok(originalUrl, "PostgreSQL is required for commercial execution tests");
const schema = `guild_payment_test_${randomUUID().replaceAll("-", "")}`;
const admin = new Pool({ connectionString: originalUrl, max: 1 });
await admin.query(`CREATE SCHEMA "${schema}"`);
const isolatedUrl = new URL(originalUrl); isolatedUrl.searchParams.set("options", `${isolatedUrl.searchParams.get("options") ?? ""} -c search_path=${schema}`.trim());
process.env.DATABASE_URL = isolatedUrl.toString();
process.env.AUTH_SECRET = "fixture-approval-secret-used-only-in-isolated-test-schema";
process.env.JUDGE_SESSION_SECRET = "fixture-session-secret-used-only-in-isolated-test-schema";
process.env.APP_URL = "http://localhost:4101";
process.env.PAYPAL_CLIENT_ID = "fixture-app-only";
process.env.PAYPAL_CLIENT_SECRET = "fixture-app-secret-only";
process.env.PAYPAL_ENVIRONMENT = "sandbox";
process.env.PAYPAL_PROJECT_ISOLATED = "true";
const fixtureRecipients = JSON.stringify(Array.from({ length: 6 }, (_, i) => ({ providerIndex: i + 1, email: `fixture-provider-${i + 1}@example.invalid`, controlledSandboxAccount: true })));
process.env.GUILD_SANDBOX_PROVIDER_RECEIVERS_JSON = fixtureRecipients;
const { getPool, transaction } = await import("../../src/server/db");
const { createSession } = await import("../../src/server/session");
const { seedCommission, saveCommission, getCommission, executeCommand } = await import("../../src/server/commissions");
const { createPaymentRuntime } = await import("../../src/server/payments/runtime");
const { executePayment, reconcilePayments } = await import("../../src/server/payments/service");
const { admitCapture } = await import("../../src/server/payments/admission");
const { listIntents } = await import("../../src/server/payments/repository");
const { admitProviderPayout, dispatchProviderPayout, recoverProviderPayouts } = await import("../../src/server/payments/payouts");
const { ingestPaymentWebhook, recoverWebhookObservations } = await import("../../src/server/payments/webhooks");
const { planDigest } = await import("../../src/domain/fixture");
const { digest, DomainError } = await import("../../src/domain/primitives");
for (const file of (await readdir(new URL("../../migrations/", import.meta.url))).filter(file => file.endsWith(".sql")).sort()) await getPool().query(await readFile(new URL(`../../migrations/${file}`, import.meta.url), "utf8"));
after(async () => { await getPool().end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); });
const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;

async function fresh(t: TestContext, acceptedIds: string[] = ["research"], replacement = false) {
  const wire = new PayPalWireFixture();
  const provider = new SandboxPayPalProvider({ environment: "sandbox", baseUrl: "https://api-m.sandbox.paypal.com", clientId: "fixture-client", clientSecret: "fixture-secret", isolatedProject: "guild-fixture" }, wire.fetch);
  const runtime = createPaymentRuntime(provider); await runtime.store.initialize(); t.after(() => runtime.db.close());
  const commerceWire = new CommerceWireFixture();
  runtime.commerce = new SandboxCommerceRestGateway({ environment: "sandbox", baseUrl: "https://api-m.sandbox.paypal.com", clientId: "fixture-app-only", clientSecret: "fixture-app-secret-only", isolatedProject: "guild-fixture" }, commerceWire.fetch);
  const { session } = await createSession(); const seeded = await seedCommission(session);
  await transaction(async db => {
    seeded.mode = "live"; seeded.state = "awaiting_approval";
    if (replacement) { const web = seeded.packages.find(p => p.id === "web")!; web.providerId = "ostrava"; web.providerAwardMinor = 16000; web.grossMinor = 17500; web.contractVersion = 2; web.workingHours = 8; }
    await saveCommission(db, seeded);
  });
  await executeCommand(session, seeded.id, { type: "approve_plan", expectedRevision: 0, commandId: randomUUID(), planDigest: planDigest(seeded) });
  await transaction(async db => {
    const c = (await db.query<{ snapshot: Commission }>("SELECT snapshot FROM guild_commissions WHERE id=$1 FOR UPDATE", [seeded.id])).rows[0]!.snapshot;
    for (const packageId of acceptedIds) {
      const pkg = c.packages.find(p => p.id === packageId)!;
      const artifactId = randomUUID(), content = { fixtureOnly: true, packageId, statement: "Synthetic transport test; no actual model or human review is claimed." };
      const provenance = { mode: "live" as const, label: "Isolated PostgreSQL transport fixture only", sourceId: null, observedAt: new Date().toISOString(), sandbox: false };
      const artifact = { id: artifactId, packageId, title: "Test artifact", mediaType: "application/json", contentHash: digest(content), content, downloadUrl: `/api/artifacts/${artifactId}/download`, previewUrl: null, sourceIds: [], createdAt: new Date().toISOString(), provenance, reviewStatus: "Test fixture" };
      c.artifacts.push(artifact); pkg.artifactIds = [artifactId]; pkg.state = "accepted"; pkg.acceptedBy = session.id; pkg.acceptedAt = new Date().toISOString(); pkg.paymentState = "eligible"; pkg.provenance = provenance;
      pkg.acceptancePack.criteria.forEach(criterion => criterion.status = "passed");
      await saveCommission(db, c);
      await db.query("INSERT INTO guild_acceptance_decisions(id,tenant_id,commission_id,package_id,contract_version,artifact_id,artifact_hash,criteria_digest,actor_id,decision,review_disclosures) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'accepted',$10)", [randomUUID(), c.tenantId, c.id, pkg.id, pkg.contractVersion, artifactId, artifact.contentHash, pkg.acceptancePack.digest, session.id, { humanReviewed: true, actorKind: "judge", mode: "live", fixtureOnly: true }]);
      let mandate = c.mandates.find(m => m.parentId && m.allowedKinds.includes(pkg.kind)) ?? c.mandates[0]!;
      await db.query("INSERT INTO guild_budget_reservations(id,tenant_id,commission_id,mandate_id,operation_key,amount_minor,currency,state) VALUES($1,$2,$3,$4,$5,$6,'USD','committed')", [randomUUID(), c.tenantId, c.id, mandate.id, `production:${c.id}:${pkg.id}:${pkg.contractVersion}`, pkg.grossMinor]);
      while (mandate) { mandate.committedMinor += pkg.grossMinor; const parent = c.mandates.find(m => m.id === mandate.parentId); if (!parent) break; mandate = parent; }
    }
    c.state = c.packages.every(p => p.state === "accepted") ? "delivered" : "producing"; await saveCommission(db, c);
  });
  return { session, c: await getCommission(session, seeded.id), runtime, wire, commerceWire };
}
async function authorize(f: Awaited<ReturnType<typeof fresh>>) {
  const prepared = await executePayment(f.session, f.c.id, { type: "prepare_checkout", route: "authorization", expectedRevision: (await getCommission(f.session, f.c.id)).revision }, f.runtime);
  const checkout = prepared.commission.payments.checkout!; f.wire.approve(checkout.orderId!);
  return executePayment(f.session, f.c.id, { type: "complete_checkout", intentId: checkout.id, orderId: checkout.orderId!, checkoutToken: prepared.checkoutToken! }, f.runtime);
}

test("sample, operator and cross-tenant admissions make zero SDK financial calls", async t => {
  const f = await fresh(t), other = await createSession(), sample = await seedCommission(f.session);
  await assert.rejects(executePayment(f.session, sample.id, { type: "prepare_checkout", route: "authorization", expectedRevision: 0 }, f.runtime), code("SAMPLE_NOT_PAYABLE"));
  await assert.rejects(executePayment({ ...f.session, role: "operator" }, f.c.id, { type: "prepare_checkout", route: "authorization", expectedRevision: f.c.revision }, f.runtime), code("PAYMENT_ROLE"));
  await assert.rejects(executePayment(other.session, f.c.id, { type: "prepare_checkout", route: "authorization", expectedRevision: f.c.revision }, f.runtime), code("NOT_FOUND"));
  assert.equal(f.wire.calls.length, 0);
});
test("concurrent checkout and callback repeats retain one order and one authorization", async t => {
  const f = await fresh(t), command = { type: "prepare_checkout" as const, route: "authorization" as const, expectedRevision: f.c.revision };
  const [one, two] = await Promise.all([executePayment(f.session, f.c.id, command, f.runtime), executePayment(f.session, f.c.id, command, f.runtime)]);
  assert.equal(one.commission.payments.checkout!.id, two.commission.payments.checkout!.id);
  const checkout = (await getCommission(f.session, f.c.id)).payments.checkout!;
  assert.equal(f.wire.writes("/orders").length, 1); f.wire.approve(checkout.orderId!);
  const returned = { type: "complete_checkout" as const, intentId: checkout.id, orderId: checkout.orderId!, checkoutToken: one.checkoutToken! };
  await Promise.all([executePayment(f.session, f.c.id, returned, f.runtime), executePayment(f.session, f.c.id, returned, f.runtime)]);
  assert.equal(f.wire.writes("/authorize").length, 1);
  assert.equal((await getCommission(f.session, f.c.id)).payments.authorizedMinor, 64000);
  assert.equal((await getCommission(f.session, f.c.id)).payments.capturedMinor, 0);
  assert.deepEqual(f.wire.writes("/authorize")[0]!.body, {}); assert.ok(f.wire.writes("/authorize")[0]!.requestId);
});
test("payer callback is bound to the original order and challenge", async t => {
  const f = await fresh(t), prepared = await executePayment(f.session, f.c.id, { type: "prepare_checkout", route: "authorization", expectedRevision: f.c.revision }, f.runtime), checkout = prepared.commission.payments.checkout!;
  await assert.rejects(executePayment(f.session, f.c.id, { type: "complete_checkout", intentId: checkout.id, orderId: "FORGEDORDER0000001", checkoutToken: prepared.checkoutToken! }, f.runtime), code("ORDER_BINDING"));
  await assert.rejects(executePayment(f.session, f.c.id, { type: "complete_checkout", intentId: checkout.id, orderId: checkout.orderId!, checkoutToken: "incorrect-return-proof" }, f.runtime), code("CHECKOUT_CHALLENGE"));
  assert.equal(f.wire.writes("/authorize").length, 0);
});
test("lost create response remains uncertain across repeated clicks and fresh runtime", async t => {
  const f = await fresh(t); f.wire.failNextCreate = true;
  const first = await executePayment(f.session, f.c.id, { type: "prepare_checkout", route: "authorization", expectedRevision: f.c.revision }, f.runtime);
  assert.equal(first.commission.payments.checkout!.state, "pending_reconciliation");
  await executePayment(f.session, f.c.id, { type: "prepare_checkout", route: "authorization", expectedRevision: f.c.revision }, f.runtime);
  const resumed = createPaymentRuntime(f.runtime.provider); t.after(() => resumed.db.close());
  const second = await reconcilePayments(f.session, f.c.id, resumed);
  assert.equal(second.payments.checkout!.orderId, null); assert.equal(f.wire.writes("/orders").length, 1);
  await assert.rejects(executePayment(f.session, f.c.id, { type: "retry_operation", intentId: first.commission.payments.checkout!.id }, resumed), code("RECONCILIATION_REQUIRED"));
});
test("six exact captures total $580, close on the last $175 and fund six $530-total provider awards", async t => {
  const ids = ["research", "translation", "narration", "images", "captions", "web"], f = await fresh(t, ids, true); await authorize(f);
  for (const packageId of ids) await executePayment(f.session, f.c.id, { type: "capture_package", expectedRevision: (await getCommission(f.session, f.c.id)).revision, packageId }, f.runtime);
  const c = await getCommission(f.session, f.c.id), writes = f.wire.writes("/capture");
  assert.deepEqual(writes.map(w => w.body!.amount.value), ["98.00", "130.00", "87.00", "50.00", "40.00", "175.00"]);
  assert.deepEqual(writes.map(w => w.body!.final_capture), [false, false, false, false, false, true]);
  assert.equal(c.payments.capturedMinor, 58000); assert.equal(c.payments.serviceFeeMinor, 5000); assert.equal(c.payments.providerPayableMinor, 53000);
  assert.equal(c.payments.authorizedMinor - c.payments.capturedMinor, 6000); assert.equal(c.payments.authorization!.status, "CAPTURED");
  assert.equal(c.payments.authorization!.closureQualified, false, "fixture closure cannot manufacture a live merchant qualification");
  assert.equal(c.payments.providerPaidMinor, 0); assert.ok(c.packages.every(p => p.paymentState === "paid"));
  for (const packageId of ids) await executePayment(f.session, f.c.id, { type: "pay_provider", expectedRevision: (await getCommission(f.session, f.c.id)).revision, packageId }, f.runtime);
  const settled = await getCommission(f.session, f.c.id), payouts = f.commerceWire.writes("/payouts");
  assert.deepEqual(payouts.map(p => p.body!.items[0].amount.value), ["90.00", "120.00", "80.00", "45.00", "35.00", "160.00"]);
  assert.equal(new Set(payouts.map(p => p.body!.items[0].receiver)).size, 6); assert.ok(settled.payments.payouts.every(p => p.status === "SUCCESS")); assert.equal(settled.payments.providerPaidMinor, 53000); assert.equal(settled.payments.providerPayableMinor, 0); assert.equal(settled.payments.serviceFeeMinor, 5000);
});
test("concurrent requests for an accepted package create only one SDK capture", async t => {
  const f = await fresh(t); await authorize(f); const c = await getCommission(f.session, f.c.id), command = { type: "capture_package" as const, expectedRevision: c.revision, packageId: "research" };
  await Promise.all([executePayment(f.session, f.c.id, command, f.runtime), executePayment(f.session, f.c.id, command, f.runtime)]);
  assert.equal(f.wire.writes("/capture").length, 1); assert.equal((await getCommission(f.session, f.c.id)).payments.capturedMinor, 9800);
});
test("unknown partial capture blocks further charges without borrowing another capture identity", async t => {
  const f = await fresh(t, ["research", "translation"]); await authorize(f); f.wire.failNextCapture = "lost";
  await executePayment(f.session, f.c.id, { type: "capture_package", expectedRevision: (await getCommission(f.session, f.c.id)).revision, packageId: "research" }, f.runtime);
  const current = await getCommission(f.session, f.c.id); assert.equal(current.packages[0]!.paymentState, "unknown");
  await assert.rejects(executePayment(f.session, f.c.id, { type: "capture_package", expectedRevision: current.revision, packageId: "translation" }, f.runtime), code("CAPTURE_UNCERTAIN"));
  await executePayment(f.session, f.c.id, { type: "capture_package", expectedRevision: current.revision, packageId: "research" }, f.runtime);
  assert.equal(f.wire.writes("/capture").length, 1); assert.equal((await reconcilePayments(f.session, f.c.id, f.runtime)).packages[0]!.paymentState, "unknown");
});
test("revocation during provider preflight wins before the capture claim", async t => {
  const f = await fresh(t); await authorize(f);
  const current = await getCommission(f.session, f.c.id), intent = await admitCapture(f.session, f.c.id, { expectedRevision: current.revision, packageId: "research" }, f.runtime);
  f.wire.beforeRead = async () => { const c = await getCommission(f.session, f.c.id); await executeCommand(f.session, c.id, { type: "revoke_mandate", commandId: randomUUID(), expectedRevision: c.revision, mandateId: "passport-root" }); };
  await assert.rejects(f.runtime.core.execute(intent.command), error => error instanceof Error && error.message.includes("approved plan"));
  assert.equal(f.wire.writes("/capture").length, 0); assert.equal(await f.runtime.store.get(intent.command.scope, intent.id), null);
});
test("void fallback preserves accepted work, then a package callback pays it once", async t => {
  const f = await fresh(t); await authorize(f); let c = await getCommission(f.session, f.c.id);
  await assert.rejects(executePayment(f.session, f.c.id, { type: "close_authorization", expectedRevision: c.revision }, f.runtime), code("ACCEPTED_WORK_UNPAID"));
  await executePayment(f.session, f.c.id, { type: "close_authorization", expectedRevision: c.revision, switchToPackageCheckout: true }, f.runtime);
  c = await getCommission(f.session, f.c.id); assert.equal(c.payments.authorization!.status, "VOIDED"); assert.equal(c.packages[0]!.paymentState, "eligible");
  const checkout = await executePayment(f.session, f.c.id, { type: "prepare_checkout", route: "package_checkout", packageId: "research", expectedRevision: c.revision }, f.runtime), details = checkout.commission.payments.checkout!; f.wire.approve(details.orderId!);
  const callback = { type: "complete_checkout" as const, intentId: details.id, orderId: details.orderId!, checkoutToken: checkout.checkoutToken! };
  await executePayment(f.session, f.c.id, callback, f.runtime); await executePayment(f.session, f.c.id, callback, f.runtime);
  c = await getCommission(f.session, f.c.id); assert.equal(c.payments.route, "package_checkout"); assert.equal(c.payments.capturedMinor, 9800); assert.equal(c.packages[0]!.paymentState, "paid");
  assert.equal(f.wire.writes("/capture").length, 1); assert.equal((await listIntents(f.session.tenantId, f.c.id)).filter(i => i.kind === "capture_order").length, 1);
});
test("workspace ceiling spans commissions and cancelled checkout can safely reopen", async t => {
  const f = await fresh(t), first = await executePayment(f.session, f.c.id, { type: "prepare_checkout", route: "authorization", expectedRevision: f.c.revision }, f.runtime);
  const another = await seedCommission(f.session); another.mode = "live"; await transaction(db => saveCommission(db, another));
  await executeCommand(f.session, another.id, { type: "approve_plan", commandId: randomUUID(), expectedRevision: 0, planDigest: planDigest(another) });
  await assert.rejects(executePayment(f.session, another.id, { type: "prepare_checkout", route: "authorization", expectedRevision: 1 }, f.runtime), code("WORKSPACE_CEILING"));
  await executePayment(f.session, f.c.id, { type: "cancel_checkout", intentId: first.commission.payments.checkout!.id, checkoutToken: first.checkoutToken! }, f.runtime);
  const reopened = await executePayment(f.session, f.c.id, { type: "prepare_checkout", route: "authorization", expectedRevision: (await getCommission(f.session, f.c.id)).revision }, f.runtime);
  assert.notEqual(reopened.commission.payments.checkout!.id, first.commission.payments.checkout!.id); assert.equal(f.wire.writes("/orders").length, 2);
});

test("explicit resume retains the original approved order, cancellation history and one authorization", async t => {
  const f = await fresh(t), prepared = await executePayment(f.session, f.c.id, { type: "prepare_checkout", route: "authorization", expectedRevision: f.c.revision }, f.runtime), checkout = prepared.commission.payments.checkout!;
  const identity = { intentId: checkout.id, orderId: checkout.orderId!, checkoutToken: prepared.checkoutToken! };
  await executePayment(f.session, f.c.id, { type: "cancel_checkout", intentId: identity.intentId, checkoutToken: identity.checkoutToken }, f.runtime);
  const before = (await getPool().query("SELECT cancelled_at,expires_at FROM guild_checkout_challenges WHERE payment_intent_id=$1", [checkout.id])).rows[0]!;
  f.wire.approve(checkout.orderId!);
  await assert.rejects(executePayment(f.session, f.c.id, { type: "complete_checkout", ...identity }, f.runtime), code("CHECKOUT_CANCELLED"));
  await Promise.all([executePayment(f.session, f.c.id, { type: "resume_checkout", ...identity }, f.runtime), executePayment(f.session, f.c.id, { type: "resume_checkout", ...identity }, f.runtime)]);
  await executePayment(f.session, f.c.id, { type: "resume_checkout", ...identity }, f.runtime);
  const after = (await getPool().query("SELECT cancelled_at,expires_at,resumed_at,resumed_by,completed_at FROM guild_checkout_challenges WHERE payment_intent_id=$1", [checkout.id])).rows[0]!;
  assert.equal(after.cancelled_at.toISOString(), before.cancelled_at.toISOString()); assert.equal(after.expires_at.toISOString(), before.expires_at.toISOString()); assert.equal(after.resumed_by, f.session.id); assert.ok(after.resumed_at); assert.ok(after.completed_at);
  assert.equal(f.wire.writes("/orders").length, 1); assert.equal(f.wire.writes("/authorize").length, 1); assert.equal(f.wire.writes("/capture").length, 0);
  const current = await getCommission(f.session, f.c.id); assert.equal(current.payments.checkout!.state, "approved"); assert.equal(current.payments.authorizedMinor, 64000);
  assert.equal(current.events.filter(e => e.type === "payment.checkout_resumed").length, 1);
});

test("resume rejects unapproved, mismatched, expired and cross-workspace checkout returns", async t => {
  const f = await fresh(t), prepared = await executePayment(f.session, f.c.id, { type: "prepare_checkout", route: "authorization", expectedRevision: f.c.revision }, f.runtime), checkout = prepared.commission.payments.checkout!;
  const command = { type: "resume_checkout" as const, intentId: checkout.id, orderId: checkout.orderId!, checkoutToken: prepared.checkoutToken! };
  await executePayment(f.session, f.c.id, { type: "cancel_checkout", intentId: command.intentId, checkoutToken: command.checkoutToken }, f.runtime);
  await assert.rejects(executePayment(f.session, f.c.id, command, f.runtime), code("CHECKOUT_NOT_APPROVED"));
  await assert.rejects(executePayment(f.session, f.c.id, { ...command, orderId: "UNOWNEDORDER000001" }, f.runtime), code("ORDER_BINDING"));
  await assert.rejects(executePayment(f.session, f.c.id, { ...command, checkoutToken: "wrong-challenge-proof" }, f.runtime), code("CHECKOUT_CHALLENGE"));
  const other = await createSession(); await assert.rejects(executePayment(other.session, f.c.id, command, f.runtime), code("NOT_FOUND"));
  f.wire.approve(checkout.orderId!); await getPool().query("UPDATE guild_checkout_challenges SET expires_at=now()-interval '1 second' WHERE payment_intent_id=$1", [checkout.id]);
  await assert.rejects(executePayment(f.session, f.c.id, command, f.runtime), code("CHECKOUT_EXPIRED"));
  assert.equal(f.wire.writes("/orders").length, 1); assert.equal(f.wire.writes("/authorize").length, 0);
});

test("revocation during resume's fresh provider read prevents reopening the cancelled instruction", async t => {
  const f = await fresh(t), prepared = await executePayment(f.session, f.c.id, { type: "prepare_checkout", route: "authorization", expectedRevision: f.c.revision }, f.runtime), checkout = prepared.commission.payments.checkout!;
  await executePayment(f.session, f.c.id, { type: "cancel_checkout", intentId: checkout.id, checkoutToken: prepared.checkoutToken! }, f.runtime); f.wire.approve(checkout.orderId!);
  f.wire.beforeRead = async () => { const c = await getCommission(f.session, f.c.id); await executeCommand(f.session, c.id, { type: "revoke_mandate", commandId: randomUUID(), expectedRevision: c.revision, mandateId: "passport-root" }); };
  await assert.rejects(executePayment(f.session, f.c.id, { type: "resume_checkout", intentId: checkout.id, orderId: checkout.orderId!, checkoutToken: prepared.checkoutToken! }, f.runtime), error => error instanceof DomainError && error.message.includes("approved plan"));
  const intent = (await listIntents(f.session.tenantId, f.c.id))[0]!; assert.equal(intent.admission_state, "cancelled"); assert.equal(f.wire.writes("/authorize").length, 0);
});

test("resume rechecks workspace exposure and refuses an order superseded by a newer checkout", async t => {
  const f = await fresh(t), prepared = await executePayment(f.session, f.c.id, { type: "prepare_checkout", route: "authorization", expectedRevision: f.c.revision }, f.runtime), checkout = prepared.commission.payments.checkout!;
  const resume = { type: "resume_checkout" as const, intentId: checkout.id, orderId: checkout.orderId!, checkoutToken: prepared.checkoutToken! };
  await executePayment(f.session, f.c.id, { type: "cancel_checkout", intentId: checkout.id, checkoutToken: prepared.checkoutToken! }, f.runtime); f.wire.approve(checkout.orderId!);
  const another = await seedCommission(f.session); another.mode = "live"; await transaction(db => saveCommission(db, another));
  await executeCommand(f.session, another.id, { type: "approve_plan", commandId: randomUUID(), expectedRevision: 0, planDigest: planDigest(another) });
  const second = await executePayment(f.session, another.id, { type: "prepare_checkout", route: "authorization", expectedRevision: 1 }, f.runtime);
  await assert.rejects(executePayment(f.session, f.c.id, resume, f.runtime), code("WORKSPACE_CEILING"));
  await executePayment(f.session, another.id, { type: "cancel_checkout", intentId: second.commission.payments.checkout!.id, checkoutToken: second.checkoutToken! }, f.runtime);
  await executePayment(f.session, f.c.id, { type: "prepare_checkout", route: "authorization", expectedRevision: (await getCommission(f.session, f.c.id)).revision }, f.runtime);
  await assert.rejects(executePayment(f.session, f.c.id, resume, f.runtime), code("CHECKOUT_SUPERSEDED"));
  assert.equal(f.wire.writes("/authorize").length, 0);
});

async function capturedResearch(t: TestContext) {
  const f = await fresh(t); await authorize(f);
  await executePayment(f.session, f.c.id, { type: "capture_package", expectedRevision: (await getCommission(f.session, f.c.id)).revision, packageId: "research" }, f.runtime);
  return f;
}

test("provider disbursement needs a captured acceptance and concurrent requests send one private award", async t => {
  const f = await fresh(t);
  await assert.rejects(executePayment(f.session, f.c.id, { type: "pay_provider", expectedRevision: f.c.revision, packageId: "research" }, f.runtime), code("CAPTURE_REQUIRED"));
  assert.equal(f.commerceWire.writes("/payouts").length, 0);
  await authorize(f); await executePayment(f.session, f.c.id, { type: "capture_package", expectedRevision: (await getCommission(f.session, f.c.id)).revision, packageId: "research" }, f.runtime);
  const current = await getCommission(f.session, f.c.id), command = { type: "pay_provider" as const, expectedRevision: current.revision, packageId: "research" };
  await Promise.all([executePayment(f.session, f.c.id, command, f.runtime), executePayment(f.session, f.c.id, command, f.runtime)]);
  const paid = await getCommission(f.session, f.c.id), row = (await getPool().query("SELECT document,request_hash,receiver_hash FROM guild_payout_operations WHERE commission_id=$1", [f.c.id])).rows[0]!;
  assert.equal(f.commerceWire.writes("/payouts").length, 1); assert.equal(paid.payments.providerPaidMinor, 9000); assert.equal(paid.payments.providerPayableMinor, 0); assert.equal(paid.payments.serviceFeeMinor, 800); assert.equal(paid.payments.payouts[0]!.status, "SUCCESS"); assert.equal(paid.payments.payouts[0]!.feeMinor, 25);
  assert.match(row.document, /^g1\./); assert.ok(!row.document.includes("fixture-provider")); assert.ok(!JSON.stringify(paid).includes("@example.invalid"));
  assert.equal(f.commerceWire.writes("/payouts")[0]!.body!.items[0].amount.value, "90.00");
  const other = await createSession(); await assert.rejects(executePayment(other.session, f.c.id, { type: "retry_payout", payoutId: paid.payments.payouts[0]!.id }, f.runtime), code("NOT_FOUND"));
});

test("batch SUCCESS and an unreadable or pending item never count as provider payment", async t => {
  const f = await capturedResearch(t); f.commerceWire.nextStatus = "PENDING"; f.commerceWire.failItemReads = true;
  await executePayment(f.session, f.c.id, { type: "pay_provider", expectedRevision: (await getCommission(f.session, f.c.id)).revision, packageId: "research" }, f.runtime);
  let current = await getCommission(f.session, f.c.id); assert.equal(current.payments.providerPaidMinor, 0); assert.equal(current.payments.providerPayableMinor, 9000);
  f.commerceWire.failItemReads = false; current = await reconcilePayments(f.session, f.c.id, f.runtime); assert.equal(current.payments.payouts[0]!.status, "PENDING"); assert.equal(current.payments.providerPaidMinor, 0);
  [...f.commerceWire.items.values()][0]!.transaction_status = "SUCCESS";
  current = await reconcilePayments(f.session, f.c.id, f.runtime); assert.equal(current.payments.providerPaidMinor, 9000); assert.equal(f.commerceWire.writes("/payouts").length, 1);
});

test("a mismatched recipient in the individual item is never borrowed from a valid batch", async t => {
  const f = await capturedResearch(t); f.commerceWire.mismatchedItemReceiver = true;
  await executePayment(f.session, f.c.id, { type: "pay_provider", expectedRevision: (await getCommission(f.session, f.c.id)).revision, packageId: "research" }, f.runtime);
  let current = await getCommission(f.session, f.c.id); assert.equal(current.payments.providerPaidMinor, 0); assert.equal(current.payments.payouts[0]!.errorCode, "PAYOUT_ITEM_BINDING");
  f.commerceWire.mismatchedItemReceiver = false; current = await reconcilePayments(f.session, f.c.id, f.runtime); assert.equal(current.payments.providerPaidMinor, 9000);
  assert.equal(f.commerceWire.writes("/payouts").length, 1);
});

test("lost payout create remains reserved until explicit recovery reuses the identical batch and request", async t => {
  const f = await capturedResearch(t); f.commerceWire.loseNextCreate = true;
  await executePayment(f.session, f.c.id, { type: "pay_provider", expectedRevision: (await getCommission(f.session, f.c.id)).revision, packageId: "research" }, f.runtime);
  let current = await getCommission(f.session, f.c.id); const payoutId = current.payments.payouts[0]!.id;
  assert.equal(current.payments.payouts[0]!.operationState, "pending_reconciliation"); assert.equal(current.payments.providerPaidMinor, 0);
  await reconcilePayments(f.session, f.c.id, f.runtime); await recoverProviderPayouts(f.session.tenantId, f.c.id, f.runtime, true);
  await executePayment(f.session, f.c.id, { type: "pay_provider", expectedRevision: current.revision, packageId: "research" }, f.runtime); assert.equal(f.commerceWire.writes("/payouts").length, 1);
  await executePayment(f.session, f.c.id, { type: "retry_payout", payoutId }, f.runtime);
  current = await getCommission(f.session, f.c.id); const writes = f.commerceWire.writes("/payouts");
  assert.equal(writes.length, 2); assert.deepEqual(writes[0]!.body, writes[1]!.body); assert.equal(writes[0]!.requestId, writes[1]!.requestId); assert.equal(f.commerceWire.batches.size, 1); assert.equal(current.payments.providerPaidMinor, 9000);
  await executePayment(f.session, f.c.id, { type: "retry_payout", payoutId }, f.runtime); assert.equal(f.commerceWire.writes("/payouts").length, 2);
});

test("provider payout checks current approval after its fresh capture read", async t => {
  const f = await capturedResearch(t), current = await getCommission(f.session, f.c.id), row = await admitProviderPayout(f.session, f.c.id, "research", current.revision, f.runtime);
  f.wire.beforeRead = async () => { const c = await getCommission(f.session, f.c.id); await executeCommand(f.session, c.id, { type: "revoke_mandate", commandId: randomUUID(), expectedRevision: c.revision, mandateId: "passport-root" }); };
  await assert.rejects(dispatchProviderPayout(row, f.runtime), error => error instanceof DomainError && error.message.includes("approved plan"));
  assert.equal(f.commerceWire.writes("/payouts").length, 0); assert.equal((await getCommission(f.session, f.c.id)).payments.payouts[0]!.operationState, "not_sent");
});

test("payout rejects a refunded capture and a changed controlled recipient before dispatch", async t => {
  const f = await capturedResearch(t), current = await getCommission(f.session, f.c.id), row = await admitProviderPayout(f.session, f.c.id, "research", current.revision, f.runtime);
  const capture = [...f.wire.captures.values()][0]!; capture.status = "REFUNDED";
  await assert.rejects(dispatchProviderPayout(row, f.runtime), code("PAYOUT_CAPTURE_UNVERIFIED")); assert.equal(f.commerceWire.writes("/payouts").length, 0);
  capture.status = "COMPLETED";
  process.env.GUILD_SANDBOX_PROVIDER_RECEIVERS_JSON = fixtureRecipients.replace("fixture-provider-1@", "replacement-fixture@");
  try { await assert.rejects(executePayment(f.session, f.c.id, { type: "retry_payout", payoutId: row.id }, f.runtime), code("PAYOUT_AUTHORITY_CHANGED")); }
  finally { process.env.GUILD_SANDBOX_PROVIDER_RECEIVERS_JSON = fixtureRecipients; }
  assert.equal(f.commerceWire.writes("/payouts").length, 0);
});

test("encrypted payout documents cannot be moved between independent row identities", async t => {
  const first = await capturedResearch(t), second = await capturedResearch(t);
  const a = await admitProviderPayout(first.session, first.c.id, "research", (await getCommission(first.session, first.c.id)).revision, first.runtime);
  const b = await admitProviderPayout(second.session, second.c.id, "research", (await getCommission(second.session, second.c.id)).revision, second.runtime);
  await getPool().query("UPDATE guild_payout_operations SET document=$2 WHERE id=$1", [a.id, b.document]);
  await assert.rejects(dispatchProviderPayout(a, first.runtime), code("PRIVATE_DOCUMENT_UNREADABLE"));
  assert.equal(first.commerceWire.writes("/payouts").length, 0); assert.equal((await getCommission(first.session, first.c.id)).payments.payouts[0]!.canRetry, false);
  const row = (await getPool().query("SELECT state,lease_until FROM guild_payout_operations WHERE id=$1", [a.id])).rows[0]!; assert.equal(row.state, "not_sent"); assert.equal(row.lease_until, null);
});

test("unclaimed cancellation reads the exact item, retains the award and tolerates a lost response", async t => {
  const f = await capturedResearch(t); f.commerceWire.nextStatus = "UNCLAIMED";
  await executePayment(f.session, f.c.id, { type: "pay_provider", expectedRevision: (await getCommission(f.session, f.c.id)).revision, packageId: "research" }, f.runtime);
  const current = await getCommission(f.session, f.c.id), payout = current.payments.payouts[0]!; assert.equal(payout.canCancel, true); assert.equal(current.payments.providerPaidMinor, 0);
  f.commerceWire.loseNextCancel = true;
  await Promise.all([executePayment(f.session, f.c.id, { type: "cancel_payout", payoutId: payout.id }, f.runtime), executePayment(f.session, f.c.id, { type: "cancel_payout", payoutId: payout.id }, f.runtime)]);
  const after = await getCommission(f.session, f.c.id); assert.equal(after.payments.payouts[0]!.status, "RETURNED"); assert.equal(after.payments.payouts[0]!.cancellationState, "succeeded"); assert.equal(after.payments.payouts[0]!.canCancel, false); assert.equal(after.payments.providerPaidMinor, 0); assert.equal(after.payments.providerPayableMinor, 9000); assert.equal(f.commerceWire.writes("/cancel").length, 1);
});

test("simultaneous payout reads and cancellation retain one terminal item without a lock inversion", async t => {
  for (let round = 0; round < 4; round++) {
    const f = await capturedResearch(t); f.commerceWire.nextStatus = "UNCLAIMED";
    await executePayment(f.session, f.c.id, { type: "pay_provider", expectedRevision: (await getCommission(f.session, f.c.id)).revision, packageId: "research" }, f.runtime);
    const payout = (await getCommission(f.session, f.c.id)).payments.payouts[0]!;
    await Promise.all([
      executePayment(f.session, f.c.id, { type: "cancel_payout", payoutId: payout.id }, f.runtime),
      executePayment(f.session, f.c.id, { type: "cancel_payout", payoutId: payout.id }, f.runtime),
      reconcilePayments(f.session, f.c.id, f.runtime),
      reconcilePayments(f.session, f.c.id, f.runtime),
    ]);
    await reconcilePayments(f.session, f.c.id, f.runtime);
    const saved = (await getCommission(f.session, f.c.id)).payments;
    assert.equal(saved.payouts[0]!.status, "RETURNED"); assert.equal(saved.providerPaidMinor, 0); assert.equal(saved.providerPayableMinor, 9000);
    assert.equal(f.commerceWire.writes("/cancel").length, 1); assert.equal(f.commerceWire.writes("/payouts").length, 1);
  }
});

test("read reconciliation leaves an orphan claim unchanged; the durable worker alone resumes it", async t => {
  const f = await capturedResearch(t), current = await getCommission(f.session, f.c.id), row = await admitProviderPayout(f.session, f.c.id, "research", current.revision, f.runtime);
  await reconcilePayments(f.session, f.c.id, f.runtime); assert.equal(f.commerceWire.writes("/payouts").length, 0);
  await recoverProviderPayouts(f.session.tenantId, f.c.id, f.runtime, true); assert.equal(f.commerceWire.writes("/payouts").length, 1); assert.equal((await getCommission(f.session, f.c.id)).payments.payouts[0]!.id, row.id);
  await recoverProviderPayouts(f.session.tenantId, f.c.id, f.runtime, true); assert.equal(f.commerceWire.writes("/payouts").length, 1);
});

const fixtureVerifier = { verify: async () => ({ verified: true, transmissionId: "fixture-only-not-authentic-delivery" }) };
const eventBody = (id: string, type: string, resource: Record<string, unknown>) => JSON.stringify({ id, event_type: type, resource, create_time: new Date().toISOString() });

test("verified fixture webhook queues a redacted observation and cannot turn order approval into a charge", async t => {
  const f = await fresh(t), prepared = await executePayment(f.session, f.c.id, { type: "prepare_checkout", route: "authorization", expectedRevision: f.c.revision }, f.runtime), orderId = prepared.commission.payments.checkout!.orderId!;
  const body = eventBody(`WH-${randomUUID()}`, "CHECKOUT.ORDER.APPROVED", { id: orderId, payer: { email_address: "fixture-private-contact@example.invalid" } });
  const first = await ingestPaymentWebhook(body, new Headers(), f.runtime, fixtureVerifier), repeat = await ingestPaymentWebhook(body, new Headers(), f.runtime, fixtureVerifier);
  assert.equal(first.duplicate, false); assert.equal(repeat.duplicate, true); assert.equal(f.wire.writes("/authorize").length, 0);
  const deliveries = (await getPool().query("SELECT document FROM paycore_webhook_deliveries WHERE event_id=$1", [first.eventId])).rows;
  assert.equal(deliveries.length, 2); assert.ok(deliveries.every(row => !row.document.includes("fixture-private-contact")));
  f.wire.approve(orderId); const result = await recoverWebhookObservations(f.runtime); assert.equal(result.processed, 1);
  assert.equal((await getCommission(f.session, f.c.id)).payments.authorizedMinor, 0); assert.equal(f.wire.writes("/authorize").length, 0); assert.equal(f.wire.writes("/orders").length, 1);
});

test("payout webhook names cannot override authoritative pending or successful individual items", async t => {
  const f = await capturedResearch(t); f.commerceWire.nextStatus = "PENDING";
  await executePayment(f.session, f.c.id, { type: "pay_provider", expectedRevision: (await getCommission(f.session, f.c.id)).revision, packageId: "research" }, f.runtime);
  const item = [...f.commerceWire.items.values()][0]!;
  await ingestPaymentWebhook(eventBody(`WH-${randomUUID()}`, "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", { payout_item_id: item.payout_item_id, payout_batch_id: item.payout_batch_id, transaction_status: "SUCCESS" }), new Headers(), f.runtime, fixtureVerifier);
  await recoverWebhookObservations(f.runtime); assert.equal((await getCommission(f.session, f.c.id)).payments.providerPaidMinor, 0);
  item.transaction_status = "SUCCESS";
  await ingestPaymentWebhook(eventBody(`WH-${randomUUID()}`, "PAYMENT.PAYOUTS-ITEM.UNCLAIMED", { payout_item_id: item.payout_item_id, payout_batch_id: item.payout_batch_id, transaction_status: "UNCLAIMED" }), new Headers(), f.runtime, fixtureVerifier);
  await recoverWebhookObservations(f.runtime); assert.equal((await getCommission(f.session, f.c.id)).payments.providerPaidMinor, 9000); assert.equal(f.commerceWire.writes("/payouts").length, 1); assert.equal(f.commerceWire.writes("/cancel").length, 0);
});

test("invalid signatures, conflicting events and unowned resources never dispatch or probe a guessed ID", async t => {
  const f = await fresh(t), id = `WH-${randomUUID()}`, body = eventBody(id, "PAYMENT.CAPTURE.COMPLETED", { id: "UNOWNEDFIXTURE0001", amount: { value: "640.00", currency_code: "USD" } });
  await assert.rejects(ingestPaymentWebhook(body, new Headers(), f.runtime, { verify: async () => ({ verified: false, transmissionId: "invalid-fixture" }) }), error => error instanceof Error && "code" in error && error.code === "INVALID_SIGNATURE");
  assert.equal((await getPool().query("SELECT * FROM guild_webhook_reconciliation WHERE event_id=$1", [id])).rowCount, 0);
  await ingestPaymentWebhook(body, new Headers(), f.runtime, fixtureVerifier);
  await assert.rejects(ingestPaymentWebhook(eventBody(id, "PAYMENT.CAPTURE.COMPLETED", { id: "CHANGEDFIXTURE0001" }), new Headers(), f.runtime, fixtureVerifier), error => error instanceof Error && "code" in error && error.code === "WEBHOOK_PAYLOAD_CONFLICT");
  const result = await recoverWebhookObservations(f.runtime); assert.equal(result.awaitingOwnership, 1); assert.equal(f.wire.calls.length, 0); assert.equal(f.commerceWire.calls.length, 0);
  assert.equal((await getCommission(f.session, f.c.id)).payments.capturedMinor, 0);
});

test("an early payout observation waits for original-batch ownership instead of allocating a replacement", async t => {
  const f = await capturedResearch(t); f.commerceWire.loseNextCreate = true;
  await executePayment(f.session, f.c.id, { type: "pay_provider", expectedRevision: (await getCommission(f.session, f.c.id)).revision, packageId: "research" }, f.runtime);
  const batch = [...f.commerceWire.batches.values()][0]!, eventId = `WH-${randomUUID()}`;
  await ingestPaymentWebhook(eventBody(eventId, "PAYMENT.PAYOUTSBATCH.SUCCESS", { batch_header: { payout_batch_id: batch.id, sender_batch_header: { sender_batch_id: batch.senderBatchId } } }), new Headers(), f.runtime, fixtureVerifier);
  assert.equal((await recoverWebhookObservations(f.runtime)).awaitingOwnership, 1); assert.equal(f.commerceWire.writes("/payouts").length, 1);
  const payoutId = (await getCommission(f.session, f.c.id)).payments.payouts[0]!.id;
  await executePayment(f.session, f.c.id, { type: "retry_payout", payoutId }, f.runtime);
  await getPool().query("UPDATE guild_webhook_reconciliation SET next_check_at=now() WHERE event_id=$1", [eventId]);
  assert.equal((await recoverWebhookObservations(f.runtime)).processed, 1); assert.equal(f.commerceWire.batches.size, 1); assert.equal((await getCommission(f.session, f.c.id)).payments.providerPaidMinor, 9000);
});

test("all six independent package checkouts fit the original ceiling after zero-capture void fallback", async t => {
  const ids = ["research", "translation", "narration", "images", "captions", "web"], f = await fresh(t, ids, true); await authorize(f);
  await executePayment(f.session, f.c.id, { type: "close_authorization", expectedRevision: (await getCommission(f.session, f.c.id)).revision, switchToPackageCheckout: true }, f.runtime);
  for (const packageId of ids) {
    const prepared = await executePayment(f.session, f.c.id, { type: "prepare_checkout", route: "package_checkout", expectedRevision: (await getCommission(f.session, f.c.id)).revision, packageId }, f.runtime), checkout = prepared.commission.payments.checkout!;
    f.wire.approve(checkout.orderId!);
    await executePayment(f.session, f.c.id, { type: "complete_checkout", intentId: checkout.id, orderId: checkout.orderId!, checkoutToken: prepared.checkoutToken! }, f.runtime);
  }
  const current = await getCommission(f.session, f.c.id); assert.equal(current.payments.route, "package_checkout"); assert.equal(current.payments.capturedMinor, 58000); assert.equal(current.payments.providerPayableMinor, 53000); assert.equal(current.payments.serviceFeeMinor, 5000); assert.equal(f.wire.writes("/capture").length, 6); assert.equal(current.payments.authorization!.status, "VOIDED");
});

test("changing the isolated merchant cannot reuse an existing checkout or authorize its order", async t => {
  const f = await fresh(t), prepared = await executePayment(f.session, f.c.id, { type: "prepare_checkout", route: "authorization", expectedRevision: f.c.revision }, f.runtime), checkout = prepared.commission.payments.checkout!; f.wire.approve(checkout.orderId!);
  process.env.PAYPAL_CLIENT_ID = "different-fixture-merchant";
  try {
    await assert.rejects(executePayment(f.session, f.c.id, { type: "prepare_checkout", route: "authorization", expectedRevision: prepared.commission.revision }, f.runtime), code("MERCHANT_CHANGED"));
    await assert.rejects(executePayment(f.session, f.c.id, { type: "complete_checkout", intentId: checkout.id, orderId: checkout.orderId!, checkoutToken: prepared.checkoutToken! }, f.runtime), code("MERCHANT_CHANGED"));
  } finally { process.env.PAYPAL_CLIENT_ID = "fixture-app-only"; }
  assert.equal(f.wire.writes("/orders").length, 1); assert.equal(f.wire.writes("/authorize").length, 0);
});

test("reader initialization failure stays visible as a durable failed attempt without a provider call", async t => {
  const f = await fresh(t); await executePayment(f.session, f.c.id, { type: "prepare_checkout", route: "authorization", expectedRevision: f.c.revision }, f.runtime);
  const originalKey = process.env.OPENAI_API_KEY; delete process.env.OPENAI_API_KEY;
  try { await assert.rejects(executePayment(f.session, f.c.id, { type: "inspect_order" }, f.runtime), code("MODEL_UNAVAILABLE")); }
  finally { if (originalKey) process.env.OPENAI_API_KEY = originalKey; }
  const current = await getCommission(f.session, f.c.id); assert.equal(current.payments.toolRuns.length, 1); assert.equal(current.payments.toolRuns[0]!.state, "failed"); assert.equal(current.payments.toolRuns[0]!.failureCode, "MODEL_UNAVAILABLE"); assert.equal(current.payments.toolEvidence.length, 0); assert.equal(f.wire.writes("/authorize").length, 0);
});

test("an interrupted cancellation stays read-only until explicit recovery of the same unclaimed item", async t => {
  const f = await capturedResearch(t); f.commerceWire.nextStatus = "UNCLAIMED";
  await executePayment(f.session, f.c.id, { type: "pay_provider", expectedRevision: (await getCommission(f.session, f.c.id)).revision, packageId: "research" }, f.runtime);
  const payoutId = (await getCommission(f.session, f.c.id)).payments.payouts[0]!.id;
  await getPool().query("UPDATE guild_payout_operations SET cancel_state='dispatching',cancel_lease_until=now()-interval '1 second' WHERE id=$1", [payoutId]);
  await recoverProviderPayouts(f.session.tenantId, f.c.id, f.runtime, true);
  assert.equal(f.commerceWire.writes("/cancel").length, 0); const current = await getCommission(f.session, f.c.id); assert.equal(current.payments.payouts[0]!.canCancel, true); assert.equal(current.payments.payouts[0]!.cancellationState, "pending_reconciliation");
  await executePayment(f.session, f.c.id, { type: "cancel_payout", payoutId }, f.runtime); assert.equal(f.commerceWire.writes("/cancel").length, 1); assert.equal((await getCommission(f.session, f.c.id)).payments.payouts[0]!.status, "RETURNED");
});
