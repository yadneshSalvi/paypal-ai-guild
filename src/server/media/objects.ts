import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { digest, DomainError } from "@/domain/primitives";
import { getPool, transaction } from "../db";
import { authorizeTargetedMedia } from "../narration-targeted-corrections";
import { requireProductionLease, type ProductionLease } from "../production-authority";
import { ProductionContinuation, ProductionReviewRequired } from "../production-continuation";
import { VercelPrivateBlobGateway, type PrivateBlobGateway, type StoredBlob } from "./blob-store";

const formats = { "image/webp": { extension: "webp", maximum: 2_000_000 }, "audio/mpeg": { extension: "mp3", maximum: 32 * 1024 * 1024 }, "audio/wav": { extension: "wav", maximum: 32 * 1024 * 1024 }, "text/vtt": { extension: "vtt", maximum: 1_000_000 }, "application/json": { extension: "json", maximum: 2_000_000 } } as const;
type MediaType = keyof typeof formats;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export interface MediaObjectRow {
  id: string; tenant_id: string; commission_id: string; job_id: string; package_id: string; operation_key: string;
  media_type: MediaType; content_hash: string; byte_length: string; blob_pathname: string; metadata: Record<string, unknown>;
  state: "reserved" | "storing" | "checking" | "ready" | "needs_review"; etag: string | null; error_code: string | null; verified_at: Date | null;
}
export interface MediaObject {
  id: string; url: string; mediaType: MediaType; contentHash: string; byteLength: number;
  metadata: Record<string, unknown>; verifiedAt: string | null;
}
export const mediaView = (row: MediaObjectRow): MediaObject => ({ id: row.id, url: `/api/media/${row.id}`, mediaType: row.media_type, contentHash: row.content_hash, byteLength: Number(row.byte_length), metadata: row.metadata, verifiedAt: row.verified_at?.toISOString() ?? null });
const validPath = (row: MediaObjectRow) => row.blob_pathname === `guild/private/v1/${row.tenant_id}/${row.commission_id}/${row.job_id}/${row.id}-${row.content_hash}.${formats[row.media_type]?.extension}`;

async function ownedMedia(tenantId: string, mediaId: string): Promise<MediaObjectRow> {
  const row = (await getPool().query<MediaObjectRow>("SELECT * FROM guild_media_objects WHERE id=$1 AND tenant_id=$2", [z.string().uuid().parse(mediaId), tenantId])).rows[0];
  if (!row) throw new DomainError("MEDIA_NOT_FOUND", "That file is not in this workspace.", 404, false);
  if (!formats[row.media_type] || !validPath(row)) throw new DomainError("MEDIA_RECORD_BINDING", "The file's storage identity no longer matches its independent record.", 422, false);
  return row;
}
function matches(row: MediaObjectRow, blob: StoredBlob): boolean {
  return blob.pathname === row.blob_pathname && blob.mediaType === row.media_type && blob.bytes.length === Number(row.byte_length) && hash(blob.bytes) === row.content_hash;
}
function externalStep(context: ProductionLease, step: string): void {
  if ((context.externalCalls ?? 0) >= 1) throw new ProductionContinuation(step, 1);
  context.externalCalls = (context.externalCalls ?? 0) + 1;
}

