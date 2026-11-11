import { z } from "zod";
import { scheduleSnapshotSchema, type ScheduleEvaluation } from "./contracts";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/);
const revision = z.number().int().nonnegative();
export const scheduleSourceSchema = z.strictObject({
  commissionId: z.string().uuid(), openingAt: z.iso.datetime(), timeZone: z.string(),
  contracts: z.array(z.strictObject({
    packageId: id, contractVersion: revision, contractDigest: hash, acceptancePackDigest: hash,
    providerId: id, providerPolicyDigest: hash, providerCapacity: z.number().int().positive(),
    providerAwardMinor: z.number().int().nonnegative(), serviceFeeMinor: z.number().int().nonnegative(),
    workingHours: z.number().nonnegative(), dependsOn: z.array(id),
    artifacts: z.array(z.strictObject({ id: z.string().uuid(), hash })),
  })).min(1).max(32),
});
export type ScheduleSource = z.infer<typeof scheduleSourceSchema>;

export const controlledScheduleQuoteSchema = z.strictObject({
  schemaVersion: z.literal("guild.controlled-schedule-quote.v1"), id: z.string().uuid(), revision: z.literal(1),
  tenantId: z.string().uuid(), commissionId: z.string().uuid(), packageId: id,
  contractVersion: revision, contractDigest: hash, acceptancePackDigest: hash,
  failedSubmission: z.strictObject({ artifactId: z.string().uuid(), artifactHash: hash, verificationId: z.string().uuid(), criteriaDigest: hash }),
  providerId: z.enum(["formwork", "ostrava"]), providerPolicyDigest: hash, servicePolicyDigest: hash,
  offer: z.enum(["economy", "accessible"]), providerAwardMinor: z.number().int().positive(),
  serviceFeeMinor: z.number().int().nonnegative(), grossMinor: z.number().int().positive(),
  workingHours: z.number().positive().multipleOf(0.25), capacityUnits: z.number().int().positive(),
  calendar: scheduleSnapshotSchema.shape.calendars.element,
  timeZone: z.literal("America/New_York"), notBefore: z.iso.datetime(),
  issuedAt: z.iso.datetime(), expiresAt: z.iso.datetime(), authorityExpiresAt: z.iso.datetime(),
  renewal: z.strictObject({ quoteId: z.string().uuid(), quoteDigest: hash }).nullable(),
  clock: z.literal("accelerated_scenario"),
  provenance: z.strictObject({
    kind: z.literal("controlled_provider_offer"), environment: z.enum(["sample", "live"]),
    issuer: z.literal("Guild team-operated provider service"), disclosure: z.string(),
  }),
  digest: hash, signature: hash,
});
export type ControlledScheduleQuote = z.infer<typeof controlledScheduleQuoteSchema>;

/** The nested engine forecast keeps v1's modelled meaning. Real quote expiry is separate. */
export const persistedScheduleSchema = z.strictObject({
  schemaVersion: z.literal("guild.schedule.v2"), id: z.string().uuid(), commissionId: z.string().uuid(),
  revision: revision.min(1), source: scheduleSourceSchema, sourceDigest: hash,
  forecast: scheduleSnapshotSchema, quoteBindings: z.array(controlledScheduleQuoteSchema).max(32),
  createdAt: z.iso.datetime(), digest: hash,
});
export type PersistedSchedule = z.infer<typeof persistedScheduleSchema>;
export interface ScheduleAuthorityBinding {
  schemaVersion: "guild.schedule-authority.v1";
  id: string; revision: number; digest: string; sourceDigest: string;
  quoteIds: string[];
}
export const schedulePatchSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("quote"), quoteId: z.string().uuid() }),
  z.strictObject({ type: z.literal("move_task"), taskId: id, notBefore: z.iso.datetime() }),
  z.strictObject({ type: z.literal("reconcile_source") }),
]);
export type SchedulePatch = z.infer<typeof schedulePatchSchema>;
export interface ScheduleProposal {
  schemaVersion: "guild.schedule-proposal.v1"; id: string; digest: string;
  baseScheduleRevision: number; baseCommissionRevision: number; sourceDigest: string;
  patch: SchedulePatch; candidate: PersistedSchedule; evaluation: ScheduleEvaluation;
  createdAt: string; expiresAt: string; status: "proposed" | "prepared";
  commercial: { previousTotalMinor: number; proposedTotalMinor: number; capMinor: number };
  disclosure: string;
}
export interface ScheduleWorkspace {
  schedule: PersistedSchedule | null;
  evaluation: ScheduleEvaluation | null;
  quotes: ControlledScheduleQuote[];
  proposals: ScheduleProposal[];
  comparisons: { quoteId: string; evaluation: ScheduleEvaluation | null; unavailable: string | null }[];
  sourceCurrent: boolean;
  serverTime: string;
  assistant: { configured: boolean; model: "gpt-6.1-sol"; reasoning: "max" };
}
const base = { commandId: z.string().uuid(), expectedRevision: revision };
export const scheduleCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...base, type: z.literal("initialize_schedule") }),
  z.strictObject({ ...base, type: z.literal("request_recovery_offers"), scheduleRevision: revision.min(1) }),
  z.strictObject({ ...base, type: z.literal("renew_recovery_offer"), scheduleRevision: revision.min(1), quoteId: z.string().uuid() }),
  z.strictObject({ ...base, type: z.literal("propose_schedule"), scheduleRevision: revision.min(1), patch: schedulePatchSchema }),
  z.strictObject({ ...base, type: z.literal("prepare_schedule_passport"), scheduleRevision: revision.min(1), proposalId: z.string().uuid(), proposalDigest: hash, acknowledge: z.literal(true) }),
]);
export type ScheduleCommand = z.infer<typeof scheduleCommandSchema>;
