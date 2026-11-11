import { PayPalWebhookVerifier, type ProviderResource, type WebhookDelivery, type WebhookVerifier } from "@fracture/paypal-core";
import type { Commission } from "@/contracts/guild";
import { DomainError } from "@/domain/primitives";
import { getPool, transaction } from "@/server/db";
import { projectProviderPayouts, reconcileProviderPayout, type PayoutRow } from "./payouts";
import { projectPayments } from "./projection";
import { merchantFingerprint, paymentScope, rememberResource } from "./repository";
import { paymentRuntime, sandboxConfig, type PaymentRuntime } from "./runtime";

interface ObservationJob { merchant_fingerprint: string; event_id: string; event_type: string; resource_id: string; attempts: number }
const inboxScope = () => ({ tenantId: `guild:sandbox:${merchantFingerprint()}`, projectId: "webhook-inbox-v1" });
function registeredVerifier(): WebhookVerifier {
  const id = process.env.PAYPAL_WEBHOOK_ID;
  if (!id) throw new DomainError("WEBHOOK_NOT_REGISTERED", "The signed payment receiver is not configured yet.", 503, false);
  return new PayPalWebhookVerifier(sandboxConfig(), id);
}

/** Signature + canonical intake only. Event payloads never move money or change a package. */
export async function ingestPaymentWebhook(rawBody: string, headers: Headers, runtime: PaymentRuntime = paymentRuntime(), verifier: WebhookVerifier = registeredVerifier()): Promise<{ duplicate: boolean; eventId: string }> {
  const scope = inboxScope(), admitted = await runtime.core.ingestWebhook(scope, rawBody, headers, verifier);
  const stored = (await getPool().query<{ document: string }>("SELECT document FROM paycore_webhook_events WHERE tenant_id=$1 AND project_id=$2 AND event_id=$3", [scope.tenantId, scope.projectId, admitted.eventId])).rows[0];
  if (!stored) throw new DomainError("WEBHOOK_INTAKE_MISSING", "The verified observation was not durably recorded.", 503);
  const event = JSON.parse(stored.document) as WebhookDelivery;
  if (!event.verified || !event.schemaValid || event.status !== "queued") throw new DomainError("WEBHOOK_NOT_ADMITTED", "This delivery is retained for review and cannot reconcile commerce.", 422, false);
  await getPool().query("INSERT INTO guild_webhook_reconciliation(merchant_fingerprint,event_id,body_hash,event_type,resource_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(merchant_fingerprint,event_id) DO NOTHING", [merchantFingerprint(), event.eventId, event.bodyHash, event.eventType, event.resourceId]);
  return { duplicate: admitted.duplicate, eventId: admitted.eventId };
}

/** Reconciles only resource IDs already owned by the same isolated merchant and commission. */
export async function recoverWebhookObservations(runtime: PaymentRuntime = paymentRuntime()): Promise<{ processed: number; awaitingOwnership: number; retrying: number }> {
  const fingerprint = merchantFingerprint();
  const jobs = await transaction(async db => {
    const selected = (await db.query<ObservationJob>("SELECT merchant_fingerprint,event_id,event_type,resource_id,attempts FROM guild_webhook_reconciliation WHERE merchant_fingerprint=$1 AND state IN ('queued','awaiting_ownership') AND next_check_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY next_check_at FOR UPDATE SKIP LOCKED LIMIT 12", [fingerprint])).rows;
    for (const row of selected) await db.query("UPDATE guild_webhook_reconciliation SET lease_until=now()+interval '3 minutes',attempts=attempts+1 WHERE merchant_fingerprint=$1 AND event_id=$2", [fingerprint, row.event_id]);
    return selected;
  });
  let processed = 0, awaitingOwnership = 0, retrying = 0;
  for (const job of jobs) {
    let owner: { tenant_id: string; commission_id: string } | undefined;
    try {
      if (job.event_type.startsWith("PAYMENT.PAYOUTS")) {
        const rows = (await getPool().query<PayoutRow>("SELECT * FROM guild_payout_operations WHERE batch_id=$1 OR item_id=$1", [job.resource_id])).rows;
        if (rows.length === 1) {
          const row = rows[0]!;
          // This verifies the private merchant/request binding before reading the known original batch.
          await reconcileProviderPayout(row, runtime); owner = row;
          await projectProviderPayouts(row.tenant_id, row.commission_id);
        }
      } else if (/^(CHECKOUT\.ORDER\.|PAYMENT\.(AUTHORIZATION|CAPTURE|REFUND)\.)/.test(job.event_type)) {
        const rows = (await getPool().query<{ tenant_id: string; commission_id: string; operation_id: string; kind: ProviderResource["kind"]; resource_id: string }>("SELECT r.tenant_id,r.commission_id,r.operation_id,r.kind,r.resource_id FROM guild_payment_resources r JOIN guild_payment_intents i ON i.id=r.operation_id WHERE r.resource_id=$1 AND i.binding->>'merchantFingerprint'=$2", [job.resource_id, fingerprint])).rows;
        if (rows.length === 1) {
          const row = rows[0]!, observed = await runtime.provider.read(row.kind, row.resource_id);
          const exact = observed.find(resource => resource.id === row.resource_id && resource.kind === row.kind && resource.source === "live_sandbox");
          if (!exact) throw new DomainError("WEBHOOK_READ_UNVERIFIED", "The original resource did not return a verified observation.", 503);
          const c = await transaction(async db => {
            const current = (await db.query<{ snapshot: Commission }>("SELECT snapshot FROM guild_commissions WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [row.tenant_id, row.commission_id])).rows[0]?.snapshot;
            if (!current) throw new DomainError("WEBHOOK_OWNER_MISSING", "The original commission is unavailable.", 503);
            await rememberResource(db, current, row.operation_id, exact); return current;
          });
          for (const operation of await runtime.store.list(paymentScope(c))) if (["claimed", "dispatching", "pending_reconciliation"].includes(operation.status)) await runtime.core.reconcile(paymentScope(c), operation.command.operationId);
          owner = row;
        }
      }
      if (!owner) {
        await getPool().query("UPDATE guild_webhook_reconciliation SET state='awaiting_ownership',lease_until=NULL,error_code='OWNERSHIP_NOT_BOUND',next_check_at=now()+interval '5 minutes' WHERE merchant_fingerprint=$1 AND event_id=$2", [fingerprint, job.event_id]); awaitingOwnership++; continue;
      }
      await projectPayments(owner.tenant_id, owner.commission_id, runtime);
      await getPool().query("UPDATE guild_webhook_reconciliation SET state='processed',tenant_id=$3,commission_id=$4,processed_at=now(),lease_until=NULL,error_code=NULL WHERE merchant_fingerprint=$1 AND event_id=$2", [fingerprint, job.event_id, owner.tenant_id, owner.commission_id]); processed++;
    } catch (error) {
      const code = error instanceof DomainError ? error.code : "RESOURCE_READ_UNAVAILABLE";
      await getPool().query("UPDATE guild_webhook_reconciliation SET lease_until=NULL,error_code=$3,next_check_at=now()+interval '1 minute' WHERE merchant_fingerprint=$1 AND event_id=$2", [fingerprint, job.event_id, code]); retrying++;
    }
  }
  return { processed, awaitingOwnership, retrying };
}
