import { createHash } from "node:crypto";
import { webBundleDigest, webBundleSchema, type WebBundle, type WebFile } from "@/domain/web-exhibition";
import { DomainError } from "@/domain/primitives";

const table = new Uint32Array(256);
for (let i = 0; i < table.length; i++) { let value = i; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1; table[i] = value >>> 0; }
export function zipCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 255]! ^ crc >>> 8;
  return (crc ^ 0xffffffff) >>> 0;
}
function checkedBundle(raw: WebBundle) {
  const bundle = webBundleSchema.parse(raw);
  if (bundle.filesDigest !== webBundleDigest(bundle.files) || new Set(bundle.files.map(file => file.path)).size !== bundle.files.length
    || bundle.totalBytes !== bundle.files.reduce((sum, file) => sum + file.byteLength, 0)
    || bundle.files.some((file, index) => index > 0 && bundle.files[index - 1]!.path.localeCompare(file.path) >= 0)) throw new DomainError("WEB_EXPORT_MANIFEST", "The exact portable file register changed. No altered archive was returned.", 422, false);
  return bundle;
}

/** ZIP32, stored files, UTF-8 names, fixed 1980 date and retained original bytes. */
export async function* webZipChunks(raw: WebBundle, read: (file: WebFile) => Promise<Buffer>): AsyncGenerator<Uint8Array> {
  const bundle = checkedBundle(raw), central: Buffer[] = [];
  let offset = 0;
  for (const file of bundle.files) {
    const bytes = await read(file);
    if (bytes.length !== file.byteLength || createHash("sha256").update(bytes).digest("hex") !== file.contentHash) throw new DomainError("WEB_EXPORT_BYTES", "An original file no longer matches the exact exhibition. The download stopped without substituting any bytes.", 422, false);
    const name = Buffer.from(file.path, "utf8"), crc = zipCrc32(bytes), header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0808, 6); header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10); header.writeUInt16LE(33, 12); header.writeUInt16LE(name.length, 26);
    const footer = Buffer.alloc(16); footer.writeUInt32LE(0x08074b50, 0); footer.writeUInt32LE(crc, 4); footer.writeUInt32LE(bytes.length, 8); footer.writeUInt32LE(bytes.length, 12);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(3 << 8 | 20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x0808, 8); directory.writeUInt16LE(0, 10);
    directory.writeUInt16LE(0, 12); directory.writeUInt16LE(33, 14); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(bytes.length, 20); directory.writeUInt32LE(bytes.length, 24);
    directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(0o100444 * 0x10000, 38); directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    yield header; yield name;
    for (let start = 0; start < bytes.length; start += 64 * 1024) yield bytes.subarray(start, Math.min(bytes.length, start + 64 * 1024));
    yield footer;
    offset += header.length + name.length + bytes.length + footer.length;
  }
  const centralOffset = offset;
  for (const item of central) { yield item; offset += item.length; }
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(bundle.files.length, 8); end.writeUInt16LE(bundle.files.length, 10); end.writeUInt32LE(offset - centralOffset, 12); end.writeUInt32LE(centralOffset, 16);
  yield end;
}

export function webZipStream(bundle: WebBundle, read: (file: WebFile) => Promise<Buffer>): ReadableStream<Uint8Array> {
  const checked = checkedBundle(bundle), iterator = webZipChunks(checked, read);
  return new ReadableStream({ async pull(controller) { try { const next = await iterator.next(); if (next.done) controller.close(); else controller.enqueue(new Uint8Array(next.value)); } catch (error) { controller.error(error); } }, async cancel() { await iterator.return(undefined); } });
}
