import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { digest } from "@/domain/primitives";
import { webBundleDigest, webBundleSchema, webSourceSchema, type WebBundle } from "@/domain/web-exhibition";
import { readAuthoredWebAssets, renderWebFiles } from "@/exhibition/generated/render";

const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const writeNew = (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });

/** A new reader edition over the exact old Sample sources. No provider call,
 * audio generation, timing change, browser launch or old-file write occurs. */
async function main() {
  const [previousSetPath, output] = process.argv.slice(2);
  assert(previousSetPath && output && isAbsolute(previousSetPath) && isAbsolute(output), "Supply the absolute frozen Sample set and a new absolute output directory.");
  const previousBytes = await readFile(previousSetPath), previous = JSON.parse(previousBytes.toString());
  assert.equal(previous.version, "guild.web-qualification-set.v1");
  const oldBundle = webBundleSchema.parse(previous.baseline.bundle), oldRoot = await realpath(previous.baseline.directory);
  assert.equal(webBundleDigest(oldBundle.files), oldBundle.filesDigest);
  const original = new Map<string, Buffer>();
  for (const file of oldBundle.files) {
    const path = await realpath(resolve(oldRoot, file.path)), part = relative(oldRoot, path);
    assert(part && part !== ".." && !part.startsWith(".." + sep) && !isAbsolute(part));
    const bytes = await readFile(path);
    assert.equal(bytes.length, file.byteLength); assert.equal(sha(bytes), file.contentHash);
    original.set(file.path, bytes);
  }
  assert.equal([...original.values()].reduce((sum, bytes) => sum + bytes.length, 0), oldBundle.totalBytes);
  const record = JSON.parse(original.get("source-record.json")!.toString()), source = webSourceSchema.parse(record.sources);
  assert.equal(source.provenance.mode, "sample"); assert.equal(record.acceptanceClaimed, false); assert.equal(record.paymentClaimed, false);
  assert.equal(digest(source), oldBundle.sourceDigest); assert.equal(digest(record.design), oldBundle.designDigest);
  const assets = await readAuthoredWebAssets(), baseline = renderWebFiles(source, record.design, assets), contrastDesign = structuredClone(record.design);
  assert.notEqual(assets.capability.digest, record.renderer.digest, "A new reader edition must have a distinct authored identity.");
  contrastDesign.palette.ink = contrastDesign.palette.paper; contrastDesign.palette.mutedInk = contrastDesign.palette.paper;
  contrastDesign.palette.darkInk = contrastDesign.palette.dark; contrastDesign.palette.accentInk = contrastDesign.palette.accent;
  contrastDesign.designNotes = ["Explicit contrast mutation for the diagnostic verifier qualification; never a production provider response."];
  const contrast = renderWebFiles(source, contrastDesign, assets), missingAlt = { bundle: structuredClone(baseline.bundle), authored: new Map(baseline.authored) };
  const html = missingAlt.authored.get("index.html")!.toString(), changed = html.replace(/(<img class="web-image"[^>]*?) alt="[^"]*"/, "$1");
  assert.notEqual(changed, html);
  missingAlt.authored.set("index.html", Buffer.from(changed));
  const changedFile = missingAlt.bundle.files.find(file => file.path === "index.html")!;
  changedFile.byteLength = Buffer.byteLength(changed); changedFile.contentHash = sha(Buffer.from(changed));
  missingAlt.bundle.totalBytes = missingAlt.bundle.files.reduce((sum, file) => sum + file.byteLength, 0);
  missingAlt.bundle.filesDigest = webBundleDigest(missingAlt.bundle.files);
  await mkdir(output, { recursive: false, mode: 0o700 });
  async function save(name: string, rendered: { bundle: WebBundle; authored: Map<string, Buffer> }) {
    const directory = resolve(output!, name); await mkdir(directory, { mode: 0o700 });
    for (const file of rendered.bundle.files) {
      const bytes = rendered.authored.get(file.path) ?? original.get(file.path);
      assert(bytes); assert.equal(bytes.length, file.byteLength); assert.equal(sha(bytes), file.contentHash);
      if (file.mediaId) assert.deepEqual(oldBundle.files.find(old => old.path === file.path), file, "Every source image, recording and VTT identity must stay unchanged.");
      const path = resolve(directory, file.path); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    }
    return { directory, bundle: rendered.bundle };
  }
  const set = { version: "guild.web-qualification-set.v1", baseline: await save("baseline", baseline), mutations: [
    { id: "contrast", description: "Explicit same-foreground/background tokens; the source-bound original-palette contrast gate must fail, with native axe findings retained separately.", ...await save("mutation-contrast", contrast) },
    { id: "missing-alt", description: "Explicit removal of the first synthetic image alternative; native image-alt detection is required.", ...await save("mutation-missing-alt", missingAlt) },
  ] };
  await writeNew(resolve(output, "qualification-set.json"), set);
  const provenance = { version: "guild.reader-edition-sample-provenance.v1", previousSetBytesHash: sha(previousBytes), previousSetDigest: digest(previous),
    previousBundleDigest: oldBundle.filesDigest, previousRendererDigest: record.renderer.digest, sourceDigest: digest(source), designDigest: digest(record.design),
    rendererDigest: assets.capability.digest, newSetDigest: digest(set), reusedOriginalSampleFiles: oldBundle.files.filter(file => file.mediaId),
    mediaRegenerated: false, timingsChanged: false, providerCalls: 0, browserLaunched: false, productionApproval: false, humanReview: false, acceptance: false, payment: false };
  await writeNew(resolve(output, "previous-edition.json"), provenance);
  process.stdout.write(JSON.stringify({ sourceDigest: digest(source), rendererDigest: assets.capability.digest, inputDigest: digest(set), reusedMedia: provenance.reusedOriginalSampleFiles.length, cases: 20, providerCalls: 0, browserLaunched: false }) + "\n");
}
void main();
