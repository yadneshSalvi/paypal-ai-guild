import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { digest } from "@/domain/primitives";
import { checkedWebDesign, webDesignSchema, webFileSchema, webSourceSchema } from "@/domain/web-exhibition";
import { readAuthoredWebAssets, renderWebFiles } from "@/exhibition/generated/render";
import { webZipChunks, zipCrc32 } from "@/exhibition/generated/zip";
import { webFixture } from "./helpers/web-fixture";

test("web source refuses missing locale, aliased originals and changed original audio identity", () => {
  const { source } = webFixture();
  const missing = structuredClone(source); delete missing.labels.ar.welcome;
  assert.equal(webSourceSchema.safeParse(missing).success, false);
  const alias = structuredClone(source); alias.labels.pt.welcome!.audio = alias.labels.en.welcome!.audio;
  assert.equal(webSourceSchema.safeParse(alias).success, false);
  const changed = structuredClone(source); changed.labels.en.welcome!.audio.origin.originalMediaHash = "0".repeat(64);
  assert.equal(webSourceSchema.safeParse(changed).success, false);
});

test("all eight authored families cover the original label set exactly once", () => {
  const { source, design } = webFixture();
  assert.deepEqual(checkedWebDesign(design, source), design);
  const missing = structuredClone(design); missing.chapters[3]!.labelKeys.pop();
  assert.throws(() => checkedWebDesign(missing, source), /Every exact label/);
  const duplicate = structuredClone(design); duplicate.chapters[3]!.family = "split";
  assert.throws(() => checkedWebDesign(duplicate, source), /eight authored/);
  const foreign = structuredClone(design); foreign.chapters[0]!.sourceImageId = "unowned";
  assert.throws(() => checkedWebDesign(foreign, source), /foreign source/);
});

test("valid poor-contrast provider choices stay unchanged; executable style tokens are rejected", () => {
  const { source, design } = webFixture();
  design.palette.ink = design.palette.paper;
  assert.equal(checkedWebDesign(design, source).palette.ink, design.palette.paper);
  assert.equal(webDesignSchema.safeParse({ ...design, palette: { ...design.palette, ink: "red; background:url(https://example.com)" } }).success, false);
  assert.equal(webDesignSchema.safeParse({ ...design, javascript: "alert(1)" }).success, false);
  assert.equal(webDesignSchema.safeParse({ ...design, typography: { ...design.typography, bodySize: 0 } }).success, false);
});

