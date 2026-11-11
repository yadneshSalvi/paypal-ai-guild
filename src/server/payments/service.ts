import { PaymentError, type PaymentOperation, type ProviderResource } from "@fracture/paypal-core";
import type { Commission } from "@/contracts/guild";
import type { GuildPaymentCommand } from "@/contracts/payments";
import { DomainError } from "@/domain/primitives";
import { getCommission } from "@/server/commissions";
import { getPool, transaction } from "@/server/db";
import type { Session } from "@/server/session";
import { admitCapture, admitCheckout, admitCheckoutCompletion, admitCheckoutResume, admitClosure, cancelCheckout, requireFinancialActor } from "./admission";
import { checkoutToken, listIntents, ownedIntent, paymentScope, rememberResource, type PaymentIntent } from "./repository";
import { projectPayments } from "./projection";
import { paymentRuntime, sandboxConfig, type PaymentRuntime } from "./runtime";

export interface PaymentResult { ok: true; commission: Commission; checkoutToken?: string }

/** Returning an existing operation is a read. Only explicit retry can resend a known refusal. */
export async function dispatchIntent(intent: PaymentIntent, runtime: PaymentRuntime): Promise<PaymentOperation> {
  const existing = await runtime.store.get(intent.command.scope, intent.id);
  if (existing) return existing;
  if (intent.admission_state === "cancelled") throw new DomainError("CHECKOUT_CANCELLED", "This checkout was cancelled. Open a new checkout to continue.", 422);
  try {
    const operation = await runtime.core.execute(intent.command);
    await finishChallenge(intent, operation);
    return operation;
  } catch (error) {
    if (error instanceof PaymentError && !(await runtime.store.get(intent.command.scope, intent.id))) await getPool().query("UPDATE guild_payment_intents SET blocked_reason=$2 WHERE id=$1", [intent.id, error.message]);
    throw paymentError(error);
  } finally {
    await projectPayments(intent.tenant_id, intent.commission_id, runtime);
  }
}

async function finishChallenge(intent: PaymentIntent, operation: PaymentOperation): Promise<void> {
  if (intent.binding.challengeId && ["authorize_order", "capture_order"].includes(intent.kind) && operation.status === "succeeded") await getPool().query("UPDATE guild_checkout_challenges SET completed_at=COALESCE(completed_at,now()) WHERE id=$1 AND tenant_id=$2", [intent.binding.challengeId, intent.tenant_id]);
}

