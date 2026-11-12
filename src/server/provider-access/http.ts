import { z } from "zod";
import type { AgentAccessScope, ProviderAgentScope } from "@/contracts/provider-access";
import { providerMarketCommandSchema, type ProviderMarketCommandResult, type ProviderMarketSnapshot } from "@/contracts/provider-market";
import { DomainError } from "@/domain/primitives";
import { transaction } from "../db";
import { errorResponse } from "../http";
import { executeProviderMarketCommand } from "../provider-market/commands";
import { privateMcpResponse } from "../provider-market/mcp-http";
import { marketSnapshot } from "../provider-market/snapshot";
import { agentAccessSnapshot } from "./clients";
import { executeAgentAccessCommand, agentAccessCommandStatus } from "./commands";
import { authenticateProviderAgent, recheckProviderAgent, type ProviderAgentPrincipal } from "./agent-auth";
import { providerArtifactResponse } from "./artifacts";
import { accessErrorResponse, accessJson } from "./http-response";
import { claimProviderInvitation, previewProviderInvitation } from "./invitations";
import { requireBrowserEntryOrigin } from "./origin";
import { providerCookieHeader, requireAccessBrowserSession } from "./sessions";

const uuid = z.string().uuid();
function json(value: unknown, request: Request, status = 200): Response {
  return privateMcpResponse(new Response(request.method === "HEAD" ? null : JSON.stringify(value), {
    status, headers: { "Content-Type": "application/json; charset=utf-8" },
  }));
}

export async function handleInvitationPreview(request: Request, invitationId: string): Promise<Response> {
  try {
    const origin = requireBrowserEntryOrigin(request), id = uuid.parse(invitationId);
    // The private fragment is omitted from HTTP URLs. The challenge belongs
    // only in this request header, never in a referrer or response body.
    const challenge = request.headers.get("x-guild-invitation-challenge") ?? "";
    return json(await previewProviderInvitation(id, challenge, origin), request);
  } catch (error) { return accessErrorResponse(error, request.method === "HEAD"); }
}

export async function handleInvitationClaim(request: Request, invitationId: string): Promise<Response> {
  try {
    const origin = requireBrowserEntryOrigin(request, true), id = uuid.parse(invitationId);
    const claimed = await claimProviderInvitation(id, await accessJson(request, 2048), origin);
    const response = json(claimed.result, request);
    response.headers.set("Set-Cookie", providerCookieHeader(claimed.cookie, claimed.result.sessionExpiresAt, origin));
    return response;
  } catch (error) { return accessErrorResponse(error); }
}

export async function handleAgentAccessRead(request: Request, scope: AgentAccessScope): Promise<Response> {
  try {
    const origin = requireBrowserEntryOrigin(request), session = await requireAccessBrowserSession(request, scope);
    return json(await agentAccessSnapshot(session, scope, origin), request);
  } catch (error) { return accessErrorResponse(error, request.method === "HEAD"); }
}

export async function handleAgentAccessCommand(request: Request, scope: AgentAccessScope): Promise<Response> {
  try {
    requireBrowserEntryOrigin(request, true);
    const session = await requireAccessBrowserSession(request, scope);
    const result = await executeAgentAccessCommand(session, scope, await accessJson(request));
    return json(result, request, result.ok ? 200 : result.error.unknownOutcome ? 202 : 409);
  } catch (error) { return accessErrorResponse(error); }
}

export async function handleAgentAccessCommandStatus(request: Request, scope: AgentAccessScope, commandId: string): Promise<Response> {
  try {
    requireBrowserEntryOrigin(request);
    const session = await requireAccessBrowserSession(request, scope);
    return json(await agentAccessCommandStatus(session, scope, uuid.parse(commandId)), request);
  } catch (error) { return accessErrorResponse(error, request.method === "HEAD"); }
}

