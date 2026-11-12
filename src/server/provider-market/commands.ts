import { randomUUID } from "node:crypto";
import { AgentCard, SendMessageRequest, Task } from "@a2a-js/sdk";
import type { PoolClient } from "pg";
import { providerMarketCommandSchema, type A2AMarketPayload, type ProviderMarketCommand, type ProviderMarketCommandResult } from "@/contracts/provider-market";
import { buyerOfferDecision, marketContractDigest, marketSourceDigest, marketWorkCeiling, providerOfferDecision } from "@/domain/provider-market";
import { digest, DomainError } from "@/domain/primitives";
import { getPool, transaction } from "../db";
import type { Session } from "../session";
import { providerMarketTransport, type MarketTransport } from "./a2a-client";
import { lockMarketCommission } from "./a2a-service";
import { marketSendRequest, originalServiceTaskId, resultFromServiceTask } from "./a2a-wire";
import { cancelMarketTask, prepareMarketDelegation, type MarketTaskRow } from "./delegation";
import { createOfferThread, declineOffer, proposeOffer, readyPolicy, requireOfferThread, writablePackage } from "./offers";
import { boundProvider, discoverProvider, providerAgentCard, providerRow, requireMarketSession, saveProviderPolicy } from "./registry";
import { marketSnapshot, type MarketOperationRow, type MarketThreadRow } from "./snapshot";

interface CommandRow { payload_hash: string; operation_id: string | null; result: ProviderMarketCommandResult | null }
interface Services { transport?: MarketTransport; fetch?: typeof fetch; authorize?: (db: PoolClient) => Promise<void> }
type Prepared = { result: ProviderMarketCommandResult } | { operation: MarketOperationRow; recovery: boolean };
const requireBuyer = (session: Session) => { if (!["owner", "judge"].includes(session.role)) throw new DomainError("MARKET_BUYER_REQUIRED", "Only the current customer owner can negotiate or delegate this work.", 403, false); };

async function commandLock(db: PoolClient, session: Session, command: ProviderMarketCommand): Promise<CommandRow | undefined> {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`guild-market-command:${session.id}:${command.commandId}`]);
  const old = (await db.query<CommandRow>("SELECT payload_hash,operation_id,result FROM guild_market_commands WHERE actor_id=$1 AND tenant_id=$2 AND command_id=$3", [session.id, session.tenantId, command.commandId])).rows[0];
  if (old && old.payload_hash !== digest(command)) throw new DomainError("COMMAND_CHANGED", "This command identity already belongs to a different decision. Its original result is retained.", 409, false);
  return old;
}
async function remember(db: PoolClient, session: Session, command: ProviderMarketCommand, result: ProviderMarketCommandResult | null, operationId: string | null = null) {
  await db.query("INSERT INTO guild_market_commands(actor_id,tenant_id,command_id,payload_hash,result,operation_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(actor_id,command_id) DO UPDATE SET result=COALESCE(guild_market_commands.result,EXCLUDED.result)", [session.id, session.tenantId, command.commandId, digest(command), result, operationId]);
}
async function ownOperation(db: PoolClient, session: Session, id: string, lock = false): Promise<MarketOperationRow> {
  const row = (await db.query<MarketOperationRow>(`SELECT * FROM guild_market_operations WHERE id=$1 AND actor_id=$2 AND tenant_id=$3${lock ? " FOR UPDATE" : ""}`, [id, session.id, session.tenantId])).rows[0];
  if (!row) throw new DomainError("MARKET_OPERATION_NOT_FOUND", "The original operation is not available to this owner.", 404, false);
  return row;
}
async function noPending(db: PoolClient, row: MarketThreadRow) {
  if ((await db.query("SELECT id FROM guild_market_operations WHERE thread_id=$1 AND tenant_id=$2 AND state IN ('prepared','dispatching','needs_review') LIMIT 1", [row.id, row.tenant_id])).rowCount) throw new DomainError("MARKET_ORIGINAL_OPERATION_REQUIRED", "Recover the original service response before changing this conversation.", 409, false);
}
async function buyerThread(db: PoolClient, session: Session, id: string, revision: number) {
  requireBuyer(session);
  const hint = (await db.query<MarketThreadRow>("SELECT * FROM guild_market_threads WHERE id=$1 AND tenant_id=$2", [id, session.tenantId])).rows[0];
  if (!hint) throw new DomainError("OFFER_NOT_FOUND", "That offer is not available in this workspace.", 404, false);
  const c = await lockMarketCommission(db, session.tenantId, hint.commission_id), row = await requireOfferThread(db, session.tenantId, id, revision);
  await noPending(db, row); return { c, row };
}
async function newOperation(db: PoolClient, session: Session, command: ProviderMarketCommand, value: {
  providerId: string; commissionId: string | null; threadId: string | null; request: unknown; messageId: string; taskId: string | null; ceiling: string; endpoint: string; card: unknown;
}): Promise<MarketOperationRow> {
  const row = (await db.query<MarketOperationRow>("INSERT INTO guild_market_operations(id,tenant_id,actor_id,command_id,provider_id,commission_id,thread_id,kind,state,request_body,request_digest,original_message_id,original_task_id,original_work_ceiling,provider_endpoint,provider_card,provider_card_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'prepared',$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *", [randomUUID(), session.tenantId, session.id, command.commandId, value.providerId, value.commissionId, value.threadId, command.type, value.request, digest(value.request), value.messageId, value.taskId, value.ceiling, value.endpoint, value.card, digest(value.card)])).rows[0]!;
  await remember(db, session, command, null, row.id); return row;
}

