import { randomUUID } from "node:crypto";
import { SandboxCommerceRestGateway, type CommerceRestResult, type CreatePayout, type PayoutBatchObservation, type PayoutItemObservation, type PayoutRequestItem } from "@fracture/paypal-core";
import type { PoolClient } from "pg";
import { z } from "zod";
import type { Commission, ProviderPayoutView } from "@/contracts/guild";
import { assertAcceptedPayment, assertFinancialPlan, normalizePayments, resourceLabel } from "@/domain/payments";
import { digest, DomainError } from "@/domain/primitives";
import { appendEvent, getCommission, saveCommission } from "@/server/commissions";
import { getPool, transaction } from "@/server/db";
import type { Session } from "@/server/session";
import { requireFinancialActor } from "./admission";
import { openDocument, sealDocument, type PrivateDocumentContext } from "./private-document";
import { paymentSource } from "./projection";
import { acceptanceFor, approvalFor, contractDigest, listIntents, merchantFingerprint, openRecourse, operationResource, paymentScope } from "./repository";
import { sandboxConfig, type PaymentRuntime, type PayoutGateway } from "./runtime";

type State = ProviderPayoutView["operationState"];
export interface PayoutRow {
  id: string; tenant_id: string; commission_id: string; package_id: string; contract_version: number; provider_id: string;
  acceptance_id: string; capture_operation_id: string; approval_id: string; amount_minor: string; currency: "USD";
  receiver_hash: string; request_hash: string; document: string; state: State; provider_status: string | null;
  batch_id: string | null; item_id: string | null; fee_minor: string | null; error_code: string | null;
  cancel_state: ProviderPayoutView["cancellationState"]; cancel_lease_until: Date | null; lease_owner: string | null; lease_until: Date | null; version: number; attempts: number;
  observed_at: Date | null; created_at: Date; updated_at: Date;
}
interface PayoutDocument {
  operationId: string; request: CreatePayout;
  binding: { actorId: string; approvalId: string; approvalDigest: string; approvalSignature: string; contractDigest: string; acceptanceId: string; artifactHash: string; receiverHash: string; captureId: string; captureOperationId: string; grossMinor: number; merchantFingerprint: string };
  batch: CommerceRestResult<PayoutBatchObservation> | null;
  item: CommerceRestResult<PayoutItemObservation> | null;
  cancellation: CommerceRestResult<PayoutItemObservation> | null;
}
const recipientIndexes: Record<string, number> = { marlow: 1, tessellate: 2, quill: 3, halide: 4, ostrava: 5, northlight: 6 };
const registrySchema = z.array(z.object({ providerIndex: z.number().int().min(1).max(6), email: z.email().max(127), controlledSandboxAccount: z.literal(true) }).strict()).length(6);
export function payoutRecipient(providerId: string): { item: Pick<PayoutRequestItem, "recipientType" | "receiver">; hash: string } {
  try {
    const raw = process.env.GUILD_SANDBOX_PROVIDER_RECEIVERS_JSON;
    if (!raw || raw.length > 8192) throw new Error("Missing recipient registry");
    const registry = registrySchema.parse(JSON.parse(raw));
    if (new Set(registry.map(r => r.providerIndex)).size !== 6 || new Set(registry.map(r => r.email.toLowerCase())).size !== 6) throw new Error("Ambiguous receiver registry");
    const receiver = registry.find(r => r.providerIndex === recipientIndexes[providerId]);
    if (!receiver) throw new Error("Provider has no controlled receiver");
    const item = { recipientType: "EMAIL" as const, receiver: receiver.email.toLowerCase() };
    return { item, hash: digest({ providerId, ...item, controlledSandboxAccount: true }) };
  } catch { throw new DomainError("PAYOUT_RECIPIENT_UNAVAILABLE", "This provider has no unambiguous controlled sandbox destination in the approved registry.", 503, false); }
}
const privateContext = (row: Pick<PayoutRow, "id" | "tenant_id" | "commission_id">): PrivateDocumentContext => ({ tenantId: row.tenant_id, commissionId: row.commission_id, operationId: row.id, purpose: "provider-payout" });
function documentFor(row: PayoutRow): PayoutDocument {
  const document = openDocument<PayoutDocument>(row.document, privateContext(row));
  if (document.operationId !== row.id || digest(document.request) !== row.request_hash || document.binding.acceptanceId !== row.acceptance_id || document.binding.captureOperationId !== row.capture_operation_id || document.binding.approvalId !== row.approval_id || document.binding.receiverHash !== row.receiver_hash || document.request.items.length !== 1 || document.request.items[0]?.money.currency !== "USD" || document.request.items[0].money.minor !== Number(row.amount_minor)) throw new DomainError("PAYOUT_DOCUMENT_BINDING", "The stored payout does not match its independent commercial identity. It cannot be dispatched.", 503, false);
  return document;
}
async function ownedPayout(tenantId: string, commissionId: string, payoutId: string, db: Pick<PoolClient, "query"> = getPool()): Promise<PayoutRow> {
  const row = (await db.query<PayoutRow>("SELECT * FROM guild_payout_operations WHERE id=$1 AND tenant_id=$2 AND commission_id=$3", [payoutId, tenantId, commissionId])).rows[0];
  if (!row) throw new DomainError("PAYOUT_NOT_FOUND", "This payout is not in your commission.", 404, false);
  return row;
}
const gateway = (runtime: PaymentRuntime): PayoutGateway => runtime.commerce ??= new SandboxCommerceRestGateway(sandboxConfig());
const matchesItem = (expected: PayoutRequestItem, observed: PayoutItemObservation): boolean => expected.senderItemId === observed.senderItemId && expected.recipientType === observed.recipientType && expected.receiver === observed.receiver && expected.money.currency === observed.money.currency && expected.money.minor === observed.money.minor;

