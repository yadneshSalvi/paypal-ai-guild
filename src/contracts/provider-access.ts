import { z } from "zod";
import { packageKindSchema } from "./provider-market";

export const PROVIDER_ACCESS_VERSION = "guild.provider-access.v1" as const;
export const PROVIDER_SETUP_VERSION = "guild.controlled-provider-setup.v1" as const;
export const PROVIDER_INVITATION_PREVIEW_VERSION = "guild.provider-invitation-preview.v1" as const;
export const PROVIDER_CLAIM_VERSION = "guild.provider-claim.v1" as const;
export const AGENT_ACCESS_VERSION = "guild.agent-access.v1" as const;
export const AGENT_COMMAND_STATUS_VERSION = "guild.agent-access-command-status.v1" as const;
export const CONTROLLED_PROVIDER_IDS = ["marlow", "tessellate", "quill", "halide", "ostrava", "formwork", "northlight"] as const;
export const CUSTOMER_AGENT_SCOPES = ["mcp", "a2a"] as const;
export const PROVIDER_AGENT_SCOPES = ["provider:read", "provider:negotiate", "provider:cancel"] as const;
export const PROVIDER_ACCESS_PATHS = {
  invitation: "/api/provider-access/invitations",
  customerSnapshot: "/api/agent-access", customerCommands: "/api/agent-access/commands",
  providerSnapshot: "/api/provider/agent-access", providerCommands: "/api/provider/agent-access/commands",
  providerWorkspace: "/api/provider/workspace", providerWorkspaceCommands: "/api/provider/workspace/commands",
  providerAgentWorkspace: "/api/provider-agent/workspace", providerAgentCommands: "/api/provider-agent/workspace/commands",
} as const;

const uuid = z.string().uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/), time = z.string().datetime();
const providerId = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/), text = z.string().trim().min(1).max(1200), label = z.string().trim().min(1).max(80);
export const accessOriginSchema = z.url().refine(value => {
  try {
    const url = new URL(value);
    return url.origin === value && !url.username && !url.password && (url.protocol === "https:" || url.protocol === "http:" && url.hostname === "127.0.0.1");
  } catch { return false; }
}, "Use an exact HTTPS origin or an explicit owned127.0.0.1 HTTP origin.");
export const customerAgentScopeSchema = z.enum(CUSTOMER_AGENT_SCOPES);
export const providerAgentScopeSchema = z.enum(PROVIDER_AGENT_SCOPES);
export const agentScopeSchema = z.enum([...CUSTOMER_AGENT_SCOPES, ...PROVIDER_AGENT_SCOPES]);
export type CustomerAgentScope = z.infer<typeof customerAgentScopeSchema>;
export type ProviderAgentScope = z.infer<typeof providerAgentScopeSchema>;
export type AgentScope = z.infer<typeof agentScopeSchema>;
export type AgentAccessScope = "customer" | "provider";

function checkScopes(scopes: AgentScope[], context: z.RefinementCtx, path: (string | number)[] = ["scopes"]): void {
  if (new Set(scopes).size !== scopes.length) context.addIssue({ code: "custom", path, message: "Choose each scope once." });
  const customer = scopes.some(scope => (CUSTOMER_AGENT_SCOPES as readonly string[]).includes(scope));
  const provider = scopes.some(scope => (PROVIDER_AGENT_SCOPES as readonly string[]).includes(scope));
  if (customer && provider) context.addIssue({ code: "custom", path, message: "Customer and provider credential scopes cannot be mixed." });
  if (provider && scopes.some(scope => scope !== "provider:read") && !scopes.includes("provider:read")) context.addIssue({ code: "custom", path, message: "Provider negotiation and cancellation require provider:read." });
}

export const providerDisplayIdentitySchema = z.object({
  id: providerId, displayName: label, ownerDisplayName: label, ownerIdentity: z.string().min(1).max(240), specialty: text, description: text, bindingDigest: hash,
  provenance: z.object({ kind: z.enum(["guild_controlled_service", "external_service"]), label: text, syntheticFixture: z.boolean() }).strict(),
}).strict();
export type ProviderDisplayIdentity = z.infer<typeof providerDisplayIdentitySchema>;

