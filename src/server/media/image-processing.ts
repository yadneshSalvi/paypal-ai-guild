import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { SourceAsset } from "@/contracts/guild";
import { expectedImageDimensions, imageMeasureSchema, imageTreatment, type ImageComparison, type ImageMeasure } from "@/domain/images";
import { DomainError } from "@/domain/primitives";
import { museumSources } from "@/exhibition/museum";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const decode = (bytes: Buffer) => sharp(bytes, { failOn: "error", limitInputPixels: 30_000_000, animated: false });
const rawRgb = (bytes: Buffer, width: number, height: number) => decode(bytes).rotate().resize(width, height, { fit: "fill", kernel: "lanczos3" }).toColourspace("srgb").removeAlpha().raw().toBuffer({ resolveWithObject: true });
let profileHash: Promise<string> | undefined;
async function srgbProfileHash() {
  return profileHash ??= (async () => {
    const file = await sharp({ create: { width: 1, height: 1, channels: 3, background: "white" } }).withIccProfile("srgb").webp().toBuffer();
    const profile = (await decode(file).metadata()).icc;
    if (!profile || profile.length < 128 || profile.toString("ascii", 36, 40) !== "acsp" || profile.toString("ascii", 16, 20) !== "RGB ") throw new DomainError("IMAGE_PROFILE_UNAVAILABLE", "The configured image engine did not provide a valid sRGB profile.", 503);
    return hash(profile);
  })();
}

export function assertImageEngine(): void {
  if (sharp.versions.sharp !== imageTreatment.engine.sharp || sharp.versions.vips !== imageTreatment.engine.vips || sharp.versions.webp !== imageTreatment.engine.webp) throw new DomainError("IMAGE_ENGINE_CHANGED", "The image engine differs from this acceptance pack. Agree a new pack before producing or verifying these files.", 422, false);
}

export async function loadSourceImage(source: SourceAsset): Promise<Buffer> {
  const registered = museumSources.find(item => item.id === source.id);
  if (!registered || registered.imagePath !== source.imagePath || registered.contentHash !== source.contentHash || !/^\/museum\/images\/[a-f0-9]+\.webp$/.test(source.imagePath)) throw new DomainError("IMAGE_SOURCE_UNREGISTERED", "This image is not an exact registered source in the collection.", 422);
  const root = await realpath(path.join(process.cwd(), "public", "museum", "images"));
  const filename = await realpath(path.join(process.cwd(), "public", source.imagePath));
  if (!filename.startsWith(`${root}${path.sep}`)) throw new DomainError("IMAGE_SOURCE_PATH", "The registered image path is outside the collection.", 422, false);
  const bytes = await readFile(filename);
  if (bytes.length > 4_000_000 || hash(bytes) !== source.contentHash) throw new DomainError("IMAGE_SOURCE_HASH", "The source file no longer matches its agreed image hash.", 422, false);
  return bytes;
}

async function differenceHash(bytes: Buffer): Promise<boolean[]> {
  const pixels = await decode(bytes).rotate().resize(9, 8, { fit: "fill", kernel: "lanczos3" }).toColourspace("srgb").greyscale().removeAlpha().raw().toBuffer();
  return Array.from({ length: 64 }, (_, index) => pixels[Math.floor(index / 8) * 9 + index % 8]! > pixels[Math.floor(index / 8) * 9 + index % 8 + 1]!);
}

