import type { PaymentOperation, ProviderResource } from "@fracture/paypal-core";
import type { Commission, PaymentOperationView, PaymentToolRun, Provenance } from "@/contracts/guild";
import { normalizePayments, resourceLabel } from "@/domain/payments";
import { digest } from "@/domain/primitives";
import { appendEvent, saveCommission } from "@/server/commissions";
import { transaction } from "@/server/db";
import { capabilityPassed, listIntents, operationResource, paymentScope, rememberResource, type PaymentIntent } from "./repository";
import type { PaymentRuntime } from "./runtime";

const confirmedCapture = (r: ProviderResource): boolean => r.kind === "capture" && ["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"].includes(r.status) && r.source === "live_sandbox" && r.money?.currency === "USD";
export const paymentSource = (id: string, observedAt: string | null, live = true): Provenance => ({ mode: !observedAt ? "modelled" : live ? "live" : "sample", label: !observedAt ? "Saved payment instruction" : live ? "PayPal Sandbox" : "Payment test fixture", sourceId: id, observedAt, sandbox: live });

export function operationView(intent: PaymentIntent, operation?: PaymentOperation): PaymentOperationView {
  const action = intent.command.action;
  const kind = action.kind === "create_order" ? "order" : action.kind === "authorize_order" || action.kind === "void_authorization" ? "authorization" : action.kind === "refund_capture" ? "refund" : "capture";
  const resource = operation ? operationResource(operation, kind) : null;
  return { id: intent.id, kind: intent.kind, packageId: intent.package_id, amountMinor: action.money.minor,
    state: operation?.status ?? (intent.blocked_reason || intent.admission_state === "cancelled" ? "not_sent" : "queued"),
    finalCapture: intent.binding.finalCapture, error: operation?.error?.message ?? intent.blocked_reason,
    createdAt: operation?.createdAt ?? new Date(intent.created_at).toISOString(), updatedAt: operation?.updatedAt ?? new Date(intent.created_at).toISOString(),
    resourceLabel: resource ? resourceLabel(resource.id) : null, transport: "SDK gateway",
    provenance: paymentSource(intent.id, operation?.receipt?.observedAt ?? null, operation?.receipt?.source !== "sample" && operation?.receipt?.source !== "replay") };
}

