import { z } from "zod";

const revision = z.number().int().nonnegative();
const packageId = z.string().min(1).max(80);
export const paymentCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("prepare_checkout"), expectedRevision: revision, route: z.enum(["authorization", "package_checkout"]), packageId: packageId.optional() }).strict(),
  z.object({ type: z.literal("complete_checkout"), intentId: z.string().uuid(), orderId: z.string().regex(/^[A-Z0-9]{10,32}$/), checkoutToken: z.string().min(32).max(128) }).strict(),
  z.object({ type: z.literal("resume_checkout"), intentId: z.string().uuid(), orderId: z.string().regex(/^[A-Z0-9]{10,32}$/), checkoutToken: z.string().min(32).max(128) }).strict(),
  z.object({ type: z.literal("cancel_checkout"), intentId: z.string().uuid(), checkoutToken: z.string().min(32).max(128) }).strict(),
  z.object({ type: z.literal("capture_package"), expectedRevision: revision, packageId }).strict(),
  z.object({ type: z.literal("close_authorization"), expectedRevision: revision, switchToPackageCheckout: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("retry_operation"), intentId: z.string().uuid() }).strict(),
  z.object({ type: z.literal("reconcile") }).strict(),
  z.object({ type: z.literal("inspect_order") }).strict(),
  z.object({ type: z.literal("pay_provider"), expectedRevision: revision, packageId }).strict(),
  z.object({ type: z.literal("retry_payout"), payoutId: z.string().uuid() }).strict(),
  z.object({ type: z.literal("cancel_payout"), payoutId: z.string().uuid() }).strict(),
]);
export type GuildPaymentCommand = z.infer<typeof paymentCommandSchema>;
