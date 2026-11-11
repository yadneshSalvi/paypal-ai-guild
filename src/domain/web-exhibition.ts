import { z } from "zod";
import type { AcceptancePack, Locale } from "@/contracts/guild";
import { locales } from "@/contracts/guild";
import { captionInputBindingSchema, captionReviewEvidenceSchema, easyReadLabelSchema } from "./captions";
import { digest, DomainError } from "./primitives";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
const key = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,99}$/);
const locale = z.enum(["en", "pt", "es", "fr", "ja", "ar"]);
const sourceUrl = z.string().url().refine(value => { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; }, "Source links must be public HTTPS URLs without embedded credentials.");
const localized = <T extends z.ZodType>(value: T) => z.object({ en: value, pt: value, es: value, fr: value, ja: value, ar: value }).strict();

export const webFamilies = ["cover", "full_bleed", "split", "collection_grid", "comparison", "audio", "timeline", "credits"] as const;
export const webRendererPolicy = {
  version: "guild.authored-exhibition.v1",
  families: webFamilies,
  generatedCode: false,
  exactSourceText: true,
  originalAudioOnly: true,
  narrationAutoplay: false,
  externalResources: false,
  maximumExportBytes: 128 * 1024 * 1024,
  maximumAuthoredFileBytes: 16 * 1024 * 1024,
  offlineFormat: "zip32-stored-with-descriptors.v1",
  bundleDigest: "sha256-canonical-ordered-path-type-size-contenthash.v1",
} as const;
export const webAuditPolicy = {
  version: "guild.web-measurements.v2",
  locales: ["en", "pt", "es", "fr", "ja", "ar"],
  viewports: [{ width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }],
  cases: 18,
  caseTimeoutMs: 240000,
  maximumEvidenceFileBytes: 16 * 1024 * 1024,
  maximumEvidenceCaseBytes: 64 * 1024 * 1024,
  maximumSeriousOrCriticalAxeViolations: 0,
  minimumLighthouseAccessibilityScore: 0.95,
  paletteContrast: {
    version: "guild.opaque-palette-contrast.v1", minimumRatio: 4.5,
    formula: "wcag22-srgb-relative-luminance-0.04045-unrounded",
    pairs: [
      { id: "paper_body", foreground: "ink", background: "paper" },
      { id: "paper_muted", foreground: "mutedInk", background: "paper" },
      { id: "dark_body", foreground: "darkInk", background: "dark" },
      { id: "accent_body", foreground: "accentInk", background: "accent" },
    ],
    scope: "four_original_opaque_text_palette_pairs_only_not_universal_accessibility",
  },
  horizontalOverflowTolerancePx: 1,
  incompleteAxeFindings: "retained_for_separate_manual_review",
  keyboard: "every_authored_control_and_native_dialog_focus",
  rtl: "actual_computed_direction_and_content_order",
  audio: "original_bytes_decode_play_pause_seek_and_stop_on_language_change",
  reducedMotion: "no_nonessential_motion_when_requested",
  humanReview: ["screen_reader", "keyboard_and_focus", "content_order", "contrast", "visual_experience", "language_and_listening"],
} as const;
export const webProductionPolicies = {
  formwork: { version: "formwork.single-pass-design.v1", maximumDesignResponsesPerJob: 1, producerAuditPasses: 0, independentAuditRequired: true, description: "One original design response. No producer accessibility self-check or automatic revision." },
  ostrava: { version: "ostrava.retained-audit-revision.v1", maximumDesignResponsesPerJob: 3, producerAuditPasses: 3, independentAuditRequired: true, description: "At most three original design responses, each with its complete retained audit. Stop when all measured gates pass; keep every earlier candidate and finding." },
} as const;
export const webCommercialPolicy = { version: "guild.controlled-web-terms.v2", correctionAllowance: 1, maximumProducingJobsPerAward: 2, additionalCorrectionChargeMinor: 0, allAttemptsCount: true } as const;
export const webModelPolicy = { version: "guild.source-bound-web-design.v1", model: "gpt-6.1-sol", reasoningEffort: "max", output: "bounded_design_tokens_only", newPixelInspection: false, arbitraryGeneratedCode: false } as const;

