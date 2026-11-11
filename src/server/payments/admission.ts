import { randomUUID } from "node:crypto";
import { payloadHash, type PaymentAction, type PaymentCommand, type ProviderResource } from "@fracture/paypal-core";
import type { PoolClient } from "pg";
import type { Commission, WorkPackage } from "@/contracts/guild";
import { assertAcceptedPayment, assertClosable, assertFinancialPlan, finalCaptureEligible, normalizePayments } from "@/domain/payments";
import { digest, DomainError } from "@/domain/primitives";
import { appendEvent, saveCommission } from "@/server/commissions";
import { getPool, transaction } from "@/server/db";
import type { Session } from "@/server/session";
import { acceptanceFor, appOrigin, approvalFor, checkoutToken, contractDigest, listIntents, merchantFingerprint, openRecourse, operationResource, ownedIntent, paymentScope, rememberResource, safeEqual, type PaymentBinding, type PaymentIntent } from "./repository";
import { operationView } from "./projection";
import type { PaymentRuntime } from "./runtime";

export function requireFinancialActor(session: Session): void {
  if (!["owner", "judge"].includes(session.role)) throw new DomainError("PAYMENT_ROLE", "Payment approval belongs to the commission's curator. Operator qualifications do not dispatch money.", 403, false);
  if (!Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= Date.now()) throw new DomainError("SESSION_EXPIRED", "Reopen your workspace before arranging payment.", 401);
}

