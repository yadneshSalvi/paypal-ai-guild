import { AgentCard, Artifact, Message, Role, SendMessageRequest, StreamResponse, Task, TaskState, TaskStatus,
  type CancelTaskRequest, type GetTaskRequest, type ListTasksRequest, type ListTasksResponse, type SubscribeToTaskRequest } from "@a2a-js/sdk";
import { ContentTypeNotSupportedError, ExtensionSupportRequiredError, PushNotificationNotSupportedError,
  RequestMalformedError, TaskNotCancelableError, TaskNotFoundError, UnsupportedOperationError } from "@a2a-js/sdk/errors";
import { type A2ARequestHandler, type ServerCallContext, validateVersion } from "@a2a-js/sdk/server";
import type { PoolClient } from "pg";
import { z } from "zod";
import { MARKET_EXTENSION, a2aMarketPayloadSchema, type A2AMarketPayload } from "@/contracts/provider-market";
import { marketContractDigest, marketSourceDigest, marketWorkCeiling } from "@/domain/provider-market";
import { digest, DomainError } from "@/domain/primitives";
import { getPool, transaction } from "../db";
import { executeCommandWithClient } from "../commissions";
import type { ProtocolPrincipal } from "./protocol-auth";
import { providerAgentCard, providerRow, requireMarketSession, type MarketDb } from "./registry";
import { cancelMarketTask, type MarketTaskRow } from "./delegation";
import { createOfferThread, declineOffer, proposeOffer, requireOfferThread, selectOffer, writablePackage } from "./offers";
import { marketCommission, taskView, type MarketOperationRow, type MarketThreadRow } from "./snapshot";
import { assertHistoryLength, historyBound, marketMessageMetadata, originalServiceTaskId, resultFromServiceTask, serviceResultMessage, terminalTask, type MarketServiceResult } from "./a2a-wire";
import { a2aNegotiatedVersion, a2aTimestampNanos, assertA2ATaskListParameters } from "./a2a-validation";
import { decodeA2ATaskCursor, readA2ATaskPage } from "./a2a-pagination";

interface Receipt { task_id: string; request_hash: string; task: unknown; message_id: string }
const uuid = z.string().uuid(), interrupted = (task: Task) => terminalTask(task) || [TaskState.TASK_STATE_INPUT_REQUIRED, TaskState.TASK_STATE_AUTH_REQUIRED].includes(task.status?.state ?? 0);
function assertProtocolHistoryLength(length?: number): void {
  try { assertHistoryLength(length); }
  catch (error) {
    if (error instanceof DomainError && error.code === "SERVICE_HISTORY_LIMIT") throw new RequestMalformedError(error.message);
    throw error;
  }
}
const delay = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(new Error("The protocol connection closed."));
  const done = () => { signal?.removeEventListener("abort", abort); resolve(); };
  const timer = setTimeout(done, ms), abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new Error("The protocol connection closed.")); };
  signal?.addEventListener("abort", abort, { once: true });
});

export async function lockMarketCommission(db: PoolClient, tenantId: string, commissionId: string) {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`guild-market-commission:${tenantId}:${commissionId}`]);
  return marketCommission(db, tenantId, commissionId, true);
}

/** Official A2A transport calls these durable business methods. No model or
 * payment request is made by negotiating or acknowledging a delegation. */
export class GuildA2AService implements A2ARequestHandler {
  constructor(readonly providerId: string, readonly principal: ProtocolPrincipal, readonly signal?: AbortSignal) {}

  async getAgentCard(): Promise<AgentCard> { return providerAgentCard(await providerRow(getPool(), this.providerId)); }

  private async authorize(context: ServerCallContext, dispatch = false) {
    await requireMarketSession(getPool(), this.principal.session);
    validateVersion(a2aNegotiatedVersion(context.requestedVersion), await this.getAgentCard(), "JSONRPC");
    if (context.tenant !== this.principal.session.tenantId || !context.user?.isAuthenticated || context.user.userName !== this.principal.session.id) throw new RequestMalformedError("The request tenant does not match its authenticated owner.");
    if (!context.requestedExtensions?.includes(MARKET_EXTENSION)) throw new ExtensionSupportRequiredError({ message: "The Guild contract-bound work extension is required.", metadata: { extension: MARKET_EXTENSION } });
    context.addActivatedExtension(MARKET_EXTENSION);
    if (this.principal.operation && (Date.parse(this.principal.operation.expiresAt) <= Date.now() || dispatch && this.principal.operation.mode !== "dispatch")) throw new RequestMalformedError("This credential permits only its original unexpired operation and result reads.");
    if (dispatch && !["owner", "judge"].includes(this.principal.session.role)) throw new RequestMalformedError("Delegated service work needs the original customer owner's authority.");
  }