test("generated reading copy preserves 78 exact originals and never inserts curated sample text", async () => {
  const { source, design } = webFixture(), assets = await readAuthoredWebAssets(), rendered = renderWebFiles(source, design, assets), html = rendered.authored.get("index.html")!.toString();
  assert.equal((html.match(/<div class="web-article"/g) ?? []).length, 6);
  assert.equal((html.match(/data-label-key=/g) ?? []).length, 78);
  assert.equal((html.match(/data-player data-label=/g) ?? []).length, 78);
  assert.equal((html.match(/data-chapter="/g) ?? []).length, 48);
  assert.equal(rendered.bundle.files.filter(file => file.mediaType === "audio/mpeg").length, 78);
  assert.equal(rendered.bundle.files.filter(file => file.mediaType === "text/vtt").length, 78);
  assert.equal(rendered.bundle.files.filter(file => file.mediaType === "image/webp").length, 24);
  assert(html.includes('data-locale="ar" lang="ar" dir="rtl"'));
  assert(html.includes('preload="none"'));
  assert(!/<audio[^>]*\bautoplay\b/i.test(html));
  assert(!html.includes("Between water &amp; work"));
  assert.equal(rendered.bundle.sourceDigest, digest(source));
  assert.equal(rendered.bundle.totalBytes, rendered.bundle.files.reduce((sum, file) => sum + file.byteLength, 0));
  assert.equal(rendered.bundle.filesDigest.length, 64);
});

test("hostile source wording stays text and cannot close the script or style boundary", async () => {
  const { source, design } = webFixture();
  source.labels.en.welcome!.title = '</script><img src=x onerror="alert(1)">';
  source.labels.en.welcome!.body = '<iframe src="https://example.com"></iframe><script>alert(1)</script>';
  const rendered = renderWebFiles(source, design, await readAuthoredWebAssets()), html = rendered.authored.get("index.html")!.toString();
  assert(!html.includes('<img src=x onerror="alert(1)">'));
  assert(!html.includes('<iframe src="https://example.com">'));
  assert(html.includes("&lt;iframe"));
  assert.equal((html.match(/<script(?: |>|\n)/g) ?? []).length, 2);
  assert.equal((html.match(/<\/script>/g) ?? []).length, 2);
  assert(html.includes("\\u003c/script\\u003e"));
  assert.equal((html.match(/<style>/g) ?? []).length, 2);
});

test("the immutable file manifest changes with exact source bytes, style choices or reader assets", async () => {
  const { source, design } = webFixture(), assets = await readAuthoredWebAssets();
  const first = renderWebFiles(source, design, assets);
  const changedDesign = structuredClone(design); changedDesign.palette.paper = "#FFFFFF";
  assert.notEqual(renderWebFiles(source, changedDesign, assets).bundle.filesDigest, first.bundle.filesDigest);
  const changedSource = structuredClone(source); changedSource.labels.en.welcome!.audio.contentHash = "1".repeat(64); changedSource.labels.en.welcome!.audio.origin.originalMediaHash = "1".repeat(64);
  assert.notEqual(renderWebFiles(changedSource, design, assets).bundle.filesDigest, first.bundle.filesDigest);
  assert.equal(first.bundle.filesDigest, renderWebFiles(source, design, assets).bundle.filesDigest);
});

test("portable paths cannot escape the bundle or alias a parent directory", () => {
  const base = { path: "assets/fonts/Inter-OFL.txt", mediaType: "text/plain", byteLength: 1, contentHash: "a".repeat(64), mediaId: null };
  assert.equal(webFileSchema.safeParse(base).success, true);
  for (const path of ["../private", "assets/../private", "/absolute", "assets//file", "assets/%2e%2e/private", "assets\\private", "data:text/javascript,evil"]) assert.equal(webFileSchema.safeParse({ ...base, path }).success, false, path);
});

test("portable ZIP is deterministic and stops on changed owned bytes", async () => {
  assert.equal(zipCrc32(Buffer.from("123456789")), 0xcbf43926);
  const { source, design, bytes } = webFixture(), rendered = renderWebFiles(source, design, await readAuthoredWebAssets());
  const read = async (file: typeof rendered.bundle.files[number]) => file.mediaId ? bytes.get(file.mediaId)! : rendered.authored.get(file.path)!;
  async function archive() { const parts: Uint8Array[] = []; for await (const part of webZipChunks(rendered.bundle, read)) parts.push(part); return Buffer.concat(parts); }
  const first = await archive(), second = await archive();
  assert.equal(createHash("sha256").update(first).digest("hex"), createHash("sha256").update(second).digest("hex"));
  assert.equal(first.readUInt32LE(0), 0x04034b50); assert.equal(first.readUInt32LE(first.length - 22), 0x06054b50);
  assert.equal(first.readUInt16LE(first.length - 12), rendered.bundle.files.length);
  const altered = async (file: typeof rendered.bundle.files[number]) => file.mediaType === "audio/mpeg" ? Buffer.from("replacement") : read(file);
  await assert.rejects(async () => { for await (const _part of webZipChunks(rendered.bundle, altered)) { /* Consume until the exact first changed file. */ } }, /original file/);
});

test("the authored reader is valid JavaScript without eval or HTML insertion", async () => {
  const source = await readFile("public/exhibit-reader/v1/reader.js", "utf8");
  new vm.Script(source);
  assert(!/\beval\s*\(|\bnew Function\s*\(|\.innerHTML\s*=|\.outerHTML\s*=|document\.write\s*\(/.test(source));
});
