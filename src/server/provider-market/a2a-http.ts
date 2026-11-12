import { AgentCard, Extensions, SSE_HEADERS, formatSSEEvent } from "@a2a-js/sdk";
import { A2AError, ExtensionSupportRequiredError, RequestMalformedError, toJsonRpcError } from "@a2a-js/sdk/errors";
import { JsonRpcTransportHandler, ServerCallContext, validateVersion } from "@a2a-js/sdk/server";
import { A2A_PROTOCOL, MARKET_EXTENSION } from "@/contracts/provider-market";
import { DomainError } from "@/domain/primitives";
import { getPool } from "../db";
import { readJson } from "../http";
import { authenticateProtocol } from "./protocol-auth";
import { GuildA2AService } from "./a2a-service";
import { providerAgentCard, providerRow } from "./registry";

const privateHeaders = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "A2A-Version": A2A_PROTOCOL.protocolVersion };

export async function marketAgentCardResponse(providerId: string): Promise<Response> {
  try {
    const row = await providerRow(getPool(), providerId);
    if (row.revoked_at) throw new DomainError("PROVIDER_UNAVAILABLE", "This provider has withdrawn its service.", 410, false);
    return Response.json(AgentCard.toJSON(providerAgentCard(row)), { headers: { ...privateHeaders, "Access-Control-Allow-Origin": "*" } });
  } catch (error) { return businessHttpError(error); }
}

function businessHttpError(error: unknown): Response {
  if (error instanceof DomainError) return Response.json({ error: error.code, message: error.message }, { status: error.status, headers: { ...privateHeaders, ...(error.status === 401 ? { "WWW-Authenticate": "Bearer" } : {}) } });
  return Response.json({ error: "SERVICE_UNAVAILABLE", message: "The provider service is unavailable. Retain the original request identity before recovering its result." }, { status: 503, headers: privateHeaders });
}

export async function marketA2AResponse(request: Request, providerId: string): Promise<Response> {
  let principal;
  try { principal = await authenticateProtocol(request, "a2a", providerId); }
  catch (error) { return businessHttpError(error); }
  let body: unknown;
  try { body = await readJson(request, 65_536); }
  catch (error) {
    if (error instanceof DomainError && error.code === "INVALID_JSON") return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "The JSON-RPC body could not be parsed." } }, { headers: privateHeaders });
    return businessHttpError(error);
  }
  const rpc = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const id = typeof rpc.id === "string" || typeof rpc.id === "number" ? rpc.id : null;
  try {
    const params = rpc.params && typeof rpc.params === "object" && !Array.isArray(rpc.params) ? rpc.params as Record<string, unknown> : {};
    if (params.tenant && params.tenant !== principal.session.tenantId) throw new RequestMalformedError("The requested tenant differs from the authenticated workspace.");
    const extensions = Extensions.parseServiceParameter(request.headers.get("a2a-extensions") ?? undefined);
    const context = new ServerCallContext({ requestedVersion: request.headers.get("a2a-version") ?? "0.3", requestedExtensions: extensions,
      user: { isAuthenticated: true, userName: principal.session.id }, ...(params.tenant ? {} : { tenant: principal.session.tenantId }) });
    const service = new GuildA2AService(providerId, principal, request.signal), card = await service.getAgentCard();
    validateVersion(context.requestedVersion, card, "JSONRPC");
    if (!extensions?.includes(MARKET_EXTENSION)) throw new ExtensionSupportRequiredError({ message: "The Guild contract-bound work extension is required.", metadata: { extension: MARKET_EXTENSION } });
    const result = await new JsonRpcTransportHandler(service).handle(body as Record<string, unknown>, context);
    const headers = { ...privateHeaders, "A2A-Extensions": MARKET_EXTENSION };
    if (Symbol.asyncIterator in result) {
      const iterator = result[Symbol.asyncIterator](), encoder = new TextEncoder(); let closed = false;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (closed) return;
          try {
            const next = await iterator.next();
            if (next.done) { closed = true; controller.close(); return; }
            controller.enqueue(encoder.encode(formatSSEEvent(next.value)));
          } catch (error) {
            closed = true;
            controller.enqueue(encoder.encode(formatSSEEvent({ jsonrpc: "2.0", id, error: error instanceof A2AError ? toJsonRpcError(error) : { code: -32603, message: "The original task remains retained. Reconnect to read its current status." } })));
            controller.close();
          }
        },
        async cancel() { closed = true; await iterator.return?.(); },
      });
      return new Response(stream, { headers: { ...SSE_HEADERS, ...headers } });
    }
    return Response.json(result, { headers });
  } catch (error) {
    return Response.json({ jsonrpc: "2.0", id, error: error instanceof A2AError ? toJsonRpcError(error) : { code: -32603, message: "The original operation remains retained for review." } }, { headers: privateHeaders });
  }
}