  private parseMessage(params: SendMessageRequest): { payload: A2AMarketPayload; commissionRevision?: number } {
    const message = params.message;
    if (!message || !uuid.safeParse(message.messageId).success || message.role !== Role.ROLE_USER || message.parts.length !== 1
      || message.parts[0]?.content?.$case !== "data" || message.referenceTaskIds.length
      || !message.extensions.includes(MARKET_EXTENSION) || params.metadata && Object.keys(params.metadata).length) throw new RequestMalformedError("Send exactly one typed Guild data part with a stable message identity.");
    if (params.configuration?.taskPushNotificationConfig) throw new PushNotificationNotSupportedError();
    const modes = params.configuration?.acceptedOutputModes ?? [];
    if (modes.length && !modes.includes("application/json") && !modes.includes("*/*")) throw new ContentTypeNotSupportedError();
    const payload = a2aMarketPayloadSchema.safeParse(message.parts[0].content.value), metadata = marketMessageMetadata.safeParse(message.metadata);
    if (!payload.success || !metadata.success) throw new RequestMalformedError("The Guild work payload or its revision metadata is invalid.");
    if (["quote.request", "offer.accept", "work.delegate"].includes(payload.data.type) && metadata.data.guild.commissionRevision === undefined) throw new RequestMalformedError("This action needs the exact commission revision reviewed by the owner.");
    assertProtocolHistoryLength(params.configuration?.historyLength);
    return { payload: payload.data, commissionRevision: metadata.data.guild.commissionRevision };
  }

  private async validateMessageTaskReference(message: Message, context: ServerCallContext): Promise<void> {
    if (!message.taskId) return;
    // Resolve through the same original-actor/provider boundary as GetTask.
    // This happens before acquiring a transaction connection to avoid a nested
    // seventh pool lease when six requests arrive together.
    const task = await this.getTask({ id: message.taskId, tenant: this.principal.session.tenantId }, context);
    const inferredContext = message.contextId || task.contextId;
    if (inferredContext !== task.contextId) throw new RequestMalformedError("The message context differs from its referenced task.");
    if (terminalTask(task)) throw new UnsupportedOperationError("A terminal task cannot accept another message.");
    throw new UnsupportedOperationError("This contract-bound service does not amend an existing task through an additional message. Continue its retained work operation.");
  }

  private async validateMessageContext(db: PoolClient, message: Message, payload: A2AMarketPayload, op: MarketOperationRow | null): Promise<void> {
    if (!message.contextId) return;
    if (!uuid.safeParse(message.contextId).success) throw new RequestMalformedError("The provider conversation context is not available to this owner.");
    const actor = this.principal.session;
    const owned = op?.thread_id === message.contextId || (await db.query("SELECT 1 FROM guild_market_protocol_receipts WHERE tenant_id=$1 AND actor_id=$2 AND provider_id=$3 AND task->>'contextId'=$4 LIMIT 1",
      [actor.tenantId, actor.id, this.providerId, message.contextId])).rowCount;
    const thread = (await db.query<MarketThreadRow>("SELECT * FROM guild_market_threads WHERE id=$1 AND tenant_id=$2 AND provider_id=$3", [message.contextId, actor.tenantId, this.providerId])).rows[0];
    const matches = payload.type === "quote.request" ? thread?.commission_id === payload.commissionId && thread?.package_id === payload.packageId
      : message.contextId === (payload.type === "work.delegate" ? payload.delegation.threadId : payload.threadId);
    if (!owned || !thread || !matches) throw new RequestMalformedError("The provider conversation context is not available for this owner's exact work.");
  }

