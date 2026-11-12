import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { locales } from "@/contracts/guild";
import { webAuditCapabilitySchema, webAuditPolicy } from "@/domain/web-exhibition";
import { canonical, digest, DomainError } from "@/domain/primitives";

const hash = z.string().regex(/^[a-f0-9]{64}$/), date = z.string().datetime();
const providerId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
export const hostedWebPaths = {
  node: "/tmp/guild-node/node-v22.22.3-linux-x64/bin/node",
  tools: "/tmp/guild/tools/web-audit",
  runtime: "/tmp/guild/qualification-v1/runtime.json",
  workspace: "/tmp/guild/qualification-v1",
  browserRoot: "/tmp/guild-browser/chromium-1254",
  browser: "/tmp/guild-browser/chromium-1254/chrome-linux64/chrome",
  cases: "/tmp/guild/hosted-cases",
} as const;

const qualificationCase = z.object({
  id: z.string().regex(/^(baseline-(en|pt|es|fr|ja|ar)-(390|768|1440)|mutation-(contrast|missing-alt))$/),
  requestDigest: hash, resultHash: hash, fileManifestHash: hash, baseline: z.boolean(), passes: z.boolean(),
  score: z.number().min(0).max(1).nullable(), violationIds: z.array(z.string().min(1).max(200)).max(100),
  paletteContrast: z.boolean(), paletteSourceBound: z.boolean(), paletteRatios: z.array(z.number().finite().nonnegative()).length(4), detectedMutation: z.boolean(),
}).strict();
export const hostedQualificationSchema = z.object({
  version: z.literal("guild.web-audit-qualification.v2"), engineDigest: hash, rendererDigest: hash, inputDigest: hash, policyDigest: hash,
  baselineCases: z.literal(18), detectedMutations: z.literal(2), passed: z.literal(true), cases: z.array(qualificationCase).length(20), completedAt: date,
  productionApproval: z.literal(false), humanReview: z.literal(false), acceptance: z.literal(false), payment: z.literal(false),
}).strict();
const originalRuntimeSchema = z.object({
  version: z.literal("guild.web-audit-runtime.v2"), state: z.literal("qualified"), browserRoot: z.literal(hostedWebPaths.browserRoot),
  browserExecutable: z.literal(hostedWebPaths.browser), workspace: z.literal(hostedWebPaths.workspace), inputDigest: hash,
  capability: webAuditCapabilitySchema, qualificationPath: z.literal(hostedWebPaths.workspace + "/qualification.json"),
}).strict();
export const hostedWebMetadataSchema = z.object({
  version: z.literal("guild.web-hosted-snapshot.v1"),
  snapshot: z.object({ id: z.string().regex(/^snap_[a-zA-Z0-9]{1,100}$/), sourceSessionId: providerId, createdAt: date, expiresAt: date, region: z.literal("iad1") }).strict(),
  controlPlane: z.object({ teamId: z.string().regex(/^team_[a-zA-Z0-9]{1,100}$/), projectId: z.string().regex(/^prj_[a-zA-Z0-9]{1,100}$/) }).strict(),
  originalRuntime: originalRuntimeSchema, qualification: hostedQualificationSchema,
  originalEvidenceArchive: z.object({ sha256: hash, byteLength: z.number().int().positive().max(64 * 1024 * 1024) }).strict(),
  networkPolicy: z.literal("deny-all"), ports: z.array(z.never()).length(0), vcpus: z.literal(2), timeoutMs: z.literal(600000),
}).strict();
export const hostedWebConfigurationSchema = z.object({
  version: z.literal("guild.web-audit-hosted-runtime.v1"), execution: z.literal("hosted"), state: z.literal("qualified"),
  metadata: hostedWebMetadataSchema, seal: hash,
}).strict();
export type HostedWebConfiguration = z.infer<typeof hostedWebConfigurationSchema>;
export type HostedWebMetadata = z.infer<typeof hostedWebMetadataSchema>;

