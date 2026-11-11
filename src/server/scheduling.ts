import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Commission, WorkPackage } from "@/contracts/guild";
import { checkAuthority } from "@/domain/authority";
import { planDigest } from "@/domain/fixture";
import { digest, DomainError } from "@/domain/primitives";
import { evaluateSchedule } from "@/scheduling/model";
import { persistedScheduleSchema, type ControlledScheduleQuote, type PersistedSchedule, type ScheduleCommand, type ScheduleProposal, type ScheduleWorkspace } from "@/scheduling/persisted";
import { forecastFromCommission, scheduleSource } from "@/scheduling/source";
import { appendEvent, getCommission, saveCommission } from "./commissions";
import { getPool, transaction } from "./db";
import { issueRecoveryQuote, requireScheduleWindow, validateScheduleQuote } from "./schedule-quotes";
import type { Session } from "./session";

type Db = Pool | PoolClient;
function fail(code: string, message: string, status = 422): never { throw new DomainError(code, message, status, false); }
export function persistedScheduleDigest(input: Omit<PersistedSchedule, "digest"> | PersistedSchedule) {
  const { digest: _digest, ...value } = input as PersistedSchedule; return digest(value);
}
export function scheduleProposalDigest(input: Omit<ScheduleProposal, "digest" | "status"> | ScheduleProposal) {
  const { digest: _digest, status: _status, ...value } = input as ScheduleProposal; return digest(value);
}
export async function latestSchedule(db: Db, c: Commission) {
  const row = (await db.query<{ snapshot: PersistedSchedule; evaluation: ScheduleWorkspace["evaluation"]; digest: string }>("SELECT snapshot,evaluation,digest FROM guild_schedule_revisions WHERE tenant_id=$1 AND commission_id=$2 ORDER BY revision DESC LIMIT 1", [c.tenantId, c.id])).rows[0];
  if (!row) return null;
  const sheet = persistedScheduleSchema.parse(row.snapshot);
  if (sheet.digest !== row.digest || persistedScheduleDigest(sheet) !== row.digest || sheet.sourceDigest !== digest(sheet.source) || row.evaluation?.snapshotDigest !== digest(sheet.forecast)) fail("SCHEDULE_INTEGRITY", "The saved schedule or native engine result no longer matches its fingerprint.");
  return { sheet, evaluation: row.evaluation };
}
export function sourceCurrent(c: Commission, sheet: PersistedSchedule) {
  const current = scheduleSource(c);
  // A planned empty output may be produced normally. An already supplied input
  // remains pinned; replacing it needs a new source/contract review.
  current.contracts = current.contracts.map(item => ({ ...item,
    artifacts: sheet.source.contracts.find(source => source.packageId === item.packageId)?.artifacts.length === 0 ? [] : item.artifacts,
  }));
  return sheet.sourceDigest === digest(current);
}
function authority(c: Commission, pkg: WorkPackage, providerId = pkg.providerId) {
  if (!c.approvedPlanDigest || c.approvedPlanDigest !== planDigest(c) || ["paused", "cancelled"].includes(c.state)) fail("APPROVAL_REQUIRED", "Review the current Passport before requesting or preparing a recovery offer.");
  const page = c.mandates.find(item => item.parentId && item.allowedKinds.includes(pkg.kind)) ?? c.mandates.find(item => !item.parentId);
  const result = page && checkAuthority(c.mandates, { mandateId: page.id, amountMinor: 0, kind: pkg.kind, providerId, purpose: page.purpose, now: new Date().toISOString() });
  if (!result?.allowed) fail(result ? result.ruleId : "PASSPORT.NOT_FOUND", result ? result.reason : "This work has no current Passport.");
}
function reviewScope(c: Commission, pkg: WorkPackage, providerId = pkg.providerId) {
  requireScheduleWindow(c);
  const pages = c.mandates.map(page => ({ ...page, status: "active" as const }));
  const page = pages.find(item => item.parentId && item.allowedKinds.includes(pkg.kind)) ?? pages.find(item => !item.parentId);
  const result = page && checkAuthority(pages, { mandateId: page.id, amountMinor: 0, kind: pkg.kind, providerId, purpose: page.purpose, now: new Date().toISOString() });
  if (!result?.allowed) fail(result ? result.ruleId : "PASSPORT.NOT_FOUND", result ? result.reason : "This work has no current Passport scope.");
}
function reconcileForecast(c: Commission, sheet: PersistedSchedule) {
  const forecast = forecastFromCommission(c);
  for (const task of forecast.tasks) {
    const previous = sheet.forecast.tasks.find(item => item.id === task.id);
    if (previous) { task.notBefore = previous.notBefore; task.baseline = previous.baseline; }
    const bound = sheet.quoteBindings.find(item => item.packageId === task.id);
    if (bound) {
      task.notBefore = new Date(Math.max(Date.parse(task.notBefore), Date.parse(bound.notBefore))).toISOString();
      task.calendarId = bound.calendar.id;
      forecast.calendars = [...forecast.calendars.filter(item => item.id !== bound.calendar.id), structuredClone(bound.calendar)];
      const resource = forecast.resources.find(item => item.id === task.resourceId);
      if (resource) resource.calendarId = bound.calendar.id;
    }
  }
  return forecast;
}
function projectQuote(c: Commission, quote: ControlledScheduleQuote) {
  c.quotes.push({ id: quote.id, packageId: quote.packageId, providerId: quote.providerId, revision: quote.revision, amountMinor: quote.providerAwardMinor, workingHours: quote.workingHours, expiresAt: quote.expiresAt, acceptancePackDigest: quote.acceptancePackDigest, providerPolicyDigest: quote.providerPolicyDigest, status: "proposed", reason: quote.provenance.disclosure, provenance: { mode: c.mode, label: "Issued controlled-service offer · scenario turnaround", sourceId: quote.id, observedAt: quote.issuedAt, sandbox: false } });
}
async function ensureActor(db: Db, session: Session) {
  if (!["owner", "judge", "operator"].includes(session.role) || !(await db.query("SELECT id FROM guild_sessions WHERE id=$1 AND tenant_id=$2 AND role IN ('owner','judge','operator') AND expires_at>now() AND revoked_at IS NULL", [session.id, session.tenantId])).rowCount) fail("SCHEDULE_ACTOR", "An active owner workspace is required to change this schedule.", 403);
}
async function storeSchedule(db: PoolClient, session: Session, sheet: PersistedSchedule, evaluation: NonNullable<ScheduleWorkspace["evaluation"]>) {
  await db.query("INSERT INTO guild_schedule_revisions(id,tenant_id,commission_id,revision,digest,snapshot,evaluation,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [randomUUID(), session.tenantId, sheet.commissionId, sheet.revision, sheet.digest, sheet, evaluation, session.id]);
}

export async function schedulingWorkspace(session: Session, commissionId: string): Promise<ScheduleWorkspace> {
  await ensureActor(getPool(), session);
  const c = await getCommission(session, commissionId), saved = await latestSchedule(getPool(), c);
  const [quotes, proposals] = await Promise.all([
    getPool().query<{ terms: ControlledScheduleQuote }>("SELECT terms FROM guild_schedule_quotes WHERE tenant_id=$1 AND commission_id=$2 ORDER BY issued_at DESC LIMIT 20", [session.tenantId, c.id]),
    getPool().query<{ proposal: ScheduleProposal; state: ScheduleProposal["status"] }>("SELECT proposal,state FROM guild_schedule_proposals WHERE tenant_id=$1 AND commission_id=$2 ORDER BY created_at DESC LIMIT 20", [session.tenantId, c.id]),
  ]);
  const eligible = quotes.rows.map(row => row.terms).filter((quote, index, list) => list.findIndex(item => item.providerId === quote.providerId) === index && quote.contractVersion === c.packages.find(pkg => pkg.id === quote.packageId)?.contractVersion);
  const comparisons = saved ? await Promise.all(eligible.map(async quote => {
    try {
      const proposal = await proposalFor(getPool(), session, c, saved.sheet, { type: "propose_schedule", commandId: randomUUID(), expectedRevision: c.revision, scheduleRevision: saved.sheet.revision, patch: { type: "quote", quoteId: quote.id } }, false);
      return { quoteId: quote.id, evaluation: proposal.evaluation, unavailable: null };
    } catch (error) { return { quoteId: quote.id, evaluation: null, unavailable: error instanceof DomainError ? error.message : "The native comparison could not finish. Refresh to read the current offer." }; }
  })) : [];
  return { schedule: saved?.sheet ?? null, evaluation: saved?.evaluation ?? null, quotes: quotes.rows.map(item => item.terms),
    proposals: proposals.rows.map(item => ({ ...item.proposal, status: item.state })), comparisons,
    sourceCurrent: !saved || sourceCurrent(c, saved.sheet), serverTime: new Date().toISOString(),
    assistant: { configured: !!process.env.OPENAI_API_KEY, model: "gpt-6.1-sol", reasoning: "max" },
  };
}

async function proposalFor(db: Db, session: Session, c: Commission, sheet: PersistedSchedule, command: Extract<ScheduleCommand, { type: "propose_schedule" }>, persist = true) {
  const candidate = structuredClone(sheet), now = new Date().toISOString();
  candidate.source = scheduleSource(c); candidate.sourceDigest = digest(candidate.source);
  if (!sourceCurrent(c, sheet) || command.patch.type === "reconcile_source") candidate.forecast = reconcileForecast(c, sheet);
  candidate.revision++; candidate.forecast.revision = candidate.revision; candidate.createdAt = now;
  let quote: ControlledScheduleQuote | undefined;
  const total = c.packages.reduce((sum, item) => sum + item.grossMinor, 0);
  let proposedTotal = total;
  if (command.patch.type === "quote") {
    quote = (await db.query<{ terms: ControlledScheduleQuote }>("SELECT terms FROM guild_schedule_quotes WHERE id=$1 AND tenant_id=$2 AND commission_id=$3", [command.patch.quoteId, c.tenantId, c.id])).rows[0]?.terms;
    if (!quote) fail("QUOTE_NOT_FOUND", "That offer is not in this workspace.", 404);
    if (!sourceCurrent(c, sheet) && !quote.renewal) fail("SCHEDULE_SOURCE_CHANGED", "Preview the changed source before comparing a new recovery offer.", 409);
    await validateScheduleQuote(db, c, quote, "proposal");
    const pkg = c.packages.find(item => item.id === quote!.packageId)!;
    if (quote.renewal) reviewScope(c, pkg, quote.providerId); else authority(c, pkg, quote.providerId);
    const task = candidate.forecast.tasks.find(item => item.id === pkg.id);
    if (!task) fail("SCHEDULE_TASK", "The offered package is not in the current schedule.");
    Object.assign(task, { workingHours: quote.workingHours, notBefore: quote.notBefore, resourceId: quote.providerId, calendarId: quote.calendar.id });
    candidate.forecast.calendars = [...candidate.forecast.calendars.filter(item => item.id !== quote!.calendar.id), structuredClone(quote.calendar)];
    candidate.forecast.resources = [...candidate.forecast.resources.filter(item => item.id !== quote!.providerId), { id: quote.providerId, name: c.providers.find(item => item.id === quote!.providerId)!.name, calendarId: quote.calendar.id, capacityUnits: quote.capacityUnits }];
    candidate.quoteBindings = [...candidate.quoteBindings.filter(item => item.packageId !== pkg.id), quote];
    proposedTotal = total - pkg.grossMinor + quote.grossMinor;
  } else if (command.patch.type === "move_task") {
    const patch = command.patch;
    const moved = candidate.forecast.tasks.find(item => item.id === patch.taskId);
    if (!moved) fail("SCHEDULE_TASK", "Choose a task in the current schedule.", 404);
    const bound = candidate.quoteBindings.find(item => item.packageId === patch.taskId);
    if (bound && Date.parse(patch.notBefore) < Date.parse(bound.notBefore)) fail("SCHEDULE_QUOTED_START", "This move precedes the provider's agreed earliest start. Request new terms first.");
    moved.notBefore = patch.notBefore;
  }
  if (proposedTotal > c.capMinor) fail("SCHEDULE_OVER_CAP", "The proposed contract exceeds the commission's approved ceiling.");
  const evaluation = await evaluateSchedule(candidate.forecast);
  candidate.digest = persistedScheduleDigest(candidate);
  const proposal: ScheduleProposal = {
    schemaVersion: "guild.schedule-proposal.v1", id: randomUUID(), digest: "", status: "proposed",
    baseScheduleRevision: sheet.revision, baseCommissionRevision: c.revision + 1, sourceDigest: sheet.sourceDigest,
    patch: command.patch, candidate, evaluation, createdAt: now,
    expiresAt: new Date(Math.min(Date.now() + 10 * 60_000, Date.parse(session.expiresAt), ...c.mandates.map(item => Date.parse(item.expiresAt)), ...candidate.quoteBindings.map(item => Date.parse(item.authorityExpiresAt)), ...(quote ? [Date.parse(quote.expiresAt)] : []))).toISOString(),
    commercial: { previousTotalMinor: total, proposedTotalMinor: proposedTotal, capMinor: c.capMinor },
    disclosure: "A native-engine proposal against this exact schedule and source revision. It changes no contract, reservation, acceptance or payment until the owner prepares its Passport and approves the resulting plan.",
  };
  proposal.digest = scheduleProposalDigest(proposal);
  if (persist) await db.query("INSERT INTO guild_schedule_proposals(id,tenant_id,commission_id,base_revision,digest,proposal,actor_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [proposal.id, c.tenantId, c.id, sheet.revision, proposal.digest, proposal, session.id, proposal.expiresAt]);
  return proposal;
}

async function releaseUnacceptedReservation(db: PoolClient, c: Commission, pkg: WorkPackage) {
  const row = (await db.query<{ id: string; amount_minor: string; mandate_id: string; state: string }>("SELECT id,amount_minor,mandate_id,state FROM guild_budget_reservations WHERE tenant_id=$1 AND commission_id=$2 AND operation_key=$3 FOR UPDATE", [c.tenantId, c.id, `production:${c.id}:${pkg.id}:${pkg.contractVersion}`])).rows[0];
  if (!row) return;
  if (row.state !== "reserved" || Number(row.amount_minor) !== pkg.grossMinor) fail("SCHEDULE_OBLIGATION", "The earlier contract has an obligation that cannot be released as unaccepted work.");
  let page = c.mandates.find(item => item.id === row.mandate_id); const seen = new Set<string>();
  if (!page) fail("SCHEDULE_RESERVATION", "The original reservation's authority is unavailable.");
  while (page) {
    if (seen.has(page.id) || page.reservedMinor < pkg.grossMinor) fail("SCHEDULE_RESERVATION", "The exact original reservation cannot be released safely.");
    seen.add(page.id); page.reservedMinor -= pkg.grossMinor;
    const parentId: string | null = page.parentId; page = c.mandates.find(item => item.id === parentId);
    if (parentId && !page) fail("SCHEDULE_RESERVATION", "The original authority chain is incomplete.");
  }
  await db.query("UPDATE guild_budget_reservations SET state='released' WHERE id=$1 AND tenant_id=$2", [row.id, c.tenantId]);
}

export async function executeScheduleCommand(session: Session, commissionId: string, command: ScheduleCommand) {
  return transaction(async db => {
    await ensureActor(db, session);
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${session.tenantId}:${command.commandId}`]);
    const payloadHash = digest({ namespace: "scheduling", commissionId, command });
    const prior = (await db.query<{ payload_hash: string; result: { ok: true; commission: Commission; proposalId?: string } }>("SELECT payload_hash,result FROM guild_commands WHERE tenant_id=$1 AND command_id=$2", [session.tenantId, command.commandId])).rows[0];
    if (prior) { if (prior.payload_hash !== payloadHash) fail("COMMAND_CHANGED", "That command identity belongs to a different decision.", 409); return prior.result; }
    const c = (await db.query<{ snapshot: Commission }>("SELECT snapshot FROM guild_commissions WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [commissionId, session.tenantId])).rows[0]?.snapshot;
    if (!c) fail("NOT_FOUND", "This commission is not in your workspace.", 404);
    if (c.revision !== command.expectedRevision) fail("REVISION_CONFLICT", "The commission changed. Refresh the schedule and review the current proposal.", 409);
    if (["paused", "cancelled"].includes(c.state)) fail("COMMISSION_INACTIVE", "Resume the commission before changing its schedule.");
    const saved = await latestSchedule(db, c); let proposalId: string | undefined;
    if (command.type === "initialize_schedule") {
      if (saved) fail("SCHEDULE_EXISTS", "This commission already has a saved schedule.", 409);
      const forecast = forecastFromCommission(c), first = await evaluateSchedule(forecast);
      for (const task of forecast.tasks) { const calculated = first.tasks.find(item => item.id === task.id)!; task.baseline = { startAt: calculated.startAt, endAt: calculated.endAt, workingHours: calculated.workingHours }; }
      const source = scheduleSource(c), sheet: PersistedSchedule = { schemaVersion: "guild.schedule.v2", id: randomUUID(), commissionId: c.id, revision: 1, source, sourceDigest: digest(source), forecast, quoteBindings: [], createdAt: new Date().toISOString(), digest: "" };
      sheet.digest = persistedScheduleDigest(sheet); await storeSchedule(db, session, sheet, await evaluateSchedule(forecast));
      appendEvent(c, "schedule.created", "The opening has a working plan", "A modelled schedule now binds the current contracts, dependencies, provider calendars and four-hour curator review. No completed work or new authority is inferred.", "Curator");
    } else {
      if (!saved || saved.sheet.revision !== command.scheduleRevision) fail("SCHEDULE_REVISION", "The schedule changed. Review its current revision.", 409);
      const sheet = saved.sheet;
      const reconciliation = command.type === "propose_schedule" && command.patch.type === "reconcile_source";
      const quoteReview = command.type === "propose_schedule" && command.patch.type === "quote";
      if (!sourceCurrent(c, sheet) && !reconciliation && !quoteReview && !["renew_recovery_offer", "prepare_schedule_passport"].includes(command.type)) fail("SCHEDULE_SOURCE_CHANGED", "A source artifact, contract, provider policy or capacity changed. Preview a current-source reconciliation before a new commitment.", 409);
      if (command.type === "request_recovery_offers") {
        const pkg = c.packages.find(item => item.kind === "web"); if (!pkg) fail("SCHEDULE_WEB_CONTRACT", "This commission has no exhibition contract.");
        authority(c, pkg);
        for (const offer of ["economy", "accessible"] as const) {
          const quote = await issueRecoveryQuote(db, session, c, pkg, command.commandId, offer);
          projectQuote(c, quote);
        }
        appendEvent(c, "provider.quote_received", "Two recovery offers, with real expiry", "Formwork offers 24 working hours at $130; Studio Ostrava offers eight at $160. Each retains its service fee, owner policy, capacity, calendar and exact failed contract. Native simulation decides whether either meets opening.", "Controlled provider services", pkg.id);
      } else if (command.type === "renew_recovery_offer") {
        const prior = sheet.quoteBindings.find(item => item.id === command.quoteId);
        const pkg = c.packages.find(item => item.id === prior?.packageId);
        if (!prior || !pkg) fail("QUOTE_RENEWAL_CHANGED", "Renew the exact prepared offer shown in the current schedule.");
        reviewScope(c, pkg, prior.providerId); requireScheduleWindow(c, [prior]);
        const quote = await issueRecoveryQuote(db, session, c, pkg, command.commandId, prior.offer, prior);
        projectQuote(c, quote);
        appendEvent(c, "provider.quote_renewed", "New terms, with the original history intact", "A distinct signed offer retains the previous quote, failed submission, report and original authority ceiling. Preview its current source and schedule, then prepare and approve a fresh Passport. The prior agreement remains unchanged.", "Controlled provider service", pkg.id);
      } else if (command.type === "propose_schedule") {
        const proposal = await proposalFor(db, session, c, sheet, command); proposalId = proposal.id;
        appendEvent(c, "schedule.proposed", proposal.evaluation.scheduleFeasible ? "A feasible opening proposal" : "The proposal misses a constraint", proposal.evaluation.scheduleFeasible ? "The native engine finds room for the required work and curator review. The current plan is unchanged; the proposal needs an explicit owner decision." : `The current plan is unchanged. Native result: ${proposal.evaluation.reasons.join(", ")}. This proposal cannot prepare a Passport.`, "Schedule planner");
      } else {
        const row = (await db.query<{ proposal: ScheduleProposal; digest: string; state: string }>("SELECT proposal,digest,state FROM guild_schedule_proposals WHERE id=$1 AND tenant_id=$2 AND commission_id=$3 FOR UPDATE", [command.proposalId, c.tenantId, c.id])).rows[0];
        const p = row?.proposal;
        if (!p || row.state !== "proposed" || row.digest !== p.digest || p.digest !== command.proposalDigest || p.digest !== scheduleProposalDigest(p) || p.baseScheduleRevision !== sheet.revision || p.baseCommissionRevision !== c.revision || p.sourceDigest !== sheet.sourceDigest) fail("SCHEDULE_PROPOSAL_CHANGED", "The proposal, source or revision changed. Review a fresh native simulation.", 409);
        if (Date.parse(p.expiresAt) <= Date.now()) fail("SCHEDULE_PROPOSAL_EXPIRED", "The proposal expired. Obtain current offers and review a new simulation.");
        if (p.candidate.sourceDigest !== digest(scheduleSource(c))) fail("SCHEDULE_SOURCE_CHANGED", "The proposal's current contracts or source artifacts changed. Review a fresh reconciliation.", 409);
        requireScheduleWindow(c, p.candidate.quoteBindings);
        const fresh = await evaluateSchedule(p.candidate.forecast);
        if (digest(fresh) !== digest(p.evaluation) || !fresh.scheduleFeasible) fail("SCHEDULE_INFEASIBLE", "This proposal does not meet opening or available capacity. It cannot prepare a Passport.");
        if ((await db.query("SELECT id FROM guild_jobs WHERE tenant_id=$1 AND commission_id=$2 AND state IN ('queued','running') LIMIT 1", [c.tenantId, c.id])).rowCount) fail("AMENDMENT_WORK_RUNNING", "Finish saved work before changing the approved plan.");
        let amendment: { id: string; previous: WorkPackage; current: WorkPackage; reason: string } | undefined;
        const previousPlan = c.approvedPlanDigest;
        if (p.patch.type === "quote") {
          const quoteId = p.patch.quoteId;
          const quote = p.candidate.quoteBindings.find(item => item.id === quoteId);
          if (!quote) fail("QUOTE_NOT_FOUND", "The reviewed candidate has no matching offer.");
          await validateScheduleQuote(db, c, quote, "proposal");
          const pkg = c.packages.find(item => item.id === quote.packageId)!;
          if (quote.renewal) reviewScope(c, pkg, quote.providerId); else authority(c, pkg, quote.providerId);
          if (pkg.acceptedAt || pkg.paymentState !== "not_eligible" || (await db.query("SELECT id FROM guild_payment_intents WHERE tenant_id=$1 AND commission_id=$2 AND package_id=$3 LIMIT 1", [c.tenantId, c.id, pkg.id])).rowCount) fail("SCHEDULE_OBLIGATION", "Accepted or financially committed work requires its own recourse agreement.");
          const previous = structuredClone(pkg); await releaseUnacceptedReservation(db, c, pkg);
          Object.assign(pkg, { providerId: quote.providerId, providerAwardMinor: quote.providerAwardMinor, serviceFeeMinor: quote.serviceFeeMinor, grossMinor: quote.grossMinor, workingHours: quote.workingHours, contractVersion: pkg.contractVersion + 1, state: "awarded", artifactIds: [], progress: null });
          pkg.acceptancePack = { ...pkg.acceptancePack, criteria: pkg.acceptancePack.criteria.map(item => ({ ...item, status: "pending", evidence: null })) };
          amendment = { id: randomUUID(), previous, current: pkg, reason: `Explicit recovery offer ${quote.id}, native schedule proposal ${p.id}, unchanged acceptance pack. Earlier failed work and its unaccepted reservation remain in history. A fresh Passport must approve the changed contract and complete schedule before production.` };
          await db.query("UPDATE guild_schedule_quotes SET state='accepted',prepared_at=now() WHERE id=$1 AND tenant_id=$2", [quote.id, c.tenantId]);
          const projected = c.quotes.find(item => item.id === quote.id); if (projected) projected.status = "accepted";
        } else {
          for (const pkg of c.packages) reviewScope(c, pkg);
          for (const quote of p.candidate.quoteBindings) await validateScheduleQuote(db, c, quote, "approval");
        }
        const candidate = structuredClone(p.candidate); candidate.source = scheduleSource(c); candidate.sourceDigest = digest(candidate.source); candidate.digest = persistedScheduleDigest(candidate);
        c.schedule = { schemaVersion: "guild.schedule-authority.v1", id: candidate.id, revision: candidate.revision, digest: candidate.digest, sourceDigest: candidate.sourceDigest, quoteIds: candidate.quoteBindings.map(item => item.id) };
        c.approvedPlanDigest = null; c.state = "awaiting_approval";
        for (const mandate of c.mandates) if (mandate.status === "active") mandate.status = "draft";
        if (amendment) await db.query("INSERT INTO guild_contract_amendments(id,tenant_id,commission_id,package_id,from_version,to_version,previous_plan_digest,proposed_plan_digest,previous_contract,proposed_contract,actor_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)", [amendment.id, c.tenantId, c.id, amendment.current.id, amendment.previous.contractVersion, amendment.current.contractVersion, previousPlan, planDigest(c), amendment.previous, amendment.current, session.id, amendment.reason]);
        await storeSchedule(db, session, candidate, fresh);
        await db.query("UPDATE guild_schedule_proposals SET state='prepared' WHERE id=$1 AND tenant_id=$2", [p.id, c.tenantId]);
        appendEvent(c, "schedule.passport_prepared", "The new plan is ready for your Passport", "The selected native schedule and exact issued offer are bound to the new plan. Review its source, business dates, price and real expiry before approving. No production or payment was started.", "Curator");
      }
    }
    c.revision++; await saveCommission(db, c);
    const result = { ok: true as const, commission: c, ...(proposalId ? { proposalId } : {}) };
    await db.query("INSERT INTO guild_commands(tenant_id,command_id,commission_id,payload_hash,result) VALUES($1,$2,$3,$4,$5)", [session.tenantId, command.commandId, c.id, payloadHash, result]);
    return result;
  });
}

/** The optional binding keeps every older plan's digest and behavior unchanged. */
export async function validateScheduleAuthority(db: Db, c: Commission, stage: "approval" | "production") {
  if (!c.schedule) return;
  const saved = await latestSchedule(db, c), binding = c.schedule;
  requireScheduleWindow(c, saved?.sheet.quoteBindings);
  if (!saved || saved.sheet.id !== binding.id || saved.sheet.revision !== binding.revision || saved.sheet.digest !== binding.digest || saved.sheet.sourceDigest !== binding.sourceDigest || digest(saved.sheet.quoteBindings.map(item => item.id)) !== digest(binding.quoteIds) || !sourceCurrent(c, saved.sheet)) fail("SCHEDULE_AUTHORITY_CHANGED", "The approved schedule no longer matches its exact contracts, source artifacts or provider capacity. Review a new plan before work.");
  if (!saved.evaluation?.scheduleFeasible) fail("SCHEDULE_INFEASIBLE", "A plan that misses opening or capacity cannot authorize work.");
  for (const quote of saved.sheet.quoteBindings) await validateScheduleQuote(db, c, quote, stage);
}
