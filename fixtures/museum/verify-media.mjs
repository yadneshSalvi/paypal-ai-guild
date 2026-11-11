import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import sharp from "sharp";

const manifest = JSON.parse(await readFile("fixtures/museum/media-manifest.json", "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
assert.equal(manifest.records.length, 12);
const sources = [];
for (const record of manifest.records) {
  const files = [];
  for (const [path, expectedHash, role] of [[record.imagePath, record.contentHash, "exhibition"], [record.thumbnailPath, record.thumbnailHash, "thumbnail"], [record.originalPath, record.originalHash, "archive-jpeg"]]) {
    const bytes = await readFile(`public${path}`);
    assert.equal(hash(bytes), expectedHash, `${record.id}: ${role} hash`);
    const metadata = await sharp(bytes).metadata();
    await sharp(bytes).stats(); // Decode all pixels, not merely the image header.
    if (role === "archive-jpeg") { assert.equal(bytes.at(-2), 255); assert.equal(bytes.at(-1), 217); }
    files.push({ role, path, bytes: bytes.length, sha256: hash(bytes), width: metadata.width, height: metadata.height, fullDecode: true });
  }
  const xml = await readFile(`fixtures/museum/records/${record.itemId}.marcxml`);
  assert.equal(hash(xml), record.marcxmlHash);
  assert.ok(xml.toString().includes(record.itemId));
  assert.equal(record.nativeNotesComplete, true);
  assert.ok(record.nativeRights.includes("No known restrictions on publication."));
  sources.push({ id: record.id, sourceUrl: record.sourceUrl, marcxmlUrl: record.marcxmlUrl, marcxmlSha256: hash(xml), nativeNotes: record.nativeNotes.length, files });
}
const report = { schemaVersion: "guild.media-verification.v1", observedAt: new Date().toISOString(), sourceCount: sources.length, decodedImageFiles: sources.reduce((total, source) => total + source.files.length, 0), metadataSnapshots: sources.length, result: "passed", method: "Recomputed SHA-256 from local bytes; decoded every pixel with Sharp; checked JPEG end markers, primary MARCXML hashes, item identifiers, complete native-note flags and exact rights advisories. No archive-issued checksum is claimed.", limitations: ["Does not establish translation quality or fluent review.", "Does not prove subjective alt-text quality; descriptions were compared against an actual contact sheet.", "Does not replace browser, keyboard, screen-reader, contrast or real-audio listening tests."], sources };
await writeFile("docs/evidence/media/verification.json", `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${report.sourceCount} sources, ${report.decodedImageFiles} decoded image files, ${report.metadataSnapshots} primary metadata snapshots: passed\n`);