/** Only authoritative resources change the money totals; admission is never a receipt. */
export async function projectPayments(tenantId: string, commissionId: string, runtime: PaymentRuntime): Promise<Commission> {
  return transaction(async db => {
    const c = (await db.query<{ snapshot: Commission }>("SELECT snapshot FROM guild_commissions WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [tenantId, commissionId])).rows[0]?.snapshot;
    if (!c) throw new Error("Commission not found during payment projection");
    const payments = normalizePayments(c), before = digest({ payments, packages: c.packages.map(p => p.paymentState), state: c.state });
    const intents = await listIntents(tenantId, commissionId, db), operations = await runtime.store.list(paymentScope(c));
    await db.query("UPDATE guild_payment_tool_runs SET state='failed',failure_code='READ_INTERRUPTED',updated_at=now() WHERE tenant_id=$1 AND commission_id=$2 AND state='running' AND created_at<now()-interval '6 minutes'", [tenantId, commissionId]);
    const readRuns = (await db.query<{ id: string; state: PaymentToolRun["state"]; resource_id: string; created_at: Date; updated_at: Date; failure_code: string | null }>("SELECT id,state,resource_id,created_at,updated_at,failure_code FROM guild_payment_tool_runs WHERE tenant_id=$1 AND commission_id=$2 AND tool='get_order' ORDER BY created_at DESC LIMIT 20", [tenantId, commissionId])).rows;
    payments.toolRuns = readRuns.map(run => ({ id: run.id, tool: "get_order", state: run.state, resourceLabel: resourceLabel(run.resource_id), createdAt: run.created_at.toISOString(), updatedAt: run.updated_at.toISOString(), failureCode: run.failure_code }));
    const byId = new Map(operations.map(o => [o.command.operationId, o]));
    for (const operation of operations) {
      const intent = intents.find(i => i.id === operation.command.operationId);
      if (!intent) continue;
      for (const resource of operation.receipt?.resources ?? []) await rememberResource(db, c, intent.id, resource);
    }
    const resources = (await db.query<{ resource: ProviderResource }>("SELECT resource FROM guild_payment_resources WHERE tenant_id=$1 AND commission_id=$2", [tenantId, commissionId])).rows.map(r => r.resource);
    payments.operations = intents.map(i => operationView(i, byId.get(i.id)));
    payments.receipts = operations.flatMap(operation => {
      if (!operation.receipt) return [];
      const intent = intents.find(i => i.id === operation.command.operationId);
      if (!intent) return [];
      const view = operationView(intent, operation);
      return [{ id: operation.receipt.id, kind: intent.kind, packageId: intent.package_id, amountMinor: operation.command.action.money.minor, status: operation.status, transport: "SDK gateway", source: view.provenance, resourceId: view.resourceLabel ?? "Not yet identified", observedAt: operation.receipt.observedAt }];
    });
    const authorization = resources.find(r => r.kind === "authorization" && r.source === "live_sandbox");
    payments.authorizedMinor = authorization?.money?.minor ?? 0;
    payments.capturedMinor = resources.filter(confirmedCapture).reduce((n, r) => n + r.money!.minor, 0);
    payments.refundedMinor = resources.filter(r => r.kind === "refund" && r.status === "COMPLETED" && r.source === "live_sandbox" && r.money?.currency === "USD").reduce((n, r) => n + r.money!.minor, 0);
    payments.authorization = authorization?.money ? { resourceLabel: resourceLabel(authorization.id), amountMinor: authorization.money.minor, status: authorization.status, observedAt: authorization.observedAt, closureQualified: await capabilityPassed("final_capture_closure", db) } : null;
    const closed = authorization && ["VOIDED", "CAPTURED", "EXPIRED"].includes(authorization.status);
    payments.closure = closed ? "closed" : authorization ? "pending" : "not_started";
    const authorizedIntent = intents.find(i => i.kind === "authorize_order" && byId.get(i.id)?.status === "succeeded");
    const packageCheckout = intents.some(i => i.binding.route === "package_checkout" && i.admission_state === "ready");
    const switched = intents.some(i => i.kind === "void_authorization" && i.binding.switchToPackageCheckout && byId.get(i.id)?.status === "succeeded");
    payments.route = switched || packageCheckout ? "package_checkout" : authorization || authorizedIntent ? "authorization" : "unqualified";

    for (const pkg of c.packages) {
      if (pkg.paymentState === "not_eligible") continue;
      const related = intents.filter(i => i.package_id === pkg.id && i.contract_version === pkg.contractVersion && ["capture_authorization", "capture_order"].includes(i.kind));
      const views = related.map(i => byId.get(i.id)).filter((o): o is PaymentOperation => !!o);
      if (views.some(o => o.status === "succeeded" && o.receipt?.resources.some(confirmedCapture))) pkg.paymentState = "paid";
      else if (views.some(o => o.status === "pending_reconciliation" || o.status === "dispatching")) pkg.paymentState = "unknown";
      else if (related.some(i => i.admission_state === "ready" && (!byId.has(i.id) || byId.get(i.id)?.status === "claimed"))) pkg.paymentState = "pending";
      else if (pkg.state === "accepted") pkg.paymentState = "eligible";
    }
    payments.serviceFeeMinor = c.packages.filter(p => p.paymentState === "paid").reduce((n, p) => n + p.serviceFeeMinor, 0);
    payments.providerPaidMinor = payments.payouts.filter(p => p.status === "SUCCESS").reduce((n, p) => n + p.amountMinor, 0);
    payments.providerPayableMinor = Math.max(0, c.packages.filter(p => p.paymentState === "paid").reduce((n, p) => n + p.providerAwardMinor, 0) - payments.providerPaidMinor);
    const checkouts = intents.filter(i => i.kind === "create_order");
    const latest = checkouts.at(-1);
    if (latest) {
      const challenge = (await db.query<{ expires_at: Date; cancelled_at: Date | null; resumed_at: Date | null; completed_at: Date | null }>("SELECT expires_at,cancelled_at,resumed_at,completed_at FROM guild_checkout_challenges WHERE payment_intent_id=$1", [latest.id])).rows[0];
      const operation = byId.get(latest.id), order = operation ? operationResource(operation, "order") : null;
      const follow = intents.find(i => i.binding.parentIntentId === latest.id && ["authorize_order", "capture_order"].includes(i.kind));
      const followOperation = follow ? byId.get(follow.id) : undefined;
      const approvalLink = order?.links.find(l => ["approve", "payer-action"].includes(l.rel))?.href;
      // The only external navigation the client receives is PayPal's sandbox approval URL.
      const validLink = approvalLink && (() => { try { const u = new URL(approvalLink); return u.protocol === "https:" && u.hostname === "www.sandbox.paypal.com" && !u.username && !u.password; } catch { return false; } })();
      const uncertain = [operation, followOperation].some(o => o?.status === "pending_reconciliation" || o?.status === "dispatching");
      payments.checkout = { id: latest.id, route: latest.binding.route, packageId: latest.package_id, orderId: order?.id ?? null, approvalUrl: validLink ? approvalLink! : null, amountMinor: latest.command.action.money.minor,
        state: latest.admission_state === "cancelled" || challenge?.cancelled_at && (!challenge.resumed_at || challenge.resumed_at <= challenge.cancelled_at) ? "cancelled" : followOperation?.status === "succeeded" ? "approved" : uncertain ? "pending_reconciliation" : operation?.status === "refused" || operation?.status === "not_sent" || latest.blocked_reason ? "refused" : order ? "awaiting_payer" : "preparing",
        expiresAt: challenge?.expires_at.toISOString() ?? new Date(latest.created_at).toISOString() };
      const pkg = c.packages.find(p => p.id === latest.package_id);
      if (pkg && payments.checkout.state === "awaiting_payer" && pkg.paymentState === "eligible") pkg.paymentState = "awaiting_payer";
    }
    if (payments.capturedMinor > 0 && c.state !== "paused") c.state = "settling";
    const changed = before !== digest({ payments, packages: c.packages.map(p => p.paymentState), state: c.state });
    if (changed) {
      for (const view of payments.operations) {
        const eventKey = `payment.operation.${view.id}.${view.state}`;
        if (!c.events.some(e => e.type === eventKey)) appendEvent(c, eventKey, view.state === "succeeded" ? `${operationTitle(view.kind)} confirmed` : view.state === "pending_reconciliation" ? "Payment needs reconciliation" : `${operationTitle(view.kind)}: ${view.state.replaceAll("_", " ")}`, view.error ?? (view.state === "succeeded" ? "The provider response is recorded against this exact commercial decision." : "This durable operation keeps its original provider request identity."), "Payment gateway", view.packageId, view.provenance);
      }
      c.revision++;
      await saveCommission(db, c);
    }
    return c;
  });
}

export const operationTitle = (kind: string): string => ({ create_order: "Checkout", authorize_order: "Authorization", capture_authorization: "Accepted-work capture", capture_order: "Package payment", void_authorization: "Authorization closure", refund_capture: "Refund" }[kind] ?? "Payment");
