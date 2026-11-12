import { z } from "zod";
import type { Locale, PackageKind } from "./guild";

export const MARKET_VERSION = "guild.provider-market.v1" as const;
export const MARKET_EXTENSION = "urn:guild:provider-market:v1" as const;
export const A2A_PROTOCOL = { specification: "1.0.1", protocolVersion: "1.0", binding: "JSONRPC", sourceCommit: "3303592588e388e62e0f69f701af531d2f4e3991" } as const;
export const MCP_TOOL_NAMES = ["commission.create", "commission.status", "approval.link"] as const;

const uuid = z.string().uuid(), digest = z.string().regex(/^[a-f0-9]{64}$/), revision = z.number().int().nonnegative();
const providerId = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/), minor = z.number().int().nonnegative().max(10_000_000);
export const packageKindSchema = z.enum(["research", "translation", "narration", "images", "web", "captions"]);
const note = z.string().trim().min(1).max(1_200);

export const providerPolicyInputSchema = z.object({
  minimumAwardMinor: minor, askingAwardMinor: minor,
  maximumConcurrentTasks: z.number().int().min(1).max(25),
  workingHours: z.number().int().min(1).max(240),
  calendarId: z.literal("museum-weekdays-v1"),
  allowedKinds: z.array(packageKindSchema).min(1).max(6),
  correctionAllowance: z.number().int().min(0).max(3),
  counterofferLimit: z.number().int().min(0).max(20),
  validUntil: z.string().datetime(),
  contentRules: z.string().trim().min(1).max(1_200),
}).strict().superRefine((value, context) => {
  if (value.askingAwardMinor < value.minimumAwardMinor) context.addIssue({ code: "custom", path: ["askingAwardMinor"], message: "The asking award must meet the provider's minimum." });
  if (new Set(value.allowedKinds).size !== value.allowedKinds.length) context.addIssue({ code: "custom", path: ["allowedKinds"], message: "Choose each work type once." });
});
export type ProviderPolicyInput = z.infer<typeof providerPolicyInputSchema>;
export interface ProviderPolicy extends ProviderPolicyInput {
  id: string; providerId: string; revision: number; digest: string; previousDigest: string | null;
  ownerId: string; createdAt: string; disclosure: string;
}

export const providerProfileInputSchema = z.object({
  displayName: z.string().trim().min(2).max(80), ownerDisplayName: z.string().trim().min(2).max(80),
  specialty: z.string().trim().min(3).max(120), description: z.string().trim().min(20).max(1_200),
  portfolioUrl: z.url().max(500).nullable(),
}).strict();
export type ProviderProfileInput = z.infer<typeof providerProfileInputSchema>;
export type ProviderEnrollmentState = "profile_required" | "policy_required" | "discovery_required" | "ready" | "unavailable" | "revoked";

export interface MarketProvider extends ProviderProfileInput {
  id: string; monogram: string; color: string; kinds: PackageKind[];
  endpoint: string | null; cardUrl: string | null;
  protocol: { specification: "1.0.1"; version: "1.0"; binding: "JSONRPC"; cardDigest: string | null; observedAt: string | null; streaming: boolean };
  enrollment: { state: ProviderEnrollmentState; revision: number; message: string; requiredActions: string[]; lastFailure: string | null; canEdit: boolean };
  policy: ProviderPolicy | null;
  capacity: { active: number; reserved: number; maximum: number };
  history: { accepted: number; rejected: number; disclosure: string } | null;
  provenance: { kind: "guild_controlled_service" | "external_service"; label: string; syntheticFixture: boolean };
}

export interface MarketPackage {
  id: string; title: string; kind: PackageKind; description: string;
  contractVersion: number; contractDigest: string; acceptancePackDigest: string;
  criteria: { id: string; label: string; blocking: boolean; kind: "deterministic" | "human" | "advisory" }[];
  sourceDigest: string; providerId: string; providerAwardMinor: number; serviceFeeMinor: number; grossMinor: number;
  workAuthorityExpiresAt: string; allowedProviderIds: string[]; availableGrossMinor: number;
  state: string; canRequestQuote: boolean; unavailableReason: string | null;
}

