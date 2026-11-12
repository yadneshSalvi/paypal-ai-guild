import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { Commission, WorkPackage } from "@/contracts/guild";
import { delegationBindingSchema, type DelegationBinding, type OfferTerms } from "@/contracts/provider-market";
import { marketContractDigest, marketMandate, marketSourceDigest, providerOfferDecision } from "@/domain/provider-market";
import { planDigest } from "@/domain/fixture";
import { digest, DomainError } from "@/domain/primitives";
import { appendEvent, saveCommission } from "../commissions";
import type { Session } from "../session";
import { currentProviderPolicy, providerCapacity, providerRow, requireMarketSession } from "./registry";

export interface MarketTaskRow {
  id: string; tenant_id: string; commission_id: string; provider_id: string; thread_id: string; actor_id: string;
  package_id: string; context_id: string; revision: number; state: "submitted" | "working" | "input_required" | "auth_required" | "completed" | "failed" | "cancelled" | "rejected";
  binding: DelegationBinding; binding_digest: string; original_job_id: string | null; created_at: Date; updated_at: Date;
}
export interface SelectedThread {
  id: string; tenant_id: string; commission_id: string; provider_id: string; package_id: string; revision: number; state: string;
  selected_terms: OfferTerms | null; selected_terms_digest: string | null; prepared_contract: WorkPackage | null;
  original_work_ceiling: Date;
}

export async function prepareMarketDelegation(db: PoolClient, session: Session, c: Commission, pkg: WorkPackage, thread: SelectedThread): Promise<DelegationBinding> {
  if (thread.state !== "selected" || !thread.selected_terms || !thread.selected_terms_digest || !thread.prepared_contract) throw new DomainError("MARKET_SELECT_REQUIRED", "Select the exact provider offer before delegating work.", 422, false);
  if (!c.approvedPlanDigest || c.approvedPlanDigest !== planDigest(c)) throw new DomainError("APPROVAL_REQUIRED", "Approve the current Passport before delegating this work.", 422, false);
  if (marketContractDigest(pkg) !== marketContractDigest(thread.prepared_contract) || marketSourceDigest(c, pkg) !== thread.selected_terms.sourceDigest) throw new DomainError("MARKET_DELEGATION_CHANGED", "The selected contract or its exact sources changed after selection.", 409, false);
  if (Date.parse(thread.selected_terms.expiresAt) <= Date.now() || thread.original_work_ceiling.getTime() <= Date.now()) throw new DomainError("MARKET_OFFER_EXPIRED", "The selected offer has expired. Its original authority is not extended by approval.", 422, false);
  const page = marketMandate(c, pkg), parent = page.parentId ? c.mandates.find(item => item.id === page.parentId) : null;
  const taskId = randomUUID(), id = randomUUID();
  const binding = delegationBindingSchema.parse({ id, commissionId: c.id, packageId: pkg.id, providerId: thread.provider_id, threadId: thread.id,
    offerRevision: thread.revision, offerDigest: thread.selected_terms_digest, contractVersion: pkg.contractVersion, contractDigest: marketContractDigest(pkg),
    acceptancePackDigest: pkg.acceptancePack.digest, sourceDigest: marketSourceDigest(c, pkg), approvedPlanDigest: c.approvedPlanDigest,
    mandateId: page.id, mandateRevision: page.revision, mandateDigest: page.digest,
    parentMandateId: parent?.id ?? null, parentMandateRevision: parent?.revision ?? null, parentMandateDigest: parent?.digest ?? null,
    providerPolicyRevision: thread.selected_terms.providerPolicyRevision, providerPolicyDigest: thread.selected_terms.providerPolicyDigest,
    providerAwardMinor: pkg.providerAwardMinor, serviceFeeMinor: pkg.serviceFeeMinor, grossMinor: pkg.grossMinor,
    originalWorkCeiling: thread.original_work_ceiling.toISOString(), taskId, createdAt: new Date().toISOString() });
  const other = await db.query("SELECT id FROM guild_market_tasks WHERE tenant_id=$1 AND commission_id=$2 AND package_id=$3 AND state NOT IN ('cancelled','rejected') LIMIT 1", [c.tenantId, c.id, pkg.id]);
  if (other.rowCount) throw new DomainError("MARKET_ORIGINAL_TASK_REQUIRED", "This contract already has a retained task. Open that original task before considering new work.", 409, false);
  await db.query("INSERT INTO guild_market_tasks(id,tenant_id,commission_id,provider_id,thread_id,actor_id,package_id,context_id,state,binding,binding_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'submitted',$9,$10)",
    [taskId, c.tenantId, c.id, thread.provider_id, thread.id, session.id, pkg.id, randomUUID(), binding, digest(binding)]);
  return binding;
}

