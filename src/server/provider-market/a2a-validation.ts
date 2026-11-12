import type { ListTasksRequest } from "@a2a-js/sdk";
import { RequestMalformedError } from "@a2a-js/sdk/errors";

const taskStates = new Set(["TASK_STATE_UNSPECIFIED", "TASK_STATE_SUBMITTED", "TASK_STATE_WORKING", "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED", "TASK_STATE_CANCELED", "TASK_STATE_INPUT_REQUIRED", "TASK_STATE_REJECTED", "TASK_STATE_AUTH_REQUIRED"]);
const roles = new Set(["ROLE_UNSPECIFIED", "ROLE_USER", "ROLE_AGENT"]);
const present = (value: unknown) => value !== undefined && value !== null;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function invalid(field: string): never { throw new RequestMalformedError(`The ${field} parameter has an invalid JSON type or value.`); }
function string(value: unknown, field: string, required = false): void {
  if (!present(value)) { if (required) invalid(field); return; }
  if (typeof value !== "string" || required && !value.length) invalid(field);
}
function object(value: unknown, field: string, required = false): void {
  if (!present(value)) { if (required) invalid(field); return; }
  if (!record(value)) invalid(field);
}
function integer(value: unknown, field: string, minimum: number, maximum: number): void {
  if (present(value) && (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum)) invalid(field);
}
function boolean(value: unknown, field: string): void { if (present(value) && typeof value !== "boolean") invalid(field); }
function strings(value: unknown, field: string): void {
  if (present(value) && (!Array.isArray(value) || value.some(item => typeof item !== "string"))) invalid(field);
}

/** A2A 1.0.1 §5.6.1 requires UTC timestamps. Keep nanosecond precision for
 * filtering and cursor ordering instead of rounding through Date.parse. */
export function a2aTimestampNanos(value: string): bigint {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
  if (!match || value.startsWith("0000-")) invalid("timestamp");
  const milliseconds = Date.parse(`${match[1]}Z`);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 19) !== match[1]) invalid("timestamp");
  return BigInt(milliseconds) * 1_000_000n + BigInt((match[2] ?? "").padEnd(9, "0"));
}

/** Patch revisions describe the specification, not a different wire version
 * (§3.6). Responses and Agent Cards continue to advertise Major.Minor only. */
export function a2aNegotiatedVersion(value: string): string {
  const match = /^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:\.(?:0|[1-9]\d*))?$/.exec(value);
  return match?.[1] ?? value;
}

/** Validate before generated fromJSON functions can coerce strings/objects into
 * booleans, numbers or identifiers. Unknown fields remain forward compatible.
 * Null optional fields retain ProtoJSON's unset semantics. */
export function assertRawA2AParameters(method: unknown, value: unknown): void {
  const supported = new Set(["SendMessage", "SendStreamingMessage", "GetTask", "ListTasks", "CancelTask", "SubscribeToTask", "GetExtendedAgentCard",
    "CreateTaskPushNotificationConfig", "GetTaskPushNotificationConfig", "ListTaskPushNotificationConfigs", "DeleteTaskPushNotificationConfig"]);
  if (typeof method !== "string" || !supported.has(method)) return;
  if (method === "GetExtendedAgentCard" && value === undefined) return;
  if (!record(value)) invalid("params");
  string(value.tenant, "tenant");
  if (method === "ListTasks") {
    string(value.contextId, "contextId"); string(value.pageToken, "pageToken");
    integer(value.pageSize, "pageSize", 1, 100); integer(value.historyLength, "historyLength", 0, 2_147_483_647);
    boolean(value.includeArtifacts, "includeArtifacts");
    if (present(value.status) && (typeof value.status !== "string" || !taskStates.has(value.status))) invalid("status");
    if (present(value.statusTimestampAfter)) {
      string(value.statusTimestampAfter, "statusTimestampAfter"); a2aTimestampNanos(value.statusTimestampAfter as string);
    }
  } else if (["GetTask", "SubscribeToTask", "CancelTask"].includes(method)) {
    string(value.id, "id", true);
    if (method === "GetTask") integer(value.historyLength, "historyLength", 0, 2_147_483_647);
    if (method === "CancelTask") object(value.metadata, "metadata");
  } else if (method === "SendMessage" || method === "SendStreamingMessage") {
    object(value.message, "message", true); object(value.configuration, "configuration"); object(value.metadata, "metadata");
    const message = value.message as Record<string, unknown>;
    string(message.messageId, "message.messageId", true); string(message.contextId, "message.contextId"); string(message.taskId, "message.taskId");
    if (typeof message.role !== "string" || !roles.has(message.role)) invalid("message.role");
    object(message.metadata, "message.metadata"); strings(message.extensions, "message.extensions"); strings(message.referenceTaskIds, "message.referenceTaskIds");
    if (!Array.isArray(message.parts) || !message.parts.length) invalid("message.parts");
    for (const part of message.parts) {
      if (!record(part)) invalid("message.parts");
      for (const key of ["text", "raw", "url", "filename", "mediaType"]) string(part[key], `message.parts.${key}`);
      object(part.metadata, "message.parts.metadata");
      if (["text", "raw", "url", "data"].filter(key => key === "data" ? Object.hasOwn(part, key) : present(part[key])).length !== 1) invalid("message.parts.content");
    }
    if (record(value.configuration)) {
      strings(value.configuration.acceptedOutputModes, "configuration.acceptedOutputModes");
      integer(value.configuration.historyLength, "configuration.historyLength", 0, 2_147_483_647);
      boolean(value.configuration.returnImmediately, "configuration.returnImmediately");
      object(value.configuration.taskPushNotificationConfig, "configuration.taskPushNotificationConfig");
    }
  }
}

export function assertA2ATaskListParameters(params: ListTasksRequest): void {
  integer(params.pageSize, "pageSize", 1, 100); integer(params.historyLength, "historyLength", 0, 2_147_483_647);
  boolean(params.includeArtifacts, "includeArtifacts"); string(params.contextId, "contextId"); string(params.pageToken, "pageToken");
  if (!Number.isSafeInteger(params.status) || params.status < 0 || params.status > 8) invalid("status");
  if (present(params.statusTimestampAfter)) a2aTimestampNanos(params.statusTimestampAfter!);
}
