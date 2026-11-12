import { createMcpHandler, McpServer, type CallToolResult, type JSONObject } from "@modelcontextprotocol/server";
import { z, ZodError } from "zod";
import { createCommissionSchema } from "@/contracts/guild";
import { mcpApprovalLinkSchema, mcpCommissionCreateSchema, mcpCommissionStatusSchema, type McpCommissionDraftResult, type McpCommissionStatusResult } from "@/contracts/provider-market";
import { planDigest } from "@/domain/fixture";
import { DomainError } from "@/domain/primitives";
import { createCommission, getCommission } from "../commissions";
import { getPool } from "../db";
import { errorResponse } from "../http";
import { issueApprovalLink } from "./approval-links";
import { requireCommissionOwner } from "./mcp-authority";
import { privateMcpResponse, requireConfiguredOrigin } from "./mcp-http";
import { mcpBusinessRefusalSchema, mcpDraftResultSchema, mcpLinkResultSchema, mcpStatusResultSchema } from "./mcp-results";
import { authenticateProtocol, type ProtocolPrincipal } from "./protocol-auth";
import { marketOrigin, requireMarketSession } from "./registry";

export const MCP_MAX_REQUEST_BYTES = 32_768;
async function authorized(principal: ProtocolPrincipal): Promise<void> {
  requireCommissionOwner(principal.session);
  if (!principal.scopes.includes("mcp") || principal.operation || principal.providerId) throw new DomainError("MCP_SCOPE_REQUIRED", "This client has no commission-tool authority.", 403, false);
  await requireMarketSession(getPool(), principal.session);
}
async function toolResult(run: () => Promise<object>, text: string, mutating: boolean): Promise<CallToolResult> {
  try { return { content: [{ type: "text", text }], structuredContent: await run() as JSONObject }; }
  catch (error) {
    const known = error instanceof DomainError || error instanceof ZodError;
    const refusal = mcpBusinessRefusalSchema.parse({ ok: false, error: {
      code: error instanceof DomainError ? error.code : error instanceof ZodError ? "MCP_INPUT_REFUSED" : "MCP_RESULT_UNKNOWN",
      message: error instanceof DomainError ? error.message : error instanceof ZodError ? "This request is outside the tool's supported fields or limits." : mutating ? "The tool result is unknown. Retry the same request ID and exact content to recover its original outcome." : "The current status could not be read. No work or financial action was dispatched.",
      retryable: error instanceof DomainError ? error.recoverable : !known, unknownOutcome: !known && mutating,
    }, paymentAuthorized: false });
    return { isError: true, content: [{ type: "text", text: refusal.error.message }], structuredContent: refusal };
  }
}
/** The official SDK owns protocol envelopes, discovery, initialization and transport. */
export function createGuildMcpServer(principal: ProtocolPrincipal): McpServer {
  const server = new McpServer({ name: "guild-commissions", version: "1.0.0" }, { capabilities: { tools: { listChanged: false } }, instructions: "Create and inspect owned commission drafts, or obtain an owner-bound one-use link to Passport. These tools cannot approve a plan, approve funds, produce work, capture payment, or pay providers." });
  server.registerTool("commission.create", {
    title: "Create an owned commission draft", description: "Save a brief with no sources selected. The current commission service accepts a USD cap from $1.00 to $640.00. statusUri opens the studio; commission.status reads machine progress. No approval or production is dispatched.",
    inputSchema: mcpCommissionCreateSchema, outputSchema: z.union([mcpDraftResultSchema, mcpBusinessRefusalSchema]), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, input => toolResult(async () => {
    await authorized(principal);
    const parsed = createCommissionSchema.safeParse({ commandId: input.requestId, title: input.title, museum: "Guild commission", objective: input.brief, capMinor: input.capMinor, languages: input.languages, sourceIds: [] });
    if (!parsed.success) throw new DomainError("MCP_COMMISSION_SERVICE_RANGE", "The current commission service accepts a cap from $1.00 to $640.00. The original request was not changed.", 422, false);
    const commission = await createCommission(principal.session, parsed.data, []);
    const result: McpCommissionDraftResult = { commissionId: commission.id, state: "draft", statusUri: new URL(`/?commission=${encodeURIComponent(commission.id)}`, marketOrigin()).href, approvalRequired: true, paymentAuthorized: false };
    return mcpDraftResultSchema.parse(result);
  }, "The owned draft is retained. Compile and review it in the original workspace; no payment is authorized.", true));
  server.registerTool("commission.status", {
    title: "Read current owned commission status", description: "Read allowlisted package progress, exact current-plan approval and recorded capture/payout totals. This read does not refresh providers or dispatch background work.",
    inputSchema: mcpCommissionStatusSchema, outputSchema: z.union([mcpStatusResultSchema, mcpBusinessRefusalSchema]), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, input => toolResult(async () => {
    await authorized(principal);
    const commission = await getCommission(principal.session, input.commissionId);
    const result: McpCommissionStatusResult = { commissionId: commission.id, title: commission.title, revision: commission.revision, state: commission.state, packages: commission.packages.map(work => ({ id: work.id, title: work.title, state: work.state })), approvedPlan: commission.approvedPlanDigest === planDigest(commission), captureMinor: commission.payments.capturedMinor, payoutMinor: commission.payments.providerPaidMinor, disclosure: "Current recorded workspace progress. Capture and payout are separate recorded totals; this tool does not authorize, refresh, or dispatch a financial operation." };
    return mcpStatusResultSchema.parse(result);
  }, "Current recorded commission status. Financial state is reported without being modified.", false));
  server.registerTool("approval.link", {
    title: "Open the original owner's Passport review", description: "Issue a short-lived one-use continuation bound to the exact original owner browser session, current commission revision and plan digest. GET never consumes it. Continuing only opens Passport; human plan and payer approval remain separate.",
    inputSchema: mcpApprovalLinkSchema, outputSchema: z.union([mcpLinkResultSchema, mcpBusinessRefusalSchema]), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, input => toolResult(async () => { await authorized(principal); return mcpLinkResultSchema.parse(await issueApprovalLink(principal.session, input)); }, "Open the returned URL in the original owner's browser. The link continues to Passport without approving a plan or funds.", true));
  return server;
}
export async function handleGuildMcpHttp(request: Request): Promise<Response> {
  try {
    requireConfiguredOrigin(request);
    const principal = await authenticateProtocol(request, "mcp");
    const handler = createMcpHandler(() => createGuildMcpServer(principal), { legacy: "stateless", responseMode: "auto", maxRequestBodySize: MCP_MAX_REQUEST_BYTES, maxSubscriptions: 0, keepAliveMs: 0 });
    try { return privateMcpResponse(await handler.fetch(request)); }
    finally { await handler.close(); }
  } catch (error) {
    const response = errorResponse(error);
    if (response.status === 401) response.headers.set("WWW-Authenticate", 'Bearer realm="Guild commission tools"');
    return privateMcpResponse(response);
  }
}