export const offerTermsSchema = z.object({
  providerId, packageId: z.string().min(1).max(80), kind: packageKindSchema,
  contractVersion: revision, contractDigest: digest, acceptancePackDigest: digest, sourceDigest: digest,
  providerPolicyRevision: revision, providerPolicyDigest: digest,
  providerAwardMinor: minor, serviceFeeMinor: minor, grossMinor: minor, currency: z.literal("USD"),
  workingHours: z.number().int().positive().max(240), calendarId: z.literal("museum-weekdays-v1"),
  correctionAllowance: z.number().int().min(0).max(3),
  expiresAt: z.string().datetime(), workAuthorityExpiresAt: z.string().datetime(),
}).strict().superRefine((value, context) => {
  if (value.grossMinor !== value.providerAwardMinor + value.serviceFeeMinor) context.addIssue({ code: "custom", path: ["grossMinor"], message: "The customer gross must equal the provider award and disclosed service fee." });
  if (Date.parse(value.expiresAt) > Date.parse(value.workAuthorityExpiresAt)) context.addIssue({ code: "custom", path: ["expiresAt"], message: "An offer cannot extend its original work authority." });
});
export type OfferTerms = z.infer<typeof offerTermsSchema>;
export interface MarketPolicyDecision {
  side: "buyer" | "provider"; allowed: boolean; code: string; reason: string; policyId: string; policyRevision: number; policyDigest: string; checkedAt: string;
}
export type OfferMessageKind = "quote.request" | "offer.propose" | "offer.counter" | "offer.accept" | "offer.decline";
export interface OfferMessage {
  id: string; commandId: string; revision: number; parentDigest: string | null; digest: string;
  kind: OfferMessageKind; side: "buyer" | "provider"; senderLabel: string; createdAt: string;
  terms: OfferTerms | null; termsDigest: string | null; note: string; decisions: MarketPolicyDecision[];
}
export type OfferThreadState = "requesting" | "open" | "selected" | "declined" | "withdrawn" | "expired" | "superseded" | "needs_review";
export interface MarketOperation {
  id: string; commandId: string; kind: string; state: "prepared" | "dispatching" | "completed" | "needs_review" | "refused";
  requestDigest: string; originalMessageId: string; failureCode: string | null; canRecoverOriginal: boolean; createdAt: string;
}
export interface OfferThread {
  id: string; revision: number; commissionId: string; customerLabel: string; packageId: string; packageTitle: string; providerId: string;
  state: OfferThreadState; messages: OfferMessage[]; latestTerms: OfferTerms | null; latestTermsDigest: string | null;
  selectedAt: string | null; approvalRequired: boolean; operations: MarketOperation[];
  permissions: { counter: boolean; select: boolean; decline: boolean; respond: boolean; delegate: boolean };
  unavailableReason: string | null;
}

export const delegationBindingSchema = z.object({
  id: uuid, commissionId: uuid, packageId: z.string().min(1).max(80), providerId, threadId: uuid,
  offerRevision: revision, offerDigest: digest, contractVersion: revision, contractDigest: digest,
  acceptancePackDigest: digest, sourceDigest: digest, approvedPlanDigest: digest,
  mandateId: z.string().min(1).max(80), mandateRevision: revision, mandateDigest: digest,
  parentMandateId: z.string().min(1).max(80).nullable(), parentMandateRevision: revision.nullable(), parentMandateDigest: digest.nullable(),
  providerPolicyRevision: revision, providerPolicyDigest: digest,
  providerAwardMinor: minor, serviceFeeMinor: minor, grossMinor: minor,
  originalWorkCeiling: z.string().datetime(), taskId: uuid, createdAt: z.string().datetime(),
}).strict();
export type DelegationBinding = z.infer<typeof delegationBindingSchema>;
export type ProviderTaskState = "submitted" | "working" | "input_required" | "auth_required" | "completed" | "failed" | "cancelled" | "rejected";
export interface ProviderTaskArtifact {
  id: string; title: string; contentHash: string; mediaType: string; downloadUrl: string; submittedAt: string;
  verification: { state: "pending" | "passed" | "failed" | "review"; checks: { label: string; status: string; evidence: string | null }[] };
}
export interface ProviderTaskView {
  id: string; contextId: string; revision: number; state: ProviderTaskState; providerId: string; commissionId: string; customerLabel: string;
  packageId: string; packageTitle: string; binding: DelegationBinding; originalJobId: string | null;
  statusMessage: string; updatedAt: string; artifacts: ProviderTaskArtifact[];
  acceptance: { state: "not_submitted" | "awaiting_review" | "accepted" | "correction_requested" | "rejected"; message: string };
  payment: { awardMinor: number; customerGrossMinor: number; captureState: string; payoutState: string; disclosure: string };
  canCancel: boolean; canReadOriginal: boolean; syntheticFixture: boolean;
}

export interface ProviderMarketSnapshot {
  version: typeof MARKET_VERSION; scope: "buyer" | "provider"; serverTime: string; revision: number;
  viewer: { role: "owner" | "judge" | "provider" | "operator"; providerId: string | null; label: string; canManageProvider: boolean };
  commission: { id: string; revision: number; title: string; customerLabel: string; capMinor: number; availableMinor: number;
    approvedPlanDigest: string | null; originalWorkCeiling: string; languages: Locale[]; studioUrl: string } | null;
  providers: MarketProvider[]; packages: MarketPackage[]; threads: OfferThread[]; tasks: ProviderTaskView[];
  disclosure: string; syntheticFixture: boolean;
  protocol: { a2a: typeof A2A_PROTOCOL; interoperability: "pending" | "controlled_client_passed"; mcpTools: typeof MCP_TOOL_NAMES; ap2Conformance: "pending" };
}