async function assertPayoutAuthority(db: PoolClient, c: Commission, row: PayoutRow, document: PayoutDocument): Promise<void> {
  assertFinancialPlan(c);
  const pkg = c.packages.find(p => p.id === row.package_id && p.contractVersion === row.contract_version);
  if (!pkg || pkg.paymentState !== "paid" || pkg.providerId !== row.provider_id || pkg.providerAwardMinor !== Number(row.amount_minor)) throw new DomainError("PAYOUT_NOT_EARNED", "The provider award needs this exact accepted and captured contract.", 422);
  const acceptance = await acceptanceFor(db, c, pkg.id); assertAcceptedPayment(c, pkg, acceptance);
  const approval = await approvalFor(db, c), receiver = payoutRecipient(pkg.providerId);
  const actor = await db.query("SELECT id FROM guild_sessions WHERE id=$1 AND tenant_id=$2 AND role IN ('judge','owner') AND expires_at>now() AND revoked_at IS NULL", [document.binding.actorId, c.tenantId]);
  if (!actor.rowCount || acceptance?.id !== row.acceptance_id || acceptance.artifactHash !== document.binding.artifactHash || approval.row.id !== row.approval_id || approval.row.signature !== document.binding.approvalSignature || approval.row.plan_digest !== document.binding.approvalDigest || contractDigest(c, pkg.id) !== document.binding.contractDigest || receiver.hash !== row.receiver_hash || document.binding.merchantFingerprint !== merchantFingerprint()) throw new DomainError("PAYOUT_AUTHORITY_CHANGED", "The provider, accepted artifact, merchant or current approval changed. This payout cannot be sent.", 403, false);
  if (await openRecourse(c, db)) throw new DomainError("RECOURSE_OPEN", "Resolve the open recourse review before disbursing provider awards.", 422);
}

