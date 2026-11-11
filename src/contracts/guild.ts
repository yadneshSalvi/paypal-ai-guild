import { z } from "zod";
import type { ScheduleAuthorityBinding } from "@/scheduling/persisted";

export const CONTRACT_VERSION = "guild.v2" as const;
export type Locale = "en" | "pt" | "es" | "fr" | "ja" | "ar";
export const locales: Locale[] = ["en", "pt", "es", "fr", "ja", "ar"];
export const localeNames: Record<Locale, string> = { en: "English", pt: "Português", es: "Español", fr: "Français", ja: "日本語", ar: "العربية" };
export type ProvenanceMode = "live" | "replay" | "modelled" | "sample";
export interface Provenance { mode: ProvenanceMode; label: string; sourceId: string | null; observedAt: string | null; sandbox: boolean }
export type PackageKind = "research" | "translation" | "narration" | "images" | "web" | "captions";
export type PackageState = "draft" | "bidding" | "awarded" | "producing" | "submitted" | "verifying" | "awaiting_acceptance" | "accepted" | "correction_requested" | "rejected" | "withdrawn";
export type CommissionState = "draft" | "planning" | "awaiting_approval" | "producing" | "reviewing" | "delivered" | "settling" | "completed" | "paused" | "needs_attention" | "cancelled";
export type Money = { currency: "USD"; minor: number };