async function prepare(session: Session, command: ProviderMarketCommand, authorize?: Services["authorize"]): Promise<Prepared> {
  return transaction(async db => {
    await authorize?.(db);
    await requireMarketSession(db, session);
    const old = await commandLock(db, session, command);
    if (old?.result) return { result: old.result };
    if (old?.operation_id) return { operation: await ownOperation(db, session, old.operation_id), recovery: command.type === "recover_original" };
    if (command.type === "recover_original") {
      const operation = await ownOperation(db, session, command.operationId);
      if (operation.state === "prepared" && operation.dispatch_count === 0) throw new DomainError("MARKET_OPERATION_NOT_SENT", "This original request has not been dispatched. Retry that exact request before seeking a result.", 409, false);
      await remember(db, session, command, null, operation.id); return { operation, recovery: true };
    }
    if (command.type === "update_provider_profile" || command.type === "update_provider_policy") {
      const own = await boundProvider(db, session);
      if (own !== command.providerId) throw new DomainError("PROVIDER_IDENTITY_REQUIRED", "This console session does not own that provider.", 403, false);
      const row = await providerRow(db, own, true);
      if (command.type === "update_provider_profile") {
        if (row.profile_revision !== command.expectedProfileRevision) throw new DomainError("PROVIDER_REVISION_CONFLICT", "The profile changed. Keep your draft and review its current revision.", 409, false);
        if (command.profile.portfolioUrl) { const url = new URL(command.profile.portfolioUrl); if (url.protocol !== "https:" || url.username || url.password) throw new DomainError("PROVIDER_PORTFOLIO_URL", "Use a public HTTPS portfolio address without credentials.", 422, false); }
        await db.query("UPDATE guild_market_providers SET profile=$2,profile_revision=profile_revision+1,enrollment_state=CASE WHEN current_policy_revision=0 THEN 'policy_required' ELSE 'discovery_required' END,last_failure=NULL,updated_at=now() WHERE id=$1", [own, command.profile]);
      } else {
        if (row.current_policy_revision !== command.expectedPolicyRevision) throw new DomainError("PROVIDER_POLICY_CONFLICT", "The owner policy changed. Review the current version before publishing your draft.", 409, false);
        await saveProviderPolicy(db, row, session, command.policy);
      }
      const result: ProviderMarketCommandResult = { ok: true, commandId: command.commandId, message: command.type === "update_provider_profile" ? "The profile is saved. Discover the exact updated service card before receiving new work." : "The complete owner policy is saved as a new immutable version. Earlier offers retain their original policy binding.", snapshot: await marketSnapshot(db, session) };
      await remember(db, session, command, result); return { result };
    }
    if (command.type === "provider_counter" || command.type === "provider_decline") {
      const own = await boundProvider(db, session), hint = (await db.query<MarketThreadRow>("SELECT * FROM guild_market_threads WHERE id=$1 AND provider_id=$2", [command.threadId, own])).rows[0];
      if (!hint) throw new DomainError("OFFER_NOT_FOUND", "This conversation is not addressed to your provider service.", 404, false);
      const c = await lockMarketCommission(db, hint.tenant_id, hint.commission_id), row = await requireOfferThread(db, hint.tenant_id, hint.id, command.expectedThreadRevision);
      await noPending(db, row);
      const { provider } = await readyPolicy(db, own!);
      if (command.type === "provider_counter") await proposeOffer(db, session, row, command.commandId, command.providerAwardMinor, command.note, "provider");
      else await declineOffer(db, row, command.commandId, "provider", provider.profile.displayName, command.note);
      const result: ProviderMarketCommandResult = { ok: true, commandId: command.commandId, message: "Your response is retained for the exact customer contract. Selection, approval and payment remain separate.", threadId: row.id, snapshot: await marketSnapshot(db, session, c.id) };
      await remember(db, session, command, result); return { result };
    }
    if (command.type === "cancel_task") {
      const own = await boundProvider(db, session, false), hint = (await db.query<MarketTaskRow>("SELECT * FROM guild_market_tasks WHERE id=$1", [command.taskId])).rows[0];
      if (!hint || !(session.role === "provider" ? hint.provider_id === own : ["owner", "judge"].includes(session.role) && hint.tenant_id === session.tenantId)) throw new DomainError("MARKET_TASK_NOT_FOUND", "This task is not available in your current workspace.", 404, false);
      const c = await lockMarketCommission(db, hint.tenant_id, hint.commission_id), task = (await db.query<MarketTaskRow>("SELECT * FROM guild_market_tasks WHERE id=$1 FOR UPDATE", [hint.id])).rows[0]!;
      if (task.revision !== command.expectedTaskRevision) throw new DomainError("TASK_REVISION_CONFLICT", "The task changed. Review its original worker before cancelling.", 409, false);
      await cancelMarketTask(db, session, task, c, command.note);
      const result: ProviderMarketCommandResult = { ok: true, commandId: command.commandId, message: "The original task was cancelled before provider dispatch. Its released reservation and full history are retained.", taskId: task.id, snapshot: await marketSnapshot(db, session, c.id) };
      await remember(db, session, command, result); return { result };
    }
    if (command.type === "discover_provider") {
      const own = await boundProvider(db, session, false);
      if (session.role === "provider" ? own !== command.providerId : !["owner", "judge"].includes(session.role)) throw new DomainError("PROVIDER_DISCOVERY_ROLE", "Open this provider's console or an owned customer workspace to discover its service.", 403, false);
      const row = await providerRow(db, command.providerId, true);
      if (row.revoked_at || !row.current_policy_revision || row.enrollment_state === "profile_required") throw new DomainError("PROVIDER_SETUP_REQUIRED", "Complete the provider profile and current owner policy before discovery.", 422, false);
      const card = AgentCard.toJSON(providerAgentCard(row)), messageId = randomUUID();
      const operation = await newOperation(db, session, command, { providerId: row.id, commissionId: null, threadId: null, request: { providerId: row.id, profileRevision: row.profile_revision, cardUrl: row.card_url, expectedCardDigest: digest(card) },
        messageId, taskId: null, ceiling: session.expiresAt, endpoint: row.card_url, card });
      return { operation, recovery: false };
    }

    requireBuyer(session);
    let row: MarketThreadRow, payload: A2AMarketPayload, commissionRevision: number | undefined;
    if (command.type === "request_quote") {
      const c = await lockMarketCommission(db, session.tenantId, command.commissionId);
      if (c.revision !== command.expectedCommissionRevision) throw new DomainError("COMMISSION_REVISION_CONFLICT", "The commission changed. Review the current package before requesting its quote.", 409, false);
      const pkg = await writablePackage(db, c, command.packageId); row = await createOfferThread(db, session, c, pkg, command.providerId);
      payload = { type: "quote.request", requestId: command.commandId, commissionId: c.id, packageId: pkg.id, contractVersion: pkg.contractVersion,
        contractDigest: marketContractDigest(pkg), acceptancePackDigest: pkg.acceptancePack.digest, sourceDigest: marketSourceDigest(c, pkg), kind: pkg.kind, workAuthorityExpiresAt: row.original_work_ceiling.toISOString() };
      commissionRevision = c.revision;
    } else {
      const current = await buyerThread(db, session, command.threadId, command.expectedThreadRevision); row = current.row;
      if (command.type === "counter_offer") payload = { type: "offer.counter", requestId: command.commandId, threadId: row.id, expectedRevision: row.revision, providerAwardMinor: command.providerAwardMinor, note: command.note };
      else if (command.type === "decline_offer") payload = { type: "offer.decline", requestId: command.commandId, threadId: row.id, expectedRevision: row.revision, note: command.note };
      else {
        if (current.c.revision !== command.expectedCommissionRevision || row.latest_terms_digest !== command.termsDigest) throw new DomainError("OFFER_CHANGED", "The exact offer or commission changed. Review its current terms before continuing.", 409, false);
        commissionRevision = current.c.revision;
        if (command.type === "select_offer") payload = { type: "offer.accept", requestId: command.commandId, threadId: row.id, expectedRevision: row.revision, termsDigest: command.termsDigest };
        else {
          if (current.c.approvedPlanDigest !== command.approvedPlanDigest) throw new DomainError("APPROVAL_CHANGED", "The current Passport approval differs from the one you reviewed.", 409, false);
          const pkg = current.c.packages.find(item => item.id === row.package_id);
          if (!pkg || !row.selected_terms) throw new DomainError("MARKET_SELECT_REQUIRED", "Select the exact current contract before delegating it.", 422, false);
          const { policy, activeTasks } = await readyPolicy(db, row.provider_id);
          for (const decision of [buyerOfferDecision(current.c, pkg, row.selected_terms, new Date().toISOString(), true), providerOfferDecision(policy, row.selected_terms, activeTasks)]) if (!decision.allowed) throw new DomainError(decision.code, decision.reason, 422, false);
          payload = { type: "work.delegate", requestId: command.commandId, delegation: await prepareMarketDelegation(db, session, current.c, pkg, row) };
        }
      }
    }
    const provider = await providerRow(db, row.provider_id), messageId = randomUUID(), request = marketSendRequest(messageId, payload, session.tenantId, row.id, commissionRevision);
    if (!provider.observed_card || !provider.card_digest || digest(provider.observed_card) !== provider.card_digest) throw new DomainError("PROVIDER_DISCOVERY_REQUIRED", "Retain the exact enrolled service card before sending this request.", 422, false);
    const operation = await newOperation(db, session, command, { providerId: row.provider_id, commissionId: row.commission_id, threadId: row.id,
      request: SendMessageRequest.toJSON(request), messageId, taskId: originalServiceTaskId(row.provider_id, session.tenantId, session.id, messageId), ceiling: row.original_work_ceiling.toISOString(), endpoint: provider.endpoint, card: provider.observed_card });
    return { operation, recovery: false };
  });
}