/** Called inside the existing production transaction, including direct Studio calls. */
export async function requireMarketProductionBinding(db: PoolClient, session: Session, c: Commission, pkg: WorkPackage, taskId?: string): Promise<void> {
  const selected = (await db.query<SelectedThread>("SELECT * FROM guild_market_threads WHERE tenant_id=$1 AND commission_id=$2 AND package_id=$3 AND state='selected' AND (prepared_contract->>'contractVersion')::int=$4 ORDER BY selected_at DESC LIMIT 1", [c.tenantId, c.id, pkg.id, pkg.contractVersion])).rows[0];
  if (!selected && !taskId) return;
  if (!selected || !taskId) throw new DomainError("MARKET_DELEGATION_REQUIRED", "Start this selected provider's work from the marketplace so its exact offer and task remain bound.", 422, false);
  const task = (await db.query<MarketTaskRow>("SELECT * FROM guild_market_tasks WHERE id=$1 AND tenant_id=$2 AND commission_id=$3 FOR UPDATE", [taskId, c.tenantId, c.id])).rows[0];
  if (!task || task.actor_id !== session.id || task.thread_id !== selected.id || task.state !== "submitted" || task.original_job_id) throw new DomainError("MARKET_TASK_CHANGED", "This delegation is not the current unstarted task for the selected offer.", 409, false);
  const b = delegationBindingSchema.parse(task.binding), page = marketMandate(c, pkg), parent = page.parentId ? c.mandates.find(item => item.id === page.parentId) : null;
  if (digest(b) !== task.binding_digest || b.taskId !== task.id || b.threadId !== selected.id || b.providerId !== pkg.providerId || b.offerDigest !== selected.selected_terms_digest
      || b.offerRevision !== selected.revision || b.contractVersion !== pkg.contractVersion || b.contractDigest !== marketContractDigest(pkg)
      || b.acceptancePackDigest !== pkg.acceptancePack.digest || b.sourceDigest !== marketSourceDigest(c, pkg)
      || b.approvedPlanDigest !== c.approvedPlanDigest || c.approvedPlanDigest !== planDigest(c)
      || b.mandateId !== page.id || b.mandateRevision !== page.revision || b.mandateDigest !== page.digest
      || b.parentMandateId !== (parent?.id ?? null) || b.parentMandateRevision !== (parent?.revision ?? null) || b.parentMandateDigest !== (parent?.digest ?? null)
      || b.providerAwardMinor !== pkg.providerAwardMinor || b.serviceFeeMinor !== pkg.serviceFeeMinor || b.grossMinor !== pkg.grossMinor
      || b.originalWorkCeiling !== selected.original_work_ceiling.toISOString() || Date.parse(b.originalWorkCeiling) <= Date.now()) {
    throw new DomainError("MARKET_DELEGATION_CHANGED", "The exact offer, work, policy or Passport binding changed. No production was dispatched.", 422, false);
  }
  const provider = await providerRow(db, task.provider_id, true), policy = await currentProviderPolicy(db, provider), capacity = await providerCapacity(db, task.provider_id);
  if (provider.revoked_at || provider.enrollment_state !== "ready" || !policy || !selected.selected_terms) throw new DomainError("PROVIDER_UNAVAILABLE", "The selected provider is unavailable or its owner policy is missing.", 422, false);
  const decision = providerOfferDecision(policy, selected.selected_terms, capacity.active + capacity.reserved - 1);
  if (!decision.allowed) throw new DomainError(decision.code, decision.reason, 422, false);
}

