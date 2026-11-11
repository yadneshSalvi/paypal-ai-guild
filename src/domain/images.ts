import { z } from "zod";
import type { AcceptancePack, Locale, SourceAsset } from "@/contracts/guild";
import { locales } from "@/contracts/guild";
import { digest } from "./primitives";

export const imageTreatment = {
  version: "halide.full-frame.v1",
  engine: { sharp: "0.35.5", vips: "8.18.7", webp: "1.6.0" },
  full: { longEdge: 2200, minimumLongEdge: 1440, maximumBytes: 2_000_000 },
  thumbnail: { longEdge: 640, minimumLongEdge: 320, maximumBytes: 200_000 },
  format: "webp", colourspace: "srgb", quality: 90, fit: "inside", withoutEnlargement: true,
  crop: "full_frame", generativePixelChanges: false,
  comparison: { method: "aligned_rgb_rmse_and_dhash.v1", maximumNormalizedRmse: 0.06, maximumDHashDistance: 10 },
} as const;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const localizedAlt = z.object({ en: z.string().min(8).max(500), pt: z.string().min(8).max(500), es: z.string().min(8).max(500), fr: z.string().min(8).max(500), ja: z.string().min(8).max(500), ar: z.string().min(8).max(500) }).strict();
export const imageDescriptionSchema = z.object({ sourceId: z.string(), alt: localizedAlt, visibleFeatures: z.array(z.string().min(4).max(400)).min(1).max(12), uncertainties: z.array(z.string().min(4).max(500)).max(12), framingReason: z.string().min(20).max(1200) }).strict();
export type ImageDescription = z.infer<typeof imageDescriptionSchema>;

export const imageComparisonSchema = z.object({
  method: z.literal(imageTreatment.comparison.method), pixelsCompared: z.number().int().positive(),
  normalizedMeanAbsoluteError: z.number().min(0).max(1), normalizedRootMeanSquareError: z.number().min(0).max(1),
  peakSignalToNoiseDb: z.number().finite().nullable(), dHashDistance: z.number().int().min(0).max(64),
  alignedSourcePixelHash: sha256, derivativePixelHash: sha256,
}).strict();
export type ImageComparison = z.infer<typeof imageComparisonSchema>;
export const imageMeasureSchema = z.object({
  width: z.number().int().positive(), height: z.number().int().positive(), bytes: z.number().int().positive(),
  format: z.literal("webp"), colourspace: z.literal("srgb"), hasIccProfile: z.literal(true), iccProfileHash: sha256,
  contentHash: sha256, comparison: imageComparisonSchema,
}).strict();
export type ImageMeasure = z.infer<typeof imageMeasureSchema>;
export const imageFileSchema = imageMeasureSchema.extend({ mediaId: z.string().uuid(), url: z.string().regex(/^\/api\/media\/[0-9a-f-]{36}$/) }).strict();
export type ImageFile = z.infer<typeof imageFileSchema>;
export const treatedImageSchema = z.object({
  sourceId: z.string(), sourceHash: sha256, rightsHash: sha256, sourceUrl: z.string().url(), rightsUrl: z.string().url(),
  sourceWidth: z.number().int().positive(), sourceHeight: z.number().int().positive(),
  crop: z.object({ left: z.literal(0), top: z.literal(0), width: z.number().int().positive(), height: z.number().int().positive() }).strict(),
  description: imageDescriptionSchema, full: imageFileSchema, thumbnail: imageFileSchema,
  modelRun: z.object({ id: z.string().uuid(), model: z.string() }).strict(),
}).strict();
export type TreatedImage = z.infer<typeof treatedImageSchema>;
export const imageArtifactSchema = z.object({
  schemaVersion: z.literal("guild.image-treatment.v2"), contractDigest: sha256, treatment: z.unknown(),
  sourceManifest: z.array(z.object({ id: z.string(), contentHash: sha256, rightsHash: sha256 }).strict()).min(1).max(30),
  images: z.array(treatedImageSchema).min(1).max(30), humanFidelityReviewed: z.literal(false),
  languageReviews: z.record(z.string(), z.object({ fluentReviewed: z.literal(false), disclosure: z.string() }).strict()),
  limitations: z.array(z.string()),
}).strict();
export type ImageArtifact = z.infer<typeof imageArtifactSchema>;