async function unknownResult(session: Session, command: ProviderMarketCommand, op: MarketOperationRow): Promise<ProviderMarketCommandResult> {
  return { ok: false, commandId: command.commandId, error: { code: "SERVICE_OUTCOME_UNKNOWN", message: "The original provider response is not confirmed. Recover its original result before any further action on this work.", retryable: true, unknownOutcome: true }, snapshot: await marketSnapshot(getPool(), session, op.commission_id ?? undefined) };
}

async function finalize(session: Session, command: ProviderMarketCommand, op: MarketOperationRow, response?: Task | { card: unknown; cardDigest: string }): Promise<ProviderMarketCommandResult> {
  return transaction(async db => {
    await requireMarketSession(db, session); await commandLock(db, session, command);
    const current = await ownOperation(db, session, op.id, true);
    if (!["completed", "refused"].includes(current.state)) {
      if (!response) throw new DomainError("SERVICE_RESULT_REQUIRED", "The original service result is not yet confirmed.", 409, false);
      if (current.kind === "discover_provider") {
        if (!("card" in response)) throw new DomainError("SERVICE_RESULT_CHANGED", "The discovery result has the wrong retained shape.", 502, false);
        const provider = await providerRow(db, current.provider_id, true), request = current.request_body as { profileRevision: number; expectedCardDigest: string; cardUrl: string };
        if (provider.revoked_at || provider.profile_revision !== request.profileRevision || provider.card_url !== request.cardUrl || response.cardDigest !== request.expectedCardDigest || digest(response.card) !== response.cardDigest) throw new DomainError("PROVIDER_DISCOVERY_CHANGED", "The enrolled profile or service identity changed during discovery. Retain this result and review a new discovery request.", 409, false);
        await db.query("UPDATE guild_market_providers SET observed_card=$2,card_digest=$3,card_observed_at=now(),enrollment_state='ready',last_failure=NULL,updated_at=now() WHERE id=$1", [provider.id, response.card, response.cardDigest]);
        current.state = "completed"; current.response_body = response;
      } else {
        if (!("id" in response)) throw new DomainError("SERVICE_RESULT_CHANGED", "The provider response has no original task.", 502, false);
        const result = resultFromServiceTask(response);
        current.state = result.ok ? "completed" : "refused"; current.response_body = Task.toJSON(response);
      }
      await db.query("UPDATE guild_market_operations SET state=$2,response_body=$3,response_digest=$4,failure_code=NULL,lease_until=NULL,updated_at=now() WHERE id=$1", [current.id, current.state, current.response_body, digest(current.response_body)]);
    }
    const snapshot = await marketSnapshot(db, session, current.commission_id ?? undefined), reply = current.kind === "discover_provider" ? null : resultFromServiceTask(Task.fromJSON(current.response_body));
    const original: ProviderMarketCommandResult = reply?.ok === false ? { ok: false, commandId: current.command_id, error: { code: reply.code, message: reply.message, retryable: false, unknownOutcome: false }, snapshot }
      : { ok: true, commandId: current.command_id, message: reply?.message ?? "The exact enrolled service card was read and retained. This is service discovery, not a claim of external provider independence.", snapshot,
        ...(reply?.ok ? { threadId: reply.threadId, ...(reply.taskId ? { taskId: reply.taskId } : {}) } : {}),
        ...(current.kind === "select_offer" ? { approvalUrl: `/?view=passport&commission=${current.commission_id}` } : {}) };
    await db.query("UPDATE guild_market_commands SET result=COALESCE(result,$3) WHERE actor_id=$1 AND command_id=$2", [session.id, current.command_id, original]);
    const result: ProviderMarketCommandResult = command.type === "recover_original" ? { ok: true, commandId: command.commandId,
      message: reply?.ok === false ? `The original service refusal is retained: ${reply.message}` : "The original service result is confirmed. Its request, task, contract and deadline are unchanged.", snapshot,
      ...(reply?.ok && reply.taskId ? { taskId: reply.taskId } : {}), ...(reply?.ok ? { threadId: reply.threadId } : {}) } : original;
    await remember(db, session, command, result, current.id); return result;
  });
}