/** Stable path + no-overwrite writes let a lost upload be recovered by reading its original bytes. */
export async function storeMedia(context: ProductionLease, packageId: string, operationKey: string, bytes: Buffer, mediaType: MediaType, metadata: Record<string, unknown>, gateway: PrivateBlobGateway = new VercelPrivateBlobGateway()): Promise<MediaObject> {
  if (!formats[mediaType] || !bytes.length || bytes.length > formats[mediaType].maximum || operationKey.length > 200 || !/^[A-Za-z0-9:._-]+$/.test(operationKey) || JSON.stringify(metadata).length > 65536) throw new DomainError("MEDIA_INPUT", "This file does not fit the agreed media storage contract.", 422);
  const contentHash = hash(bytes);
  let row = (await getPool().query<MediaObjectRow>("SELECT * FROM guild_media_objects WHERE tenant_id=$1 AND job_id=$2 AND operation_key=$3", [context.tenantId, context.jobId, operationKey])).rows[0];
  if (!row) {
    row = await transaction(async db => {
      const authority = await requireProductionLease(db, context, packageId), id = randomUUID();
      if (!authority.package || authority.package.kind === "images" && mediaType !== "image/webp" || authority.package.kind === "narration" && !["audio/mpeg", "audio/wav", "application/json"].includes(mediaType) || authority.package.kind === "captions" && !["text/vtt", "application/json"].includes(mediaType) || !["images", "narration", "captions"].includes(authority.package.kind) && mediaType !== "application/json") throw new DomainError("MEDIA_PACKAGE_FORMAT", "This file format does not belong to the producing package.", 422, false);
      authorizeTargetedMedia(authority.package, operationKey);
      const pathname = `guild/private/v1/${context.tenantId}/${authority.commission.id}/${context.jobId}/${id}-${contentHash}.${formats[mediaType].extension}`;
      const inserted = await db.query<MediaObjectRow>("INSERT INTO guild_media_objects(id,tenant_id,commission_id,job_id,package_id,operation_key,media_type,content_hash,byte_length,blob_pathname,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(tenant_id,job_id,operation_key) DO NOTHING RETURNING *", [id, context.tenantId, authority.commission.id, context.jobId, packageId, operationKey, mediaType, contentHash, bytes.length, pathname, metadata]);
      return inserted.rows[0] ?? (await db.query<MediaObjectRow>("SELECT * FROM guild_media_objects WHERE tenant_id=$1 AND job_id=$2 AND operation_key=$3", [context.tenantId, context.jobId, operationKey])).rows[0]!;
    });
  }
  if (!row || row.package_id !== packageId || row.media_type !== mediaType || row.content_hash !== contentHash || Number(row.byte_length) !== bytes.length || digest(row.metadata) !== digest(metadata) || !validPath(row)) throw new ProductionReviewRequired("MEDIA_OPERATION_CHANGED", "This file identity already belongs to different bytes or metadata. The existing object was not overwritten.");
  if (row.state === "ready") return mediaView(row);
  if (row.state === "needs_review") throw new ProductionReviewRequired(row.error_code ?? "MEDIA_NEEDS_REVIEW", "The saved media object needs review before this submission can continue.");
  if (row.state === "storing" || row.state === "checking") {
    externalStep(context, "Saving the next media file");
    let blob: StoredBlob | null;
    try { blob = await gateway.read(row.blob_pathname, Number(row.byte_length)); } catch (error) {
      if (error instanceof DomainError && !error.recoverable) {
        await getPool().query("UPDATE guild_media_objects SET state='needs_review',error_code=$1,updated_at=now() WHERE id=$2 AND tenant_id=$3", [error.code, row.id, context.tenantId]);
        throw new ProductionReviewRequired(error.code, "The private file failed its identity or size check. Its original record is retained without an overwrite.");
      }
      await getPool().query("UPDATE guild_media_objects SET state='checking',error_code='MEDIA_READ_UNAVAILABLE',updated_at=now() WHERE id=$1 AND tenant_id=$2", [row.id, context.tenantId]);
      throw new ProductionContinuation("The private store is unavailable; the saved file identity is retained", 15);
    }
    if (!blob) {
      await getPool().query("UPDATE guild_media_objects SET state='reserved',error_code='MEDIA_NOT_STORED',updated_at=now() WHERE id=$1 AND tenant_id=$2", [row.id, context.tenantId]);
      throw new ProductionContinuation("Continuing the original immutable media upload", 1);
    }
    if (!matches(row, blob)) {
      await getPool().query("UPDATE guild_media_objects SET state='needs_review',error_code='MEDIA_CONTENT_MISMATCH',updated_at=now() WHERE id=$1 AND tenant_id=$2", [row.id, context.tenantId]);
      throw new ProductionReviewRequired("MEDIA_CONTENT_MISMATCH", "The stored file does not match its agreed bytes. It was not accepted or overwritten.");
    }
    row = (await getPool().query<MediaObjectRow>("UPDATE guild_media_objects SET state='ready',etag=$1,error_code=NULL,verified_at=now(),updated_at=now() WHERE id=$2 AND tenant_id=$3 RETURNING *", [blob.etag, row.id, context.tenantId])).rows[0]!;
    return mediaView(row);
  }
  externalStep(context, "Saving the next media file");
  await transaction(async db => {
    await requireProductionLease(db, context, packageId);
    const current = (await db.query<MediaObjectRow>("SELECT * FROM guild_media_objects WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [row.id, context.tenantId])).rows[0];
    if (current?.state !== "reserved") throw new ProductionContinuation("Checking the existing media upload", 1);
    await db.query("UPDATE guild_media_objects SET state='storing',error_code=NULL,updated_at=now() WHERE id=$1", [row.id]);
  });
  try {
    const uploaded = await gateway.put(row.blob_pathname, bytes, mediaType);
    await getPool().query("UPDATE guild_media_objects SET state='checking',etag=$1,error_code=NULL,updated_at=now() WHERE id=$2 AND tenant_id=$3", [uploaded.etag, row.id, context.tenantId]);
  } catch (error) {
    if(error instanceof DomainError&&!error.recoverable){
      await getPool().query("UPDATE guild_media_objects SET state='needs_review',error_code=$1,updated_at=now() WHERE id=$2 AND tenant_id=$3",[error.code,row.id,context.tenantId]);
      throw new ProductionReviewRequired(error.code,error.message);
    }
    await getPool().query("UPDATE guild_media_objects SET state='checking',error_code='MEDIA_UPLOAD_UNCONFIRMED',updated_at=now() WHERE id=$1 AND tenant_id=$2", [row.id, context.tenantId]);
  }
  throw new ProductionContinuation("Checking the uploaded file against its saved hash", 1);
}

export async function readOwnedMedia(tenantId: string, mediaId: string, gateway: PrivateBlobGateway = new VercelPrivateBlobGateway()): Promise<{ row: MediaObjectRow; bytes: Buffer }> {
  const row = await ownedMedia(tenantId, mediaId);
  if (row.state !== "ready") throw new DomainError("MEDIA_NOT_READY", "This file is still being saved and checked.", 409);
  let blob: StoredBlob | null;
  try { blob = await gateway.read(row.blob_pathname, Number(row.byte_length)); } catch (error) { if (error instanceof DomainError && !error.recoverable) throw error; throw new DomainError("MEDIA_READ_UNAVAILABLE", "The private file is temporarily unavailable. Its original record is retained.", 503); }
  if (!blob || !matches(row, blob)) throw new DomainError("MEDIA_CONTENT_MISMATCH", "The stored file could not be verified against its agreed hash. No unverified bytes were returned.", 422, false);
  return { row, bytes: blob.bytes };
}

export function privateMediaResponse(row: MediaObjectRow, bytes: Buffer, request: Request): Response {
  const etag = `"sha256-${row.content_hash}"`;
  const headers = { "Content-Type": row.media_type, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": `inline; filename="guild-${row.id}.${formats[row.media_type].extension}"`, "Accept-Ranges": "bytes", ETag: etag };
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  const range = request.headers.get("range");
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    const suffix = match && !match[1] && match[2] ? Number(match[2]) : null;
    const start = suffix !== null ? Math.max(0, bytes.length - suffix) : Number(match?.[1] ?? NaN);
    const end = suffix !== null || !match?.[2] ? bytes.length - 1 : Math.min(bytes.length - 1, Number(match[2]));
    if (!match || !match[1]&&!match[2] || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || suffix !== null && (!Number.isSafeInteger(suffix)||suffix<=0) || start < 0 || start >= bytes.length || end < start) return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${bytes.length}` } });
    return new Response(new Uint8Array(bytes.subarray(start, end + 1)), { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${bytes.length}`, "Content-Length": String(end - start + 1) } });
  }
  return new Response(new Uint8Array(bytes), { headers: { ...headers, "Content-Length": String(bytes.length) } });
}
