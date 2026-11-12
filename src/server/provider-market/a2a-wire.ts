import { createHash } from "node:crypto";
import { Message, Role, SendMessageRequest, Task, TaskState } from "@a2a-js/sdk";
import { z } from "zod";
import { MARKET_EXTENSION, a2aMarketPayloadSchema, type A2AMarketPayload } from "@/contracts/provider-market";
import { DomainError } from "@/domain/primitives";

export const marketMessageMetadata = z.object({ guild: z.object({ commissionRevision: z.number().int().nonnegative().optional() }).strict() }).strict();
export const marketServiceResult = z.discriminatedUnion("ok", [
  z.object({ version: z.literal("guild.market-service-result.v1"), ok: z.literal(true), providerId: z.string(), commandId: z.string().uuid(),
    threadId: z.string().uuid(), taskId: z.string().uuid().nullable(), message: z.string() }).strict(),
  z.object({ version: z.literal("guild.market-service-result.v1"), ok: z.literal(false), providerId: z.string(), commandId: z.string().uuid(),
    code: z.string(), message: z.string() }).strict(),
]);
export type MarketServiceResult = z.infer<typeof marketServiceResult>;

/** The original operation knows its service task identity before dispatch. */
export function originalServiceTaskId(providerId: string, tenantId: string, actorId: string, messageId: string): string {
  const bytes = createHash("sha256").update(`guild-a2a-task-v1:${providerId}:${tenantId}:${actorId}:${messageId}`).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function marketSendRequest(messageId: string, payload: A2AMarketPayload, tenantId: string, contextId?: string, commissionRevision?: number): SendMessageRequest {
  return SendMessageRequest.fromJSON({ tenant: tenantId, configuration: { returnImmediately: true, acceptedOutputModes: ["application/json"], historyLength: 2 },
    message: { messageId, role: "ROLE_USER", ...(contextId ? { contextId } : {}),
      parts: [{ data: a2aMarketPayloadSchema.parse(payload) }], extensions: [MARKET_EXTENSION],
      metadata: { guild: { ...(commissionRevision === undefined ? {} : { commissionRevision }) } } } });
}

export function serviceResultMessage(taskId: string, contextId: string, value: MarketServiceResult): Message {
  return Message.fromJSON({ messageId: originalServiceTaskId(value.providerId, taskId, contextId, value.commandId), taskId, contextId,
    role: "ROLE_AGENT", extensions: [MARKET_EXTENSION], parts: [{ data: marketServiceResult.parse(value) }] });
}

export function resultFromServiceTask(task: Task): MarketServiceResult {
  const message = [...task.history].reverse().find(item => item.role === Role.ROLE_AGENT && item.parts.some(part => part.content?.$case === "data" && part.content.value?.version === "guild.market-service-result.v1"));
  const part = message?.parts.find(item => item.content?.$case === "data");
  const parsed = marketServiceResult.safeParse(part?.content?.$case === "data" ? part.content.value : null);
  if (!parsed.success) throw new DomainError("SERVICE_RESULT_UNBOUND", "The original service result lacks its exact typed Guild receipt.", 502, false);
  return parsed.data;
}

export function assertHistoryLength(length?: number): void {
  if (length !== undefined && (!Number.isSafeInteger(length) || length < 0 || length > 100)) throw new DomainError("SERVICE_HISTORY_LIMIT", "History length must be between zero and 100.", 400, false);
}
export function historyBound(task: Task, length?: number): Task {
  assertHistoryLength(length);
  return { ...task, history: task.history.slice(-Math.min(length ?? 50, 50)).filter(() => length !== 0) };
}

export const terminalTask = (task: Task) => [TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_FAILED, TaskState.TASK_STATE_CANCELED, TaskState.TASK_STATE_REJECTED].includes(task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED);