export async function executeProviderMarketCommand(session: Session, input: ProviderMarketCommand, services: Services = {}): Promise<ProviderMarketCommandResult> {
  const command = providerMarketCommandSchema.parse(input);
  try {
    const prepared = await prepare(session, command, services.authorize);
    if ("result" in prepared) return prepared.result;
    let op = prepared.operation;
    if (["completed", "refused"].includes(op.state)) return finalize(session, command, op);
    if (!prepared.recovery) {
      const claimed = await transaction(async db => {
        await requireMarketSession(db, session);
        return (await db.query<MarketOperationRow>("UPDATE guild_market_operations SET state='dispatching',dispatch_count=dispatch_count+1,lease_until=now()+interval '45 seconds',updated_at=now() WHERE id=$1 AND actor_id=$2 AND tenant_id=$3 AND state='prepared' AND dispatch_count=0 AND original_work_ceiling>now() RETURNING *", [op.id, session.id, session.tenantId])).rows[0];
      });
      if (!claimed) return unknownResult(session, command, op);
      op = claimed;
    }
    try {
      let response: Task | { card: unknown; cardDigest: string };
      if (op.kind === "discover_provider") {
        const provider = await providerRow(getPool(), op.provider_id), expected = op.request_body as { profileRevision: number; expectedCardDigest: string };
        if (provider.profile_revision !== expected.profileRevision || digest(AgentCard.toJSON(providerAgentCard(provider))) !== expected.expectedCardDigest) throw new DomainError("PROVIDER_DISCOVERY_CHANGED", "The enrolled provider changed before discovery completed.", 409, false);
        response = await discoverProvider(provider, services.fetch);
      } else {
        const transport = services.transport ?? providerMarketTransport(services.fetch);
        response = prepared.recovery ? await transport.readOriginal(op, session) : await transport.dispatch(op, session);
      }
      return await finalize(session, command, op, response);
    } catch (error) {
      await transaction(async db => {
        await db.query("UPDATE guild_market_operations SET state='needs_review',failure_code=$2,lease_until=NULL,updated_at=now() WHERE id=$1 AND state NOT IN ('completed','refused')", [op.id, error instanceof DomainError ? error.code : "SERVICE_RESPONSE_LOST"]);
        if (op.kind === "discover_provider") await db.query("UPDATE guild_market_providers SET enrollment_state=CASE WHEN revoked_at IS NULL THEN 'unavailable' ELSE enrollment_state END,last_failure='The original service discovery was not confirmed; recover or review its retained identity.',updated_at=now() WHERE id=$1", [op.provider_id]);
      });
      return unknownResult(session, command, op);
    }
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    const result: ProviderMarketCommandResult = { ok: false, commandId: command.commandId, error: { code: error.code, message: error.message, retryable: false, unknownOutcome: false } };
    if (error.status === 401 || error.code === "COMMAND_CHANGED") return result;
    return transaction(async db => {
      if (services.authorize) await services.authorize(db);
      await requireMarketSession(db, session); const prior = await commandLock(db, session, command);
      if (prior?.result) return prior.result;
      try { result.snapshot = await marketSnapshot(db, session, "commissionId" in command ? command.commissionId : undefined); } catch (failure) { if (!(failure instanceof DomainError)) throw failure; }
      await remember(db, session, command, result); return result;
    });
  }
}
