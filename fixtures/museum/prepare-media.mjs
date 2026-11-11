/** Rebuild local archival renditions. Run from the Guild repository root. */
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";

const run = promisify(execFile);
const catalogue = JSON.parse(await readFile("fixtures/museum/catalogue.json", "utf8"));
const sha = (data) => createHash("sha256").update(data).digest("hex");
const observedAt = new Date().toISOString();
const rights = "No known restrictions on publication.";
const rightsUrl = "https://guides.loc.gov/p-and-p-rights-and-restrictions/rights#102_det.html";
const creditLine = "Library of Congress, Prints & Photographs Division, Detroit Publishing Company Collection.";
for (const dir of ["public/museum/originals", "public/museum/images", "public/museum/thumbnails", "fixtures/museum/records", "fixtures/museum/.download-cache"]) await mkdir(dir, { recursive: true });

async function download(url, path) {
  let resolvedUrl;
  const flags = ["--http1.1", "--silent", "--show-error", "--location", "--fail", "--max-time", "40", "--proto", "=https"];
  try {
    const { stdout } = await run("curl", [...flags, "--output", path, "--write-out", "%{url_effective}", url], { maxBuffer: 1024 * 1024 });
    resolvedUrl = stdout.trim();
  } catch {
    // Never retain a partial JPEG when an archive edge stalls during transfer.
    const { stdout: headers } = await run("curl", [...flags, "--head", "--write-out", "\nRESOLVED:%{url_effective}", url]);
    const matches = [...headers.matchAll(/content-length:\s*(\d+)/gi)];
    const length = Number(matches.at(-1)?.[1]);
    resolvedUrl = headers.match(/RESOLVED:(\S+)/)?.[1];
    if (!length || !resolvedUrl) throw new Error(`Archive file length could not be established: ${url}`);
    const parts = [];
    for (let start = 0; start < length; start += 32768) {
      const end = Math.min(start + 32767, length - 1);
      const partPath = `${path}.part`;
      await run("curl", [...flags, "--range", `${start}-${end}`, "--output", partPath, resolvedUrl]);
      const bytes = await readFile(partPath);
      if (bytes.length !== end - start + 1) throw new Error(`Incomplete archive byte range ${start}-${end}`);
      parts.push(bytes);
      await rm(partPath);
    }
    await writeFile(path, Buffer.concat(parts));
  }
  const resolved = new URL(resolvedUrl);
  if (!["cdn.loc.gov", "tile.loc.gov"].includes(resolved.hostname)) throw new Error(`Unexpected source host: ${resolved.hostname}`);
  return resolved.href;
}

