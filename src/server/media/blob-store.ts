import { get, put, BlobAccessError, BlobClientTokenExpiredError, BlobContentTypeNotAllowedError, BlobFileTooLargeError, BlobStoreNotFoundError, BlobStoreSuspendedError } from "@vercel/blob";
import { DomainError } from "@/domain/primitives";

export interface StoredBlob { pathname: string; bytes: Buffer; mediaType: string; etag: string }
export interface PrivateBlobGateway {
  put(pathname: string, bytes: Buffer, mediaType: string): Promise<{ pathname: string; etag: string }>;
  read(pathname: string, maximumBytes: number): Promise<StoredBlob | null>;
}
function token(): string {
  const value = process.env.BLOB_READ_WRITE_TOKEN;
  if (!value) throw new DomainError("MEDIA_STORAGE_UNAVAILABLE", "Private artifact storage is not configured. The saved work remains recoverable.", 503);
  return value;
}

/** Object paths come only from a tenant-bound database reservation, never a URL supplied by a model. */
export class VercelPrivateBlobGateway implements PrivateBlobGateway {
  async put(pathname: string, bytes: Buffer, mediaType: string) {
    let result;
    try { result = await put(pathname, bytes, { access: "private", addRandomSuffix: false, allowOverwrite: false, contentType: mediaType, cacheControlMaxAge: 60, token: token(), abortSignal: AbortSignal.timeout(30000) }); }
    catch(error) { if(error instanceof BlobAccessError||error instanceof BlobClientTokenExpiredError||error instanceof BlobContentTypeNotAllowedError||error instanceof BlobFileTooLargeError||error instanceof BlobStoreNotFoundError||error instanceof BlobStoreSuspendedError)throw new DomainError("MEDIA_STORAGE_REJECTED","The private store rejected this file or its configured access. Review storage configuration before continuing the original operation.",503,false);throw error; }
    if (result.pathname !== pathname) throw new DomainError("MEDIA_STORAGE_IDENTITY", "The store returned a different object identity. The original request remains saved.", 503, false);
    return { pathname: result.pathname, etag: result.etag };
  }
  async read(pathname: string, maximumBytes: number): Promise<StoredBlob | null> {
    const result = await get(pathname, { access: "private", useCache: false, token: token(), abortSignal: AbortSignal.timeout(30000) });
    if (!result) return null;
    if (result.statusCode !== 200) throw new DomainError("MEDIA_STORAGE_RESPONSE", "The store did not return complete file bytes.", 503);
    if (result.blob.pathname !== pathname || result.blob.size > maximumBytes) { await result.stream.cancel(); throw new DomainError("MEDIA_STORAGE_IDENTITY", "The stored object does not match its agreed identity or size.", 422, false); }
    const reader = result.stream.getReader(), chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        const next = await reader.read(); if (next.done) break;
        length += next.value.length;
        if (length > maximumBytes) { await reader.cancel(); throw new DomainError("MEDIA_STORAGE_SIZE", "The stored file exceeds its agreed size.", 422, false); }
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
    if (length !== result.blob.size) throw new DomainError("MEDIA_STORAGE_LENGTH", "The store returned an incomplete file. Its saved identity is retained.", 503);
    return { pathname, bytes: Buffer.concat(chunks), mediaType: result.blob.contentType.split(";")[0]!.toLowerCase(), etag: result.blob.etag };
  }
}