export const webArtifactReferenceSchema = z.object({ kind: z.enum(["research", "translation", "narration", "images", "captions"]), packageId: key, contractVersion: z.number().int().positive(), artifactId: uuid, artifactHash: hash }).strict();
export const webMediaReferenceSchema = z.object({ mediaId: uuid, contentHash: hash, byteLength: z.number().int().positive().max(32 * 1024 * 1024), mediaType: z.enum(["image/webp", "audio/mpeg", "text/vtt"]) }).strict();
export const webAudioOriginSchema = z.object({ artifactId: uuid, artifactHash: hash, productionJobId: uuid, contractVersion: z.number().int().positive(), contractDigest: hash, inputBindingsDigest: hash,
  approvalPlanDigest: hash, speechRunId: uuid, speechReceiptHash: hash, originalMediaId: uuid, originalMediaHash: hash }).strict();
export const webCueSchema = z.object({ sourceStart: z.number().int().nonnegative(), sourceEnd: z.number().int().positive(), index: z.number().int().positive(), start: z.number().finite().nonnegative(), end: z.number().finite().positive(), text: z.string().min(1).max(6000), lines: z.array(z.string().min(1)).min(1).max(2) }).strict();
export const webLabelSchema = z.object({
  title: z.string().min(1).max(600), body: z.string().min(1).max(18000), transcript: z.string().min(1).max(24000),
  sourceTrackDigest: hash, scriptBytesHash: hash,
  audio: webMediaReferenceSchema.extend({ mediaType: z.literal("audio/mpeg"), durationSeconds: z.number().finite().positive().max(1200), origin: webAudioOriginSchema }).strict(),
  captions: z.object({ vtt: webMediaReferenceSchema.extend({ mediaType: z.literal("text/vtt") }).strict(), alignmentRunId: uuid, receiptHash: hash, timingsHash: hash, cuesHash: hash, cues: z.array(webCueSchema).min(1).max(1500) }).strict(),
  easyRead: easyReadLabelSchema,
}).strict();
export type WebLabel = z.infer<typeof webLabelSchema>;
export const webPhotographSchema = z.object({ id: key, sourceHash: hash, rightsHash: hash, title: z.string().min(1).max(1200), description: z.string().max(6000), creator: z.string().max(1200), date: z.string().max(400), rights: z.string().min(1).max(8000),
  sourceUrl, rightsUrl: sourceUrl, alt: localized(z.string().min(1).max(500)),
  full: webMediaReferenceSchema.extend({ mediaType: z.literal("image/webp"), width: z.number().int().positive(), height: z.number().int().positive() }).strict(),
  thumbnail: webMediaReferenceSchema.extend({ mediaType: z.literal("image/webp"), width: z.number().int().positive(), height: z.number().int().positive() }).strict(),
}).strict();
export const webSourceSchema = z.object({
  schemaVersion: z.literal("guild.exhibition-sources.v1"), museum: z.string().min(1).max(300),
  provenance: z.object({ mode: z.enum(["live", "sample"]), label: z.string().min(1).max(1200) }).strict(),
  ancestors: z.array(webArtifactReferenceSchema).length(5), inputBindings: z.array(captionInputBindingSchema).min(4).max(6), reviews: z.array(captionReviewEvidenceSchema).min(4).max(12),
  captionSourceDigest: hash, captionProductionJobId: uuid, captionVerification: z.object({ jobId: uuid, outputHash: hash }).strict(),
  requiredKeys: z.array(key).min(10).max(31), photographs: z.array(webPhotographSchema).min(9).max(30), labels: localized(z.record(key, webLabelSchema)),
  languageReviews: localized(z.object({ fluentHumanReviewed: z.literal(false), disclosure: z.string().min(1).max(1200) }).strict()),
}).strict().superRefine((value, context) => {
  const required = ["welcome", ...value.photographs.map(photo => photo.id)].sort();
  if (new Set(required).size !== required.length || [...value.requiredKeys].sort().join("\0") !== required.join("\0")) context.addIssue({ code: "custom", message: "The exact welcome and photograph label register is required." });
  if ([...new Set(value.ancestors.map(item => item.kind))].sort().join() !== ["captions", "images", "narration", "research", "translation"].join()) context.addIssue({ code: "custom", message: "All five exact upstream artifact families are required." });
  const media = new Set<string>();
  let byteLength = value.photographs.reduce((sum, photo) => sum + photo.full.byteLength + photo.thumbnail.byteLength, 0);
  for (const language of locales) {
    if (Object.keys(value.labels[language]).sort().join("\0") !== required.join("\0")) context.addIssue({ code: "custom", message: `${language}: exact complete labels required.` });
    for (const label of Object.values(value.labels[language])) {
      if (label.audio.origin.originalMediaId !== label.audio.mediaId || label.audio.origin.originalMediaHash !== label.audio.contentHash || label.captions.cues.some((cue, index, cues) => cue.end <= cue.start || index > 0 && cue.start < cues[index - 1]!.end)) context.addIssue({ code: "custom", message: "Original audio or ordered caption boundaries differ." });
      for (const file of [label.audio, label.captions.vtt]) {
        if (media.has(file.mediaId)) context.addIssue({ code: "custom", message: "Each registered audio and VTT identity must be distinct." });
        media.add(file.mediaId); byteLength += file.byteLength;
      }
    }
  }
  for (const photo of value.photographs) for (const file of [photo.full, photo.thumbnail]) {
    if (media.has(file.mediaId)) context.addIssue({ code: "custom", message: "A photograph cannot alias another original asset identity." });
    media.add(file.mediaId);
  }
  if (byteLength + 4 * 1024 * 1024 > webRendererPolicy.maximumExportBytes) context.addIssue({ code: "custom", message: "The exact owned source set exceeds the agreed portable bundle limit." });
});
export type WebSources = z.infer<typeof webSourceSchema>;

