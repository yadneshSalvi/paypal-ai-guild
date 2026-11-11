import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { museumSources } from "../src/exhibition/museum";
import { checkImageArtifact, imageAcceptancePack, imageRightsHash, imageSourceManifest, imageTreatment, unreviewedImageLanguages, type ImageArtifact } from "../src/domain/images";
import { DomainError } from "../src/domain/primitives";
import { loadSourceImage, measureImageDerivative, treatImage } from "../src/server/media/image-processing";
import { generateStructured } from "../src/server/models";
import { z } from "zod";

const source = museumSources[0]!;
const original = await loadSourceImage(source), treated = await treatImage(original);
const code = (value: string) => (error: unknown) => error instanceof DomainError && error.code === value;
function manifest(): ImageArtifact {
  const file = (kind: "full" | "thumbnail") => { const mediaId = randomUUID(); return { ...treated[kind].measure, mediaId, url: `/api/media/${mediaId}` }; };
  return { schemaVersion: "guild.image-treatment.v2", contractDigest: imageAcceptancePack([source]).digest, treatment: imageTreatment, sourceManifest: imageSourceManifest([source]), humanFidelityReviewed: false, languageReviews: unreviewedImageLanguages(), limitations: ["Synthetic test manifest with fixture descriptions; no human review."], images: [{ sourceId: source.id, sourceHash: source.contentHash, rightsHash: imageRightsHash(source), sourceUrl: source.sourceUrl, rightsUrl: source.rightsUrl, sourceWidth: treated.sourceWidth, sourceHeight: treated.sourceHeight, crop: { left: 0, top: 0, width: treated.sourceWidth, height: treated.sourceHeight }, description: { sourceId: source.id, alt: { en: "Synthetic fixture description.", pt: "Descrição sintética para teste.", es: "Descripción sintética de prueba.", fr: "Description synthétique pour le test.", ja: "これは検証用の合成された説明です。", ar: "وصف اصطناعي لاختبار التحقق فقط." }, visibleFeatures: ["Synthetic fixture, not a generated observation."], uncertainties: [], framingReason: "This synthetic fixture preserves the complete source frame." }, full: file("full"), thumbnail: file("thumbnail"), modelRun: { id: randomUUID(), model: "fixture-model" } }] };
}

test("actual derivative bytes retain full-frame geometry, valid sRGB and bounded comparison measurements", async () => {
  assert.equal(Math.max(treated.full.measure.width, treated.full.measure.height), 2200);
  assert.equal(Math.max(treated.thumbnail.measure.width, treated.thumbnail.measure.height), 640);
  for (const kind of ["full", "thumbnail"] as const) {
    const measured = await measureImageDerivative(original, treated[kind].bytes, kind);
    assert.deepEqual(measured, treated[kind].measure);
    assert.ok(measured.bytes <= imageTreatment[kind].maximumBytes);
    assert.ok(measured.comparison.normalizedRootMeanSquareError <= 0.06);
    assert.ok(measured.comparison.dHashDistance <= 10);
    assert.equal(measured.hasIccProfile, true);
  }
  assert.ok(Object.values(checkImageArtifact(manifest(), [source], imageAcceptancePack([source]).digest)).every(check => check.passed));
});

test("wrong geometry, missing profiles and substituted pixels are measured rather than trusted", async () => {
  const wrongSize = await sharp(original).resize(800, 400).withIccProfile("srgb").webp().toBuffer();
  await assert.rejects(measureImageDerivative(original, wrongSize, "full"), code("IMAGE_SIZE_LIMIT"));
  const noProfile = await sharp(treated.full.bytes).webp().toBuffer();
  await assert.rejects(measureImageDerivative(original, noProfile, "full"), code("IMAGE_PROFILE"));
  const replacement = await sharp({ create: { width: treated.full.measure.width, height: treated.full.measure.height, channels: 3, background: "black" } }).withIccProfile("srgb").webp().toBuffer();
  const actual = await measureImageDerivative(original, replacement, "full");
  assert.ok(actual.comparison.normalizedRootMeanSquareError > 0.06);
  const submission = manifest(); submission.images[0]!.full = { ...submission.images[0]!.full, ...actual };
  assert.equal(checkImageArtifact(submission, [source], submission.contractDigest).comparison.passed, false);
});

test("source paths, rights changes, duplicate files and invented review flags cannot borrow a frozen pack", async () => {
  await assert.rejects(loadSourceImage({ ...source, imagePath: "../../.env" }), code("IMAGE_SOURCE_UNREGISTERED"));
  await assert.rejects(loadSourceImage({ ...source, contentHash: "a".repeat(64) }), code("IMAGE_SOURCE_UNREGISTERED"));
  const originalPack = imageAcceptancePack([source]), differentRights = { ...source, rights: "A materially different rights advisory." };
  assert.notEqual(imageAcceptancePack([differentRights]).digest, originalPack.digest);
  assert.equal(checkImageArtifact(manifest(), [differentRights], originalPack.digest).rights.passed, false);
  const duplicate = manifest(); duplicate.images[0]!.thumbnail.mediaId = duplicate.images[0]!.full.mediaId;
  assert.equal(checkImageArtifact(duplicate, [source], originalPack.digest).coverage.passed, false);
  const claimed = manifest() as unknown as Record<string, unknown>; claimed.humanFidelityReviewed = true;
  assert.equal(checkImageArtifact(claimed, [source], originalPack.digest).alt.passed, false);
});

test("vision inputs reject a false byte fingerprint before a database or network request", async () => {
  process.env.OPENAI_MODEL = "fixture-model";
  await assert.rejects(generateStructured({ tenantId: randomUUID(), jobId: randomUUID() }, "fixture_image", "Fixture only.", {}, z.object({ value: z.string() }), [{ sourceId: source.id, bytes: original, contentHash: "f".repeat(64), mediaType: "image/webp" }]), code("MODEL_IMAGE_BINDING"));
});