const command = { commandId: uuid };
const threadCommand = { ...command, threadId: uuid, expectedThreadRevision: revision };
export const providerMarketCommandSchema = z.discriminatedUnion("type", [
  z.object({ ...command, type: z.literal("discover_provider"), providerId }).strict(),
  z.object({ ...command, type: z.literal("request_quote"), commissionId: uuid, expectedCommissionRevision: revision, packageId: z.string().min(1).max(80), providerId }).strict(),
  z.object({ ...threadCommand, type: z.literal("counter_offer"), providerAwardMinor: minor, note }).strict(),
  z.object({ ...threadCommand, type: z.literal("select_offer"), expectedCommissionRevision: revision, termsDigest: digest }).strict(),
  z.object({ ...threadCommand, type: z.literal("decline_offer"), note }).strict(),
  z.object({ ...threadCommand, type: z.literal("provider_counter"), providerAwardMinor: minor, note }).strict(),
  z.object({ ...threadCommand, type: z.literal("provider_decline"), note }).strict(),
  z.object({ ...command, type: z.literal("update_provider_profile"), providerId, expectedProfileRevision: revision, profile: providerProfileInputSchema }).strict(),
  z.object({ ...command, type: z.literal("update_provider_policy"), providerId, expectedPolicyRevision: revision, policy: providerPolicyInputSchema }).strict(),
  z.object({ ...threadCommand, type: z.literal("delegate_task"), expectedCommissionRevision: revision, termsDigest: digest, approvedPlanDigest: digest }).strict(),
  z.object({ ...command, type: z.literal("cancel_task"), taskId: uuid, expectedTaskRevision: revision, note }).strict(),
  z.object({ ...command, type: z.literal("recover_original"), operationId: uuid }).strict(),
]);
export type ProviderMarketCommand = z.infer<typeof providerMarketCommandSchema>;
export interface ProviderMarketError { code: string; message: string; retryable: boolean; unknownOutcome: boolean; currentRevision?: number }
export type ProviderMarketCommandResult =
  | { ok: true; commandId: string; message: string; snapshot: ProviderMarketSnapshot; threadId?: string; taskId?: string; approvalUrl?: string }
  | { ok: false; commandId: string; error: ProviderMarketError; snapshot?: ProviderMarketSnapshot };

/** Client components receive these functions from their client-side route shell.
 * No server credential or function is serialized across an RSC boundary. */
export interface ProviderMarketViewProps {
  snapshot: ProviderMarketSnapshot | null;
  status: "loading" | "ready" | "error";
  error: string | null;
  onRefresh: () => Promise<void>;
  onCommand: (command: ProviderMarketCommand) => Promise<ProviderMarketCommandResult>;
}

/** Business payload inside an official A2A v1 DataPart. The outer Message,
 * Task, JSON-RPC and SSE shapes are handled by the pinned official SDK. */
export const a2aMarketPayloadSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("quote.request"), requestId: uuid, commissionId: uuid, packageId: z.string().min(1).max(80), contractVersion: revision,
    contractDigest: digest, acceptancePackDigest: digest, sourceDigest: digest, kind: packageKindSchema, workAuthorityExpiresAt: z.string().datetime() }).strict(),
  z.object({ type: z.literal("offer.counter"), requestId: uuid, threadId: uuid, expectedRevision: revision, providerAwardMinor: minor, note }).strict(),
  z.object({ type: z.literal("offer.accept"), requestId: uuid, threadId: uuid, expectedRevision: revision, termsDigest: digest }).strict(),
  z.object({ type: z.literal("offer.decline"), requestId: uuid, threadId: uuid, expectedRevision: revision, note }).strict(),
  z.object({ type: z.literal("work.delegate"), requestId: uuid, delegation: delegationBindingSchema }).strict(),
]);
export type A2AMarketPayload = z.infer<typeof a2aMarketPayloadSchema>;

export const mcpCommissionCreateSchema = z.object({
  requestId: uuid, title: z.string().trim().min(3).max(100), brief: z.string().trim().min(20).max(4_000), capMinor: minor,
  languages: z.array(z.enum(["en", "pt", "es", "fr", "ja", "ar"])).min(1).max(6),
}).strict();
export const mcpCommissionStatusSchema = z.object({ commissionId: uuid }).strict();
export const mcpApprovalLinkSchema = z.object({ requestId: uuid, commissionId: uuid, expectedRevision: revision, approvalDigest: digest }).strict();
export interface McpCommissionDraftResult { commissionId: string; state: "draft"; statusUri: string; approvalRequired: true; paymentAuthorized: false }
export interface McpCommissionStatusResult { commissionId: string; title: string; revision: number; state: string; packages: { id: string; title: string; state: string }[];
  approvedPlan: boolean; captureMinor: number; payoutMinor: number; disclosure: string }
export interface McpApprovalLinkResult { url: string; expiresAt: string; commissionId: string; expectedRevision: number; ownerInteractionRequired: true; paymentAuthorized: false }