export async function cancelMarketTask(db: PoolClient, session: Session, task: MarketTaskRow, c: Commission, note: string): Promise<void> {
  if (task.state === "cancelled") return;
  if (["completed", "failed", "rejected"].includes(task.state)) throw new DomainError("TASK_NOT_CANCELABLE", "This task already has a final result. Its record is preserved.", 409, false);
  if (task.original_job_id) {
    const job = (await db.query<{ state: string; attempts: number }>("SELECT state,attempts FROM guild_jobs WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [task.original_job_id, task.tenant_id])).rows[0];
    if (!job || job.state !== "queued" || job.attempts !== 0) throw new DomainError("TASK_NOT_CANCELABLE", "The original worker has already started. Recover its original result; cancellation cannot undo an external request.", 409, false);
    await db.query("UPDATE guild_jobs SET state='failed',error='Cancelled by owner before any worker dispatch',updated_at=now() WHERE id=$1", [task.original_job_id]);
    const snapshotJob = c.jobs.find(item => item.id === task.original_job_id);
    if (snapshotJob) Object.assign(snapshotJob, { state: "failed", step: "Cancelled before production", error: "The owner cancelled this task before dispatch.", updatedAt: new Date().toISOString() });
    const reservation = (await db.query<{ id: string; mandate_id: string; amount_minor: string }>("SELECT id,mandate_id,amount_minor FROM guild_budget_reservations WHERE tenant_id=$1 AND operation_key=$2 AND state='reserved' FOR UPDATE", [c.tenantId, `production:${c.id}:${task.package_id}:${task.binding.contractVersion}`])).rows[0];
    if (reservation) {
      let page = c.mandates.find(item => item.id === reservation.mandate_id); const seen = new Set<string>();
      while (page) { if (seen.has(page.id)) throw new DomainError("PASSPORT.CYCLE", "The saved reservation chain is invalid.", 422, false); seen.add(page.id);
        if (page.reservedMinor < Number(reservation.amount_minor)) throw new DomainError("RESERVATION_CHANGED", "The retained reservation no longer matches its Passport.", 422, false);
        page.reservedMinor -= Number(reservation.amount_minor); page = page.parentId ? c.mandates.find(item => item.id === page!.parentId) : undefined; }
      await db.query("UPDATE guild_budget_reservations SET state='released' WHERE id=$1", [reservation.id]);
    }
    const pkg = c.packages.find(item => item.id === task.package_id);
    if (pkg?.state === "producing") pkg.state = "awarded";
  }
  await db.query("UPDATE guild_market_tasks SET state='cancelled',revision=revision+1,cancellation_note=$2,updated_at=now() WHERE id=$1", [task.id, note]);
  appendEvent(c, "provider.task_cancelled", "Unstarted provider task cancelled", note, session.role === "provider" ? "Provider owner" : "Curator", task.package_id);
  c.revision++; await saveCommission(db, c);
}

/** Each future provider create rechecks the original bilateral authority.
 * Known-result reads remain in the existing worker's separate recovery path. */
export async function requireMarketProductionLease(db: PoolClient, c: Commission, pkg: WorkPackage, jobId: string, input: { marketTaskId?: string; marketBindingDigest?: string }): Promise<void> {
  if (!pkg.marketOffer && !input.marketTaskId && !input.marketBindingDigest) return;
  const task = (await db.query<MarketTaskRow>("SELECT * FROM guild_market_tasks WHERE original_job_id=$1 AND tenant_id=$2 AND commission_id=$3 FOR UPDATE", [jobId, c.tenantId, c.id])).rows[0];
  if (!task || task.id !== input.marketTaskId || task.package_id !== pkg.id || task.provider_id !== pkg.providerId || task.state !== "working"
    || task.binding_digest !== input.marketBindingDigest || digest(task.binding) !== task.binding_digest) throw new DomainError("MARKET_WORKER_BINDING", "This worker no longer has its exact original delegated task.", 422, false);
  const b = task.binding, page = marketMandate(c, pkg), parent = page.parentId ? c.mandates.find(item => item.id === page.parentId) : null;
  const thread = (await db.query<SelectedThread>("SELECT * FROM guild_market_threads WHERE id=$1 AND tenant_id=$2 AND commission_id=$3 AND provider_id=$4", [task.thread_id, c.tenantId, c.id, task.provider_id])).rows[0];
  if (!thread || thread.state !== "selected" || !thread.selected_terms || b.threadId !== thread.id || b.offerRevision !== thread.revision
    || b.offerDigest !== thread.selected_terms_digest || b.contractDigest !== marketContractDigest(pkg) || b.sourceDigest !== marketSourceDigest(c, pkg)
    || b.contractVersion !== pkg.contractVersion || b.acceptancePackDigest !== pkg.acceptancePack.digest || b.approvedPlanDigest !== c.approvedPlanDigest
    || b.mandateId !== page.id || b.mandateRevision !== page.revision || b.mandateDigest !== page.digest
    || b.parentMandateId !== (parent?.id ?? null) || b.parentMandateRevision !== (parent?.revision ?? null) || b.parentMandateDigest !== (parent?.digest ?? null)
    || b.originalWorkCeiling !== thread.original_work_ceiling.toISOString() || Date.parse(b.originalWorkCeiling) <= Date.now()
    || b.providerAwardMinor !== pkg.providerAwardMinor || b.serviceFeeMinor !== pkg.serviceFeeMinor || b.grossMinor !== pkg.grossMinor) {
    throw new DomainError("MARKET_WORK_AUTHORITY_CHANGED", "The original offer, sources, approved contract or work expiry changed. No new provider request was sent.", 422, false);
  }
  const actor = (await db.query<{ id: string; tenant_id: string; role: Session["role"]; expires_at: Date }>("SELECT id,tenant_id,role,expires_at FROM guild_sessions WHERE id=$1 AND tenant_id=$2", [task.actor_id, c.tenantId])).rows[0];
  if (!actor) throw new DomainError("MARKET_ORIGINAL_OWNER_REQUIRED", "The original delegating owner is unavailable.", 422, false);
  await requireMarketSession(db, { id: actor.id, tenantId: actor.tenant_id, role: actor.role, expiresAt: actor.expires_at.toISOString() });
  const provider = await providerRow(db, task.provider_id, true), policy = await currentProviderPolicy(db, provider), capacity = await providerCapacity(db, task.provider_id);
  if (!policy || provider.revoked_at || provider.enrollment_state !== "ready") throw new DomainError("PROVIDER_UNAVAILABLE", "The provider owner withdrew this service or its current policy.", 422, false);
  // The quote's response window closes after selection. Already delegated work
  // retains its original work ceiling; this does not extend either saved term.
  const decision = providerOfferDecision(policy, { ...thread.selected_terms, expiresAt: b.originalWorkCeiling }, Math.max(0, capacity.active + capacity.reserved - 1));
  if (!decision.allowed) throw new DomainError(decision.code, decision.reason, 422, false);
}