const color = z.string().regex(/^#[a-fA-F0-9]{6}$/);
export const webDesignSchema = z.object({
  schemaVersion: z.literal("guild.exhibition-design.v1"),
  palette: z.object({ paper: color, ink: color, mutedInk: color, accent: color, accentInk: color, dark: color, darkInk: color }).strict(),
  typography: z.object({ heading: z.enum(["editorial_serif", "humanist_sans"]), body: z.enum(["humanist_sans", "editorial_serif"]), bodySize: z.number().int().min(12).max(22), lineHeight: z.number().min(1.2).max(2), measure: z.enum(["compact", "balanced", "wide"]) }).strict(),
  chapters: z.array(z.object({ family: z.enum(webFamilies), labelKeys: z.array(key).max(30), sourceImageId: key.nullable(), crop: z.enum(["full_frame", "center", "upper", "lower"]), imageSide: z.enum(["leading", "trailing"]), treatment: z.enum(["paper", "dark", "accent"]) }).strict()).length(8),
  designNotes: z.array(z.string().min(1).max(800)).min(1).max(8),
}).strict();
export type WebDesign = z.infer<typeof webDesignSchema>;
export function checkedWebDesign(raw: unknown, source: WebSources): WebDesign {
  const design = webDesignSchema.parse(raw), families = design.chapters.map(item => item.family), keys = design.chapters.flatMap(item => item.labelKeys);
  if (new Set(families).size !== 8 || families[0] !== "cover" || families.at(-1) !== "credits" || keys.length !== source.requiredKeys.length || [...keys].sort().join("\0") !== [...source.requiredKeys].sort().join("\0")) throw new DomainError("WEB_DESIGN_COVERAGE", "Every exact label must appear once across all eight authored chapter families, with the cover first and credits last.", 422, false);
  for (const chapter of design.chapters) {
    if (chapter.family === "cover" && !chapter.sourceImageId || chapter.family !== "cover" && chapter.sourceImageId !== null || chapter.sourceImageId && !source.photographs.some(photo => photo.id === chapter.sourceImageId) || chapter.family === "cover" && chapter.labelKeys.join() !== "welcome" || chapter.family === "credits" && chapter.labelKeys.length
      || !["cover", "credits"].includes(chapter.family) && (!chapter.labelKeys.length || chapter.labelKeys.includes("welcome"))) throw new DomainError("WEB_DESIGN_SOURCE", "A chapter contains a foreign source, missing exact label or invented cover/credit content.", 422, false);
    if (chapter.family === "comparison" && chapter.labelKeys.length !== 2 || ["full_bleed", "split", "audio"].includes(chapter.family) && chapter.labelKeys.length !== 1 || ["collection_grid", "timeline"].includes(chapter.family) && chapter.labelKeys.length < 2) throw new DomainError("WEB_DESIGN_LAYOUT", "This authored family needs its complete agreed group of exact source labels.", 422, false);
  }
  // Keep the provider's actual valid colours and type choices, even when their
  // later measured contrast/readability fails. This validator does not fix a bid.
  return design;
}

export const webAuditCapabilitySchema = z.object({
  version: z.literal("guild.chromium-web-audit.v2"), runnerHash: hash, packageLockHash: hash,
  dependenciesDigest: hash, browserDistributionDigest: hash, nodeExecutableHash: hash, browserRevision: z.literal("1254"), operatingSystem: z.string().min(1).max(300),
  playwright: z.string().min(1).max(80), axe: z.string().min(1).max(80), lighthouse: z.string().min(1).max(80),
  browserVersion: z.string().min(1).max(160), browserExecutableHash: hash, platform: z.string().min(1).max(80), architecture: z.string().min(1).max(80), node: z.string().min(1).max(80),
  qualifiedAt: z.string().datetime(), qualificationDigest: hash,
  qualifiedRendererDigest: hash,
}).strict();
export type WebAuditCapability = z.infer<typeof webAuditCapabilitySchema>;
export const webRendererCapabilitySchema = z.object({ version: z.literal(webRendererPolicy.version), files: z.array(z.object({ path: z.string().min(1).max(240), sha256: hash }).strict()).min(8).max(32), digest: hash }).strict();
export type WebRendererCapability = z.infer<typeof webRendererCapabilitySchema>;
export const webAuthoritySchema = z.object({ version: z.literal("guild.web-authority-ceiling.v1"), expiresAt: z.string().datetime(),
  approval: z.object({ id: uuid, actorId: uuid, planDigest: hash, receiptHash: hash, actorExpiresAt: z.string().datetime(), commandId: uuid, snapshotHash: hash }).strict(),
  limits: z.array(z.object({ label: z.string().min(1), expiresAt: z.string().datetime() }).strict()).min(1).max(32),
}).strict().superRefine((value, context) => {
  if (Date.parse(value.expiresAt) !== Math.min(Date.parse(value.approval.actorExpiresAt), ...value.limits.map(item => Date.parse(item.expiresAt)))) context.addIssue({ code: "custom", message: "The web authority ceiling must retain the earliest original approved limit." });
});
export type WebAuthority = z.infer<typeof webAuthoritySchema>;
export function webAcceptancePack(raw: WebSources, rawAuthority: WebAuthority, rawCapability: WebAuditCapability, rawRenderer: WebRendererCapability): AcceptancePack {
  const source = webSourceSchema.parse(raw), authority = webAuthoritySchema.parse(rawAuthority), auditCapability = webAuditCapabilitySchema.parse(rawCapability), rendererCapability = webRendererCapabilitySchema.parse(rawRenderer);
  if (rendererCapability.digest !== digest(rendererCapability.files)) throw new DomainError("WEB_RENDERER_CHANGED", "The authored renderer files do not match their frozen capability.", 422, false);
  if (auditCapability.qualifiedRendererDigest !== rendererCapability.digest) throw new DomainError("WEB_AUDIT_UNQUALIFIED", "The exact authored reader has not completed the retained browser qualification for this engine.", 422, false);
  const criteria: AcceptancePack["criteria"] = [
    { id: "sources", label: "Every exact label, original recording, caption and image is present", description: "All six locales and exact original sources, transitive producers, reviews and independent reports remain hash-bound.", kind: "deterministic", blocking: true, status: "pending", evidence: null },
    { id: "bundle", label: "The actual portable files match their immutable manifest", description: "Authored code, all original media, complete content and font licences match the exact ordered file hashes. No generated code or external resource is executed.", kind: "deterministic", blocking: true, status: "pending", evidence: null },
    { id: "axe", label: "No serious or critical axe violations in any of 18 cases", description: "The pinned browser checks all six locales at 390, 768 and 1440 pixels. Every other violation and incomplete finding is retained for review.", kind: "deterministic", blocking: true, status: "pending", evidence: null },
    { id: "lighthouse", label: "Measured accessibility score at least 95 in every case", description: "Each of the 18 pinned Lighthouse runs must return a measured accessibility score of at least 0.95. Missing scores and engine errors do not pass.", kind: "deterministic", blocking: true, status: "pending", evidence: null },
    { id: "palette", label: "Original text palette meets 4.5:1 across four bound pairs", description: "Each case preserves the original computed opaque CSS palette and exact unrounded WCAG sRGB ratios for body/paper, muted/paper, light/dark and ink/accent. This separate gate does not reclassify native axe findings or prove universal accessibility.", kind: "deterministic", blocking: true, status: "pending", evidence: null },
    { id: "interaction", label: "Keyboard, focus, original audio and RTL work at every width", description: "Measured control activation, dialog return, locale switching, original audio playback/pause/seek, no autoplay, RTL, reduced motion and document overflow checks must all pass.", kind: "deterministic", blocking: true, status: "pending", evidence: null },
    { id: "experience", label: "The curator reviews the complete reading experience", description: "Review actual keyboard and screen-reader use, content order, contrast, crops, listening, language meaning and visual quality. Automated scores do not establish universal accessibility or fluent human review.", kind: "human", blocking: true, status: "pending", evidence: null },
  ];
  const parameters = { source, sourceDigest: digest(source), authority, auditCapability, rendererCapability, renderer: webRendererPolicy, audit: webAuditPolicy, productionPolicies: webProductionPolicies, commercial: webCommercialPolicy, model: webModelPolicy };
  const pack = { id: "guild.web-exhibition", version: "2.0.0", title: "A complete, measured exhibition", correctionAllowance: 1, criteria, parameters };
  return { ...pack, digest: digest(pack) };
}
export function webSourcesFromPack(pack: AcceptancePack): WebSources {
  try {
    const source = webSourceSchema.parse(pack.parameters?.source), authority = webAuthoritySchema.parse(pack.parameters?.authority), capability = webAuditCapabilitySchema.parse(pack.parameters?.auditCapability), renderer = webRendererCapabilitySchema.parse(pack.parameters?.rendererCapability);
    if (pack.version !== "2.0.0" || digest({ ...pack, criteria: pack.criteria.map(item => ({ ...item, status: "pending", evidence: null })) }) !== digest(webAcceptancePack(source, authority, capability, renderer))) throw new Error("Changed pack");
    return source;
  } catch { throw new DomainError("WEB_CONTRACT_CHANGED", "The exact web source, renderer, measured audit capability, limits or original authority differs from its agreed acceptance pack.", 422, false); }
}

export const webFileSchema = z.object({ path: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_./-]{0,220}$/).refine(value => value.split("/").every(part => part && part !== "." && part !== ".."), "Every bundle path must stay inside its exact owned archive."), mediaType: z.enum(["text/html", "text/css", "application/javascript", "application/json", "text/plain", "font/woff2", "image/webp", "audio/mpeg", "text/vtt"]), byteLength: z.number().int().positive().max(webRendererPolicy.maximumExportBytes), contentHash: hash, mediaId: uuid.nullable() }).strict();
export type WebFile = z.infer<typeof webFileSchema>;
export const webBundleSchema = z.object({ version: z.literal("guild.portable-exhibition.v1"), rendererVersion: z.literal(webRendererPolicy.version), sourceDigest: hash, designDigest: hash, files: z.array(webFileSchema).min(12).max(450), filesDigest: hash, totalBytes: z.number().int().positive().max(webRendererPolicy.maximumExportBytes) }).strict();
export type WebBundle = z.infer<typeof webBundleSchema>;
export function webBundleDigest(files: WebFile[]) { return digest(files.map(({ path, mediaType, byteLength, contentHash }) => ({ path, mediaType, byteLength, contentHash }))); }

export function webLanguage(language: string): Locale {
  if (!locales.includes(language as Locale)) throw new DomainError("WEB_LOCALE", "Choose one of the six agreed exhibition languages.", 422, false);
  return language as Locale;
}