export async function compareImagePixels(source: Buffer, derivative: Buffer, width: number, height: number): Promise<ImageComparison> {
  const [baseline, rendered, originalHash, renderedHash] = await Promise.all([rawRgb(source, width, height), rawRgb(derivative, width, height), differenceHash(source), differenceHash(derivative)]);
  if (baseline.info.channels !== 3 || rendered.info.channels !== 3 || baseline.data.length !== width * height * 3 || baseline.data.length !== rendered.data.length) throw new DomainError("IMAGE_PIXEL_ALIGNMENT", "The images could not be aligned into the agreed RGB comparison.", 422);
  let absolute = 0, squared = 0;
  for (let index = 0; index < baseline.data.length; index++) { const difference = Math.abs(baseline.data[index]! - rendered.data[index]!) / 255; absolute += difference; squared += difference * difference; }
  const meanSquared = squared / baseline.data.length;
  return {
    method: imageTreatment.comparison.method, pixelsCompared: width * height,
    normalizedMeanAbsoluteError: absolute / baseline.data.length, normalizedRootMeanSquareError: Math.sqrt(meanSquared),
    peakSignalToNoiseDb: meanSquared === 0 ? null : 10 * Math.log10(1 / meanSquared),
    dHashDistance: originalHash.reduce((distance, bit, index) => distance + Number(bit !== renderedHash[index]), 0),
    alignedSourcePixelHash: hash(baseline.data), derivativePixelHash: hash(rendered.data),
  };
}

export async function measureImageDerivative(source: Buffer, derivative: Buffer, kind: "full" | "thumbnail"): Promise<ImageMeasure> {
  assertImageEngine();
  const [input, output, expectedProfile] = await Promise.all([decode(source).metadata(), decode(derivative).metadata(), srgbProfileHash()]);
  if (!input.width || !input.height || !output.width || !output.height || (input.pages ?? 1) !== 1 || (output.pages ?? 1) !== 1 || input.orientation && input.orientation !== 1) throw new DomainError("IMAGE_DIMENSIONS", "A source or derivative lacks a supported, single-frame image geometry.", 422);
  const expected = expectedImageDimensions(input.width, input.height, kind), maximum = imageTreatment[kind];
  if (output.width !== expected.width || output.height !== expected.height || Math.max(output.width, output.height) < maximum.minimumLongEdge || derivative.length > maximum.maximumBytes) throw new DomainError("IMAGE_SIZE_LIMIT", "The actual decoded derivative does not meet the agreed pixel or file-size limits.", 422);
  if (output.format !== "webp" || output.space !== "srgb" || !output.hasProfile || !output.icc || hash(output.icc) !== expectedProfile) throw new DomainError("IMAGE_PROFILE", "The derivative is not a WebP with the agreed embedded sRGB profile.", 422);
  const comparison = await compareImagePixels(source, derivative, output.width, output.height);
  return imageMeasureSchema.parse({ width: output.width, height: output.height, bytes: derivative.length, format: output.format, colourspace: output.space, hasIccProfile: true, iccProfileHash: hash(output.icc), contentHash: hash(derivative), comparison });
}

export async function measureSourceImage(source: Buffer): Promise<{ width: number; height: number }> {
  const input = await decode(source).metadata();
  if (!input.width || !input.height || Math.max(input.width, input.height) < imageTreatment.full.minimumLongEdge || (input.pages ?? 1) !== 1 || input.orientation && input.orientation !== 1) throw new DomainError("IMAGE_INPUT_LIMIT", "The source must be a supported full-frame image large enough for the agreed exhibit layout.", 422);
  return { width: input.width, height: input.height };
}

export async function treatImage(source: Buffer): Promise<{ sourceWidth: number; sourceHeight: number; full: { bytes: Buffer; measure: ImageMeasure }; thumbnail: { bytes: Buffer; measure: ImageMeasure } }> {
  assertImageEngine();
  const input = await measureSourceImage(source);
  const produce = async (kind: "full" | "thumbnail") => {
    const size = expectedImageDimensions(input.width!, input.height!, kind);
    const bytes = await decode(source).resize(size.width, size.height, { fit: "fill", kernel: "lanczos3", withoutEnlargement: true }).withIccProfile("srgb").webp({ quality: imageTreatment.quality, effort: 6 }).toBuffer();
    return { bytes, measure: await measureImageDerivative(source, bytes, kind) };
  };
  const [full, thumbnail] = await Promise.all([produce("full"), produce("thumbnail")]);
  return { sourceWidth: input.width, sourceHeight: input.height, full, thumbnail };
}
