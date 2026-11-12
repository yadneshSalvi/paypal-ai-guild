import type { Commission, WorkPackage } from "@/contracts/guild";
import { A2A_PROTOCOL, MARKET_VERSION, MCP_TOOL_NAMES, type MarketOperation, type MarketPackage, type OfferMessage, type OfferTerms, type OfferThread, type ProviderMarketSnapshot, type ProviderTaskView } from "@/contracts/provider-market";
import { planDigest } from "@/domain/fixture";
import { marketContractDigest, marketMandate, marketSourceDigest, marketWorkCeiling } from "@/domain/provider-market";
import { digest, DomainError } from "@/domain/primitives";
import type { Session } from "../session";
import { boundProvider, listMarketProviders, requireMarketSession, type MarketDb } from "./registry";
import type { MarketTaskRow, SelectedThread } from "./delegation";
import { boundTaskArtifact } from "./task-artifacts";

export interface MarketThreadRow extends SelectedThread {
  latest_terms: OfferTerms | null; latest_terms_digest: string | null; original_contract: WorkPackage; selected_at: Date | null;
}
export interface MarketOperationRow {
  id: string; actor_id: string; tenant_id: string; command_id: string; provider_id: string; commission_id: string | null; thread_id: string | null;
  kind: string; state: MarketOperation["state"]; request_body: unknown; request_digest: string; original_message_id: string; original_task_id: string | null;
  response_body: unknown; failure_code: string | null; dispatch_count: number; lease_until: Date | null; original_work_ceiling: Date; created_at: Date;
  provider_endpoint: string | null; provider_card: unknown; provider_card_digest: string | null;
}
export async function marketCommission(db: MarketDb, tenantId: string, id: string, lock = false): Promise<Commission> {
  const row = (await db.query<{ snapshot: Commission }>(`SELECT snapshot FROM guild_commissions WHERE id=$1 AND tenant_id=$2${lock ? " FOR UPDATE" : ""}`, [id, tenantId])).rows[0];
  if (!row) throw new DomainError("COMMISSION_NOT_FOUND", "This commission is not available in your workspace.", 404, false);
  return row.snapshot;
}