export interface SourceAsset {
  id: string; title: string; description: string; imagePath: string; thumbnailPath: string;
  sourceUrl: string; creator: string; date: string; rights: string; rightsUrl: string;
  contentHash: string; alt: string; provenance: Provenance;
}
export interface ProviderCard {
  id: string; name: string; monogram: string; specialty: string; description: string;
  color: string; kinds: PackageKind[]; priceFloorMinor: number; capacity: number;
  workingHours: string; corrections: number; history: { accepted: number; rejected: number } | null;
  provenance: Provenance; endpoint: string | null; policyDigest: string;
}
export interface AcceptanceCriterion { id: string; label: string; description: string; blocking: boolean; kind: "deterministic" | "human" | "advisory"; status: "pending" | "passed" | "failed" | "review"; evidence: string | null }
export interface AcceptancePack { id: string; version: string; title: string; digest: string; criteria: AcceptanceCriterion[]; correctionAllowance: number; parameters?: Record<string, unknown> }
export interface ArtifactManifest {
  id: string; packageId: string; title: string; mediaType: string; contentHash: string;
  downloadUrl: string; previewUrl: string | null; sourceIds: string[]; createdAt: string;
  provenance: Provenance; reviewStatus: string; content: Record<string, unknown>;
}
export interface ArtifactReview {
  id: string; packageId: string; contractVersion: number; artifactId: string; artifactHash: string;
  criteriaDigest: string; kind: "automated"; findings: string; createdAt: string;
  humanReviewed: false; accepted: false; disclosure: string;
}
export interface NarrationCorrectionEvidence {
  artifactId: string; artifactHash: string; title: string; contractVersion: number;
  productionJobId: string; productionInputDigest: string;
  verifications: { id: string; criteriaDigest: string; createdAt: string }[];
  evaluations: { jobId: string; outputDigest: string; createdAt: string }[];
}
/** Supplemental production authority. The original acceptance pack is unchanged. */
export interface NarrationCorrectionProposal {
  version: "guild.narration-correction.v1"; digest: string; commissionId: string; packageId: string;
  fromVersion: number; toVersion: number; previousPlanDigest: string; acceptancePackDigest: string;
  previousApproval: { id: string; actorId: string; actorExpiresAt: string; receiptDigest: string };
  sourceArtifactId: string; sourceArtifactHash: string; inputBindings: ArtifactInputBinding[];
  correction: { eventId: string; eventHash: string; note: string };
  scope: { maximumProductionJobs: 1; recordings: number; locales: Locale[]; scriptRegisterDigest: string;
    arabicDelivery: { version: "quill.arabic-pacing.v1"; minimumWordsPerMinute: 165; maximumWordsPerMinute: 175; instruction: string } };
  commercial: { providerId: "quill"; providerAwardMinor: number; serviceFeeMinor: number; grossMinor: number;
    additionalChargeMinor: 0; commissionTotalMinor: number; capMinor: number };
  providerOffer: { issuer: "Guild controlled Quill & Echo service"; policyVersion: "quill.additional-correction.v1";
    policyDigest: string; originalPolicyDigest: string; expiresAt: string; disclosure: string };
  history: NarrationCorrectionEvidence[];
  latestVerificationId: string; latestCriteriaDigest: string; failedRecordingKeys: string[];
}
export interface NarrationCorrectionAgreement {
  id: string; proposal: NarrationCorrectionProposal; agreedAt: string;
  providerReceipt: { kind: "guild.controlled-provider-offer-receipt.v1"; algorithm: "HMAC-SHA256"; signature: string };
}
/** A separately reviewed scope. These entries never reattribute carried media. */
export interface NarrationCorrectionRecording {
  locale: Locale; key: string; action: "replace" | "carry_forward"; failures: ("duration" | "transcript")[];
  textHash: string; replacementInstructionsHash: string | null; cue: "original_cue" | "duration_cue" | null; segmentHash: string; artifactId: string; artifactHash: string;
  productionJobId: string; contractVersion: number; contractDigest: string; inputBindingsDigest: string;
  mediaId: string; mediaHash: string; speechRunId: string; receiptHash: string; pcmHash: string;
  correctionAgreement?: { id: string; digest: string };
}
export interface NarrationTargetedCorrectionProposal extends Omit<NarrationCorrectionProposal, "version" | "scope" | "providerOffer"> {
  version: "guild.narration-targeted-correction.v1";
  /** The earlier signed actor/expiry survives later workspace renewals. */
  authorityCeiling: NarrationCorrectionProposal["previousApproval"];
  scope: {
    maximumProductionJobs: 1; maximumAttemptsPerRecording: 1;
    selectionRule: "one_original_stream_per_replacement_no_candidates";
    recordings: number; replacementRecordings: number; carriedRecordings: number;
    locales: Locale[]; scriptRegisterDigest: string; registerDigest: string;
    register: NarrationCorrectionRecording[];
    delivery: { version: "quill.targeted-delivery.v1"; instruction: string; synthesisSpeed: 1 };
  };
  latestEvaluation: { jobId: string; outputDigest: string };
  providerOffer: { issuer: "Guild controlled Quill & Echo service"; policyVersion: "quill.targeted-correction.v1";
    policyDigest: string; originalPolicyDigest: string; expiresAt: string; disclosure: string };
}
export interface NarrationTargetedCorrectionAgreement {
  id: string; proposal: NarrationTargetedCorrectionProposal; agreedAt: string;
  providerReceipt: { kind: "guild.controlled-targeted-offer-receipt.v1"; algorithm: "HMAC-SHA256"; signature: string };
}
/** A new offer after an exhausted targeted job; v1 targeted terms stay immutable. */
export interface NarrationFollowupOrigin {
  schemaVersion: "guild.narration.v2" | "guild.narration.v3";
  artifactId: string; artifactHash: string; productionJobId: string;
  contractVersion: number; segmentHash: string;
}
export interface NarrationFollowupRecording extends Omit<NarrationCorrectionRecording, "cue"> {
  cue: "followup_duration_cue" | null;
  /** From the currently reviewed assembly back to the actual producing artifact. */
  originPath: NarrationFollowupOrigin[];
}
export interface NarrationFollowupCorrectionProposal extends Omit<NarrationTargetedCorrectionProposal, "version" | "scope" | "providerOffer"> {
  version: "guild.narration-targeted-followup.v1";
  baseRevision: number;
  reference: { artifactId: string; artifactHash: string; agreementId: string; agreementDigest: string; receiptDigest: string };
  historicalContracts: { id: string; fromVersion: number; toVersion: number; previousContractDigest: string; proposedContractDigest: string; previousPlanDigest: string | null; proposedPlanDigest: string }[];
  scope: Omit<NarrationTargetedCorrectionProposal["scope"], "register" | "delivery"> & {
    register: NarrationFollowupRecording[];
    delivery: { version: "quill.targeted-followup-delivery.v1"; instruction: string; synthesisSpeed: 1; developmentRequests: 0 };
    replacementCue: { locale: "ar"; key: string; instructions: string; hash: string };
  };
  providerOffer: { issuer: "Guild controlled Quill & Echo service"; policyVersion: "quill.targeted-followup.v1";
    policyDigest: string; originalPolicyDigest: string; expiresAt: string; disclosure: string };
}
export interface NarrationFollowupCorrectionAgreement {
  id: string; proposal: NarrationFollowupCorrectionProposal; agreedAt: string;
  providerReceipt: { kind: "guild.controlled-followup-offer-receipt.v1"; algorithm: "HMAC-SHA256"; signature: string };
}
export interface CaptionCorrectionProposal {
  version: "guild.caption-correction.v1"; commissionId: string; packageId: string; contractVersion: number;
  acceptancePackDigest: string; sourceDigest: string; previousPlanDigest: string;
  previousApproval: { id: string; actorId: string; receiptHash: string };
  previous: { jobId: string; state: string; inputHash: string; outputHash: string; error: string | null; operationsHash: string;
    artifact: { id: string; contentHash: string; verificationId: string; verificationHash: string; reportJobId: string; reportHash: string } | null };
  note: { eventId: string; eventHash: string; text: string };
  maximumProductionJobs: 2; correctionAllowance: 1; attempt: 2;
  commercial: { providerId: "northlight"; providerAwardMinor: 3500; serviceFeeMinor: 500; grossMinor: 4000; additionalChargeMinor: 0 };
  authorityCeiling: string; disclosure: string; digest: string;
}
export interface CaptionCorrectionAgreement {
  id: string; proposal: CaptionCorrectionProposal; actorId: string; agreedAt: string;
  receipt: { kind: "guild.controlled-caption-correction.v1"; algorithm: "HMAC-SHA256"; signature: string };
}
export interface WorkPackage {
  id: string; kind: PackageKind; title: string; description: string; state: PackageState;
  contractVersion: number; providerId: string; providerAwardMinor: number; serviceFeeMinor: number;
  grossMinor: number; acceptancePack: AcceptancePack; artifactIds: string[]; dependsOn: string[];
  workingHours: number; progress: number | null; acceptedAt: string | null; acceptedBy: string | null;
  paymentState: "not_eligible" | "eligible" | "awaiting_payer" | "pending" | "paid" | "unknown";
  provenance: Provenance;
  inputPolicy?: "accepted" | "reviewed_drafts";
  /** Read-model fingerprint of the exact displayed check report. */
  verificationDigest?: string;
  narrationCorrection?: NarrationCorrectionAgreement;
  narrationTargetedCorrection?: NarrationTargetedCorrectionAgreement;
  narrationFollowupCorrection?: NarrationFollowupCorrectionAgreement;
  captionCorrection?: CaptionCorrectionAgreement;
}
export interface ArtifactInputBinding { packageId: string; contractVersion: number; artifactId: string; artifactHash: string; reviewKind: "curator_acceptance" | "automated_review"; reviewId: string }
export interface DraftDependencyProposal { digest: string; version: "guild.reviewed-draft-inputs.v1"; packages: { id: string; title: string; fromVersion: number; toVersion: number; grossMinor: number; dependsOn: string[] }[]; disclosure: string }
export interface Mandate {
  id: string; parentId: string | null; parentRevision: number | null; revision: number;
  title: string; grantee: string; purpose: string; capMinor: number; reservedMinor: number;
  committedMinor: number; allowedKinds: PackageKind[]; allowedProviders: string[];
  expiresAt: string; status: "draft" | "active" | "revoked" | "expired"; digest: string;
  approvalKind: "server_signed_receipt"; approvalId: string | null;
}
export interface PolicyDecision {
  id: string; allowed: boolean; ruleId: string; title: string; reason: string; amountMinor: number;
  mandateId: string; mandateRevision: number; createdAt: string; provenance: Provenance;
}
export interface DomainEvent {
  id: string; sequence: number; type: string; title: string; detail: string; actor: string;
  createdAt: string; packageId: string | null; provenance: Provenance; hash: string; previousHash: string | null;
}
export interface Quote {
  id: string; packageId: string; providerId: string; revision: number; amountMinor: number;
  workingHours: number; expiresAt: string; acceptancePackDigest: string; providerPolicyDigest: string;
  status: "proposed" | "countered" | "accepted" | "declined" | "expired";
  reason: string; provenance: Provenance;
}
export interface AgentActivity { id: string; name: string; role: string; state: "idle" | "working" | "needs_review" | "complete"; summary: string; tools: { name: string; role: "read" | "propose" | "execute"; transport: string; used: boolean }[] }
export interface JobRun { id: string; type: "compile_brief" | "produce_package" | "verify_artifact" | "assemble" | "reconcile"; state: "queued" | "running" | "completed" | "failed" | "needs_review"; attempts: number; step: string; error: string | null; packageId?: string; contractVersion?: number; blocksNewProduction?: boolean; createdAt: string; updatedAt: string }
export interface PaymentSummary {
  route: "unqualified" | "authorization" | "package_checkout"; authorizedMinor: number;
  capturedMinor: number; refundedMinor: number; providerPaidMinor: number; providerPayableMinor: number;
  serviceFeeMinor: number; closure: "not_started" | "pending" | "closed";
  receipts: { id: string; kind: string; packageId: string | null; amountMinor: number; status: string; transport: string; source: Provenance; resourceId: string; observedAt: string }[];
  operations: PaymentOperationView[];
  checkout: CheckoutView | null;
  authorization: { resourceLabel: string; amountMinor: number; status: string; observedAt: string; closureQualified: boolean } | null;
  toolEvidence: PaymentToolEvidence[];
  toolRuns: PaymentToolRun[];
  payouts: ProviderPayoutView[];
}
export interface PaymentOperationView {
  id: string; kind: string; packageId: string | null; amountMinor: number;
  state: "queued" | "claimed" | "dispatching" | "succeeded" | "pending_reconciliation" | "refused" | "not_sent";
  finalCapture: boolean; error: string | null; createdAt: string; updatedAt: string;
  resourceLabel: string | null; transport: "SDK gateway"; provenance: Provenance;
}
export interface CheckoutView {
  id: string; route: "authorization" | "package_checkout"; packageId: string | null;
  orderId: string | null; approvalUrl: string | null; amountMinor: number;
  state: "preparing" | "awaiting_payer" | "approved" | "pending_reconciliation" | "refused" | "cancelled";
  expiresAt: string;
}
export interface PaymentToolEvidence {
  id: string; tool: "get_order" | "get_refund"; transport: "PayPal Agent Toolkit";
  resourceLabel: string; status: string; observedAt: string; bodyHash: string;
  captures: { resourceLabel: string; amountMinor: number; status: string; feeMinor: number | null; netMinor: number | null }[];
  model: string | null; decision: string; provenance: Provenance;
}
export interface ProviderPayoutView {
  id: string; packageId: string; contractVersion: number; providerId: string; amountMinor: number;
  status: string; resourceLabel: string | null; observedAt: string | null;
  transport: "REST adapter"; provenance: Provenance;
  operationState: "claimed" | "dispatching" | "pending_reconciliation" | "succeeded" | "refused" | "not_sent";
  feeMinor: number | null; errorCode: string | null; canCancel: boolean; canRetry: boolean;
  cancellationState: "dispatching" | "pending_reconciliation" | "succeeded" | "refused" | "not_sent" | null;
}
export interface PaymentToolRun {
  id: string; tool: "get_order"; state: "running" | "completed" | "failed";
  resourceLabel: string; createdAt: string; updatedAt: string; failureCode: string | null;
}
export interface Commission {
  id: string; tenantId: string; title: string; museum: string; objective: string; revision: number;
  state: CommissionState; mode: "sample" | "live"; createdAt: string; updatedAt: string;
  openingAt: string; timezone: string; capMinor: number; languages: Locale[]; approvedPlanDigest: string | null;
  sourceAssets: SourceAsset[]; packages: WorkPackage[]; providers: ProviderCard[]; mandates: Mandate[];
  decisions: PolicyDecision[]; quotes: Quote[]; artifacts: ArtifactManifest[]; artifactReviews?: ArtifactReview[]; events: DomainEvent[];
  agents: AgentActivity[]; jobs: JobRun[]; payments: PaymentSummary; exhibitionSlug: string;
  schedule?: ScheduleAuthorityBinding;
}
export interface AuthorityDeadline { effectiveUntil: string | null; limits: { source: "workspace" | "passport" | "agreement"; label: string; expiresAt: string }[]; unavailable?: string }
export interface WorkspaceSnapshot { authorityDeadline?: AuthorityDeadline; schemaVersion: typeof CONTRACT_VERSION; session: { id: string; role: "judge" | "owner" | "provider" | "operator"; expiresAt: string }; commission: Commission; contractProposals?: { captions?: AcceptancePack; captionsUnavailable?: string; captionCorrection?: CaptionCorrectionProposal; captionCorrectionUnavailable?: string; images?: AcceptancePack; translation?: AcceptancePack; narration?: AcceptancePack; narrationUnavailable?: string; narrationCorrection?: NarrationCorrectionProposal; narrationCorrectionUnavailable?: string; narrationTargetedCorrection?: NarrationTargetedCorrectionProposal; narrationTargetedCorrectionUnavailable?: string; narrationFollowupCorrection?: NarrationFollowupCorrectionProposal; narrationFollowupCorrectionUnavailable?: string; draftDependencies?: DraftDependencyProposal }; serverTime: string }