async function lockedCommission(db: PoolClient, session: Session, commissionId: string): Promise<Commission> {
  requireFinancialActor(session);
  // All commercial admissions in a workspace share a lock, including different commissions.
  await db.query("SELECT id FROM guild_tenants WHERE id=$1 FOR UPDATE", [session.tenantId]);
  const c = (await db.query<{ snapshot: Commission }>("SELECT snapshot FROM guild_commissions WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [session.tenantId, commissionId])).rows[0]?.snapshot;
  if (!c) throw new DomainError("NOT_FOUND", "This commission is not in your workspace.", 404, false);
  normalizePayments(c);
  return c;
}
function revisionMatches(c: Commission, revision: number): void {
  if (c.revision !== revision) throw new DomainError("REVISION_CONFLICT", "The commission changed while you were reviewing payment. Refresh it before continuing.", 409);
}
function packageFor(c: Commission, packageId: string): WorkPackage {
  const pkg = c.packages.find(p => p.id === packageId);
  if (!pkg) throw new DomainError("PACKAGE_NOT_FOUND", "Choose accepted work from this commission.", 404, false);
  return pkg;
}
async function priorIntent(db: PoolClient, c: Commission, businessKey: string): Promise<PaymentIntent | undefined> {
  return (await db.query<PaymentIntent>("SELECT * FROM guild_payment_intents WHERE tenant_id=$1 AND commission_id=$2 AND business_key=$3", [c.tenantId, c.id, businessKey])).rows[0];
}

async function persistIntent(db: PoolClient, c: Commission, session: Session, input: { businessKey: string; action: PaymentAction; route: PaymentBinding["route"]; purpose: PaymentBinding["purpose"]; packageId?: string; parentIntentId?: string; challengeId?: string; finalCapture?: boolean; switchToPackageCheckout?: boolean }): Promise<PaymentIntent> {
  const currentApproval = await approvalFor(db, c), pkg = input.packageId ? packageFor(c, input.packageId) : null;
  const acceptance = pkg ? await acceptanceFor(db, c, pkg.id) : null;
  if (pkg) assertAcceptedPayment(c, pkg, acceptance);
  const id = randomUUID();
  const command: PaymentCommand = { scope: paymentScope(c), operationId: id, businessKey: input.businessKey, intentId: `guild:${c.id}:${pkg?.id ?? "commission"}`, providerRequestId: randomUUID(), payloadHash: payloadHash(input.action), action: input.action, approval: currentApproval.approval };
  const binding: PaymentBinding = { route: input.route, merchantFingerprint: merchantFingerprint(), planDigest: c.approvedPlanDigest!, actorId: session.id, approvalSignature: currentApproval.row.signature,
    acceptance, contractDigest: pkg ? contractDigest(c, pkg.id) : null, parentIntentId: input.parentIntentId ?? null, challengeId: input.challengeId ?? null,
    finalCapture: input.finalCapture ?? false, purpose: input.purpose, switchToPackageCheckout: input.switchToPackageCheckout ?? false };
  const result = await db.query<PaymentIntent>("INSERT INTO guild_payment_intents(id,tenant_id,commission_id,business_key,kind,package_id,contract_version,approval_id,acceptance_id,command,binding) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *", [id, c.tenantId, c.id, input.businessKey, input.action.kind, pkg?.id ?? null, pkg?.contractVersion ?? null, currentApproval.row.id, acceptance?.id ?? null, command, binding]);
  await db.query("INSERT INTO guild_payment_recovery(tenant_id,commission_id) VALUES($1,$2) ON CONFLICT(tenant_id,commission_id) DO UPDATE SET next_check_at=now()", [c.tenantId, c.id]);
  appendEvent(c, "payment.instruction_saved", input.purpose === "commission_hold" ? "Checkout prepared" : input.purpose === "close_hold" ? "Authorization closure requested" : "Accepted work is ready for payment", input.purpose === "commission_hold" ? "The approved ceiling is bound to a durable checkout. PayPal payer approval is still required." : "This instruction retains its approval receipt, commercial amount and original provider request identity.", "Curator", pkg?.id ?? null);
  c.revision++;
  await saveCommission(db, c);
  return result.rows[0]!;
}

/** An unresolved hold occupies its full ceiling; closing it does not erase captures. */
async function assertWorkspaceCeiling(db: PoolClient, c: Commission, extraMinor: number, runtime: PaymentRuntime): Promise<void> {
  const all = (await db.query<PaymentIntent>("SELECT * FROM guild_payment_intents WHERE tenant_id=$1 AND admission_state='ready'", [c.tenantId])).rows;
  const resources = (await db.query<{ commission_id: string; operation_id: string; resource: ProviderResource }>("SELECT commission_id,operation_id,resource FROM guild_payment_resources WHERE tenant_id=$1 AND kind IN ('authorization','capture')", [c.tenantId])).rows;
  let exposure = 0;
  for (const checkout of all.filter(i => i.kind === "create_order")) {
    if (checkout.binding.route === "package_checkout") exposure += checkout.command.action.money.minor;
    else {
      const operations = await runtime.store.list({ tenantId: c.tenantId, projectId: checkout.commission_id });
      const checkoutOperation = operations.find(operation => operation.command.operationId === checkout.id);
      const orderId = checkoutOperation ? operationResource(checkoutOperation, "order")?.id : null;
      const authorizationIntent = all.find(intent => intent.kind === "authorize_order" && intent.binding.parentIntentId === checkout.id);
      const authorizationOperation = operations.find(operation => operation.command.operationId === authorizationIntent?.id);
      const authorizationId = authorizationOperation ? operationResource(authorizationOperation, "authorization")?.id : null;
      const auth = resources.find(r => r.commission_id === checkout.commission_id && r.resource.kind === "authorization" && (r.resource.id === authorizationId || !!orderId && r.resource.parentId === orderId))?.resource;
      if (!auth || !["VOIDED", "CAPTURED", "EXPIRED", "DENIED"].includes(auth.status)) exposure += checkout.command.action.money.minor;
      else {
        const related = all.filter(intent => intent.commission_id === checkout.commission_id && intent.command.action.kind === "capture_authorization" && intent.command.action.authorizationId === auth.id);
        const relatedOperationIds = new Set([checkout.id, authorizationIntent?.id, ...related.map(intent => intent.id)].filter((id): id is string => !!id));
        const knownCaptureIds = new Set(related.flatMap(intent => { const operation = operations.find(candidate => candidate.command.operationId === intent.id), capture = operation ? operationResource(operation, "capture") : null; return capture ? [capture.id] : []; }));
        // Package-order captures have their own reservation; counting them here would charge the ceiling twice after a void fallback.
        const captures = resources.filter(r => r.commission_id === checkout.commission_id && r.resource.kind === "capture" && !["DECLINED", "DENIED", "FAILED"].includes(r.resource.status) && (r.resource.parentId === auth.id || !!orderId && r.resource.parentId === orderId || relatedOperationIds.has(r.operation_id) || knownCaptureIds.has(r.resource.id)));
        exposure += captures.reduce((n, r) => n + (r.resource.money?.minor ?? checkout.command.action.money.minor), 0);
        for (const intent of related) {
          const operation = operations.find(o => o.command.operationId === intent.id), capture = operation ? operationResource(operation, "capture") : null;
          if (operation && ["refused", "not_sent"].includes(operation.status)) continue;
          if (!capture || !captures.some(r => r.resource.id === capture.id)) exposure += intent.command.action.money.minor;
        }
      }
    }
  }
  if (exposure + extraMinor > 64000) throw new DomainError("WORKSPACE_CEILING", "This workspace already has an open checkout, authorization or charge using its $640 sandbox ceiling. Close or reconcile it before reserving more.", 422);
}

async function operationViews(c: Commission, db: PoolClient, runtime: PaymentRuntime) {
  const intents = await listIntents(c.tenantId, c.id, db), operations = await runtime.store.list(paymentScope(c));
  return intents.map(i => operationView(i, operations.find(o => o.command.operationId === i.id)));
}
function assertNoUncertainCapture(views: Awaited<ReturnType<typeof operationViews>>): void {
  if (views.some(v => ["capture_authorization", "capture_order"].includes(v.kind) && ["queued", "claimed", "dispatching", "pending_reconciliation"].includes(v.state))) throw new DomainError("CAPTURE_UNCERTAIN", "Reconcile the earlier capture before requesting another charge.", 422);
}

export async function admitCheckout(session: Session, commissionId: string, input: { expectedRevision: number; route: "authorization" | "package_checkout"; packageId?: string }, runtime: PaymentRuntime): Promise<PaymentIntent> {
  return transaction(async db => {
    const c = await lockedCommission(db, session, commissionId);
    if ((input.route === "package_checkout") !== !!input.packageId) throw new DomainError("CHECKOUT_SCOPE", "A package checkout needs one accepted contract; a commission authorization uses its approved ceiling.", 422);
    const pkg = input.packageId ? packageFor(c, input.packageId) : null;
    const baseKey = `checkout:${c.id}:${input.route}:${pkg ? `${pkg.id}:${pkg.contractVersion}` : "ceiling"}`;
    const earlier = (await listIntents(c.tenantId, c.id, db)).filter(i => i.kind === "create_order" && i.binding.route === input.route && i.package_id === (pkg?.id ?? null) && i.contract_version === (pkg?.contractVersion ?? null));
    const existing = earlier.at(-1);
    if (existing?.admission_state === "ready") {
      if (existing.binding.merchantFingerprint !== merchantFingerprint()) throw new DomainError("MERCHANT_CHANGED", "The saved checkout belongs to an earlier merchant configuration. Inspect its original record before continuing.", 403, false);
      return existing;
    }
    const businessKey = earlier.length ? `${baseKey}:attempt:${earlier.length + 1}` : baseKey;
    revisionMatches(c, input.expectedRevision); assertFinancialPlan(c);
    if (pkg) assertAcceptedPayment(c, pkg, await acceptanceFor(db, c, pkg.id));
    const views = await operationViews(c, db, runtime); assertNoUncertainCapture(views);
    if (pkg?.paymentState === "paid") throw new DomainError("ALREADY_PAID", "This accepted contract already has a confirmed capture.", 422);
    const active = await db.query("SELECT id FROM guild_checkout_challenges WHERE tenant_id=$1 AND commission_id=$2 AND completed_at IS NULL AND (cancelled_at IS NULL OR resumed_at>cancelled_at) AND expires_at>now()", [c.tenantId, c.id]);
    if (active.rowCount) throw new DomainError("CHECKOUT_OPEN", "Finish or cancel the current PayPal checkout before opening another.", 422);
    const amountMinor = pkg?.grossMinor ?? c.capMinor;
    await assertWorkspaceCeiling(db, c, amountMinor, runtime);
    const challengeId = randomUUID(), token = checkoutToken(challengeId, c.id);
    // The intent id is not known until persistence; the random challenge resolves its one owner.
    const query = new URLSearchParams({ commission: c.id, challenge: token, challengeId }).toString();
    const intent = await persistIntent(db, c, session, { businessKey, route: input.route, purpose: pkg ? "accepted_work" : "commission_hold", packageId: pkg?.id, challengeId,
      action: { kind: "create_order", money: { currency: "USD", minor: amountMinor }, intent: pkg ? "CAPTURE" : "AUTHORIZE", customId: `guild:${c.id}:${pkg?.id ?? "commission"}`,
        experience: { returnUrl: `${appOrigin()}/payments/return?${query}`, cancelUrl: `${appOrigin()}/payments/cancel?${query}`, userAction: "CONTINUE", shippingPreference: "NO_SHIPPING", brandName: "Guild", locale: "en-US", landingPage: "NO_PREFERENCE" } } });
    await db.query("INSERT INTO guild_checkout_challenges(id,tenant_id,commission_id,payment_intent_id,actor_id,token_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)", [challengeId, c.tenantId, c.id, intent.id, session.id, digest(token), new Date(Math.min(Date.now() + 2 * 3600000, Date.parse(session.expiresAt), Date.parse(intent.command.approval.expiresAt))).toISOString()]);
    return intent;
  });
}

export async function admitCheckoutCompletion(session: Session, commissionId: string, input: { intentId: string; orderId: string; checkoutToken: string }, runtime: PaymentRuntime): Promise<PaymentIntent> {
  return transaction(async db => {
    const c = await lockedCommission(db, session, commissionId), parent = await ownedIntent(c.tenantId, c.id, input.intentId, db);
    if (parent.kind !== "create_order" || !parent.binding.challengeId || parent.binding.actorId !== session.id) throw new DomainError("CHECKOUT_OWNER", "Return to the workspace that opened this checkout.", 403, false);
    const challenge = (await db.query<{ token_hash: string; expires_at: Date; cancelled_at: Date | null; resumed_at: Date | null; completed_at: Date | null }>("SELECT token_hash,expires_at,cancelled_at,resumed_at,completed_at FROM guild_checkout_challenges WHERE id=$1 AND tenant_id=$2 AND actor_id=$3 FOR UPDATE", [parent.binding.challengeId, c.tenantId, session.id])).rows[0];
    if (!challenge || !safeEqual(challenge.token_hash, digest(input.checkoutToken))) throw new DomainError("CHECKOUT_CHALLENGE", "The checkout return could not be matched to this workspace.", 403, false);
    const parentOperation = await runtime.store.get(paymentScope(c), parent.id), order = parentOperation ? operationResource(parentOperation, "order") : null;
    if (!order || order.id !== input.orderId || parentOperation?.status !== "succeeded") throw new DomainError("ORDER_BINDING", "The payer return must match the exact order created for this checkout. Reconcile an uncertain order first.", 422, false);
    const businessKey = `complete:${parent.id}`, existing = await priorIntent(db, c, businessKey);
    if (existing) return existing;
    if (parent.binding.merchantFingerprint !== merchantFingerprint()) throw new DomainError("MERCHANT_CHANGED", "The original checkout merchant binding changed. Inspect that saved order before continuing.", 403, false);
    if (challenge.expires_at.getTime() <= Date.now()) throw new DomainError("CHECKOUT_EXPIRED", "This checkout has expired. Its saved order cannot authorize a new payment from this return.", 422);
    if (parent.admission_state === "cancelled" || challenge.cancelled_at && (!challenge.resumed_at || challenge.resumed_at <= challenge.cancelled_at)) throw new DomainError("CHECKOUT_CANCELLED", "This checkout was previously cancelled. Review and explicitly resume the original approved order to continue.", 422);
    assertFinancialPlan(c);
    const kind = parent.binding.route === "authorization" ? "authorize_order" : "capture_order";
    if (kind === "capture_order") assertNoUncertainCapture(await operationViews(c, db, runtime));
    return persistIntent(db, c, session, { businessKey, route: parent.binding.route, purpose: parent.binding.purpose, packageId: parent.package_id ?? undefined, parentIntentId: parent.id, challengeId: parent.binding.challengeId,
      action: { kind, orderId: order.id, money: parent.command.action.money } });
  });
}

/** Resuming is a new curator decision about the same order, never a replay of cancellation. */
export async function admitCheckoutResume(session: Session, commissionId: string, input: { intentId: string; orderId: string; checkoutToken: string }, runtime: PaymentRuntime): Promise<PaymentIntent> {
  requireFinancialActor(session);
  const parent = await ownedIntent(session.tenantId, commissionId, input.intentId);
  if (parent.kind !== "create_order" || !parent.binding.challengeId || parent.binding.actorId !== session.id) throw new DomainError("CHECKOUT_OWNER", "Return to the workspace that opened this checkout.", 403, false);
  const challengeProof = (await getPool().query<{ token_hash: string }>("SELECT token_hash FROM guild_checkout_challenges WHERE id=$1 AND tenant_id=$2 AND actor_id=$3", [parent.binding.challengeId, session.tenantId, session.id])).rows[0];
  if (!challengeProof || !safeEqual(challengeProof.token_hash, digest(input.checkoutToken))) throw new DomainError("CHECKOUT_CHALLENGE", "The checkout return could not be matched to this workspace.", 403, false);
  const parentOperation = await runtime.store.get(parent.command.scope, parent.id), originalOrder = parentOperation ? operationResource(parentOperation, "order") : null;
  if (parentOperation?.status !== "succeeded" || originalOrder?.id !== input.orderId || originalOrder.source !== "live_sandbox") throw new DomainError("ORDER_BINDING", "Resume must retain the exact confirmed order created for this checkout.", 422, false);
  const existing = (await getPool().query<PaymentIntent>("SELECT * FROM guild_payment_intents WHERE tenant_id=$1 AND commission_id=$2 AND business_key=$3", [session.tenantId, commissionId, `complete:${parent.id}`])).rows[0];
  if (existing) return existing;
  if (parent.binding.merchantFingerprint !== merchantFingerprint()) throw new DomainError("MERCHANT_CHANGED", "The original checkout merchant binding changed. Inspect that saved order before continuing.", 403, false);
  const observed = await runtime.provider.read("order", originalOrder.id);
  if (observed.length !== 1 || observed[0]?.kind !== "order" || observed[0].id !== originalOrder.id || observed[0].source !== "live_sandbox" || observed[0].status !== "APPROVED") throw new DomainError("CHECKOUT_NOT_APPROVED", "PayPal must confirm this exact order is approved and has no authorization or capture before it can resume.", 422);
  return transaction(async db => {
    const c = await lockedCommission(db, session, commissionId), current = await ownedIntent(c.tenantId, c.id, parent.id, db);
    const prior = await priorIntent(db, c, `complete:${parent.id}`); if (prior) return prior;
    const challenge = (await db.query<{ expires_at: Date; cancelled_at: Date | null }>("SELECT expires_at,cancelled_at FROM guild_checkout_challenges WHERE id=$1 AND tenant_id=$2 AND actor_id=$3 FOR UPDATE", [parent.binding.challengeId, c.tenantId, session.id])).rows[0];
    if (!challenge || challenge.expires_at.getTime() <= Date.now()) throw new DomainError("CHECKOUT_EXPIRED", "The original checkout expired. Resuming cannot extend its approval window.", 422);
    if (!challenge.cancelled_at || current.admission_state !== "cancelled") throw new DomainError("CHECKOUT_NOT_CANCELLED", "This checkout is already active. Complete its original approval instead.", 422);
    assertFinancialPlan(c);
    const approved = await approvalFor(db, c);
    if (current.approval_id !== approved.row.id || current.binding.approvalSignature !== approved.row.signature || current.binding.planDigest !== c.approvedPlanDigest) throw new DomainError("APPROVAL_CHANGED", "Review the current Passport; the original checkout approval changed.", 403);
    const intents = await listIntents(c.tenantId, c.id, db);
    if (intents.filter(i => i.kind === "create_order").at(-1)?.id !== current.id) throw new DomainError("CHECKOUT_SUPERSEDED", "A newer checkout exists. The older cancelled order cannot resume.", 422);
    assertNoUncertainCapture(await operationViews(c, db, runtime));
    await assertWorkspaceCeiling(db, c, current.command.action.money.minor, runtime);
    await db.query("UPDATE guild_checkout_challenges SET resumed_at=now(),resumed_by=$2 WHERE id=$1", [current.binding.challengeId, session.id]);
    await db.query("UPDATE guild_payment_intents SET admission_state='ready',blocked_reason=NULL WHERE id=$1", [current.id]);
    await rememberResource(db, c, current.id, observed[0]!);
    appendEvent(c, "payment.checkout_resumed", "Original approved checkout resumed", "The curator explicitly resumed the same PayPal order after a fresh approved-order read and current Passport check. The earlier cancellation and original expiry remain recorded.", "Curator", current.package_id);
    const kind = current.binding.route === "authorization" ? "authorize_order" : "capture_order";
    return persistIntent(db, c, session, { businessKey: `complete:${current.id}`, route: current.binding.route, purpose: current.binding.purpose, packageId: current.package_id ?? undefined, parentIntentId: current.id, challengeId: current.binding.challengeId!,
      action: { kind, orderId: originalOrder.id, money: current.command.action.money } });
  });
}

export async function admitCapture(session: Session, commissionId: string, input: { expectedRevision: number; packageId: string }, runtime: PaymentRuntime): Promise<PaymentIntent> {
  return transaction(async db => {
    const c = await lockedCommission(db, session, commissionId), pkg = packageFor(c, input.packageId), businessKey = `capture:${c.id}:${pkg.id}:${pkg.contractVersion}`;
    const existing = await priorIntent(db, c, businessKey); if (existing) return existing;
    revisionMatches(c, input.expectedRevision); assertAcceptedPayment(c, pkg, await acceptanceFor(db, c, pkg.id));
    if (pkg.paymentState === "paid") throw new DomainError("ALREADY_PAID", "This accepted work is already paid.", 422);
    const views = await operationViews(c, db, runtime); assertNoUncertainCapture(views);
    const intents = await listIntents(c.tenantId, c.id, db);
    if (intents.some(i => i.package_id === pkg.id && i.binding.route === "package_checkout" && i.admission_state === "ready")) throw new DomainError("PACKAGE_CHECKOUT_RESERVED", "This package already has its own checkout. Complete or cancel that checkout before capturing against a hold.", 422);
    const authorization = (await db.query<{ resource: ProviderResource }>("SELECT resource FROM guild_payment_resources WHERE tenant_id=$1 AND commission_id=$2 AND kind='authorization'", [c.tenantId, c.id])).rows[0]?.resource;
    const parent = intents.find(i => i.kind === "authorize_order" && i.command.action.kind === "authorize_order");
    if (!authorization?.money || !parent || parent.command.action.kind !== "authorize_order") throw new DomainError("AUTHORIZATION_REQUIRED", "Approve the commission authorization in PayPal, or choose a checkout for this accepted package.", 422);
    if (!["CREATED", "PARTIALLY_CAPTURED"].includes(authorization.status)) throw new DomainError("AUTHORIZATION_CLOSED", "This authorization is closed. Use the package checkout route for unpaid accepted work.", 422);
    const finalCapture = finalCaptureEligible(c, pkg.id, views, await openRecourse(c, db));
    return persistIntent(db, c, session, { businessKey, route: "authorization", purpose: "accepted_work", packageId: pkg.id, parentIntentId: parent.id, finalCapture,
      action: { kind: "capture_authorization", authorizationId: authorization.id, orderId: parent.command.action.orderId, money: { currency: "USD", minor: pkg.grossMinor }, finalCapture } });
  });
}

export async function admitClosure(session: Session, commissionId: string, expectedRevision: number, runtime: PaymentRuntime, switchToPackageCheckout = false): Promise<PaymentIntent> {
  return transaction(async db => {
    const c = await lockedCommission(db, session, commissionId), intents = await listIntents(c.tenantId, c.id, db);
    const authorization = (await db.query<{ resource: ProviderResource }>("SELECT resource FROM guild_payment_resources WHERE tenant_id=$1 AND commission_id=$2 AND kind='authorization'", [c.tenantId, c.id])).rows[0]?.resource;
    if (!authorization?.money) throw new DomainError("AUTHORIZATION_REQUIRED", "There is no confirmed authorization to close.", 422);
    const businessKey = `close:${c.id}:${authorization.id}`, existing = await priorIntent(db, c, businessKey); if (existing) return existing;
    revisionMatches(c, expectedRevision); assertFinancialPlan(c);
    assertClosable(c, await operationViews(c, db, runtime), await openRecourse(c, db), switchToPackageCheckout);
    if (!["CREATED", "PARTIALLY_CAPTURED"].includes(authorization.status)) throw new DomainError("AUTHORIZATION_CLOSED", "The authorization is already closed or expired.", 422);
    const parent = intents.find(i => i.kind === "authorize_order");
    return persistIntent(db, c, session, { businessKey, route: "authorization", purpose: "close_hold", parentIntentId: parent?.id, switchToPackageCheckout,
      action: { kind: "void_authorization", authorizationId: authorization.id, orderId: parent?.command.action.kind === "authorize_order" ? parent.command.action.orderId : undefined, money: authorization.money } });
  });
}

export async function cancelCheckout(session: Session, commissionId: string, input: { intentId: string; checkoutToken: string }): Promise<void> {
  await transaction(async db => {
    const c = await lockedCommission(db, session, commissionId), intent = await ownedIntent(c.tenantId, c.id, input.intentId, db);
    if (!intent.binding.challengeId || intent.kind !== "create_order" || intent.binding.actorId !== session.id || !safeEqual(input.checkoutToken, checkoutToken(intent.binding.challengeId, c.id))) throw new DomainError("CHECKOUT_CHALLENGE", "This checkout cannot be cancelled from another workspace.", 403, false);
    if ((await listIntents(c.tenantId, c.id, db)).some(i => i.binding.parentIntentId === intent.id)) throw new DomainError("PAYMENT_ALREADY_SUBMITTED", "The approved payment was already submitted. Reconcile its result instead of cancelling checkout.", 422);
    await db.query("UPDATE guild_checkout_challenges SET cancelled_at=COALESCE(cancelled_at,now()),resumed_at=NULL,resumed_by=NULL WHERE payment_intent_id=$1", [intent.id]);
    await db.query("UPDATE guild_payment_intents SET admission_state='cancelled',blocked_reason='Checkout was cancelled before payment authorization.' WHERE id=$1", [intent.id]);
    appendEvent(c, "payment.checkout_cancelled", "Checkout cancelled", "No authorization or capture will be submitted from this checkout return.", "Curator", intent.package_id); c.revision++; await saveCommission(db, c);
  });
}