export const controlledProviderSetupPlanSchema = z.object({
  version: z.literal(PROVIDER_SETUP_VERSION), operationId: uuid, createdAt: time, browserOrigin: accessOriginSchema, serviceOrigin: accessOriginSchema,
  databaseIdentity: z.object({ database: z.string().min(1).max(128), schema: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/), serverFingerprint: hash }).strict(),
  schemaFingerprint: hash, registryFingerprint: hash, syntheticFixture: z.boolean(), issuerIdentity: z.string().trim().min(1).max(240),
  services: z.array(z.object({ id: z.enum(CONTROLLED_PROVIDER_IDS), ownerIdentity: z.string().min(1).max(240), displayName: label,
    kinds: z.array(packageKindSchema).min(1).max(6), endpoint: z.url(), cardUrl: z.url(), existingRowFingerprint: hash.nullable(), provenance: z.literal("guild_controlled_service"),
    invitationId: uuid, challengeHash: hash }).strict()).length(7),
  invitationExpiresAt: time, sessionCeilingAt: time, digest: hash,
}).strict().superRefine((value, context) => {
  if (new Set(value.services.map(item => item.id)).size !== 7) context.addIssue({ code: "custom", path: ["services"], message: "Identify all seven controlled services once." });
  if (Date.parse(value.createdAt) >= Date.parse(value.invitationExpiresAt) || Date.parse(value.invitationExpiresAt) > Date.parse(value.sessionCeilingAt)) context.addIssue({ code: "custom", path: ["invitationExpiresAt"], message: "Retain the explicit invitation and session ceiling ordering." });
  value.services.forEach((service, index) => {
    let originsMatch = false;
    try { originsMatch = new URL(service.endpoint).origin === value.serviceOrigin && new URL(service.cardUrl).origin === value.serviceOrigin; } catch { /* URL fields retain their validation issues. */ }
    if (!originsMatch) context.addIssue({ code: "custom", path: ["services", index], message: "Endpoints must match the exact reviewed service origin." });
    if (new Set(service.kinds).size !== service.kinds.length) context.addIssue({ code: "custom", path: ["services", index, "kinds"], message: "Choose each capability once." });
  });
});
export type ControlledProviderSetupPlan = z.infer<typeof controlledProviderSetupPlanSchema>;

export const providerClaimSchema = z.object({ claimId: uuid, challenge: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/) }).strict();
export type ProviderClaim = z.infer<typeof providerClaimSchema>;
export const providerClaimResultSchema = z.object({ version: z.literal(PROVIDER_CLAIM_VERSION), invitationId: uuid, claimId: uuid, providerId,
  sessionExpiresAt: time, restoredOriginal: z.boolean(), consoleUrl: z.literal("/provider") }).strict();
export type ProviderClaimResult = z.infer<typeof providerClaimResultSchema>;

/** Private persistence shape. Preview/claim APIs must never return this row. */
export const providerInvitationSchema = z.object({
  version: z.literal(PROVIDER_ACCESS_VERSION), id: uuid, providerId, ownerIdentity: z.string().min(1).max(240), providerBindingDigest: hash,
  setupOperationId: uuid, issuerIdentity: z.string().min(1).max(240), browserOrigin: accessOriginSchema, serviceOrigin: accessOriginSchema,
  challengeHash: hash, issuedAt: time, expiresAt: time, sessionCeilingAt: time, consumedAt: time.nullable(), consumedSessionId: uuid.nullable(),
  consumedClaimId: uuid.nullable(), revokedAt: time.nullable(), retainedResult: providerClaimResultSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (Date.parse(value.expiresAt) > Date.parse(value.sessionCeilingAt)) context.addIssue({ code: "custom", path: ["expiresAt"], message: "An invitation cannot extend its original session ceiling." });
  const consumed = [value.consumedAt, value.consumedSessionId, value.consumedClaimId, value.retainedResult];
  if (consumed.some(item => item !== null) && consumed.some(item => item === null)) context.addIssue({ code: "custom", path: ["consumedAt"], message: "Retain one complete original claim/session result." });
  if (value.retainedResult && (value.retainedResult.invitationId !== value.id || value.retainedResult.claimId !== value.consumedClaimId || value.retainedResult.providerId !== value.providerId || Date.parse(value.retainedResult.sessionExpiresAt) > Date.parse(value.sessionCeilingAt))) context.addIssue({ code: "custom", path: ["retainedResult"], message: "Recovery must match the original claim, provider and session ceiling." });
});
export type ProviderInvitation = z.infer<typeof providerInvitationSchema>;