export type ExhibitionLayout = "cover" | "full_bleed" | "split" | "collection_grid" | "comparison" | "audio" | "timeline" | "credits";
export interface ExhibitionText { title: string; eyebrow: string; body: string; caption: string; transcript: string }
export interface ExhibitionChapter {
  id: string; number: string; layout: ExhibitionLayout; sourceIds: string[];
  imagePath: string | null; imageAlt: Record<Locale, string>; imagePosition: string;
  mapPosition: { x: number; y: number }; content: Record<Locale, ExhibitionText>;
  audio: Partial<Record<Locale, { url: string; durationSeconds: number; segments: { start: number; end: number; text: string }[] }>>;
}
export interface ExhibitionDocument {
  id: string; slug: string; title: Record<Locale, string>; subtitle: Record<Locale, string>;
  museum: string; chapters: ExhibitionChapter[]; sources: SourceAsset[];
  languageReviews: Record<Locale, { fluentReviewed: boolean; reviewer: string | null; reviewedAt: string | null; disclosure: string }>;
  provenance: Provenance; acceptedArtifactIds: string[]; createdAt: string;
  palette: { background: string; foreground: string; accent: string }; accessibilityStatement: string;
}
export interface ScheduleSnapshot {
  revision: number; timezone: "America/New_York"; openingAt: string;
  calendar: { id: string; days: number[]; startHour: number; endHour: number };
  tasks: { id: string; name: string; packageId: string | null; providerId: string; startAt: string; durationHours: number; percentDone: number; baselineStartAt: string; baselineEndAt: string; state: string }[];
  dependencies: { id: string; from: string; to: string; type: "finish_to_start" }[];
  resources: { id: string; name: string; capacity: number }[];
}
export interface RecoveryCandidate { id: string; providerId: string; priceMinor: number; durationHours: number; finishAt: string; reviewFinishAt: string; feasible: boolean; reason: string; engine: "bryntum"; snapshotRevision: number }