export function imageRightsHash(source: SourceAsset): string {
  return digest({ sourceUrl: source.sourceUrl, rightsUrl: source.rightsUrl, rights: source.rights, title: source.title, creator: source.creator, date: source.date });
}
export function imageSourceManifest(sources: SourceAsset[]) {
  return sources.map(source => ({ id: source.id, contentHash: source.contentHash, rightsHash: imageRightsHash(source) }));
}
export function imageAcceptancePack(sources: SourceAsset[]): AcceptancePack {
  const criteria: AcceptancePack["criteria"] = [
    { id: "rights", label: "Every image retains its agreed source and rights", description: "Exact source-image and archival-rights hashes match the frozen manifest.", blocking: true, kind: "deterministic", status: "pending", evidence: null },
    { id: "coverage", label: "Every agreed photograph has a full image and thumbnail", description: "Exactly one pair per source; each immutable file belongs to this commission and production job.", blocking: true, kind: "deterministic", status: "pending", evidence: null },
    { id: "files", label: "Measured files fit the exhibition", description: "Decode WebP, preserve full-frame aspect ratio, embed a valid sRGB profile, meet frozen pixel and byte limits, and match the stored file hash.", blocking: true, kind: "deterministic", status: "pending", evidence: null },
    { id: "comparison", label: "Pixel and perceptual comparisons remain within the agreed bounds", description: "Aligned RGB normalized RMSE ≤0.06 and 64-bit difference-hash distance ≤10. These measurements do not establish historical fidelity.", blocking: true, kind: "deterministic", status: "pending", evidence: null },
    { id: "alt", label: "Each image has a bounded alt description in all six locales", description: "Nonempty locale fields are required; wording quality, meaning and language review remain distinct decisions.", blocking: true, kind: "deterministic", status: "pending", evidence: null },
    { id: "fidelity", label: "Curator approves historical fidelity, framing and alt text", description: "Review every full-frame image beside its source. No numerical metric or model output substitutes for this decision.", blocking: true, kind: "human", status: "pending", evidence: null },
  ];
  const definition = { id: "pack-images-v2", version: "2.0.0", title: "Image treatment acceptance pack", criteria, correctionAllowance: 1, treatment: imageTreatment, sourceManifest: imageSourceManifest(sources) };
  return { id: definition.id, version: definition.version, title: definition.title, digest: digest(definition), criteria, correctionAllowance: 1 };
}

export function expectedImageDimensions(width: number, height: number, kind: "full" | "thumbnail") {
  const scale = Math.min(1, imageTreatment[kind].longEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function checkImageArtifact(content: unknown, sources: SourceAsset[], contractDigest: string) {
  const parsed = imageArtifactSchema.safeParse(content), image = parsed.success ? parsed.data : null;
  const known = new Map(sources.map(source => [source.id, source]));
  const rights = !!image && contractDigest === imageAcceptancePack(sources).digest && image.contractDigest === contractDigest && digest(image.treatment) === digest(imageTreatment) && digest(image.sourceManifest) === digest(imageSourceManifest(sources)) && image.images.every(item => {
    const source = known.get(item.sourceId);
    return !!source && item.sourceHash === source.contentHash && item.rightsHash === imageRightsHash(source) && item.sourceUrl === source.sourceUrl && item.rightsUrl === source.rightsUrl;
  });
  const coverage = !!image && image.images.length === sources.length && new Set(image.images.map(item => item.sourceId)).size === sources.length && image.images.every(item => known.has(item.sourceId)) && new Set(image.images.flatMap(item => [item.full.mediaId, item.thumbnail.mediaId])).size === sources.length * 2;
  const files = !!image && image.images.every(item => (["full", "thumbnail"] as const).every(kind => {
    const file = item[kind], expected = expectedImageDimensions(item.sourceWidth, item.sourceHeight, kind);
    return file.url === `/api/media/${file.mediaId}` && file.width === expected.width && file.height === expected.height && Math.max(file.width, file.height) >= imageTreatment[kind].minimumLongEdge && file.bytes <= imageTreatment[kind].maximumBytes && item.crop.width === item.sourceWidth && item.crop.height === item.sourceHeight && file.comparison.pixelsCompared === file.width * file.height;
  }));
  const comparison = !!image && image.images.every(item => [item.full, item.thumbnail].every(file => file.comparison.normalizedRootMeanSquareError <= imageTreatment.comparison.maximumNormalizedRmse && file.comparison.dHashDistance <= imageTreatment.comparison.maximumDHashDistance));
  const alt = !!image && image.images.every(item => item.description.sourceId === item.sourceId && locales.every(locale => item.description.alt[locale].trim().length >= 8)) && locales.every(locale => image.languageReviews[locale]?.fluentReviewed === false);
  return {
    rights: { passed: rights, evidence: rights ? "The exact source-image, rights and treatment hashes match the agreed contract." : "Source, rights or treatment definitions differ from the agreed contract." },
    coverage: { passed: coverage, evidence: coverage ? `${sources.length} sources each have one distinct full image and thumbnail.` : "The submitted image/file set does not exactly cover the agreed sources." },
    files: { passed: files, evidence: files ? "The declared dimensions, file sizes, full-frame geometry and profiles fit the frozen limits. Independent byte verification is required." : "One or more file declarations do not meet the agreed format, size, geometry or profile contract." },
    comparison: { passed: comparison, evidence: comparison ? "The declared aligned-pixel and difference-hash measurements meet the agreed bounds. Independent recomputation is required; human fidelity review remains open." : "One or more declared comparison measurements exceed the agreed bounds." },
    alt: { passed: alt, evidence: alt ? "All six bounded alt-text fields are present for every image. Wording quality and fluent review are not established by field presence." : "An image is missing bounded locale descriptions or truthful review disclosure." },
  };
}

export const unreviewedImageLanguages = (): Record<Locale, { fluentReviewed: false; disclosure: string }> => Object.fromEntries(locales.map(locale => [locale, { fluentReviewed: false, disclosure: "Model-written image description; curator and fluent-language review pending." }])) as Record<Locale, { fluentReviewed: false; disclosure: string }>;