function providerProjection(snapshot: ProviderMarketSnapshot, principal?: ProviderAgentPrincipal): ProviderMarketSnapshot {
  const root = principal ? "/api/provider-agent/workspace" : "/api/provider/workspace";
  return { ...snapshot,
    viewer: { ...snapshot.viewer, canManageProvider: principal ? false : snapshot.viewer.canManageProvider },
    providers: snapshot.providers.map(provider => ({ ...provider, enrollment: { ...provider.enrollment,
      canEdit: principal ? false : provider.enrollment.canEdit } })),
    threads: snapshot.threads.map(thread => ({ ...thread,
      operations: thread.operations.map(operation => ({ ...operation, canRecoverOriginal: principal ? false : operation.canRecoverOriginal })),
      permissions: principal ? { counter: principal.scopes.includes("provider:negotiate") && thread.permissions.counter,
        decline: principal.scopes.includes("provider:negotiate") && thread.permissions.decline,
        respond: principal.scopes.includes("provider:negotiate") && thread.permissions.respond, select: false, delegate: false } : thread.permissions })),
    tasks: snapshot.tasks.map(task => ({ ...task, canCancel: task.canCancel && (!principal || principal.scopes.includes("provider:cancel")),
      artifacts: task.artifacts.map(artifact => ({ ...artifact, downloadUrl: `${root}/tasks/${task.id}/artifacts/${artifact.id}` })) })),
  };
}
function projectResult(result: ProviderMarketCommandResult, principal?: ProviderAgentPrincipal): ProviderMarketCommandResult {
  return result.snapshot ? { ...result, snapshot: providerProjection(result.snapshot, principal) } : result;
}
function workspaceError(error: unknown, head = false): Response {
  const response = errorResponse(error);
  return privateMcpResponse(head ? new Response(null, { status: response.status, headers: response.headers }) : response);
}

export async function handleProviderWorkspaceRead(request: Request, agent = false): Promise<Response> {
  try {
    requireBrowserEntryOrigin(request);
    const principal = agent ? await authenticateProviderAgent(request, "provider:read") : undefined;
    const session = principal?.session ?? await requireAccessBrowserSession(request, "provider");
    const snapshot = await transaction(async db => {
      await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      return marketSnapshot(db, session);
    });
    return json(providerProjection(snapshot, principal), request);
  } catch (error) { return workspaceError(error, request.method === "HEAD"); }
}

export async function handleProviderWorkspaceCommand(request: Request, agent = false): Promise<Response> {
  try {
    requireBrowserEntryOrigin(request, !agent);
    const command = providerMarketCommandSchema.parse(await accessJson(request, 32768));
    let principal: ProviderAgentPrincipal | undefined;
    let permission: ProviderAgentScope = "provider:read";
    if (agent) {
      permission = command.type === "provider_counter" || command.type === "provider_decline" ? "provider:negotiate"
        : command.type === "cancel_task" ? "provider:cancel" : "provider:read";
      principal = await authenticateProviderAgent(request, permission);
      if (!["provider_counter", "provider_decline", "cancel_task"].includes(command.type)) {
        throw new DomainError("PROVIDER_AGENT_ACTION", "This credential permits only its disclosed provider replies or cancellation. Profile, policy, discovery, customer approval, delegation and payment remain separate owner decisions.", 403, false);
      }
    }
    const session = principal?.session ?? await requireAccessBrowserSession(request, "provider");
    const authority = principal;
    const result = await executeProviderMarketCommand(session, command, authority ? {
      authorize: db => recheckProviderAgent(db, authority, permission, command),
    } : {});
    return json(projectResult(result, principal), request, result.ok ? 200 : result.error.unknownOutcome ? 202 : 409);
  } catch (error) { return workspaceError(error); }
}

export async function handleProviderArtifact(request: Request, taskId: string, artifactId: string, agent = false): Promise<Response> {
  try {
    requireBrowserEntryOrigin(request);
    const principal = agent ? await authenticateProviderAgent(request, "provider:read") : undefined;
    const session = principal?.session ?? await requireAccessBrowserSession(request, "provider");
    return await providerArtifactResponse(request, session, uuid.parse(taskId), uuid.parse(artifactId));
  } catch (error) { return workspaceError(error, request.method === "HEAD"); }
}