export const providerInvitationPreviewSchema = z.object({
  version: z.literal(PROVIDER_INVITATION_PREVIEW_VERSION), invitationId: uuid, serverTime: time, state: z.enum(["available", "claimed", "expired", "revoked", "unavailable"]),
  provider: providerDisplayIdentitySchema.nullable(), invitationExpiresAt: time.nullable(), sessionCeilingAt: time.nullable(), originalSessionExpiresAt: time.nullable(), claimedAt: time.nullable(),
  permissions: z.object({ claim: z.boolean(), recoverOriginal: z.boolean() }).strict(), message: text, disclosure: text, consoleUrl: z.literal("/provider"),
}).strict().superRefine((value, context) => {
  if (value.state === "unavailable" && (value.provider !== null || value.invitationExpiresAt !== null || value.sessionCeilingAt !== null || value.originalSessionExpiresAt !== null || value.claimedAt !== null || value.permissions.claim || value.permissions.recoverOriginal)) context.addIssue({ code: "custom", path: ["provider"], message: "An unavailable invitation cannot disclose provider/deadline data or permit a claim." });
  if (value.permissions.claim && value.state !== "available" || value.permissions.recoverOriginal && value.state !== "claimed") context.addIssue({ code: "custom", path: ["permissions"], message: "Invitation actions must match its retained state." });
  if (value.state === "available" && (!value.provider || !value.invitationExpiresAt || !value.sessionCeilingAt)) context.addIssue({ code: "custom", path: ["state"], message: "An available invitation needs its provider and original ceilings." });
});
export type ProviderInvitationPreview = z.infer<typeof providerInvitationPreviewSchema>;
export const providerAccessErrorSchema = z.object({ code: z.string().min(1).max(100), message: text, retryable: z.boolean(), unknownOutcome: z.boolean() }).strict();
export type ProviderAccessError = z.infer<typeof providerAccessErrorSchema>;
export const providerAccessErrorResponseSchema = z.object({ version: z.literal(PROVIDER_ACCESS_VERSION), ok: z.literal(false), error: providerAccessErrorSchema }).strict();
export type ProviderAccessErrorResponse = z.infer<typeof providerAccessErrorResponseSchema>;

export const protocolClientSummarySchema = z.object({
  id: uuid, label, prefix: z.string().regex(/^[A-Za-z0-9_.:-]{1,24}$/), scope: z.enum(["customer", "provider"]), scopes: z.array(agentScopeSchema).min(1).max(3),
  actorId: uuid, providerId: providerId.nullable(), issuedAt: time, expiresAt: time, revokedAt: time.nullable(), state: z.enum(["active", "expired", "revoked"]),
  canRevoke: z.boolean(), permittedActions: z.array(text).max(30),
}).strict().superRefine((value, context) => {
  checkScopes(value.scopes, context);
  if (value.scope === "provider" && value.providerId === null || value.scopes.some(scope => value.scope === "provider" ? !(PROVIDER_AGENT_SCOPES as readonly string[]).includes(scope) : !(CUSTOMER_AGENT_SCOPES as readonly string[]).includes(scope))) context.addIssue({ code: "custom", path: ["scope"], message: "Retain the original customer/provider binding and scope family." });
  if (Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)) context.addIssue({ code: "custom", path: ["expiresAt"], message: "An absolute expiry must follow issuance." });
  if ((value.state === "revoked") !== (value.revokedAt !== null)) context.addIssue({ code: "custom", path: ["revokedAt"], message: "Revocation must match its retained timestamp." });
});
export type ProtocolClientSummary = z.infer<typeof protocolClientSummarySchema>;

export const agentEndpointInstructionSchema = z.object({
  id: z.string().min(1).max(100), name: label, protocol: z.enum(["MCP", "A2A", "Guild provider agent API"]),
  url: z.url(), discoveryUrl: z.url().nullable(), providerId: providerId.nullable(), authentication: z.literal("Bearer"),
  scopes: z.array(agentScopeSchema).min(1).max(3), allowedActions: z.array(text).min(1).max(30), disclosure: text,
}).strict().superRefine((value, context) => {
  const expected: readonly string[] = value.protocol === "MCP" ? ["mcp"] : value.protocol === "A2A" ? ["a2a"] : PROVIDER_AGENT_SCOPES;
  if (value.scopes.some(scope => !expected.includes(scope)) || new Set(value.scopes).size !== value.scopes.length) context.addIssue({ code: "custom", path: ["scopes"], message: "Endpoint scope instructions must match their declared API." });
  if (value.protocol === "MCP" && value.providerId !== null || value.protocol !== "MCP" && value.providerId === null) context.addIssue({ code: "custom", path: ["providerId"], message: "Provider endpoints need their exact provider binding." });
});
export type AgentEndpointInstruction = z.infer<typeof agentEndpointInstructionSchema>;
export const agentAccessSnapshotSchema = z.object({
  version: z.literal(AGENT_ACCESS_VERSION), scope: z.enum(["customer", "provider"]), serverTime: time,
  viewer: z.object({ actorId: uuid, tenantId: uuid, role: z.enum(["owner", "judge", "provider"]), label,
    sessionExpiresAt: time, providerBinding: providerDisplayIdentitySchema.nullable() }).strict(),
  credentials: z.array(protocolClientSummarySchema), allowedScopes: z.array(agentScopeSchema).min(1).max(3), endpoints: z.array(agentEndpointInstructionSchema).min(1).max(20),
  permissions: z.object({ issue: z.boolean(), revoke: z.boolean() }).strict(), disclosure: text,
}).strict().superRefine((value, context) => {
  const family: readonly string[] = value.scope === "provider" ? PROVIDER_AGENT_SCOPES : CUSTOMER_AGENT_SCOPES;
  if (new Set(value.allowedScopes).size !== value.allowedScopes.length || value.allowedScopes.some(scope => !family.includes(scope))) context.addIssue({ code: "custom", path: ["allowedScopes"], message: "Allowed scopes must match the fixed route's original principal." });
  if ((value.scope === "provider") !== (value.viewer.providerBinding !== null) || (value.scope === "provider") !== (value.viewer.role === "provider")) context.addIssue({ code: "custom", path: ["viewer"], message: "Provider access requires its separate provider principal and binding." });
  value.credentials.forEach((client, index) => {
    if (client.scope !== value.scope || client.actorId !== value.viewer.actorId || value.scope === "provider" && client.providerId !== value.viewer.providerBinding?.id || Date.parse(client.expiresAt) > Date.parse(value.viewer.sessionExpiresAt)) context.addIssue({ code: "custom", path: ["credentials", index], message: "Summaries cannot cross the original owner/provider/session ceiling." });
  });
  value.endpoints.forEach((endpoint, index) => {
    if (endpoint.scopes.some(scope => !family.includes(scope)) || value.scope === "provider" && endpoint.protocol !== "Guild provider agent API") context.addIssue({ code: "custom", path: ["endpoints", index], message: "Endpoint instructions must match the declared credential family." });
  });
});
export type AgentAccessSnapshot = z.infer<typeof agentAccessSnapshotSchema>;

