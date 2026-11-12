import {
  PROVIDER_ACCESS_PATHS, agentAccessCommandResultSchema, agentAccessCommandStatusSchema, agentAccessSnapshotSchema,
  providerAccessErrorResponseSchema, providerClaimResultSchema, providerInvitationPreviewSchema,
  type AgentAccessCommand, type AgentAccessCommandResult, type AgentAccessCommandStatus, type AgentAccessScope, type AgentAccessSnapshot,
  type ProviderAccessError, type ProviderClaim, type ProviderClaimResult, type ProviderInvitationPreview,
} from "@/contracts/provider-access";

export class AccessFailure extends Error {
  constructor(readonly detail: ProviderAccessError) { super(detail.message); }
}
const readOptions: RequestInit = { credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer" };
async function data(response: Response): Promise<unknown> {
  let value: unknown;
  try { value = await response.json(); } catch { throw new Error("The original response could not be verified."); }
  const failure = providerAccessErrorResponseSchema.safeParse(value);
  if (failure.success) throw new AccessFailure(failure.data.error);
  if (!response.ok) throw new Error("The original response could not be verified.");
  return value;
}
export interface InvitationTransport {
  preview: (id: string, challenge: string) => Promise<ProviderInvitationPreview>;
  claim: (id: string, request: ProviderClaim) => Promise<ProviderClaimResult>;
}
export function invitationTransport(fetcher: typeof fetch = globalThis.fetch): InvitationTransport {
  const endpoint = (id: string) => `${PROVIDER_ACCESS_PATHS.invitation}/${encodeURIComponent(id)}`;
  return {
    async preview(id, challenge) {
      const response = await fetcher(endpoint(id), { ...readOptions, headers: { "X-Guild-Invitation-Challenge": challenge } });
      const value = providerInvitationPreviewSchema.parse(await data(response));
      if (value.invitationId !== id) throw new Error("The invitation response belongs to a different invitation.");
      return value;
    },
    async claim(id, request) {
      const response = await fetcher(`${endpoint(id)}/claim`, { ...readOptions, method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
      const value = providerClaimResultSchema.parse(await data(response));
      if (value.invitationId !== id || value.claimId !== request.claimId) throw new Error("The original claim response could not be verified.");
      return value;
    },
  };
}
export interface AgentAccessTransport {
  snapshot: () => Promise<AgentAccessSnapshot>;
  command: (command: AgentAccessCommand) => Promise<AgentAccessCommandResult>;
  status: (commandId: string) => Promise<AgentAccessCommandStatus>;
}
export function agentAccessTransport(scope: AgentAccessScope, fetcher: typeof fetch = globalThis.fetch): AgentAccessTransport {
  const endpoint = scope === "provider" ? PROVIDER_ACCESS_PATHS.providerSnapshot : PROVIDER_ACCESS_PATHS.customerSnapshot;
  const commands = scope === "provider" ? PROVIDER_ACCESS_PATHS.providerCommands : PROVIDER_ACCESS_PATHS.customerCommands;
  return {
    async snapshot() {
      const value = agentAccessSnapshotSchema.parse(await data(await fetcher(endpoint, readOptions)));
      if (value.scope !== scope) throw new Error("The access response belongs to a different workspace.");
      return value;
    },
    async command(command) {
      const response = await fetcher(commands, { ...readOptions, method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command) });
      const value = agentAccessCommandResultSchema.parse(await data(response));
      if (value.commandId !== command.commandId) throw new Error("The original command response could not be verified.");
      return value;
    },
    async status(commandId) {
      const response = await fetcher(`${commands}/${encodeURIComponent(commandId)}`, readOptions);
      const value = agentAccessCommandStatusSchema.parse(await data(response));
      if (value.commandId !== commandId) throw new Error("The recovery response belongs to a different command.");
      return value;
    },
  };
}