  private async perform(db: PoolClient, params: SendMessageRequest, payload: A2AMarketPayload, commissionRevision: number | undefined, op: MarketOperationRow | null): Promise<MarketServiceResult> {
    const actor = this.principal.session;
    let row: MarketThreadRow;
    if (payload.type === "quote.request") {
      const c = await lockMarketCommission(db, actor.tenantId, payload.commissionId), pkg = await writablePackage(db, c, payload.packageId);
      if (c.revision !== commissionRevision) throw new DomainError("COMMISSION_REVISION_CONFLICT", "The commission changed before its quote request reached the service.", 409, false);
      if (pkg.contractVersion !== payload.contractVersion || marketContractDigest(pkg) !== payload.contractDigest || pkg.acceptancePack.digest !== payload.acceptancePackDigest
        || marketSourceDigest(c, pkg) !== payload.sourceDigest || pkg.kind !== payload.kind || marketWorkCeiling(c, actor.expiresAt) !== payload.workAuthorityExpiresAt) throw new DomainError("MARKET_REQUEST_CHANGED", "The requested contract, criteria, sources or original expiry differ from the current commission.", 422, false);
      row = op?.thread_id || params.message!.contextId ? await requireOfferThread(db, actor.tenantId, op?.thread_id ?? params.message!.contextId) : await createOfferThread(db, actor, c, pkg, this.providerId);
      if (row.provider_id !== this.providerId || row.commission_id !== c.id || row.package_id !== pkg.id || row.state !== "requesting") throw new DomainError("MARKET_REQUEST_CHANGED", "The retained quote request belongs to different work.", 422, false);
      if (params.message!.contextId && params.message!.contextId !== row.id) throw new RequestMalformedError("The message belongs to a different provider conversation.");
      await proposeOffer(db, actor, row, payload.requestId);
    } else {
      const threadId = payload.type === "work.delegate" ? payload.delegation.threadId : payload.threadId;
      const hint = (await db.query<MarketThreadRow>("SELECT * FROM guild_market_threads WHERE id=$1 AND tenant_id=$2 AND provider_id=$3", [threadId, actor.tenantId, this.providerId])).rows[0];
      if (!hint) throw new DomainError("OFFER_NOT_FOUND", "This provider conversation is not available to the original owner.", 404, false);
      const c = await lockMarketCommission(db, actor.tenantId, hint.commission_id);
      row = await requireOfferThread(db, actor.tenantId, threadId, payload.type === "work.delegate" ? payload.delegation.offerRevision : payload.expectedRevision);
      if (params.message!.contextId && params.message!.contextId !== row.id) throw new RequestMalformedError("The message belongs to a different provider conversation.");
      if (payload.type === "offer.counter") await proposeOffer(db, actor, row, payload.requestId, payload.providerAwardMinor, payload.note);
      else if (payload.type === "offer.decline") await declineOffer(db, row, payload.requestId, "buyer", c.museum, payload.note);
      else if (payload.type === "offer.accept") await selectOffer(db, actor, row, payload.requestId, payload.termsDigest, commissionRevision!);
      else {
        if (c.revision !== commissionRevision) throw new DomainError("COMMISSION_REVISION_CONFLICT", "The commission changed before delegation reached the provider.", 409, false);
        const b = payload.delegation;
        const task = (await db.query<MarketTaskRow>("SELECT * FROM guild_market_tasks WHERE id=$1 AND tenant_id=$2 AND actor_id=$3 AND provider_id=$4 FOR UPDATE", [b.taskId, actor.tenantId, actor.id, this.providerId])).rows[0];
        if (!task || task.thread_id !== row.id || task.commission_id !== c.id || task.binding_digest !== digest(b) || digest(task.binding) !== digest(b)) throw new DomainError("MARKET_DELEGATION_CHANGED", "The exact original delegation is not retained for this owner and provider.", 422, false);
        const commandId = originalServiceTaskId(this.providerId, actor.tenantId, actor.id, `produce:${task.id}`);
        const result = await executeCommandWithClient(db, actor, c.id, { type: "produce_package", commandId, expectedRevision: c.revision, packageId: task.package_id }, { marketTaskId: task.id });
        if (!result.ok) throw new DomainError(result.code, result.message, 409, false);
        if (!result.jobId) throw new DomainError("MARKET_JOB_REQUIRED", "The production service did not retain an original job.", 503, false);
        await db.query("UPDATE guild_market_tasks SET original_job_id=$2,updated_at=now() WHERE id=$1 AND original_job_id IS NULL", [task.id, result.jobId]);
        await db.query("UPDATE guild_jobs SET input=input || $2::jsonb WHERE id=$1", [result.jobId, JSON.stringify({ marketTaskId: task.id, marketBindingDigest: task.binding_digest })]);
        return { version: "guild.market-service-result.v1", ok: true, providerId: this.providerId, commandId: payload.requestId, threadId: row.id, taskId: task.id,
          message: "The exact delegation and original worker are saved. No artifact acceptance, capture or payout is implied." };
      }
    }
    return { version: "guild.market-service-result.v1", ok: true, providerId: this.providerId, commandId: payload.requestId, threadId: row.id, taskId: null,
      message: payload.type === "offer.accept" ? "The exact offer is selected. Fresh Passport approval is required before delegation." : "The provider conversation and policy decisions are retained. No money moved." };
  }

