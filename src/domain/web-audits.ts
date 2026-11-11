import { z } from "zod";
import { locales, type AcceptancePack, type Locale } from "@/contracts/guild";
import { digest, DomainError } from "./primitives";
import { webAuditCapabilitySchema, webAuditPolicy, webBundleSchema, webDesignSchema, webSourceSchema } from "./web-exhibition";

const hash = z.string().regex(/^[a-f0-9]{64}$/), uuid = z.string().uuid();
export const webRequiredAxeStates = ["default", "expanded", "map", "settings", "source", "share"] as const;
export const webRequiredInteractions = ["source_text", "palette_contrast", "original_media_register", "images_decoded", "no_autoplay", "document_overflow", "rtl", "keyboard_register", "dialog_focus", "locale_keyboard", "original_audio", "captions_seek", "reader_preferences", "chapter_navigation", "reduced_motion", "no_external_resources", "no_page_errors"] as const;
const viewport = z.object({ width: z.union([z.literal(390), z.literal(768), z.literal(1440)]), height: z.number().int().positive() }).strict();
export const webAuditRequestSchema = z.object({
  version: z.literal("guild.web-audit-request.v2"), mode: z.enum(["producer", "independent", "qualification"]),
  locale: z.enum(locales), viewport, caseId: z.string().regex(/^[a-z0-9:_-]{1,150}$/),
  authorityDigest: hash, rendererDigest: hash, capability: webAuditCapabilitySchema,
  sourceDigest: hash, designDigest: hash, bundle: webBundleSchema,
}).strict().superRefine((value, context) => {
  const expected = webAuditPolicy.viewports.find(item => item.width === value.viewport.width);
  if (expected?.height !== value.viewport.height || value.sourceDigest !== value.bundle.sourceDigest || value.designDigest !== value.bundle.designDigest) context.addIssue({ code: "custom", message: "The case must bind the exact declared source, design, bundle and viewport." });
});
export type WebAuditRequest = z.infer<typeof webAuditRequestSchema>;
export const webAuditFileSchema = z.object({ path: z.string().regex(/^[a-z][a-z0-9-]{0,150}\.json$/), contentHash: hash, byteLength: z.number().int().positive().max(16 * 1024 * 1024) }).strict();
export const webInteractionSchema = z.object({ id: z.enum(webRequiredInteractions), passed: z.boolean(), detail: z.string().max(8000), observed: z.unknown() }).strict();
export const webAuditResultSchema = z.object({
  version: z.literal("guild.web-audit-result.v2"), requestDigest: hash, caseId: z.string().min(1).max(150),
  locale: z.enum(locales), viewport, mode: z.enum(["producer", "independent", "qualification"]),
  sourceDigest: hash, designDigest: hash, bundleDigest: hash, capabilityDigest: hash, rendererDigest: hash,
  startedAt: z.string().datetime(), finishedAt: z.string().datetime(), complete: z.boolean(),
  axe: z.array(z.object({ state: z.enum(webRequiredAxeStates), file: webAuditFileSchema, violations: z.number().int().nonnegative(), seriousCritical: z.number().int().nonnegative(), incomplete: z.number().int().nonnegative() }).strict()).max(6),
  lighthouse: z.object({ file: webAuditFileSchema, accessibilityScore: z.number().min(0).max(1).nullable(), warnings: z.array(z.string()) }).strict().nullable(),
  interactions: z.array(webInteractionSchema).max(webRequiredInteractions.length),
  files: z.array(webAuditFileSchema).max(200), errors: z.array(z.object({ code: z.string().min(1).max(150), message: z.string().max(10000) }).strict()).max(100),
}).strict();
export type WebAuditResult = z.infer<typeof webAuditResultSchema>;
export function validateWebAuditResult(request: WebAuditRequest, raw: unknown): WebAuditResult {
  const result = webAuditResultSchema.parse(raw);
  if (result.requestDigest !== digest(request) || result.caseId !== request.caseId || result.locale !== request.locale || digest(result.viewport) !== digest(request.viewport)
    || result.mode !== request.mode || result.sourceDigest !== request.sourceDigest || result.designDigest !== request.designDigest || result.bundleDigest !== request.bundle.filesDigest
    || result.capabilityDigest !== digest(request.capability) || result.rendererDigest !== request.rendererDigest || Date.parse(result.finishedAt) < Date.parse(result.startedAt)
    || new Set(result.files.map(file => file.path)).size !== result.files.length
    || new Set(result.axe.map(item => item.state)).size !== result.axe.length || new Set(result.interactions.map(item => item.id)).size !== result.interactions.length
    || result.complete && (result.axe.length !== webRequiredAxeStates.length || result.interactions.length !== webRequiredInteractions.length || !result.lighthouse)
    || !result.complete && !result.errors.length
    || [...result.axe.map(item => item.file), ...(result.lighthouse ? [result.lighthouse.file] : [])].some(item => !result.files.some(file => digest(file) === digest(item))))
    throw new DomainError("WEB_AUDIT_BINDING", "The browser measurements differ from their exact original case, files, source or qualified engine.", 422, false);
  return result;
}
export function webCaseOutcomes(result: WebAuditResult) {
  const complete = result.complete && !result.errors.length;
  return {
    axe: complete && webRequiredAxeStates.every(state => result.axe.some(item => item.state === state)) && result.axe.every(item => item.seriousCritical === 0),
    lighthouse: complete && result.lighthouse?.accessibilityScore !== null && result.lighthouse?.accessibilityScore !== undefined && result.lighthouse.accessibilityScore >= webAuditPolicy.minimumLighthouseAccessibilityScore,
    palette: complete && result.interactions.some(item => item.id === "palette_contrast" && item.passed),
    interaction: complete && webRequiredInteractions.every(id => result.interactions.some(item => item.id === id && item.passed)) && result.interactions.every(item => item.passed),
  };
}
export const webAuditReceiptSchema = z.object({ id: uuid, requestDigest: hash, resultHash: hash, result: webAuditResultSchema }).strict();
export type WebAuditReceipt = z.infer<typeof webAuditReceiptSchema>;
export function webAuditSummary(receipts: WebAuditReceipt[]) {
  const expected = locales.flatMap(locale => webAuditPolicy.viewports.map(viewport => `${locale}:${viewport.width}`));
  const cases = receipts.map(item => `${item.result.locale}:${item.result.viewport.width}`);
  const coverageComplete = receipts.length === 18 && new Set(cases).size === 18 && expected.every(item => cases.includes(item))
    && receipts.every(item => item.resultHash === digest(item.result) && item.requestDigest === item.result.requestDigest)
    && new Set(receipts.map(({ result: item }) => digest({ source: item.sourceDigest, design: item.designDigest, bundle: item.bundleDigest, capability: item.capabilityDigest, renderer: item.rendererDigest, mode: item.mode }))).size === 1;
  const complete = coverageComplete && receipts.every(item => item.result.complete && !item.result.errors.length);
  const results = receipts.map(item => ({ id: item.id, locale: item.result.locale, width: item.result.viewport.width, ...webCaseOutcomes(item.result) }));
  return { complete, coverageComplete, expectedCases: 18, retainedCases: receipts.length, axe: complete && results.every(item => item.axe), lighthouse: complete && results.every(item => item.lighthouse), palette: complete && results.every(item => item.palette), interaction: complete && results.every(item => item.interaction),
    seriousCritical: receipts.reduce((sum, item) => sum + item.result.axe.reduce((n, state) => n + state.seriousCritical, 0), 0),
    incompleteFindings: receipts.reduce((sum, item) => sum + item.result.axe.reduce((n, state) => n + state.incomplete, 0), 0),
    scores: receipts.map(item => ({ locale: item.result.locale, width: item.result.viewport.width, score: item.result.lighthouse?.accessibilityScore ?? null })), results };
}
export const webCandidateSchema = z.object({
  ordinal: z.number().int().min(1).max(3), design: webDesignSchema, designDigest: hash, bundleId: uuid, bundle: webBundleSchema,
  model: z.object({ runId: uuid, model: z.string().min(1), inputHash: hash, outputHash: hash, providerResponseId: z.string().min(1).max(300) }).strict(),
  producerAudits: z.array(webAuditReceiptSchema).max(18),
}).strict();
export type WebCandidate = z.infer<typeof webCandidateSchema>;
export const webArtifactSchema = z.object({
  schemaVersion: z.literal("guild.exhibition.v2"), contractDigest: hash, sourceDigest: hash, sources: webSourceSchema,
  productionJobId: uuid, providerId: z.enum(["formwork", "ostrava"]), providerPolicyDigest: hash, pipelineVersion: z.string().min(1),
  attempt: z.union([z.literal(1), z.literal(2)]), correction: z.object({ id: uuid, digest: hash }).strict().nullable(),
  inputBindings: webSourceSchema.shape.inputBindings, candidates: z.array(webCandidateSchema).min(1).max(3), selectedOrdinal: z.number().int().min(1).max(3),
  originalMediaUnchanged: z.literal(true), newNarration: z.literal(false), fluentHumanReviewed: z.literal(false), humanExperienceReviewed: z.literal(false),
  limitations: z.array(z.string().min(1).max(1600)).min(1).max(12),
}).strict();
export type WebArtifact = z.infer<typeof webArtifactSchema>;
export function webMeasuredPack(pack: AcceptancePack, sources: boolean, bundle: boolean, receipts: WebAuditReceipt[]): AcceptancePack {
  const summary = webAuditSummary(receipts), values: Record<string, { passed: boolean; detail: string }> = {
    sources: { passed: sources, detail: sources ? "Exact historical source, original media, approved snapshots, reviews and independent reports were revalidated." : "The original source or approval chain failed its exact binding check." },
    bundle: { passed: bundle, detail: bundle ? "Every authored and original-media file matched its exact byte count and SHA-256." : "One or more actual portable files did not match their immutable manifest." },
    axe: { passed: summary.axe, detail: `${summary.retainedCases}/18 cases retained; ${summary.seriousCritical} serious/critical state findings; ${summary.incompleteFindings} incomplete findings retained for manual review.` },
    lighthouse: { passed: summary.lighthouse, detail: `${summary.scores.filter(item => item.score !== null && item.score >= .95).length}/18 measured scores meet 0.95. Missing scores do not pass.` },
    palette: { passed: summary.palette, detail: `${summary.results.filter(item => item.palette).length}/18 cases passed all four exact opaque text palette pairs at an unrounded ratio of at least 4.5:1. Native axe incomplete findings remain separate.` },
    interaction: { passed: summary.interaction, detail: `${summary.results.filter(item => item.interaction).length}/18 cases passed every required keyboard, focus, original-audio, content-order and layout observation.` },
  };
  return { ...pack, criteria: pack.criteria.map(item => item.kind !== "deterministic" ? { ...item, status: "pending", evidence: "Human experience, screen-reader, language and listening review remain separate; no acceptance or payment occurred." } : { ...item, status: values[item.id]?.passed ? "passed" : "failed", evidence: values[item.id]?.detail ?? "This criterion has no measured result." }) };
}
export function webCaseName(language: Locale, width: number) { return `${language}:${width}`; }