export async function taskView(db: MarketDb, task: MarketTaskRow, c: Commission, canWrite: boolean): Promise<ProviderTaskView> {
  const { job, artifact, withheld, contract } = await boundTaskArtifact(db, task, c);
  const pkg = c.packages.find(item => item.id === task.package_id);
  const verification = artifact ? (await db.query<{ criteria_digest: string; result: WorkPackage["acceptancePack"] }>("SELECT criteria_digest,result FROM guild_verifications WHERE tenant_id=$1 AND commission_id=$2 AND package_id=$3 AND contract_version=$4 AND artifact_id=$5 AND artifact_hash=$6 AND result->>'digest'=$7 ORDER BY created_at DESC LIMIT 1", [task.tenant_id, c.id, task.package_id, task.binding.contractVersion, artifact.id, artifact.contentHash, task.binding.acceptancePackDigest])).rows[0] : null;
  const definition = (pack: WorkPackage["acceptancePack"]) => ({ ...pack, criteria: pack.criteria.map(({ status: _status, evidence: _evidence, ...criterion }) => criterion) });
  // criteria_digest seals the measured result; result.digest identifies the
  // unchanged agreed pack. Both the measurement hash and definition must bind.
  const report = verification && contract && Array.isArray(verification.result?.criteria)
    && verification.criteria_digest === digest(verification.result) && verification.result.digest === task.binding.acceptancePackDigest
    && digest(definition(verification.result)) === digest(definition(contract.acceptancePack))
    && verification.result.criteria.every(item => ["pending", "passed", "failed", "review"].includes(item.status) && (item.evidence === null || typeof item.evidence === "string")) ? verification.result : null;
  const accepted = artifact ? (await db.query<{ decision: string }>("SELECT decision FROM guild_acceptance_decisions WHERE tenant_id=$1 AND commission_id=$2 AND package_id=$3 AND contract_version=$4 AND artifact_id=$5 AND artifact_hash=$6 AND criteria_digest=$7", [task.tenant_id, c.id, task.package_id, task.binding.contractVersion, artifact.id, artifact.contentHash, task.binding.acceptancePackDigest])).rows[0] : null;
  let state = task.state;
  if (!["cancelled", "rejected"].includes(state) && job) state = job.state === "completed" ? "completed" : job.state === "failed" ? "failed" : job.state === "needs_review" ? "input_required" : job.state === "running" ? "working" : "submitted";
  if (withheld && !["cancelled", "rejected"].includes(state)) state = "input_required";
  const criteria = report?.criteria ?? [];
  const checksState = !report ? "pending" : criteria.some(item => item.blocking && item.kind === "deterministic" && item.status === "failed") ? "failed" : criteria.some(item => item.blocking && item.kind === "deterministic" && item.status !== "passed") ? "review" : "passed";
  const acceptance: ProviderTaskView["acceptance"]["state"] = accepted?.decision === "accepted" ? "accepted" : pkg?.state === "correction_requested" ? "correction_requested" : accepted?.decision === "rejected" ? "rejected" : artifact ? "awaiting_review" : "not_submitted";
  return { id: task.id, contextId: task.context_id, revision: task.revision, state, providerId: task.provider_id, commissionId: c.id,
    customerLabel: c.museum, packageId: task.package_id, packageTitle: contract?.title ?? task.package_id, binding: task.binding, originalJobId: task.original_job_id,
    statusMessage: withheld ? "The original worker result does not bind this task's retained artifact. It is withheld for integrity review." : state === "completed" ? "The original artifact is retained. Its checks, customer acceptance and payment remain separate." : state === "cancelled" ? "Cancelled before any provider worker dispatch." : job?.error ?? (job ? "The original durable worker retains this task's current progress." : "The delegation is saved and awaits a confirmed service response."),
    updatedAt: (job?.updated_at ?? task.updated_at).toISOString(), artifacts: artifact ? [{ id: artifact.id, title: artifact.title, contentHash: artifact.contentHash,
      mediaType: artifact.mediaType, downloadUrl: `/api/provider-market/tasks/${task.id}/artifacts/${artifact.id}`, submittedAt: artifact.createdAt,
      verification: { state: checksState, checks: criteria.map(item => ({ label: item.label, status: item.status, evidence: item.evidence })) } }] : [],
    acceptance: { state: acceptance, message: acceptance === "accepted" ? "An exact artifact acceptance decision is retained." : "Provider completion does not approve the artifact for the customer." },
    payment: { awardMinor: task.binding.providerAwardMinor, customerGrossMinor: task.binding.grossMinor,
      captureState: pkg?.contractVersion === task.binding.contractVersion ? pkg.paymentState : "historical_record", payoutState: c.payments.payouts.find(item => item.packageId === task.package_id && item.contractVersion === task.binding.contractVersion && item.providerId === task.provider_id)?.status ?? "not_started",
      disclosure: "Selecting an offer or completing a task moves no money. Buyer capture and provider payout need their own confirmed records." },
    canCancel: canWrite && !withheld && ["submitted", "working", "input_required", "auth_required"].includes(state) && (!job || job.state === "queued" && job.attempts === 0),
    canReadOriginal: !!task.original_job_id, syntheticFixture: c.mode === "sample" };
}

