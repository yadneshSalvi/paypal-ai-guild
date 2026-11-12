import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { locales } from "@/contracts/guild";
import { webBundleDigest, webBundleSchema, webRendererPolicy, type WebBundle, type WebFile, type WebSources } from "@/domain/web-exhibition";
import { canonical, digest, DomainError } from "@/domain/primitives";
import { deepgramCaptionArtifactSchema } from "@/domain/deepgram-captions";
import { renderCaptionVtt } from "@/domain/caption-alignment";
import { webEffectiveCaptionTimingsHash } from "@/domain/web-caption-provenance";
import { getPool, transaction } from "../db";
import { requireProductionLease, type ProductionLease } from "../production-authority";
import { readOwnedMedia } from "../media/objects";
import type { PrivateBlobGateway } from "../media/blob-store";
import { deepgramCaptionVttMetadata } from "../captions/deepgram-production";
import type { ArtifactManifest } from "@/contracts/guild";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function fail(message = "The immutable exhibition files no longer match their exact original producing job and manifest."): never { throw new DomainError("WEB_BUNDLE_BINDING", message, 422, false); }
interface BundleRow { id: string; tenant_id: string; commission_id: string; job_id: string; package_id: string; contract_version: number; ordinal: number; manifest_hash: string; manifest: WebBundle; signature: string }
function signature(row: Pick<BundleRow, "id" | "tenant_id" | "commission_id" | "job_id" | "package_id" | "contract_version" | "ordinal" | "manifest_hash">) {
  if (!process.env.AUTH_SECRET) throw new Error("AUTH_SECRET required");
  return createHmac("sha256", process.env.AUTH_SECRET).update(canonical({ kind: "guild.web-bundle-receipt.v1", ...row })).digest("hex");
}
function signedFields(row: BundleRow) { return { id: row.id, tenant_id: row.tenant_id, commission_id: row.commission_id, job_id: row.job_id, package_id: row.package_id, contract_version: row.contract_version, ordinal: row.ordinal, manifest_hash: row.manifest_hash }; }
export async function saveWebBundle(context: ProductionLease, packageId: string, ordinal: number, raw: WebBundle, files: Map<string, Buffer>) {
  const manifest = webBundleSchema.parse(raw), authored = manifest.files.filter(item => item.mediaId === null);
  if (manifest.filesDigest !== webBundleDigest(manifest.files) || authored.length !== files.size || new Set(manifest.files.map(item => item.path)).size !== manifest.files.length
    || authored.some(item => { const bytes = files.get(item.path); return !bytes || bytes.length !== item.byteLength || bytes.length > webRendererPolicy.maximumAuthoredFileBytes || hash(bytes) !== item.contentHash; })) fail();
  return transaction(async db => {
    const { commission, package: pkg } = await requireProductionLease(db, context, packageId);
    if (!pkg || pkg.kind !== "web") fail();
    let row = (await db.query<BundleRow>("SELECT * FROM guild_web_bundles WHERE tenant_id=$1 AND job_id=$2 AND ordinal=$3", [context.tenantId, context.jobId, ordinal])).rows[0];
    if (!row) {
      const value = { id: randomUUID(), tenant_id: context.tenantId, commission_id: commission.id, job_id: context.jobId, package_id: packageId, contract_version: pkg.contractVersion, ordinal, manifest_hash: digest(manifest) };
      row = (await db.query<BundleRow>("INSERT INTO guild_web_bundles(id,tenant_id,commission_id,job_id,package_id,contract_version,ordinal,manifest_hash,manifest,signature) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *", [value.id, value.tenant_id, value.commission_id, value.job_id, value.package_id, value.contract_version, ordinal, value.manifest_hash, manifest, signature(value)])).rows[0]!;
      for (const file of authored) await db.query("INSERT INTO guild_web_bundle_files(bundle_id,tenant_id,path,byte_length,content_hash,bytes) VALUES($1,$2,$3,$4,$5,$6)", [row.id, context.tenantId, file.path, file.byteLength, file.contentHash, files.get(file.path)]);
    }
    if (row.package_id !== packageId || row.commission_id !== commission.id || row.contract_version !== pkg.contractVersion || row.manifest_hash !== digest(manifest) || digest(row.manifest) !== row.manifest_hash || row.signature !== signature(signedFields(row))) fail();
    return row.id;
  });
}
/** Old bundles read their saved authored bytes, even after newer renderer releases. */
export async function readWebBundle(tenantId: string, bundleId: string, db: Pool | PoolClient = getPool()) {
  const row = (await db.query<BundleRow>("SELECT * FROM guild_web_bundles WHERE tenant_id=$1 AND id=$2", [tenantId, bundleId])).rows[0];
  if (!row || !/^[a-f0-9]{64}$/.test(row.signature) || !timingSafeEqual(Buffer.from(row.signature), Buffer.from(signature(signedFields(row))))) fail();
  const manifest = webBundleSchema.parse(row.manifest);
  if (digest(manifest) !== row.manifest_hash || manifest.filesDigest !== webBundleDigest(manifest.files) || new Set(manifest.files.map(item => item.path)).size !== manifest.files.length
    || manifest.totalBytes !== manifest.files.reduce((sum, file) => sum + file.byteLength, 0)) fail();
  const saved = (await db.query<{ path: string; byte_length: number; content_hash: string; bytes: Buffer }>("SELECT path,byte_length,content_hash,bytes FROM guild_web_bundle_files WHERE tenant_id=$1 AND bundle_id=$2 ORDER BY path", [tenantId, bundleId])).rows;
  const authored = new Map<string, Buffer>();
  for (const file of saved) {
    const entry = manifest.files.find(item => item.path === file.path && item.mediaId === null);
    if (!entry || entry.contentHash !== file.content_hash || entry.byteLength !== file.byte_length || file.bytes.length !== entry.byteLength || hash(file.bytes) !== entry.contentHash) fail();
    authored.set(file.path, file.bytes);
  }
  if (authored.size !== manifest.files.filter(item => item.mediaId === null).length) fail();
  return { row, manifest, authored };
}
export async function webOriginalReader(tenantId: string, commissionId: string, sources: WebSources, storage?: PrivateBlobGateway, db: Pool | PoolClient = getPool()) {
  const images = sources.ancestors.find(item => item.kind === "images")!, narration = sources.ancestors.find(item => item.kind === "narration")!, captions = sources.ancestors.find(item => item.kind === "captions")!;
  const imageJobs = (await db.query<{ id: string }>("SELECT id FROM guild_jobs WHERE tenant_id=$1 AND commission_id=$2 AND type='produce_package' AND state='completed' AND input->>'packageId'=$3 AND output->>'artifactId'=$4", [tenantId, commissionId, images.packageId, images.artifactId])).rows;
  if (imageJobs.length !== 1) fail();
  const captionArtifact = (await db.query<{ content_hash: string; manifest: ArtifactManifest }>("SELECT content_hash,manifest FROM guild_artifacts WHERE tenant_id=$1 AND commission_id=$2 AND package_id=$3 AND id=$4", [tenantId, commissionId, captions.packageId, captions.artifactId])).rows[0];
  if (!captionArtifact || captionArtifact.content_hash !== captions.artifactHash || captionArtifact.manifest.contentHash !== captions.artifactHash || digest(captionArtifact.manifest.content) !== captions.artifactHash) fail();
  const corrected = captionArtifact.manifest.content.schemaVersion === "guild.captions.v3" ? deepgramCaptionArtifactSchema.parse(captionArtifact.manifest.content) : null;
  if (corrected && (corrected.productionJobId !== sources.captionProductionJobId || corrected.sourceDigest !== sources.captionSourceDigest || corrected.attempt !== 2 || !corrected.correction)) fail();
  const origins = new Map<string, { job: string; package: string; operation: string; expected?: Buffer; metadataHash?: string }>();
  for (const photo of sources.photographs) for (const kind of ["full", "thumbnail"] as const) origins.set(photo[kind].mediaId, { job: imageJobs[0]!.id, package: images.packageId, operation: `image:${photo.id}:${kind}` });
  for (const language of locales) for (const key of sources.requiredKeys) {
    const label = sources.labels[language][key]!;
    origins.set(label.audio.mediaId, { job: label.audio.origin.productionJobId, package: narration.packageId, operation: `narration:${language}:${key}:mp3` });
    if (corrected) {
      const source = corrected.sources.tracks.find(item => item.locale === language && item.key === key), track = corrected.tracks.find(item => item.locale === language && item.key === key);
      if (!source || !track || !track.reviewRevision || !track.vtt || !track.effective.listeningAttested || track.effective.status !== "ready-for-review"
        || source.audioHash !== label.audio.contentHash || source.mediaId !== label.audio.mediaId || digest(source) !== label.sourceTrackDigest
        || track.alignmentRunId !== label.captions.alignmentRunId || track.receiptHash !== label.captions.receiptHash || track.vtt.mediaId !== label.captions.vtt.mediaId
        || track.vtt.contentHash !== label.captions.vtt.contentHash || track.vtt.byteLength !== label.captions.vtt.byteLength
        || track.effective.cuesHash !== digest(label.captions.cues) || digest(track.effective.cues) !== digest(label.captions.cues)
        || webEffectiveCaptionTimingsHash(captions.artifactHash, corrected, source, track) !== label.captions.timingsHash) fail();
      origins.set(label.captions.vtt.mediaId, { job: corrected.productionJobId, package: captions.packageId, operation: `deepgram-caption:${language}:${key}:vtt`,
        expected: Buffer.from(renderCaptionVtt(track.effective.cues), "utf8"), metadataHash: digest(deepgramCaptionVttMetadata(corrected.contractDigest, corrected.sources, source, track)) });
    } else origins.set(label.captions.vtt.mediaId, { job: sources.captionProductionJobId, package: captions.packageId, operation: `caption:${language}:${key}:vtt` });
  }
  return async (file: WebFile): Promise<Buffer> => {
    const origin = file.mediaId && origins.get(file.mediaId);
    if (!origin || !file.mediaId) fail("This file is not in the exact original exhibition media register.");
    const observed = await readOwnedMedia(tenantId, file.mediaId, storage, db);
    if (observed.row.commission_id !== commissionId || observed.row.job_id !== origin.job || observed.row.package_id !== origin.package || observed.row.operation_key !== origin.operation
      || observed.row.media_type !== file.mediaType || observed.row.content_hash !== file.contentHash || observed.bytes.length !== file.byteLength || hash(observed.bytes) !== file.contentHash) fail("An original media file differs from its true producer, exact stored identity or bytes. No substitute was returned.");
    if (origin.expected && !observed.bytes.equals(origin.expected) || origin.metadataHash && digest(observed.row.metadata) !== origin.metadataHash)
      fail("The original VTT bytes or metadata differ from the exact accepted effective caption revision. No replacement was returned.");
    return observed.bytes;
  };
}