const id = z.string().min(1).max(160);
const revision = z.number().int().nonnegative();
export const createCommissionSchema = z.object({ commandId: z.string().uuid(), title: z.string().min(3).max(140), museum: z.string().min(2).max(140), objective: z.string().min(20).max(6000), capMinor: z.number().int().min(100).max(64000), languages: z.array(z.enum(["en","pt","es","fr","ja","ar"])).min(1).max(6), sourceIds: z.array(id).max(30) }).strict();
export const commissionCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("approve_plan"), commandId: z.string().uuid(), expectedRevision: revision, planDigest: z.string().length(64) }).strict(),
  z.object({ type: z.literal("compile_brief"), commandId: z.string().uuid(), expectedRevision: revision }).strict(),
  z.object({ type: z.literal("produce_package"), commandId: z.string().uuid(), expectedRevision: revision, packageId: id }).strict(),
  z.object({ type: z.literal("amend_image_contract"), commandId: z.string().uuid(), expectedRevision: revision, packageId: id, contractVersion: revision, acceptancePackDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ type: z.literal("amend_translation_contract"), commandId: z.string().uuid(), expectedRevision: revision, packageId: id, contractVersion: revision, acceptancePackDigest: z.string().regex(/^[a-f0-9]{64}$/), priorArtifactId: z.string().uuid().nullable(), priorArtifactHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(), acknowledgeSuccessor: z.literal(true) }).strict(),
  z.object({ type: z.literal("amend_narration_contract"), commandId: z.string().uuid(), expectedRevision: revision, packageId: id, contractVersion: revision, acceptancePackDigest: z.string().regex(/^[a-f0-9]{64}$/), sourceArtifactId: z.string().uuid(), sourceArtifactHash: z.string().regex(/^[a-f0-9]{64}$/), acknowledgeAiVoice: z.literal(true) }).strict(),
  z.object({ type: z.literal("amend_caption_contract"), commandId: z.string().uuid(), expectedRevision: revision, packageId: id, contractVersion: revision, acceptancePackDigest: z.string().regex(/^[a-f0-9]{64}$/), acknowledgePromptedAlignment: z.literal(true), acknowledgeOneCorrection: z.literal(true) }).strict(),
  z.object({ type: z.literal("agree_caption_correction"), commandId: z.string().uuid(), expectedRevision: revision, packageId: id, contractVersion: revision, proposalDigest: z.string().regex(/^[a-f0-9]{64}$/), acknowledgeExactCorrection: z.literal(true) }).strict(),
  z.object({ type: z.literal("agree_narration_correction"), commandId: z.string().uuid(), expectedRevision: revision, packageId: id, contractVersion: revision, proposalDigest: z.string().regex(/^[a-f0-9]{64}$/), acknowledgeOneRun: z.literal(true) }).strict(),
  z.object({ type: z.literal("agree_narration_targeted_correction"), commandId: z.string().uuid(), expectedRevision: revision, packageId: id, contractVersion: revision, proposalDigest: z.string().regex(/^[a-f0-9]{64}$/), acknowledgeExactScope: z.literal(true) }).strict(),
  z.object({ type: z.literal("agree_narration_followup_correction"), commandId: z.string().uuid(), expectedRevision: revision, packageId: id, contractVersion: revision, proposalDigest: z.string().regex(/^[a-f0-9]{64}$/), acknowledgeOneRecording: z.literal(true) }).strict(),
  z.object({ type: z.literal("amend_draft_dependencies"), commandId: z.string().uuid(), expectedRevision: revision, proposalDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ type: z.literal("verify_artifact"), commandId: z.string().uuid(), expectedRevision: revision, packageId: id, artifactId: id }).strict(),
  z.object({ type: z.literal("record_automated_review"), commandId: z.string().uuid(), expectedRevision: revision, packageId: id, artifactId: id, artifactHash: z.string().regex(/^[a-f0-9]{64}$/), contractVersion: revision, criteriaDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(), findings: z.string().trim().min(30).max(6000), acknowledgeLimitations: z.literal(true) }).strict(),
  z.object({ type: z.literal("accept_package"), commandId: z.string().uuid(), expectedRevision: revision, packageId: id, artifactId: id, contractVersion: revision, acknowledgeReview: z.literal(true) }).strict(),
  z.object({ type: z.literal("request_correction"), commandId: z.string().uuid(), expectedRevision: revision, packageId: id, reason: z.string().min(8).max(2000) }).strict(),
  z.object({ type: z.literal("check_policy"), commandId: z.string().uuid(), expectedRevision: revision, scenario: z.enum(["premium_voice","injected_bid"]) }).strict(),
  z.object({ type: z.literal("revoke_mandate"), commandId: z.string().uuid(), expectedRevision: revision, mandateId: id }).strict(),
  z.object({ type: z.literal("pause"), commandId: z.string().uuid(), expectedRevision: revision }).strict(),
  z.object({ type: z.literal("resume"), commandId: z.string().uuid(), expectedRevision: revision }).strict(),
]);
export type CommissionCommand = z.infer<typeof commissionCommandSchema>;
export type CommandResult = { ok: true; commandId: string; revision: number; commission: Commission; jobId: string | null } | { ok: false; code: string; message: string; recoverable: boolean; currentRevision: number | null };