export async function refreshOwnedResources(c: Commission, runtime: PaymentRuntime): Promise<void> {
  const resources = (await getPool().query<{ operation_id: string; resource: ProviderResource }>("SELECT operation_id,resource FROM guild_payment_resources WHERE tenant_id=$1 AND commission_id=$2 AND kind IN ('order','authorization') ORDER BY kind,resource_id", [c.tenantId, c.id])).rows;
  // Read only resource identities already bound by a stored SDK receipt.
  const observed = await Promise.allSettled(resources.map(async row => ({ operationId: row.operation_id, resources: await runtime.provider.read(row.resource.kind, row.resource.id) })));
  await transaction(async db => {
    // Match projection/admission lock order before touching child resource rows and their FK.
    await db.query("SELECT id FROM guild_commissions WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [c.tenantId, c.id]);
    for (const result of observed) if (result.status === "fulfilled") for (const resource of result.value.resources) await rememberResource(db, c, result.value.operationId, resource);
  });
  // A failed read leaves its prior timestamp visible. It never means closed or paid.
}

export async function reconcilePayments(session: Session, commissionId: string, runtime: PaymentRuntime = paymentRuntime()): Promise<Commission> {
  const c = await getCommission(session, commissionId), intents = await listIntents(session.tenantId, c.id);
  for (const operation of await runtime.store.list(paymentScope(c))) {
    if (["pending_reconciliation", "dispatching", "claimed"].includes(operation.status)) {
      const next = await runtime.core.reconcile(paymentScope(c), operation.command.operationId);
      const intent = intents.find(i => i.id === operation.command.operationId); if (intent) await finishChallenge(intent, next);
    }
  }
  await refreshOwnedResources(c, runtime);
  const { recoverProviderPayouts } = await import("./payouts");
  await recoverProviderPayouts(c.tenantId, c.id, runtime);
  return projectPayments(c.tenantId, c.id, runtime);
}

export async function executePayment(session: Session, commissionId: string, input: GuildPaymentCommand, runtime: PaymentRuntime = paymentRuntime()): Promise<PaymentResult> {
  await getCommission(session, commissionId); // Ownership check before any provider read or operation lookup.
  if (input.type === "reconcile") return { ok: true, commission: await reconcilePayments(session, commissionId, runtime) };
  if (input.type === "inspect_order") {
    const { inspectOwnedOrder } = await import("./reader");
    await inspectOwnedOrder(session, commissionId, runtime);
    return { ok: true, commission: await projectPayments(session.tenantId, commissionId, runtime) };
  }
  requireFinancialActor(session);
  if (["pay_provider", "retry_payout", "cancel_payout"].includes(input.type)) {
    const { payProvider, retryProviderPayout, cancelProviderPayout } = await import("./payouts");
    if (input.type === "pay_provider") await payProvider(session, commissionId, input.packageId, input.expectedRevision, runtime);
    if (input.type === "retry_payout") await retryProviderPayout(session, commissionId, input.payoutId, runtime);
    if (input.type === "cancel_payout") await cancelProviderPayout(session, commissionId, input.payoutId, runtime);
    return { ok: true, commission: await projectPayments(session.tenantId, commissionId, runtime) };
  }
  let intent: PaymentIntent | undefined;
  try {
    switch (input.type) {
      case "prepare_checkout": intent = await admitCheckout(session, commissionId, input, runtime); break;
      case "complete_checkout": intent = await admitCheckoutCompletion(session, commissionId, input, runtime); break;
      case "resume_checkout": intent = await admitCheckoutResume(session, commissionId, input, runtime); break;
      case "capture_package": intent = await admitCapture(session, commissionId, input, runtime); break;
      case "close_authorization": intent = await admitClosure(session, commissionId, input.expectedRevision, runtime, input.switchToPackageCheckout); break;
      case "cancel_checkout": await cancelCheckout(session, commissionId, input); return { ok: true, commission: await projectPayments(session.tenantId, commissionId, runtime) };
      case "retry_operation": {
        intent = await ownedIntent(session.tenantId, commissionId, input.intentId);
        if (intent.admission_state === "cancelled") throw new DomainError("CHECKOUT_CANCELLED", "Open a new checkout instead of retrying a cancelled one.", 422);
        const operation = await runtime.store.get(intent.command.scope, intent.id);
        if (operation) { const retried = await runtime.core.retry(intent.command.scope, intent.id); await finishChallenge(intent, retried); }
        else { await getPool().query("UPDATE guild_payment_intents SET blocked_reason=NULL WHERE id=$1", [intent.id]); await dispatchIntent(intent, runtime); }
        return { ok: true, commission: await projectPayments(session.tenantId, commissionId, runtime) };
      }
    }
    if (!intent) throw new DomainError("PAYMENT_ACTION", "Choose a supported payment instruction.", 422);
    const operation = await dispatchIntent(intent, runtime);
    await finishChallenge(intent, operation);
    if (["authorize_order", "capture_authorization", "capture_order", "void_authorization"].includes(intent.kind)) await refreshOwnedResources(await getCommission(session, commissionId), runtime);
    return { ok: true, commission: await projectPayments(session.tenantId, commissionId, runtime), ...(intent.kind === "create_order" && intent.binding.challengeId ? { checkoutToken: checkoutToken(intent.binding.challengeId, commissionId) } : {}) };
  } catch (error) {
    if (intent) await projectPayments(session.tenantId, commissionId, runtime);
    throw paymentError(error);
  }
}

export function paymentError(error: unknown): unknown {
  return error instanceof PaymentError ? new DomainError(error.code, error.message, error.httpStatus, error.httpStatus !== 403) : error;
}

export async function checkoutConfiguration(session: Session): Promise<{ clientId: string; currency: "USD"; environment: "sandbox" }> {
  requireFinancialActor(session);
  const config = sandboxConfig();
  return { clientId: config.clientId, currency: "USD", environment: "sandbox" };
}

/** Cron resumes durable claims and inspects ambiguous writes. It never retries a refusal. */
export async function recoverPaymentWork(runtime: PaymentRuntime = paymentRuntime()): Promise<{ inspected: number; pending: number }> {
  const scopes = await transaction(async db => {
    const selected = (await db.query<{ tenant_id: string; commission_id: string }>("SELECT tenant_id,commission_id FROM guild_payment_recovery WHERE next_check_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY next_check_at FOR UPDATE SKIP LOCKED LIMIT 3")).rows;
    for (const scope of selected) await db.query("UPDATE guild_payment_recovery SET lease_until=now()+interval '6 minutes' WHERE tenant_id=$1 AND commission_id=$2", [scope.tenant_id, scope.commission_id]);
    return selected;
  });
  let pending = 0;
  for (const scope of scopes) {
    let scopePending = 0;
    try {
    const intents = await listIntents(scope.tenant_id, scope.commission_id);
    for (const intent of intents) {
      if (!intent.blocked_reason && !(await runtime.store.get(intent.command.scope, intent.id))) {
        try { await dispatchIntent(intent, runtime); } catch { /* The durable block or uncertain claim is retained. */ }
      }
    }
    const recovered = await runtime.core.recover({ tenantId: scope.tenant_id, projectId: scope.commission_id });
    for (const operation of recovered) { const intent = intents.find(i => i.id === operation.command.operationId); if (intent) await finishChallenge(intent, operation); }
    const c = (await getPool().query<{ snapshot: Commission }>("SELECT snapshot FROM guild_commissions WHERE id=$1 AND tenant_id=$2", [scope.commission_id, scope.tenant_id])).rows[0]?.snapshot;
    if (c) {
      await refreshOwnedResources(c, runtime);
      const { recoverProviderPayouts } = await import("./payouts"); await recoverProviderPayouts(c.tenantId, c.id, runtime, true);
      const next = await projectPayments(c.tenantId, c.id, runtime);
      scopePending = next.payments.operations.filter(o => ["queued", "claimed", "dispatching", "pending_reconciliation"].includes(o.state)).length + next.payments.payouts.filter(p => ["claimed", "dispatching", "pending_reconciliation"].includes(p.operationState) || ["dispatching", "pending_reconciliation"].includes(p.cancellationState ?? "")).length; pending += scopePending;
    }
    } catch { scopePending++; pending++; }
    finally { await getPool().query("UPDATE guild_payment_recovery SET lease_until=NULL,last_check_at=now(),next_check_at=now()+($3::text||' seconds')::interval WHERE tenant_id=$1 AND commission_id=$2", [scope.tenant_id, scope.commission_id, scopePending ? 60 : 1800]); }
  }
  return { inspected: scopes.length, pending };
}