export async function marketSnapshot(db: MarketDb, session: Session, commissionId?: string): Promise<ProviderMarketSnapshot> {
  await requireMarketSession(db, session);
  const ownProvider = await boundProvider(db, session, session.role === "provider"), providerScope = session.role === "provider";
  const canBuy = ["owner", "judge"].includes(session.role);
  let c: Commission | null = null;
  if (!providerScope) {
    if (commissionId) c = await marketCommission(db, session.tenantId, commissionId);
    else c = (await db.query<{ snapshot: Commission }>("SELECT snapshot FROM guild_commissions WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 1", [session.tenantId])).rows[0]?.snapshot ?? null;
  }
  const providers = await listMarketProviders(db, ownProvider), threads: OfferThread[] = [], tasks: ProviderTaskView[] = [];
  const threadRows = providerScope
    ? (await db.query<MarketThreadRow>("SELECT * FROM guild_market_threads WHERE provider_id=$1 ORDER BY created_at DESC LIMIT 200", [ownProvider])).rows
    : c ? (await db.query<MarketThreadRow>("SELECT * FROM guild_market_threads WHERE tenant_id=$1 AND commission_id=$2 ORDER BY created_at DESC LIMIT 200", [session.tenantId, c.id])).rows : [];
  const commissions = new Map<string, Commission>(c ? [[c.id, c]] : []);
  const requestedContracts = new Map<string, MarketPackage>();
  for (const row of threadRows) {
    let customer = commissions.get(row.commission_id);
    if (!customer) { customer = await marketCommission(db, row.tenant_id, row.commission_id); commissions.set(customer.id, customer); }
    const pkg = customer.packages.find(item => item.id === row.package_id);
    const messages = (await db.query<{ message: OfferMessage }>("SELECT message FROM guild_market_messages WHERE thread_id=$1 AND tenant_id=$2 ORDER BY revision", [row.id, row.tenant_id])).rows.map(item => item.message);
    const ops = (await db.query<MarketOperationRow>("SELECT * FROM guild_market_operations WHERE thread_id=$1 AND tenant_id=$2 ORDER BY created_at", [row.id, row.tenant_id])).rows;
    const current = !!row.latest_terms && Date.parse(row.latest_terms.expiresAt) > Date.now() && row.original_work_ceiling.getTime() > Date.now();
    const provider = providers.find(item => item.id === row.provider_id), ready = provider?.enrollment.state === "ready";
    const policyCurrent = !!row.latest_terms && !!provider?.policy && provider.policy.revision === row.latest_terms.providerPolicyRevision
      && provider.policy.digest === row.latest_terms.providerPolicyDigest;
    const exact = !!pkg && !!row.latest_terms && (row.state === "selected" ? !!row.prepared_contract && marketContractDigest(pkg) === marketContractDigest(row.prepared_contract) : marketContractDigest(pkg) === row.latest_terms.contractDigest)
      && marketSourceDigest(customer, pkg) === row.latest_terms.sourceDigest;
    const noPending = !ops.some(item => ["prepared", "dispatching", "needs_review"].includes(item.state));
    const approved = !!customer.approvedPlanDigest && customer.approvedPlanDigest === planDigest(customer);
    const task = (await db.query<MarketTaskRow>("SELECT * FROM guild_market_tasks WHERE thread_id=$1 AND tenant_id=$2", [row.id, row.tenant_id])).rows[0];
    if (task) tasks.push(await taskView(db, task, customer, canBuy || ownProvider === row.provider_id));
    if (providerScope && ownProvider === row.provider_id && row.latest_terms) {
      const requested = row.original_contract, terms = row.latest_terms;
      // Providers receive only the retained contract actually requested from
      // their service. A package ID alone is not unique across customers.
      if (marketContractDigest(requested) === terms.contractDigest) requestedContracts.set(`${requested.id}:${terms.contractDigest}:${terms.sourceDigest}`, {
        id: requested.id, title: requested.title, description: requested.description, kind: requested.kind,
        contractVersion: requested.contractVersion, contractDigest: terms.contractDigest, acceptancePackDigest: requested.acceptancePack.digest,
        criteria: requested.acceptancePack.criteria.map(item => ({ id: item.id, label: item.label, blocking: item.blocking, kind: item.kind })),
        sourceDigest: terms.sourceDigest, providerId: row.provider_id, providerAwardMinor: terms.providerAwardMinor,
        serviceFeeMinor: terms.serviceFeeMinor, grossMinor: terms.grossMinor, workAuthorityExpiresAt: row.original_work_ceiling.toISOString(),
        allowedProviderIds: [row.provider_id], availableGrossMinor: terms.grossMinor, state: requested.state,
        canRequestQuote: false, unavailableReason: "This is the exact customer contract retained for this provider conversation.",
      });
    }
    const state = ["open", "requesting"].includes(row.state) && !current && row.latest_terms ? "expired" : row.state as OfferThread["state"];
    threads.push({ id: row.id, revision: row.revision, commissionId: row.commission_id, customerLabel: customer.museum,
      packageId: row.package_id, packageTitle: pkg?.title ?? row.package_id, providerId: row.provider_id, state, messages,
      latestTerms: row.latest_terms, latestTermsDigest: row.latest_terms_digest, selectedAt: row.selected_at?.toISOString() ?? null,
      approvalRequired: row.state === "selected" && !approved,
      operations: ops.map(op => ({ id: op.id, commandId: op.command_id, kind: op.kind, state: op.state, requestDigest: op.request_digest,
        originalMessageId: op.original_message_id, failureCode: op.failure_code, canRecoverOriginal: op.actor_id === session.id && ["dispatching", "needs_review"].includes(op.state), createdAt: op.created_at.toISOString() })),
      permissions: { counter: (canBuy || ownProvider === row.provider_id) && state === "open" && current && exact && ready && policyCurrent && noPending,
        select: canBuy && state === "open" && current && exact && ready && policyCurrent && noPending,
        decline: (canBuy || ownProvider === row.provider_id && current && exact && ready) && ["open", "requesting"].includes(state) && noPending,
        respond: ownProvider === row.provider_id && state === "open" && current && exact && ready && policyCurrent && noPending,
        delegate: canBuy && state === "selected" && current && exact && ready && policyCurrent && noPending && approved && !task },
      unavailableReason: !current && row.latest_terms ? "The offer expired under its original authority." : !exact && row.latest_terms ? "The current sources or contract differ from these retained terms." : !ready ? "The provider needs an active policy and service connection." : !policyCurrent && row.latest_terms ? "The provider owner changed its policy. Retain this conversation and request current terms." : !noPending ? "Recover the original service result before another action." : row.state === "selected" && !approved ? "Approve the current Passport before delegation." : null });
  }
  const ceiling = c ? marketWorkCeiling(c, session.expiresAt) : session.expiresAt;
  return { version: MARKET_VERSION, scope: providerScope ? "provider" : "buyer", serverTime: new Date().toISOString(), revision: c?.revision ?? Math.max(0, ...providers.map(item => item.enrollment.revision), ...threads.map(item => item.revision)),
    viewer: { role: session.role, providerId: ownProvider, label: providerScope ? providers.find(item => item.id === ownProvider)?.ownerDisplayName ?? "Provider owner" : c?.museum ?? "Guild workspace", canManageProvider: !!ownProvider },
    commission: c ? { id: c.id, revision: c.revision, title: c.title, customerLabel: c.museum, capMinor: c.capMinor,
      availableMinor: Math.max(0, c.capMinor - (c.mandates.find(item => !item.parentId)?.reservedMinor ?? 0) - (c.mandates.find(item => !item.parentId)?.committedMinor ?? 0)),
      approvedPlanDigest: c.approvedPlanDigest, originalWorkCeiling: ceiling, languages: c.languages, studioUrl: `/?commission=${c.id}` } : null,
    providers, packages: c ? c.packages.map(pkg => {
      const page = marketMandate(c!, pkg), available = Math.max(0, Math.min(page.capMinor - page.reservedMinor - page.committedMinor, c!.capMinor));
      const canRequest = canBuy && Date.parse(ceiling) > Date.now() && !pkg.acceptedAt && pkg.paymentState === "not_eligible" && !["producing", "verifying"].includes(pkg.state) && !pkg.artifactIds.length;
      return { id: pkg.id, title: pkg.title, description: pkg.description, kind: pkg.kind, contractVersion: pkg.contractVersion,
        contractDigest: marketContractDigest(pkg), acceptancePackDigest: pkg.acceptancePack.digest, criteria: pkg.acceptancePack.criteria.map(item => ({ id: item.id, label: item.label, blocking: item.blocking, kind: item.kind })),
        sourceDigest: marketSourceDigest(c!, pkg), providerId: pkg.providerId, providerAwardMinor: pkg.providerAwardMinor, serviceFeeMinor: pkg.serviceFeeMinor, grossMinor: pkg.grossMinor,
        workAuthorityExpiresAt: ceiling, allowedProviderIds: page.allowedProviders, availableGrossMinor: available, state: pkg.state,
        canRequestQuote: canRequest, unavailableReason: canRequest ? null : !canBuy ? "This view is read-only." : Date.parse(ceiling) <= Date.now() ? "The original work authority expired." : "This version already has submitted work or a commercial obligation; use its review and amendment flow." };
    }) : [...requestedContracts.values()], threads, tasks,
    disclosure: "These independently addressed services are operated by Guild. Offer selection, completed work, customer acceptance, buyer capture and provider payout are separate decisions.",
    syntheticFixture: c?.mode === "sample" || providers.some(item => item.provenance.syntheticFixture),
    protocol: { a2a: A2A_PROTOCOL, interoperability: "pending", mcpTools: MCP_TOOL_NAMES, ap2Conformance: "pending" } };
}