async function prepare(item) {
  try {
    const existing = JSON.parse(await readFile(`fixtures/museum/records/${item.digitalId}.json`, "utf8"));
    if (sha(await readFile(`public${existing.imagePath}`)) === existing.contentHash && sha(await readFile(`public${existing.originalPath}`)) === existing.originalHash) {
      const refreshed = { ...existing, ...item, rightsUrl, medium: item.nativeMedium ?? existing.medium };
      await writeFile(`fixtures/museum/records/${item.digitalId}.json`, `${JSON.stringify(refreshed, null, 2)}\n`);
      process.stdout.write(`${item.digitalId}: verified existing local rendition\n`);
      return refreshed;
    }
  } catch { /* Missing or changed renditions are downloaded again. */ }
  const digits = Number(item.digitalId.slice(2));
  const location = [10000, 1000, 100].map((n) => `4a${Math.floor(digits / n) * n}`).join("/");
  const archiveBase = `https://cdn.loc.gov`;
  const originalUrl = `${archiveBase}/service/pnp/det/${location}/${item.digitalId}${item.jpegRendition ?? "v"}.jpg`;
  const masterUrl = `${archiveBase}/master/pnp/det/${location}/${item.digitalId}u.tif`;
  const originalPath = `public/museum/originals/${item.digitalId}.jpg`;
  const cachePath = `fixtures/museum/.download-cache/${item.digitalId}.tif`;
  const [originalResolvedUrl, masterResolvedUrl] = await Promise.all([download(originalUrl, originalPath), download(masterUrl, cachePath)]);
  const masterBytes = await readFile(cachePath);
  const originalBytes = await readFile(originalPath);
  if (originalBytes.at(-2) !== 0xff || originalBytes.at(-1) !== 0xd9) throw new Error(`${item.digitalId}: incomplete archive JPEG`);
  if ((await sharp(originalBytes).metadata()).format !== "jpeg") throw new Error(`${item.digitalId}: invalid archive JPEG`);
  await sharp(originalBytes).stats();
  const master = await sharp(masterBytes).metadata();
  if (master.format !== "tiff" || !master.width || !master.height) throw new Error(`${item.digitalId}: invalid archival TIFF`);
  const imagePath = `/museum/images/${item.digitalId}.webp`;
  const thumbnailPath = `/museum/thumbnails/${item.digitalId}.webp`;
  // Full frame, only resize/compression. No AI restoration, recolouring or invented detail.
  await sharp(masterBytes).rotate().resize({ width: 2200, withoutEnlargement: true }).webp({ quality: 88, effort: 5 }).toFile(`public${imagePath}`);
  await sharp(masterBytes).rotate().resize({ width: 640, withoutEnlargement: true }).webp({ quality: 82, effort: 5 }).toFile(`public${thumbnailPath}`);
  const imageBytes = await readFile(`public${imagePath}`);
  const thumbnailBytes = await readFile(`public${thumbnailPath}`);
  const image = await sharp(imageBytes).metadata();
  const record = { ...item, sourceUrl: `https://www.loc.gov/item/${item.itemId}/`, resourceUrl: `https://www.loc.gov/resource/det.${item.digitalId}/`, rights, rightsUrl, creditLine, medium: item.nativeMedium ?? "1 negative : glass ; 8 x 10 in.", observedAt, originalUrl, originalResolvedUrl, originalPath: `/museum/originals/${item.digitalId}.jpg`, originalHash: sha(originalBytes), originalBytes: originalBytes.length, masterUrl, masterResolvedUrl, masterHash: sha(masterBytes), masterBytes: masterBytes.length, masterDimensions: { width: master.width, height: master.height }, masterRetainedLocally: false, imagePath, thumbnailPath, contentHash: sha(imageBytes), thumbnailHash: sha(thumbnailBytes), imageBytes: imageBytes.length, thumbnailBytes: thumbnailBytes.length, dimensions: { width: image.width, height: image.height }, treatment: "Full-frame archival TIFF resized to 2200 pixels wide and compressed as WebP. No historical content added. The viewer may apply clearly visual layout crops; complete frames remain available in source notes.", metadataMethod: "Descriptive fields transcribed from the linked Library of Congress item/resource record and complete primary MARCXML. File hashes and dimensions measured from actual downloads; these are local measurements, not archive-issued checksums." };
  await writeFile(`fixtures/museum/records/${item.digitalId}.json`, `${JSON.stringify(record, null, 2)}\n`);
  await rm(cachePath);
  process.stdout.write(`${item.digitalId}: ${image.width}×${image.height}, ${imageBytes.length} bytes, sha256 ${record.contentHash}\n`);
  return record;
}

const records = [];
for (let index = 0; index < catalogue.length; index += 3) records.push(...await Promise.all(catalogue.slice(index, index + 3).map(prepare)));
const manifest = { schemaVersion: "guild.museum-media.v1", label: "Real archival photographs in a fictional sample exhibition", observedAt, creditLine, rightsContext: "The Library of Congress item-level advisory states no known restrictions on publication. These historic collection images are made available for free use and reuse. The advisory is preserved verbatim; it is not replaced with an invented Creative Commons licence. International and other rights may differ.", records };
await writeFile("fixtures/museum/media-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile("public/museum/media-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
await rm("fixtures/museum/.download-cache", { recursive: true, force: true });