export const agentIssueCredentialCommandSchema = z.object({ type: z.literal("issue_credential"), commandId: uuid, label,
  scopes: z.array(agentScopeSchema).min(1).max(3), expiresAt: time }).strict().superRefine((value, context) => checkScopes(value.scopes, context));
export const agentRevokeCredentialCommandSchema = z.object({ type: z.literal("revoke_credential"), commandId: uuid, clientId: uuid }).strict();
export const agentAccessCommandSchema = z.union([agentIssueCredentialCommandSchema, agentRevokeCredentialCommandSchema]);
export type AgentIssueCredentialCommand = z.infer<typeof agentIssueCredentialCommandSchema>;
export type AgentRevokeCredentialCommand = z.infer<typeof agentRevokeCredentialCommandSchema>;
export type AgentAccessCommand = z.infer<typeof agentAccessCommandSchema>;

const commandResult = { version: z.literal(AGENT_ACCESS_VERSION), commandId: uuid, message: text };
export const agentAccessCommandResultSchema = z.discriminatedUnion("state", [
  z.object({ ...commandResult, ok: z.literal(true), state: z.literal("issued_now"), credential: protocolClientSummarySchema,
    tokenAvailability: z.literal("shown_once"), token: z.string().min(32).max(1024) }).strict(),
  z.object({ ...commandResult, ok: z.literal(true), state: z.literal("retained"), credential: protocolClientSummarySchema, tokenAvailability: z.literal("unavailable") }).strict(),
  z.object({ ...commandResult, ok: z.literal(true), state: z.literal("revoked"), credential: protocolClientSummarySchema, tokenAvailability: z.literal("unavailable") }).strict(),
  z.object({ ...commandResult, ok: z.literal(false), state: z.literal("refused"), error: providerAccessErrorSchema, tokenAvailability: z.literal("unavailable") }).strict(),
]);
export type AgentAccessCommandResult = z.infer<typeof agentAccessCommandResultSchema>;

/** Summary-only GET recovery. Raw tokens are structurally impossible here. */
export const agentAccessCommandStatusSchema = z.object({
  version: z.literal(AGENT_COMMAND_STATUS_VERSION), commandId: uuid, serverTime: time, operation: z.enum(["issue_credential", "revoke_credential"]).nullable(),
  state: z.enum(["pending", "completed", "refused", "not_found"]), credential: protocolClientSummarySchema.nullable(), error: providerAccessErrorSchema.nullable(),
  tokenAvailability: z.literal("unavailable"), message: text,
}).strict().superRefine((value, context) => {
  if (value.state === "completed" && (!value.credential || !value.operation)) context.addIssue({ code: "custom", path: ["credential"], message: "A completed command must retain its original credential summary." });
  if ((value.state === "refused") !== (value.error !== null)) context.addIssue({ code: "custom", path: ["error"], message: "Only a refused command has a retained refusal." });
  if (value.state === "not_found" && (value.credential !== null || value.operation !== null)) context.addIssue({ code: "custom", path: ["state"], message: "Unknown commands cannot disclose a credential or invent an operation." });
});
export type AgentAccessCommandStatus = z.infer<typeof agentAccessCommandStatusSchema>;
