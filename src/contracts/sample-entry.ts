import { z } from "zod";

/** One explicit browser admission. Retain this exact request until its original
 * result is known; changing it is never a recovery operation. */
export const sampleEntryRequestSchema = z.object({
  version: z.literal("guild.sample-entry.v1"), intent: z.literal("open_sample"),
  requestId: z.string().uuid().transform(value => value.toLowerCase()),
  proof: z.string().regex(/^[A-Za-z0-9_-]{43}$/), requestedAt: z.string().datetime(),
}).strict();
export type SampleEntryRequest = z.infer<typeof sampleEntryRequestSchema>;
