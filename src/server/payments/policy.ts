import type { AuthorizationDecision, PaymentCommand, PaymentPolicy, ProviderAdapter, ProviderResource, SqlPaymentStore } from "@fracture/paypal-core";
import type { Commission } from "@/contracts/guild";
import { assertAcceptedPayment, assertClosable, assertFinancialPlan, finalCaptureEligible, normalizePayments } from "@/domain/payments";
import { digest, DomainError } from "@/domain/primitives";
import { getPool, transaction } from "@/server/db";
import { acceptanceFor, appOrigin, approvalFor, contractDigest, merchantFingerprint, openRecourse, ownedIntent, paymentScope } from "./repository";

/** The core asks twice: before its durable claim, then immediately before dispatch. */
export class GuildPaymentPolicy implements PaymentPolicy {
  constructor(private readonly provider: ProviderAdapter, private readonly store: SqlPaymentStore, private readonly configuredMerchant: string) {}

  async authorize(command: PaymentCommand): Promise<AuthorizationDecision> {
    const base: AuthorizationDecision = { allowed: false, reason: "Payment authority could not be verified.", resourceIds: [], currency: "USD", maximumMinor: 0, approvalId: command.approval.id, approvalVersion: command.approval.version, approvalDigest: command.approval.digest };
    try {
      const intent = await ownedIntent(command.scope.tenantId, command.scope.projectId, command.operationId);
      if (digest(intent.command) !== digest(command) || intent.admission_state !== "ready") throw new DomainError("PAYMENT_BINDING", "The payment command differs from its approved commercial decision.", 403, false);
      if (this.configuredMerchant !== merchantFingerprint() || intent.binding.merchantFingerprint !== this.configuredMerchant) throw new DomainError("MERCHANT_CHANGED", "The payment's isolated merchant binding changed before dispatch.", 403, false);
      const actor = await getPool().query("SELECT id FROM guild_sessions WHERE id=$1 AND tenant_id=$2 AND role IN ('owner','judge') AND revoked_at IS NULL AND expires_at>now()", [intent.binding.actorId, intent.tenant_id]);
      if (!actor.rowCount) throw new DomainError("PAYMENT_SESSION_EXPIRED", "The payment actor's workspace expired or was revoked before dispatch.", 403, false);
      const action = command.action;
      const requiredIds = ["orderId" in action ? action.orderId : undefined, "authorizationId" in action ? action.authorizationId : undefined, "captureId" in action ? action.captureId : undefined].filter((x): x is string => !!x);
      const owned = (await getPool().query<{ resource_id: string }>("SELECT resource_id FROM guild_payment_resources WHERE tenant_id=$1 AND commission_id=$2", [intent.tenant_id, intent.commission_id])).rows.map(r => r.resource_id);
      if (requiredIds.some(id => !owned.includes(id))) throw new DomainError("RESOURCE_NOT_GRANTED", "The payment resource is outside this commission's owned records.", 403, false);

      let authorization: ProviderResource | undefined;
      let captures: ProviderResource[] = [];
      if (action.kind === "capture_authorization") {
        if (!action.orderId) throw new DomainError("OWNING_ORDER_REQUIRED", "The authorization needs its complete owning order before capture.", 422);
        // Read full owning-order effects and the exact authorization, not just its original gross.
        const orderResources = await this.provider.read("order", action.orderId);
        authorization = (await this.provider.read("authorization", action.authorizationId))[0];
        if (!orderResources.some(r => r.kind === "authorization" && r.id === action.authorizationId) || !authorization?.money || authorization.money.currency !== "USD" || !["CREATED", "PARTIALLY_CAPTURED"].includes(authorization.status)) throw new DomainError("AUTHORIZATION_UNAVAILABLE", "This authorization is closed, expired, or cannot be reconciled to its owning order.", 422);
        captures = orderResources.filter(r => r.kind === "capture" && !["DECLINED", "DENIED", "FAILED"].includes(r.status));
        if (captures.some(r => !r.money || r.money.currency !== "USD")) throw new DomainError("CAPTURE_BUDGET_UNKNOWN", "A provider capture omitted the amount needed to prove the remaining budget.", 422);
      }

      // The final local read follows provider reads, so a revocation during network I/O wins.
      return await transaction(async db => {
        const found = await db.query<{ snapshot: Commission }>("SELECT snapshot FROM guild_commissions WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [intent.tenant_id, intent.commission_id]);
        const c = found.rows[0]?.snapshot;
        if (!c) throw new DomainError("COMMISSION_NOT_FOUND", "This commission no longer exists.", 404);
        normalizePayments(c);
        assertFinancialPlan(c);
        const approved = await approvalFor(db, c);
        if (intent.approval_id !== approved.row.id || intent.binding.approvalSignature !== approved.row.signature || intent.binding.planDigest !== c.approvedPlanDigest || digest(approved.approval) !== digest(command.approval)) throw new DomainError("APPROVAL_CHANGED", "The approval receipt changed. Review the current commercial decision.", 403);
        const operations = await this.store.list(paymentScope(c));
        const currentViews = operations.filter(o => o.command.operationId !== intent.id).map(o => ({ id: o.command.operationId, kind: o.command.action.kind, packageId: null, amountMinor: o.command.action.money.minor, state: o.status, finalCapture: false, error: null, createdAt: o.createdAt, updatedAt: o.updatedAt, resourceLabel: null, transport: "SDK gateway" as const, provenance: { mode: "live" as const, label: "PayPal Sandbox", sandbox: true, sourceId: o.command.operationId, observedAt: o.updatedAt } }));
        if (["capture_authorization", "capture_order"].includes(action.kind) && currentViews.some(v => ["capture_authorization", "capture_order"].includes(v.kind) && ["claimed", "dispatching", "pending_reconciliation"].includes(v.state))) throw new DomainError("CAPTURE_UNCERTAIN", "An earlier capture must reconcile before another charge is dispatched.", 422);
        if (intent.package_id) {
          const pkg = c.packages.find(p => p.id === intent.package_id);
          if (!pkg) throw new DomainError("PACKAGE_NOT_FOUND", "The accepted work no longer matches this payment.", 422);
          const acceptance = await acceptanceFor(db, c, pkg.id);
          assertAcceptedPayment(c, pkg, acceptance);
          if (acceptance?.id !== intent.acceptance_id || contractDigest(c, pkg.id) !== intent.binding.contractDigest || command.action.money.minor !== pkg.grossMinor) throw new DomainError("ACCEPTANCE_CHANGED", "The payment must retain its accepted artifact, award and fee allocation.", 422);
          const reservation = await db.query("SELECT id FROM guild_budget_reservations WHERE tenant_id=$1 AND commission_id=$2 AND operation_key=$3 AND state='committed' AND amount_minor=$4", [c.tenantId, c.id, `production:${c.id}:${pkg.id}:${pkg.contractVersion}`, pkg.grossMinor]);
          if (!reservation.rowCount) throw new DomainError("AWARD_NOT_COMMITTED", "The accepted work has no matching committed commercial allocation.", 422);
          if (action.kind === "capture_authorization" && action.finalCapture && !finalCaptureEligible(c, pkg.id, currentViews, await openRecourse(c, db))) throw new DomainError("FINAL_CAPTURE_NOT_READY", "Other work or reconciliation remains open, so this authorization cannot close yet.", 422);
        } else if (intent.binding.purpose === "commission_hold" && action.money.minor !== c.capMinor) throw new DomainError("CAP_CHANGED", "The PayPal authorization must match the approved cap.", 422);
        if (action.kind === "void_authorization") assertClosable(c, currentViews, await openRecourse(c, db), intent.binding.switchToPackageCheckout);
        if (action.kind === "create_order" && (action.savedWallet || action.saveWalletOnSuccess || !action.experience || action.experience.returnUrl.split("?")[0] !== `${appOrigin()}/payments/return` || action.experience.cancelUrl.split("?")[0] !== `${appOrigin()}/payments/cancel`)) throw new DomainError("CHECKOUT_FLOW", "This order must use the approved buyer-present checkout flow.", 403);
        return {
          ...base, allowed: true, reason: "Current Passport, commercial contract and provider ownership match.",
          maximumMinor: action.money.minor, resourceIds: owned, checkoutOrigins: [appOrigin()],
          ...(authorization?.money ? { reservation: { resourceKey: `authorization:${authorization.id}`, currency: "USD", totalMinor: authorization.money.minor, externallyConsumedMinor: captures.reduce((sum, r) => sum + r.money!.minor, 0), observedProviderIds: captures.map(r => r.id), observedAt: authorization.observedAt } } : {}),
        };
      });
    } catch (error) {
      if (error instanceof DomainError) return { ...base, reason: error.message };
      throw error;
    }
  }
}
