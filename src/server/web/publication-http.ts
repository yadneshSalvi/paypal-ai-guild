import { createHash, randomUUID } from "node:crypto";
import { webFileSchema } from "@/domain/web-exhibition";
import { DomainError } from "@/domain/primitives";
import { publicExhibitionPath } from "@/domain/web-publication";
import { webZipChunks } from "@/exhibition/generated/zip";
import { transaction } from "../db";
import type { PrivateBlobGateway } from "../media/blob-store";
import { readBoundOriginalWebBundle } from "./exports";
import { lockPublicEdition, publicationSha } from "./publications";

export const publicNoStore = { "Cache-Control": "no-store, max-age=0", "CDN-Cache-Control": "no-store", "Vercel-CDN-Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cross-Origin-Resource-Policy": "same-origin", "Permissions-Policy": "camera=(), microphone=(), geolocation=()" };
const inlineHash = (bytes: Buffer | string) => `'sha256-${createHash("sha256").update(bytes).digest("base64")}'`;
function readerPolicy(authored: Map<string, Buffer>) {
  const script = authored.get("reader.js"), css = authored.get("reader.css"), theme = authored.get("theme.css");
  if (!script || !css || !theme) throw new DomainError("PUBLICATION_READER_CHANGED", "The selected original reader files are incomplete.", 422, false);
  return `default-src 'none'; script-src ${inlineHash(script)}; style-src ${inlineHash(css)} ${inlineHash(theme)}; img-src 'self'; media-src 'self'; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'`;
}
export interface PublicationResponseFile { path: string; mediaType: string; contentHash: string; byteLength: number }
/** Called only after ledger authorization and byte verification. Validators are
 * evaluated after withdrawal checks, so an old ETag never revives a link. */
