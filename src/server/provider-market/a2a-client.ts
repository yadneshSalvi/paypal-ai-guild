import { AgentCard, GetTaskRequest, SendMessageRequest, Task } from "@a2a-js/sdk";
import { ClientFactory, JsonRpcTransportFactory, ServiceParameters, withA2AExtensions } from "@a2a-js/sdk/client";
import { MARKET_EXTENSION } from "@/contracts/provider-market";
import { digest, DomainError } from "@/domain/primitives";
import type { Session } from "../session";
import { issueProviderCredential } from "./protocol-auth";
import { marketOrigin } from "./registry";
import type { MarketOperationRow } from "./snapshot";
import { resultFromServiceTask } from "./a2a-wire";

export interface MarketTransport { dispatch(op: MarketOperationRow, session: Session): Promise<Task>; readOriginal(op: MarketOperationRow, session: Session): Promise<Task> }

/** This transport cannot follow an arbitrary card URL, redirect, or retry a
 * write. The registered official SDK still owns all A2A wire serialization. */
export function providerMarketTransport(fetcher: typeof fetch = fetch): MarketTransport {
  async function client(op: MarketOperationRow, session: Session, mode: "dispatch" | "read") {
    const expected = `${marketOrigin()}/api/providers/${op.provider_id}/a2a`;
    if (!op.provider_endpoint || op.provider_endpoint !== expected || !op.provider_card || !op.provider_card_digest || digest(op.provider_card) !== op.provider_card_digest) throw new DomainError("SERVICE_ENDPOINT_CHANGED", "The original enrolled endpoint and agent card are not retained for this operation.", 422, false);
    const card = AgentCard.fromJSON(op.provider_card), supported = card.supportedInterfaces.filter(item => item.protocolBinding === "JSONRPC" && item.protocolVersion === "1.0");
    if (supported.length !== 1 || supported[0]!.url !== op.provider_endpoint) throw new DomainError("SERVICE_CARD_CHANGED", "The original service card does not bind this exact endpoint and protocol.", 422, false);
    const credential = issueProviderCredential(op, session, mode);
    const boundedFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url !== op.provider_endpoint || init?.method !== "POST") throw new DomainError("SERVICE_ENDPOINT_CHANGED", "The service client attempted a different transport address.", 422, false);
      const headers = new Headers(init.headers); headers.set("Authorization", `Bearer ${credential}`);
      const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
      const response = await fetcher(input, { ...init, headers, signal, redirect: "error", cache: "no-store" });
      if (!response.body) return response;
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength;
        if (size > 2_097_152) { await reader.cancel(); throw new DomainError("SERVICE_RESPONSE_LIMIT", "The original service response exceeds the retained byte limit.", 502, false); } chunks.push(next.value); }
      } finally { reader.releaseLock(); }
      return new Response(Buffer.concat(chunks), { status: response.status, statusText: response.statusText, headers: response.headers });
    };
    return new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl: boundedFetch })], preferredTransports: ["JSONRPC"], clientConfig: { polling: true, acceptedOutputModes: ["application/json"] } }).createFromAgentCard(card);
  }
  function checked(op: MarketOperationRow, task: Task): Task {
    const result = resultFromServiceTask(task);
    if (task.id !== op.original_task_id || task.metadata?.originalMessageId !== op.original_message_id || result.providerId !== op.provider_id || result.commandId !== op.command_id
      || result.ok && result.threadId !== op.thread_id) throw new DomainError("SERVICE_RESULT_CHANGED", "The response does not belong to this exact original operation.", 502, false);
    return task;
  }
  return {
    async dispatch(op, session) {
      const sdk = await client(op, session, "dispatch"), params = SendMessageRequest.fromJSON(op.request_body);
      if (digest(SendMessageRequest.toJSON(params)) !== op.request_digest || params.message?.messageId !== op.original_message_id) throw new DomainError("SERVICE_REQUEST_CHANGED", "The stored request differs from its original digest and message identity.", 422, false);
      const result = await sdk.sendMessage(params, { serviceParameters: ServiceParameters.create(withA2AExtensions(MARKET_EXTENSION)) });
      if ("messageId" in result) throw new DomainError("SERVICE_TASK_REQUIRED", "The service did not return the original durable task.", 502, false);
      return checked(op, result);
    },
    async readOriginal(op, session) {
      if (!op.original_task_id) throw new DomainError("SERVICE_TASK_REQUIRED", "This operation has no retained task identity to read.", 422, false);
      const sdk = await client(op, session, "read");
      return checked(op, await sdk.getTask(GetTaskRequest.fromJSON({ id: op.original_task_id, tenant: session.tenantId, historyLength: 2 }), { serviceParameters: ServiceParameters.create(withA2AExtensions(MARKET_EXTENSION)) }));
    },
  };
}