function fail(message: string): never { throw new DomainError("WEB_HOSTED_NOT_QUALIFIED", message, 422, false); }
function secret(value?: string) { const result = value ?? process.env.AUTH_SECRET; if (!result) throw new Error("AUTH_SECRET required"); return result; }
function signature(metadata: HostedWebMetadata, key?: string) {
  return createHmac("sha256", secret(key)).update(canonical({ kind: "guild.web-hosted-runtime-seal.v1", metadata })).digest("hex");
}
export function validateHostedWebMetadata(raw: unknown) {
  const value = hostedWebMetadataSchema.parse(raw), { originalRuntime: runtime, qualification: q, snapshot } = value;
  const { qualifiedAt: _at, qualificationDigest: _proof, qualifiedRendererDigest: _renderer, ...engine } = runtime.capability;
  const expected = [...locales.flatMap(locale => webAuditPolicy.viewports.map(viewport => `baseline-${locale}-${viewport.width}`)), "mutation-contrast", "mutation-missing-alt"];
  if (runtime.capability.platform !== "linux" || runtime.capability.architecture !== "x64" || runtime.capability.node !== "v22.22.3"
    || q.engineDigest !== digest(engine) || q.rendererDigest !== runtime.capability.qualifiedRendererDigest || q.inputDigest !== runtime.inputDigest
    || q.completedAt !== runtime.capability.qualifiedAt || digest(q) !== runtime.capability.qualificationDigest
    || q.policyDigest !== digest(webAuditPolicy) || digest(q.cases.map(item => item.id)) !== digest(expected)
    || q.cases.some(item => item.baseline !== item.id.startsWith("baseline-") || item.baseline && (!item.passes || item.detectedMutation || item.score === null || item.score < .95 || !item.paletteContrast || !item.paletteSourceBound || item.paletteRatios.some(ratio => ratio < 4.5)))
    || q.cases.some(item => !item.baseline && (!item.detectedMutation || item.passes))
    || !q.cases.find(item => item.id === "mutation-missing-alt")?.violationIds.includes("image-alt")
    || !q.cases.some(item => item.id === "mutation-contrast" && item.paletteSourceBound && !item.paletteContrast && item.paletteRatios.some(ratio => ratio < 4.5))
    || Date.parse(snapshot.createdAt) < Date.parse(q.completedAt) || Date.parse(snapshot.expiresAt) <= Date.parse(snapshot.createdAt))
    fail("The sealed Linux metadata does not bind the complete original 18-case and two-control qualification. No browser was dispatched.");
  return value;
}
/** An operator seals metadata only after independently retaining the original
 * raw archive. New VMs still run the full unchanged read-only verifier over all
 * original native bytes; this compact seal never substitutes for that check. */
export function sealHostedWebRuntime(raw: unknown, key?: string): HostedWebConfiguration {
  const metadata = validateHostedWebMetadata(raw);
  return { version: "guild.web-audit-hosted-runtime.v1", execution: "hosted", state: "qualified", metadata, seal: signature(metadata, key) };
}
export function verifyHostedWebConfiguration(raw: unknown, options: { historical?: boolean; now?: number; key?: string } = {}): HostedWebConfiguration {
  try {
    const config = hostedWebConfigurationSchema.parse(raw), expected = signature(config.metadata, options.key);
    if (!timingSafeEqual(Buffer.from(config.seal), Buffer.from(expected))) fail("The server-selected hosted runtime seal changed. Review the retained original qualification before admitting new work.");
    validateHostedWebMetadata(config.metadata);
    if (!options.historical && Date.parse(config.metadata.snapshot.expiresAt) <= (options.now ?? Date.now()))
      throw new DomainError("WEB_HOSTED_SNAPSHOT_EXPIRED", "The qualified browser snapshot expired. Original reports remain readable; a separately qualified runtime and reviewed agreement are required for new work.", 422, false);
    return config;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    fail("The exact sealed hosted runtime is unavailable or invalid. Saved exhibitions remain readable; no alternate snapshot was selected.");
  }
}