export function publicationBytesResponse(file: PublicationResponseFile, bytes: Buffer, request: Request, csp = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox") {
  if (bytes.length !== file.byteLength || publicationSha(bytes) !== file.contentHash) throw new DomainError("PUBLICATION_FILE_CHANGED", "The published original file differs from its immutable fingerprint.", 422, false);
  const etag = `"sha256-${file.contentHash}"`, head = request.method === "HEAD";
  const headers = new Headers({ ...publicNoStore, "Content-Type": file.mediaType + (file.mediaType.startsWith("text/") || ["application/javascript", "application/json"].includes(file.mediaType) ? "; charset=utf-8" : ""),
    "Content-Disposition": `${file.mediaType === "application/zip" ? "attachment" : "inline"}; filename="${file.path.split("/").at(-1)}"`, "Accept-Ranges": "bytes", ETag: etag,
    "Content-Security-Policy": csp, "X-Frame-Options": "DENY" });
  if (file.mediaType === "text/html") headers.set("Cross-Origin-Opener-Policy", "same-origin");
  const matches = (value: string | null, weak: boolean) => value?.split(",").some(item => item.trim() === "*" || (weak ? item.trim().replace(/^W\//, "") : item.trim()) === etag) ?? false;
  if (request.headers.has("if-match") && !matches(request.headers.get("if-match"), false)) return new Response(null, { status: 412, headers });
  if (matches(request.headers.get("if-none-match"), true)) return new Response(null, { status: 304, headers });
  const requestedRange = request.headers.get("range"), ifRange = request.headers.get("if-range");
  const range = request.method === "GET" && requestedRange && /^bytes=/i.test(requestedRange) && (!ifRange || ifRange === etag) ? requestedRange : null;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/i.exec(range), suffix = match && !match[1] && match[2] ? Number(match[2]) : null;
    const start = suffix !== null ? Math.max(0, bytes.length - suffix) : Number(match?.[1] ?? NaN), end = suffix !== null || !match?.[2] ? bytes.length - 1 : Math.min(bytes.length - 1, Number(match[2]));
    if (!match || !match[1] && !match[2] || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || suffix !== null && (!Number.isSafeInteger(suffix) || suffix <= 0) || start < 0 || start >= bytes.length || end < start) {
      headers.set("Content-Range", `bytes */${bytes.length}`); return new Response(null, { status: 416, headers });
    }
    headers.set("Content-Range", `bytes ${start}-${end}/${bytes.length}`); headers.set("Content-Length", String(end - start + 1));
    return new Response(head ? null : new Uint8Array(bytes.subarray(start, end + 1)), { status: 206, headers });
  }
  headers.set("Content-Length", String(bytes.length));
  return new Response(head ? null : new Uint8Array(bytes), { headers });
}

export async function publicExhibitionResponse(publicId: string, parts: string[] | undefined, request: Request, storage?: PrivateBlobGateway): Promise<Response> {
  const url = new URL(request.url), path = (parts ?? []).join("/");
  if ([...url.searchParams.keys()].some(key => key !== "lang") || url.searchParams.getAll("lang").length > 1 || url.searchParams.has("lang") && !["en", "pt", "es", "fr", "ja", "ar"].includes(url.searchParams.get("lang")!))
    throw new DomainError("PUBLICATION_PATH", "This link must name an exact public exhibition file.", 404, false);
  if (path && (!webFileSchema.shape.path.safeParse(path).success || parts?.some(part => part.includes("/") || part.includes("\\")))) throw new DomainError("PUBLICATION_PATH", "This file is not in the public edition.", 404, false);
  return transaction(async db => {
    // The shared head lock is held through the byte check and response assembly.
    // A completed withdrawal therefore precedes and denies every subsequent read.
    const edition = await lockPublicEdition(db, publicId), binding = edition.proposal.binding;
    if (!path) return new Response(null, { status: 307, headers: { ...publicNoStore, Location: publicExhibitionPath(publicId) + url.search } });
    const registered = binding.bundle.files.find(file => file.path === path);
    if (!registered && ![binding.portable.manifestPath, binding.portable.zipPath].includes(path as "bundle-manifest.json" | "exhibition.zip")) throw new DomainError("PUBLICATION_PATH", "This file is not in the public edition.", 404, false);
    const bundle = await readBoundOriginalWebBundle(db, { tenantId: edition.tenant_id, commissionId: edition.commission_id, artifactId: binding.artifactId,
      artifactHash: binding.artifactHash, artifactManifestHash: binding.artifactManifestHash, ordinal: binding.selectedOrdinal, bundleId: binding.bundleId, bundleManifestHash: binding.bundleManifestHash }, storage);
    let file: PublicationResponseFile, bytes: Buffer;
    if (registered) { file = registered; bytes = await bundle.read(registered); }
    else if (path === binding.portable.manifestPath) { bytes = edition.manifest_bytes; file = { path, mediaType: "application/json", contentHash: binding.portable.manifestHash, byteLength: binding.portable.manifestByteLength }; }
    else {
      const chunks: Uint8Array[] = []; let length = 0;
      for await (const chunk of webZipChunks(bundle.manifest, bundle.read)) {
        length += chunk.length;
        if (length > binding.portable.zipByteLength) throw new DomainError("PUBLICATION_ARCHIVE_CHANGED", "The exact original archive changed its byte length.", 422, false);
        chunks.push(chunk);
      }
      bytes = Buffer.concat(chunks); file = { path, mediaType: "application/zip", contentHash: binding.portable.zipHash, byteLength: binding.portable.zipByteLength };
    }
    const response = publicationBytesResponse(file, bytes, request, file.mediaType === "text/html" ? readerPolicy(bundle.authored) : undefined);
    if ([200, 206, 304].includes(response.status)) {
      const disposition = request.method === "HEAD" ? "head_response" : response.status === 304 ? "not_modified" : response.status === 206 ? "range_response" : "complete_response";
      await db.query("INSERT INTO guild_web_publication_downloads(id,tenant_id,edition_id,path,content_hash,byte_length,disposition) VALUES($1,$2,$3,$4,$5,$6,$7)", [randomUUID(), edition.tenant_id, edition.id, path, file.contentHash, file.byteLength, disposition]);
    }
    return response;
  });
}

const failureCss = "*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#f6f1e7;color:#183d32;font:17px/1.65 system-ui,sans-serif;display:grid;place-items:center;padding:28px}main{max-width:700px;padding:clamp(24px,6vw,72px);border:1px solid #c9c8b9;background:#fffcf5}small{font-size:12px;letter-spacing:.14em;text-transform:uppercase}h1{font-family:Georgia,serif;font-size:clamp(36px,6vw,68px);font-weight:400;line-height:1.12;letter-spacing:-.035em;margin:32px 0 24px}p{color:#45594e;max-width:46ch}.mark{font:italic 40px Georgia,serif;border-bottom:1px solid #c9c8b9;padding-bottom:26px;margin-bottom:35px}.note{font-size:14px;border-top:1px solid #d7d3c6;margin-top:38px;padding-top:22px}";
export function publicExhibitionFailure(error: unknown, request: Request) {
  const status = error instanceof DomainError ? error.status : 503, withdrawn = status === 410;
  const title = withdrawn ? "This exhibition has been withdrawn." : status === 404 ? "This exhibition link is unavailable." : "This reading copy is temporarily unavailable.";
  const message = withdrawn ? "The curator has closed this public edition. Its original work and publication history are retained in the museum’s workspace." : status === 404 ? "Check the exact link shared by the curator. Only files from a published edition are available here." : "The original files could not be verified for this request. Please try again later. No replacement files have been returned.";
  const html = request.headers.get("accept")?.includes("text/html") || /(?:\/|\/index\.html)$/.test(new URL(request.url).pathname);
  const body = html ? `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Guild</title><style>${failureCss}</style></head><body><main id="main"><div class="mark">Guild</div><small>${withdrawn ? "An earlier public edition" : "The exhibition reading room"}</small><h1>${title}</h1><p>${message}</p>${withdrawn ? '<p class="note">Previously downloaded copies cannot be recalled. This link will remain closed; any new publication receives a new edition and link.</p>' : ""}</main></body></html>`
    : JSON.stringify({ ok: false, code: withdrawn ? "PUBLICATION_WITHDRAWN" : status === 404 ? "PUBLICATION_NOT_FOUND" : "PUBLICATION_UNAVAILABLE", message });
  return new Response(request.method === "HEAD" ? null : body, { status, headers: { ...publicNoStore, "Content-Type": html ? "text/html; charset=utf-8" : "application/json; charset=utf-8",
    "Content-Security-Policy": `default-src 'none'; style-src ${inlineHash(failureCss)}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, "X-Frame-Options": "DENY" } });
}