export async function admitProviderPayout(session: Session, commissionId: string, packageId: string, expectedRevision: number, runtime: PaymentRuntime): Promise<PayoutRow> {
  requireFinancialActor(session);
  return transaction(async db => {
    await db.query("SELECT id FROM guild_tenants WHERE id=$1 FOR UPDATE", [session.tenantId]);
    const c = (await db.query<{ snapshot: Commission }>("SELECT snapshot FROM guild_commissions WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [session.tenantId, commissionId])).rows[0]?.snapshot;
    if (!c) throw new DomainError("NOT_FOUND", "This commission is not in your workspace.", 404, false);
    const pkg = c.packages.find(p => p.id === packageId); if (!pkg) throw new DomainError("PACKAGE_NOT_FOUND", "Choose an accepted package in this commission.", 404, false);
    const existing = (await db.query<PayoutRow>("SELECT * FROM guild_payout_operations WHERE tenant_id=$1 AND commission_id=$2 AND package_id=$3 AND contract_version=$4", [c.tenantId, c.id, pkg.id, pkg.contractVersion])).rows[0];
    if (existing) return existing;
    if (c.revision !== expectedRevision) throw new DomainError("REVISION_CONFLICT", "Refresh the current payment record before disbursing an award.", 409);
    const acceptance = await acceptanceFor(db, c, pkg.id); assertAcceptedPayment(c, pkg, acceptance);
    if (pkg.paymentState !== "paid" || pkg.providerAwardMinor <= 0) throw new DomainError("CAPTURE_REQUIRED", "A confirmed buyer capture is required before this provider award can be disbursed.", 422);
    if (await openRecourse(c, db)) throw new DomainError("RECOURSE_OPEN", "Resolve the open recourse review before disbursing an award.", 422);
    const intents = await listIntents(c.tenantId, c.id, db), operations = await runtime.store.list(paymentScope(c));
    const captures = operations.filter(o => o.status === "succeeded" && intents.some(i => i.id === o.command.operationId && i.package_id === pkg.id && i.contract_version === pkg.contractVersion && ["capture_authorization", "capture_order"].includes(i.kind)));
    if (captures.length !== 1) throw new DomainError("CAPTURE_BINDING", "One exact confirmed capture must fund this provider award.", 422);
    const captureOperation = captures[0]!, capture = operationResource(captureOperation, "capture");
    if (capture?.status !== "COMPLETED" || capture.source !== "live_sandbox" || capture.money?.currency !== "USD" || capture.money.minor !== pkg.grossMinor) throw new DomainError("CAPTURE_BINDING", "The captured amount and currency must match this accepted contract.", 422);
    const approval = await approvalFor(db, c), receiver = payoutRecipient(pkg.providerId), id = randomUUID();
    const request: CreatePayout = { senderBatchId: `guild-${id}`, requestId: randomUUID(), items: [{ senderItemId: id, ...receiver.item, money: { currency: "USD", minor: pkg.providerAwardMinor } }] };
    const document: PayoutDocument = { operationId: id, request, binding: { actorId: session.id, approvalId: approval.row.id, approvalDigest: approval.row.plan_digest, approvalSignature: approval.row.signature, contractDigest: contractDigest(c, pkg.id), acceptanceId: acceptance!.id, artifactHash: acceptance!.artifactHash, receiverHash: receiver.hash, captureId: capture.id, captureOperationId: captureOperation.command.operationId, grossMinor: pkg.grossMinor, merchantFingerprint: merchantFingerprint() }, batch: null, item: null, cancellation: null };
    const result = await db.query<PayoutRow>("INSERT INTO guild_payout_operations(id,tenant_id,commission_id,package_id,contract_version,provider_id,acceptance_id,capture_operation_id,approval_id,amount_minor,currency,receiver_hash,request_hash,document) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'USD',$11,$12,$13) RETURNING *", [id, c.tenantId, c.id, pkg.id, pkg.contractVersion, pkg.providerId, acceptance!.id, captureOperation.command.operationId, approval.row.id, pkg.providerAwardMinor, receiver.hash, digest(request), sealDocument(document, { tenantId: c.tenantId, commissionId: c.id, operationId: id, purpose: "provider-payout" })]);
    await db.query("INSERT INTO guild_payment_recovery(tenant_id,commission_id) VALUES($1,$2) ON CONFLICT(tenant_id,commission_id) DO UPDATE SET next_check_at=now()", [c.tenantId, c.id]);
    appendEvent(c, "payout.award_reserved", "The provider award is reserved", "A durable payout instruction binds the accepted contract, confirmed capture and controlled recipient. An individual provider result is still required.", "Curator", pkg.id, paymentSource(id, null));
    c.revision++; await saveCommission(db, c); return result.rows[0]!;
  });
}

async function recordBatch(row: PayoutRow, result: CommerceRestResult<PayoutBatchObservation>): Promise<void> {
  await transaction(async db => {
    // Match admission and cancellation order before locking a child payout row.
    await db.query("SELECT id FROM guild_commissions WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [row.tenant_id, row.commission_id]);
    const current = (await db.query<PayoutRow>("SELECT * FROM guild_payout_operations WHERE id=$1 FOR UPDATE", [row.id])).rows[0]!, document = documentFor(current);
    if (current.state === "succeeded" && current.item_id) return;
    document.batch = result;
    const batch = result.outcome === "succeeded" ? result.value : null;
    const valid = !batch || batch.senderBatchId === document.request.senderBatchId && (!current.batch_id || batch.id === current.batch_id) && (!batch.money || batch.money.currency === "USD" && batch.money.minor === Number(current.amount_minor)) && batch.items.every(item => item.batchId === batch.id && matchesItem(document.request.items[0]!, item));
    const batchId = valid ? batch?.id ?? (result.outcome !== "succeeded" ? result.originalPayoutBatchId : null) ?? current.batch_id : current.batch_id;
    const state: State = !valid || result.outcome === "succeeded" || result.outcome === "unknown" ? "pending_reconciliation" : result.outcome;
    await db.query("UPDATE guild_payout_operations SET document=$2,state=$3,batch_id=$4,error_code=$5,provider_status=$6,lease_owner=NULL,lease_until=NULL,observed_at=$7,updated_at=now(),version=version+1 WHERE id=$1", [row.id, sealDocument(document, privateContext(current)), state, batchId, valid ? result.outcome === "succeeded" ? null : result.code : "PAYOUT_BATCH_BINDING", current.provider_status ?? (valid && batch ? "PROCESSING" : null), result.observedAt]);
    await db.query("INSERT INTO guild_payout_attempts(id,payout_id,operation,outcome,safe_code) VALUES($1,$2,'create_or_read_batch',$3,$4)", [randomUUID(), row.id, state, result.outcome === "succeeded" ? null : result.code]);
  });
}

async function recordItem(row: PayoutRow, result: CommerceRestResult<PayoutItemObservation>, cancellation = false): Promise<void> {
  await transaction(async db => {
    await db.query("SELECT id FROM guild_commissions WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [row.tenant_id, row.commission_id]);
    const current = (await db.query<PayoutRow>("SELECT * FROM guild_payout_operations WHERE id=$1 FOR UPDATE", [row.id])).rows[0]!, document = documentFor(current);
    if (cancellation) document.cancellation = result; else document.item = result;
    const item = result.outcome === "succeeded" ? result.value : null;
    const valid = item && item.batchId === current.batch_id && (!current.item_id || item.id === current.item_id) && matchesItem(document.request.items[0]!, item);
    const terminal = valid && ["SUCCESS", "RETURNED", "REFUNDED"].includes(item.status);
    const rejected = valid && ["FAILED", "DENIED", "BLOCKED"].includes(item.status);
    // An older pending read cannot undo a newer completed observation.
    if (current.observed_at && current.observed_at.getTime() > Date.parse(result.observedAt)) return;
    if (current.state === "succeeded" && ["SUCCESS", "RETURNED", "REFUNDED"].includes(current.provider_status ?? "") && !terminal) return;
    const state: State = terminal ? "succeeded" : rejected ? "refused" : "pending_reconciliation";
    const cancelState = valid && item.status === "RETURNED" && (cancellation || current.cancel_state) ? "succeeded" : cancellation ? result.outcome === "not_sent" || result.outcome === "refused" ? result.outcome : "pending_reconciliation" : current.cancel_state;
    await db.query("UPDATE guild_payout_operations SET document=$2,state=$3,provider_status=$4,item_id=$5,fee_minor=$6,error_code=$7,cancel_state=$8,observed_at=$9,lease_owner=NULL,lease_until=NULL,updated_at=now(),version=version+1 WHERE id=$1", [row.id, sealDocument(document, privateContext(current)), valid ? state : current.state === "succeeded" ? current.state : "pending_reconciliation", valid ? item.status : current.provider_status, valid ? item.id : current.item_id, valid ? item.fee?.minor ?? null : current.fee_minor, valid ? null : result.outcome === "succeeded" ? "PAYOUT_ITEM_BINDING" : result.code, cancelState, result.observedAt]);
    if (cancelState && ["succeeded", "refused", "not_sent"].includes(cancelState)) await db.query("UPDATE guild_payout_operations SET cancel_lease_until=NULL WHERE id=$1", [row.id]);
    await db.query("INSERT INTO guild_payout_attempts(id,payout_id,operation,outcome,safe_code) VALUES($1,$2,$3,$4,$5)", [randomUUID(), row.id, cancellation ? "cancel_unclaimed" : "read_item", state, result.outcome === "succeeded" ? null : result.code]);
  });
}

export async function reconcileProviderPayout(row: PayoutRow, runtime: PaymentRuntime): Promise<void> {
  row = await ownedPayout(row.tenant_id, row.commission_id, row.id);
  if (!row.batch_id) return; // No lookup by a guessed recipient, amount, or sender reference.
  const document = documentFor(row);
  if (document.binding.merchantFingerprint !== merchantFingerprint()) throw new DomainError("MERCHANT_CHANGED", "The payout's isolated merchant binding changed. Preserve the original record for review.", 403, false);
  const batch = await gateway(runtime).getPayoutBatch(row.batch_id, document.request.senderBatchId);
  await recordBatch(row, batch);
  if (batch.outcome !== "succeeded" || !batch.value.complete || batch.value.items.length !== 1 || batch.value.senderBatchId !== document.request.senderBatchId) return;
  const item = batch.value.items[0]!;
  if (item.batchId !== row.batch_id || !matchesItem(document.request.items[0]!, item)) return;
  // Batch SUCCESS alone is not provider payment. Read the exact individual item.
  const detail = await gateway(runtime).getPayoutItem(item.id);
  await recordItem(await ownedPayout(row.tenant_id, row.commission_id, row.id), detail);
}

export async function dispatchProviderPayout(row: PayoutRow, runtime: PaymentRuntime): Promise<void> {
  const leaseOwner = randomUUID();
  const claimed = await getPool().query<PayoutRow>("UPDATE guild_payout_operations SET lease_owner=$2,lease_until=now()+interval '2 minutes',version=version+1 WHERE id=$1 AND state='claimed' AND (lease_until IS NULL OR lease_until<now()) RETURNING *", [row.id, leaseOwner]);
  if (!claimed.rows[0]) return;
  row = claimed.rows[0];
  let dispatched = false;
  try {
    const document = documentFor(row);
    const captures = await runtime.provider.read("capture", document.binding.captureId);
    const capture = captures.length === 1 ? captures[0] : null;
    if (capture?.id !== document.binding.captureId || capture.source !== "live_sandbox" || capture.status !== "COMPLETED" || capture.money?.currency !== "USD" || capture.money.minor !== document.binding.grossMinor) throw new DomainError("PAYOUT_CAPTURE_UNVERIFIED", "The current capture is refunded, incomplete or no longer matches the accepted work. Review it before disbursing the award.", 422);
    await transaction(async db => {
      const c = (await db.query<{ snapshot: Commission }>("SELECT snapshot FROM guild_commissions WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [row.tenant_id, row.commission_id])).rows[0]?.snapshot;
      const current = (await db.query<PayoutRow>("SELECT * FROM guild_payout_operations WHERE id=$1 FOR UPDATE", [row.id])).rows[0]!;
      if (!c || current.state !== "claimed" || current.lease_owner !== leaseOwner || !current.lease_until || current.lease_until.getTime() <= Date.now()) throw new DomainError("PAYOUT_CLAIM_CHANGED", "Another worker owns this payout instruction. Inspect its current state.", 409);
      const latestDocument = documentFor(current);
      if (digest(latestDocument.request) !== digest(document.request) || digest(latestDocument.binding) !== digest(document.binding)) throw new DomainError("PAYOUT_DOCUMENT_BINDING", "The private payout changed during preflight. No award was sent.", 503, false);
      await assertPayoutAuthority(db, c, current, document);
      await db.query("UPDATE guild_payout_operations SET state='dispatching',attempts=attempts+1,lease_until=now()+interval '2 minutes',error_code=NULL,updated_at=now(),version=version+1 WHERE id=$1", [row.id]);
    });
    dispatched = true;
    const result = await gateway(runtime).createPayout(document.request);
    await recordBatch(row, result);
    await reconcileProviderPayout(await ownedPayout(row.tenant_id, row.commission_id, row.id), runtime);
  } catch (error) {
    const safeCode = error instanceof DomainError ? error.code : dispatched ? "PAYOUT_RESULT_UNCERTAIN" : "PAYOUT_PREFLIGHT_UNAVAILABLE";
    await getPool().query("UPDATE guild_payout_operations SET state=$2,error_code=$3,lease_owner=NULL,lease_until=NULL,updated_at=now(),version=version+1 WHERE id=$1 AND state IN ('claimed','dispatching')", [row.id, dispatched ? "pending_reconciliation" : "not_sent", safeCode]);
    if (!dispatched && error instanceof DomainError) throw error;
  } finally { await projectProviderPayouts(row.tenant_id, row.commission_id); }
}

export async function projectProviderPayouts(tenantId: string, commissionId: string): Promise<Commission> {
  return transaction(async db => {
    const c = (await db.query<{ snapshot: Commission }>("SELECT snapshot FROM guild_commissions WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [tenantId, commissionId])).rows[0]!.snapshot;
    const payments = normalizePayments(c), before = digest(payments.payouts);
    const rows = (await db.query<PayoutRow>("SELECT * FROM guild_payout_operations WHERE tenant_id=$1 AND commission_id=$2 ORDER BY created_at,id", [tenantId, commissionId])).rows;
    payments.payouts = rows.map(row => ({ id: row.id, packageId: row.package_id, contractVersion: row.contract_version, providerId: row.provider_id, amountMinor: Number(row.amount_minor), status: row.provider_status ?? row.state.toUpperCase(), resourceLabel: row.item_id ? resourceLabel(row.item_id) : row.batch_id ? resourceLabel(row.batch_id) : null, observedAt: row.observed_at?.toISOString() ?? null, transport: "REST adapter", provenance: paymentSource(row.id, row.observed_at?.toISOString() ?? null), operationState: row.state, feeMinor: row.fee_minor === null ? null : Number(row.fee_minor), errorCode: row.error_code, canCancel: row.provider_status === "UNCLAIMED" && row.cancel_state !== "succeeded" && (!row.cancel_lease_until || row.cancel_lease_until.getTime() <= Date.now()), canRetry: !row.batch_id && ["refused", "not_sent", "pending_reconciliation"].includes(row.state) && Date.now() - row.created_at.getTime() < 30 * 86400000 && !["PRIVATE_DOCUMENT_UNREADABLE", "PAYOUT_DOCUMENT_BINDING"].includes(row.error_code ?? ""), cancellationState: row.cancel_state }));
    payments.providerPaidMinor = payments.payouts.filter(payout => payout.operationState === "succeeded" && payout.status === "SUCCESS").reduce((sum, payout) => sum + payout.amountMinor, 0);
    payments.providerPayableMinor = Math.max(0, c.packages.filter(pkg => pkg.paymentState === "paid").reduce((sum, pkg) => sum + pkg.providerAwardMinor, 0) - payments.providerPaidMinor);
    if (before !== digest(payments.payouts)) {
      for (const payout of payments.payouts) {
        const key = `payout.${payout.id}.${payout.status}`;
        if (!c.events.some(event => event.type === key)) appendEvent(c, key, payout.status === "SUCCESS" ? "The provider received its award" : payout.status === "RETURNED" ? "An unclaimed award was returned" : "Provider payout status recorded", payout.status === "SUCCESS" ? "PayPal confirmed the exact individual payout item, recipient and award amount." : "Batch acknowledgement and pending items do not count as provider payment.", "Payout gateway", payout.packageId, payout.provenance);
      }
      c.revision++; await saveCommission(db, c);
    }
    return c;
  });
}

export async function payProvider(session: Session, commissionId: string, packageId: string, expectedRevision: number, runtime: PaymentRuntime): Promise<void> {
  const row = await admitProviderPayout(session, commissionId, packageId, expectedRevision, runtime);
  await dispatchProviderPayout(row, runtime);
}

export async function retryProviderPayout(session: Session, commissionId: string, payoutId: string, runtime: PaymentRuntime): Promise<void> {
  requireFinancialActor(session); await getCommission(session, commissionId);
  let row = await ownedPayout(session.tenantId, commissionId, payoutId);
  if (row.batch_id) { await reconcileProviderPayout(row, runtime); await projectProviderPayouts(session.tenantId, commissionId); return; }
  if (!["refused", "not_sent", "pending_reconciliation"].includes(row.state)) throw new DomainError("PAYOUT_ALREADY_ACTIVE", "Inspect this payout's existing instruction before requesting recovery.", 422);
  if (Date.now() - row.created_at.getTime() >= 30 * 86400000) throw new DomainError("PAYOUT_DUPLICATE_WINDOW", "The provider's duplicate-retention window expired. Preserve this obligation for manual reconciliation; do not create another identity.", 422, false);
  documentFor(row); // Authenticate the identical private request before explicit recovery.
  const changed = await getPool().query<PayoutRow>("UPDATE guild_payout_operations SET state='claimed',lease_until=NULL,lease_owner=NULL,error_code=NULL,version=version+1 WHERE id=$1 AND version=$2 RETURNING *", [row.id, row.version]);
  if (!changed.rows[0]) return;
  row = changed.rows[0]; await dispatchProviderPayout(row, runtime);
}

export async function cancelProviderPayout(session: Session, commissionId: string, payoutId: string, runtime: PaymentRuntime): Promise<void> {
  requireFinancialActor(session); let row = await ownedPayout(session.tenantId, commissionId, payoutId);
  await reconcileProviderPayout(row, runtime); row = await ownedPayout(session.tenantId, commissionId, payoutId);
  if (row.provider_status === "RETURNED") { await projectProviderPayouts(session.tenantId, commissionId); return; }
  if (!row.item_id || !row.batch_id || row.provider_status !== "UNCLAIMED") throw new DomainError("PAYOUT_NOT_UNCLAIMED", "Only this commission's currently unclaimed payout item can be cancelled.", 422);
  const document = documentFor(row);
  const mayDispatch = await transaction(async db => {
    const c = (await db.query<{ snapshot: Commission }>("SELECT snapshot FROM guild_commissions WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [session.tenantId, commissionId])).rows[0]!.snapshot;
    const current = (await db.query<PayoutRow>("SELECT * FROM guild_payout_operations WHERE id=$1 FOR UPDATE", [row.id])).rows[0]!;
    if (current.cancel_state === "succeeded" || current.cancel_lease_until && current.cancel_lease_until.getTime() > Date.now()) return false;
    if (current.provider_status !== "UNCLAIMED" || current.item_id !== row.item_id || current.batch_id !== row.batch_id) throw new DomainError("PAYOUT_NOT_UNCLAIMED", "This payout's latest item is no longer unclaimed. Inspect its current record.", 422);
    await assertPayoutAuthority(db, c, current, document);
    await db.query("UPDATE guild_payout_operations SET cancel_state='dispatching',cancel_lease_until=now()+interval '2 minutes',updated_at=now(),version=version+1 WHERE id=$1", [row.id]);
    await db.query("INSERT INTO guild_payout_attempts(id,payout_id,operation,outcome) VALUES($1,$2,'cancel_admitted','dispatching')", [randomUUID(), row.id]); return true;
  });
  if (!mayDispatch) return;
  try {
    const result = await gateway(runtime).cancelUnclaimedPayout({ ...document.request.items[0]!, id: row.item_id, batchId: row.batch_id });
    await recordItem(row, result, true);
  } catch { await getPool().query("UPDATE guild_payout_operations SET cancel_state='pending_reconciliation',error_code='PAYOUT_CANCELLATION_UNCERTAIN',updated_at=now(),version=version+1 WHERE id=$1", [row.id]); }
  await projectProviderPayouts(session.tenantId, commissionId);
}

export async function recoverProviderPayouts(tenantId: string, commissionId: string, runtime: PaymentRuntime, resumeClaims = false): Promise<void> {
  const rows = (await getPool().query<PayoutRow>("SELECT * FROM guild_payout_operations WHERE tenant_id=$1 AND commission_id=$2 ORDER BY created_at", [tenantId, commissionId])).rows;
  for (const row of rows) {
    if (row.cancel_state === "dispatching" && row.cancel_lease_until && row.cancel_lease_until.getTime() <= Date.now()) await getPool().query("UPDATE guild_payout_operations SET cancel_state='pending_reconciliation',error_code='PAYOUT_CANCELLATION_INTERRUPTED',version=version+1 WHERE id=$1 AND cancel_state='dispatching' AND cancel_lease_until<now()", [row.id]);
    if (resumeClaims && row.state === "claimed" && (!row.lease_until || row.lease_until.getTime() <= Date.now())) await dispatchProviderPayout(row, runtime);
    else if (row.state === "dispatching" && row.lease_until && row.lease_until.getTime() <= Date.now()) await getPool().query("UPDATE guild_payout_operations SET state='pending_reconciliation',lease_until=NULL,lease_owner=NULL,error_code='PAYOUT_WORKER_INTERRUPTED',version=version+1 WHERE id=$1 AND state='dispatching'", [row.id]);
    if (row.batch_id && (row.state !== "succeeded" || row.cancel_state === "pending_reconciliation" || row.cancel_state === "dispatching")) await reconcileProviderPayout(row, runtime);
  }
  if (rows.length) await projectProviderPayouts(tenantId, commissionId);
}