  private async receive(params: SendMessageRequest, context: ServerCallContext): Promise<Task> {
    await this.authorize(context, true);
    const { payload, commissionRevision } = this.parseMessage(params), actor = this.principal.session, message = params.message!;
    await this.validateMessageTaskReference(message, context);
    const requestHash = digest(SendMessageRequest.toJSON(params)), taskId = originalServiceTaskId(this.providerId, actor.tenantId, actor.id, message.messageId);
    return transaction(async db => {
      await requireMarketSession(db, actor);
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`guild-a2a-receipt:${this.providerId}:${actor.tenantId}:${actor.id}:${message.messageId}`]);
      const prior = (await db.query<Receipt>("SELECT * FROM guild_market_protocol_receipts WHERE provider_id=$1 AND tenant_id=$2 AND actor_id=$3 AND message_id=$4", [this.providerId, actor.tenantId, actor.id, message.messageId])).rows[0];
      if (prior) {
        if (prior.request_hash !== requestHash || prior.task_id !== taskId) throw new RequestMalformedError("This message identity already belongs to a different request.");
        return Task.fromJSON(prior.task);
      }
      let op: MarketOperationRow | null = null;
      if (this.principal.operation) {
        op = (await db.query<MarketOperationRow>("SELECT * FROM guild_market_operations WHERE id=$1 AND actor_id=$2 AND tenant_id=$3 AND provider_id=$4", [this.principal.operation.operationId, actor.id, actor.tenantId, this.providerId])).rows[0] ?? null;
        if (!op || op.state !== "dispatching" || op.original_message_id !== message.messageId || op.original_task_id !== taskId || op.command_id !== payload.requestId
          || op.request_digest !== requestHash || digest(op.request_body) !== requestHash || op.original_work_ceiling.getTime() <= Date.now()) throw new RequestMalformedError("The message differs from its exact original dispatch authority.");
      }
      await this.validateMessageContext(db, message, payload, op);
      await db.query("SAVEPOINT market_business");
      let result: MarketServiceResult;
      try { result = await this.perform(db, params, payload, commissionRevision, op); await db.query("RELEASE SAVEPOINT market_business"); }
      catch (error) {
        await db.query("ROLLBACK TO SAVEPOINT market_business");
        if (!(error instanceof DomainError)) throw error;
        result = { version: "guild.market-service-result.v1", ok: false, providerId: this.providerId, commandId: payload.requestId, code: error.code, message: error.message };
        if (payload.type === "work.delegate") await db.query("UPDATE guild_market_tasks SET state='rejected',revision=revision+1,updated_at=now() WHERE id=$1 AND tenant_id=$2 AND actor_id=$3 AND provider_id=$4 AND original_job_id IS NULL AND state='submitted' AND binding_digest=$5", [payload.delegation.taskId, actor.tenantId, actor.id, this.providerId, digest(payload.delegation)]);
      }
      const contextId = result.ok ? result.threadId : message.contextId || op?.thread_id || taskId, reply = serviceResultMessage(taskId, contextId, result);
      const task = Task.fromJSON({ id: taskId, contextId, status: { state: result.ok ? result.taskId ? "TASK_STATE_SUBMITTED" : "TASK_STATE_COMPLETED" : "TASK_STATE_REJECTED", timestamp: new Date().toISOString(), message: Message.toJSON(reply) },
        history: [Message.toJSON({ ...message, taskId, contextId }), Message.toJSON(reply)], artifacts: [],
        metadata: { version: "guild.a2a-task.v1", providerId: this.providerId, originalMessageId: message.messageId, kind: payload.type, marketTaskId: result.ok ? result.taskId : null } });
      await db.query("INSERT INTO guild_market_protocol_receipts(provider_id,tenant_id,actor_id,message_id,request_hash,task_id,task) VALUES($1,$2,$3,$4,$5,$6,$7)", [this.providerId, actor.tenantId, actor.id, message.messageId, requestHash, taskId, Task.toJSON(task)]);
      return task;
    });
  }

  async sendMessage(params: SendMessageRequest, context: ServerCallContext): Promise<Task> {
    let task = await this.receive(params, context);
    if (!params.configuration?.returnImmediately && !interrupted(task)) {
      while (!interrupted(task)) {
        await delay(500, this.signal); task = await this.getTask({ id: task.id, tenant: this.principal.session.tenantId }, context);
      }
    }
    return historyBound(task, params.configuration?.historyLength);
  }

  async getTask(params: GetTaskRequest, context: ServerCallContext): Promise<Task> {
    await this.authorize(context);
    assertProtocolHistoryLength(params.historyLength);
    return this.readTask(getPool(), params);
  }

  private async readTask(db: MarketDb, params: GetTaskRequest): Promise<Task> {
    if (!uuid.safeParse(params.id).success || this.principal.operation && params.id !== originalServiceTaskId(this.providerId, this.principal.session.tenantId, this.principal.session.id, this.principal.operation.messageId)) throw new TaskNotFoundError();
    const actor = this.principal.session;
    const row = (await db.query<Receipt>("SELECT * FROM guild_market_protocol_receipts WHERE task_id=$1 AND provider_id=$2 AND tenant_id=$3 AND actor_id=$4", [params.id, this.providerId, actor.tenantId, actor.id])).rows[0];
    if (!row) throw new TaskNotFoundError();
    let task = Task.fromJSON(row.task);
    const result = resultFromServiceTask(task);
    if (result.ok && result.taskId) {
      const work = (await db.query<MarketTaskRow>("SELECT * FROM guild_market_tasks WHERE id=$1 AND tenant_id=$2 AND actor_id=$3 AND provider_id=$4", [result.taskId, actor.tenantId, actor.id, this.providerId])).rows[0];
      if (!work) throw new TaskNotFoundError();
      const c = await marketCommission(db, actor.tenantId, work.commission_id), view = await taskView(db, work, c, true);
      const states = { submitted: TaskState.TASK_STATE_SUBMITTED, working: TaskState.TASK_STATE_WORKING, input_required: TaskState.TASK_STATE_INPUT_REQUIRED,
        auth_required: TaskState.TASK_STATE_AUTH_REQUIRED, completed: TaskState.TASK_STATE_COMPLETED, failed: TaskState.TASK_STATE_FAILED, cancelled: TaskState.TASK_STATE_CANCELED, rejected: TaskState.TASK_STATE_REJECTED };
      task = { ...task, status: { state: states[view.state], timestamp: view.updatedAt, message: task.status?.message },
        artifacts: view.artifacts.map(artifact => Artifact.fromJSON({ artifactId: artifact.id, name: artifact.title, description: "Retained provider artifact; customer acceptance and payment are separate.",
          parts: [{ data: artifact }], extensions: [MARKET_EXTENSION] })),
        metadata: { ...task.metadata, originalJobId: view.originalJobId, statusMessage: view.statusMessage, taskRevision: view.revision,
          acceptance: view.acceptance, payment: view.payment, bindingDigest: work.binding_digest } };
    }
    return historyBound(task, params.historyLength);
  }

  async cancelTask(params: CancelTaskRequest, context: ServerCallContext): Promise<Task> {
    await this.authorize(context, true);
    if (this.principal.operation) throw new TaskNotCancelableError("An operation credential cannot authorize a separate cancellation.");
    const task = await this.getTask({ id: params.id, tenant: params.tenant }, context), result = resultFromServiceTask(task);
    const note = z.object({ note: z.string().trim().min(1).max(1200) }).strict().safeParse(params.metadata);
    if (!result.ok || !result.taskId || !note.success) throw new TaskNotCancelableError("Only an unstarted delegated task can be cancelled with its owner's explicit reason.");
    try {
      await transaction(async db => {
        const hint = (await db.query<MarketTaskRow>("SELECT * FROM guild_market_tasks WHERE id=$1 AND actor_id=$2 AND tenant_id=$3 AND provider_id=$4", [result.taskId, this.principal.session.id, this.principal.session.tenantId, this.providerId])).rows[0];
        if (!hint) throw new TaskNotFoundError();
        const c = await lockMarketCommission(db, hint.tenant_id, hint.commission_id);
        const work = (await db.query<MarketTaskRow>("SELECT * FROM guild_market_tasks WHERE id=$1 FOR UPDATE", [hint.id])).rows[0]!;
        await cancelMarketTask(db, this.principal.session, work, c, note.data.note);
      });
    } catch (error) { if (error instanceof DomainError) throw new TaskNotCancelableError({ message: error.message, metadata: { guildCode: error.code } }); throw error; }
    return this.getTask({ id: task.id, tenant: params.tenant }, context);
  }

  private async *watch(task: Task, context: ServerCallContext): AsyncGenerator<StreamResponse> {
    yield StreamResponse.fromJSON({ task: Task.toJSON(task) });
    const deadline = Date.now() + 25_000;
    while (!interrupted(task) && Date.now() < deadline && !this.signal?.aborted) {
      await delay(750, this.signal);
      const next = await this.getTask({ id: task.id, tenant: this.principal.session.tenantId }, context);
      for (const artifact of next.artifacts) if (!task.artifacts.some(prior => prior.artifactId === artifact.artifactId && digest(Artifact.toJSON(prior)) === digest(Artifact.toJSON(artifact)))) {
        yield StreamResponse.fromJSON({ artifactUpdate: { taskId: next.id, contextId: next.contextId, artifact: Artifact.toJSON(artifact), append: false, lastChunk: true } });
      }
      if (digest(TaskStatus.toJSON(next.status!)) !== digest(TaskStatus.toJSON(task.status!))) yield StreamResponse.fromJSON({ statusUpdate: { taskId: next.id, contextId: next.contextId, status: TaskStatus.toJSON(next.status!), metadata: next.metadata } });
      task = next;
    }
  }
  async *sendMessageStream(params: SendMessageRequest, context: ServerCallContext): AsyncGenerator<StreamResponse> { yield* this.watch(await this.receive(params, context), context); }
  async *resubscribe(params: SubscribeToTaskRequest, context: ServerCallContext): AsyncGenerator<StreamResponse> {
    const task = await this.getTask({ id: params.id, tenant: params.tenant }, context);
    if (terminalTask(task)) throw new UnsupportedOperationError("A terminal task cannot be subscribed to; retrieve its retained result with GetTask.");
    yield* this.watch(task, context);
  }

  async listTasks(params: ListTasksRequest, context: ServerCallContext): Promise<ListTasksResponse> {
    await this.authorize(context);
    assertProtocolHistoryLength(params.historyLength);
    assertA2ATaskListParameters(params);
    if (this.principal.operation) throw new UnsupportedOperationError("An operation credential can read only its original task.");
    const pageSize = params.pageSize ?? 50;
    const after = params.statusTimestampAfter === undefined ? undefined : a2aTimestampNanos(params.statusTimestampAfter);
    const scope = digest({ tenantId: this.principal.session.tenantId, actorId: this.principal.session.id, providerId: this.providerId,
      contextId: params.contextId || "", status: params.status, statusTimestampAfter: after?.toString() ?? null });
    const cursor = params.pageToken ? decodeA2ATaskCursor(params.pageToken, scope) : null;
    return transaction(async db => {
      await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
      await requireMarketSession(db, this.principal.session);
      return readA2ATaskPage(db, { providerId: this.providerId, tenantId: this.principal.session.tenantId, actorId: this.principal.session.id,
        contextId: params.contextId, after, status: params.status, pageSize, cursor, scope, includeArtifacts: params.includeArtifacts ?? false },
      id => this.readTask(db, { id, tenant: params.tenant, historyLength: params.historyLength }));
    });
  }
  async getAuthenticatedExtendedAgentCard(): Promise<never> { throw new UnsupportedOperationError("This provider does not advertise an authenticated extended Agent Card."); }
  async createTaskPushNotificationConfig(): Promise<never> { throw new PushNotificationNotSupportedError(); }
  async getTaskPushNotificationConfig(): Promise<never> { throw new PushNotificationNotSupportedError(); }
  async listTaskPushNotificationConfigs(): Promise<never> { throw new PushNotificationNotSupportedError(); }
  async deleteTaskPushNotificationConfig(): Promise<never> { throw new PushNotificationNotSupportedError(); }
}
