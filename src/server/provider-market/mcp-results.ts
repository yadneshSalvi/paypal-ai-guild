import { z } from "zod";

export const mcpBusinessRefusalSchema = z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean(), unknownOutcome: z.boolean() }).strict(), paymentAuthorized: z.literal(false) }).strict();
const id = z.string().uuid(), minor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const mcpDraftResultSchema = z.object({ commissionId: id, state: z.literal("draft"), statusUri: z.url(), approvalRequired: z.literal(true), paymentAuthorized: z.literal(false) }).strict();
export const mcpStatusResultSchema = z.object({ commissionId: id, title: z.string(), revision: z.number().int().nonnegative(), state: z.string(), packages: z.array(z.object({ id: z.string(), title: z.string(), state: z.string() }).strict()), approvedPlan: z.boolean(), captureMinor: minor, payoutMinor: minor, disclosure: z.string() }).strict();
export const mcpLinkResultSchema = z.object({ url: z.url(), expiresAt: z.string().datetime(), commissionId: id, expectedRevision: z.number().int().nonnegative(), ownerInteractionRequired: z.literal(true), paymentAuthorized: z.literal(false) }).strict();
