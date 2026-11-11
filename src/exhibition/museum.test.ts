import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Script } from "node:vm";
import { museumExhibition, museumSources } from "./museum";
import { exhibitionCopy, exhibitionLocaleOrder } from "./locales";
import { buildPortableHtml, exhibitionAssetUrls } from "./export";
import { escapeHtml, safeExternalUrl, safeHexColor, safeImagePosition, safeMediaUrl, safeScriptJson } from "./safety";
import manifest from "../../fixtures/museum/media-manifest.json";

const fingerprint = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const imageAssets = () => new Map(museumSources.map((source) => [source.imagePath, "data:image/webp;base64,UklGRg=="]));

test("all twelve source rows bind real complete local images to primary archive records", async () => {
  assert.equal(museumSources.length, 12);
  assert.equal(new Set(museumSources.map((source) => source.id)).size, 12);
  for (const source of museumSources) {
    const record = manifest.records.find((item) => item.id === source.id);
    assert.ok(record);
    assert.match(source.sourceUrl, /^https:\/\/www\.loc\.gov\/item\/\d+\/$/);
    assert.equal(source.rights, "No known restrictions on publication.");
    assert.equal(fingerprint(await readFile(`public${source.imagePath}`)), source.contentHash, source.id);
    assert.equal(fingerprint(await readFile(`public${source.thumbnailPath}`)), record.thumbnailHash);
    const jpeg = await readFile(`public${record.originalPath}`);
    assert.equal(jpeg.at(-2), 0xff, `${source.id} must have a complete archive JPEG`);
    assert.equal(jpeg.at(-1), 0xd9);
    assert.equal(fingerprint(jpeg), record.originalHash);
    const marcxml = await readFile(`fixtures/museum/records/${record.itemId}.marcxml`);
    assert.equal(fingerprint(marcxml), record.marcxmlHash);
    assert.equal(record.nativeNotesComplete, true);
    assert.ok(record.nativeNotes.length >= 2);
    assert.equal(record.dimensions.width, 2200);
    assert.ok(Math.abs(record.dimensions.width / record.dimensions.height - record.masterDimensions.width / record.masterDimensions.height) < .002, "local image keeps the complete master aspect ratio");
  }
});

test("all eight safe families and all twelve source lineages are present", () => {
  assert.deepEqual(new Set(museumExhibition.chapters.map((chapter) => chapter.layout)), new Set(["cover", "full_bleed", "split", "collection_grid", "comparison", "audio", "timeline", "credits"]));
  const used = new Set<string>();
  for (const chapter of museumExhibition.chapters) {
    assert.ok(chapter.sourceIds.length > 0);
    for (const id of chapter.sourceIds) { assert.ok(museumSources.some((source) => source.id === id)); used.add(id); }
    assert.ok(museumSources.some((source) => source.imagePath === chapter.imagePath));
    assert.ok(chapter.mapPosition.x >= 0 && chapter.mapPosition.x <= 100);
    assert.ok(chapter.mapPosition.y >= 0 && chapter.mapPosition.y <= 100);
  }
  assert.equal(used.size, 12);
});

test("six complete authored locales include chapter prose, transcripts, image descriptions and UI", () => {
  for (const locale of exhibitionLocaleOrder) {
    assert.deepEqual(Object.keys(exhibitionCopy[locale].ui).sort(), Object.keys(exhibitionCopy.en.ui).sort());
    assert.equal(Object.keys(exhibitionCopy[locale].sources).length, 12);
    for (const value of Object.values(exhibitionCopy[locale].ui)) assert.ok(value.trim().length > 0);
    for (const chapter of museumExhibition.chapters) {
      const content = chapter.content[locale];
      assert.deepEqual(Object.keys(content).sort(), ["body", "caption", "eyebrow", "title", "transcript"]);
      assert.ok(content.body.length >= (locale === "ja" ? 160 : 220), `${locale}/${chapter.id} has substantial non-placeholder prose`);
      assert.ok(content.transcript.length >= 80);
      assert.ok(chapter.imageAlt[locale].length > 15);
      assert.doesNotMatch(JSON.stringify(content), /\b(TODO|TBD|lorem ipsum|translation pending)\b/i);
      if (locale !== "en") assert.notEqual(content.body, chapter.content.en.body);
      if (locale === "ja") assert.match(content.body, /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u);
      if (locale === "ar") assert.match(content.body, /\p{Script=Arabic}/u);
    }
    for (const source of museumSources) {
      const translated = exhibitionCopy[locale].sources[source.id]; assert.ok(translated);
      assert.ok(translated.title.trim().length >= 2);
      assert.ok(translated.alt.length >= 15);
      assert.ok(translated.note.trim().length > 0);
    }
  }
});

test("sample provenance never fabricates acceptance, audio or fluent review", () => {
  assert.equal(museumExhibition.provenance.mode, "sample");
  assert.deepEqual(museumExhibition.acceptedArtifactIds, []);
  for (const review of Object.values(museumExhibition.languageReviews)) { assert.equal(review.fluentReviewed, false); assert.equal(review.reviewer, null); assert.equal(review.reviewedAt, null); assert.ok(review.disclosure.length > 50); }
  for (const chapter of museumExhibition.chapters) assert.deepEqual(chapter.audio, {});
  const html = buildPortableHtml(museumExhibition, "ar", imageAssets());
  assert.doesNotMatch(html, /<audio\b/);
  assert.match(html, /<html lang="ar" dir="rtl">/);
  assert.ok(html.includes(exhibitionCopy.ar.ui.transcriptDisclosure));
});

test("portable export preserves every locale, safe family, source note and complete-frame image reference", () => {
  const html = buildPortableHtml(museumExhibition, "en", imageAssets());
  assert.equal((html.match(/<article data-language=/g) ?? []).length, 6);
  assert.equal((html.match(/data-chapter=/g) ?? []).length, 48);
  assert.equal((html.match(/<symbol id="image-/g) ?? []).length, 12, "binary photos are embedded once and reused across locales");
  for (const source of museumSources) { assert.ok(html.includes(source.contentHash)); assert.ok(html.includes(source.sourceUrl)); }
  assert.doesNotMatch(html, /<(?:img|audio|script|link)[^>]+(?:src|href)="https?:/);
  assert.equal(exhibitionAssetUrls(museumExhibition).length, 12);
  assert.equal((html.match(/class="portable-map"/g) ?? []).length, 6);
  assert.equal((html.match(/class="font-licences"/g) ?? []).length, 6);
  const controller = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]; assert.ok(controller);
  assert.doesNotThrow(() => new Script(controller), "the generated offline controller must be valid JavaScript");
});

test("provider text and JSON cannot break out into executable export markup", () => {
  const document = structuredClone(museumExhibition);
  const payload = '</script><script data-attack="yes">alert(1)</script><img src=x onerror=alert(1)>';
  const first = document.chapters[0]; assert.ok(first);
  first.content.en.body = payload; document.title.en = payload;
  const source = document.sources[0]; assert.ok(source); source.creator = payload;
  const html = buildPortableHtml(document, "en", imageAssets());
  assert.doesNotMatch(html, /<script data-attack/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.ok(html.includes("&lt;script data-attack=&quot;yes&quot;&gt;"));
  assert.ok(safeScriptJson({ payload }).includes("\\u003c/script\\u003e"));
  assert.equal(escapeHtml('<a title="x">&'), "&lt;a title=&quot;x&quot;&gt;&amp;");
  const maliciousAssets = imageAssets(); maliciousAssets.set("/museum/fonts/inter-latin.woff2", 'data:font/woff2;base64,AAAA\");}</style><script data-attack="yes">');
  assert.doesNotMatch(buildPortableHtml(document, "en", maliciousAssets), /<script data-attack/);
});

test("media, archive links, palettes and image positions reject executable or unbounded tokens", () => {
  for (const value of ["javascript:alert(1)", "data:text/html,hi", "//evil.example/picture", "https://user:password@example.com/x", "/\\evil.example/x"]) assert.equal(safeMediaUrl(value), null);
  assert.equal(safeMediaUrl("/museum/images/4a22773.webp"), "/museum/images/4a22773.webp");
  assert.equal(safeExternalUrl("javascript:alert(1)"), null);
  assert.equal(safeHexColor("red; background:url(x)", "#ffffff"), "#ffffff");
  assert.equal(safeHexColor("#1b2333", "#ffffff"), "#1b2333");
  assert.equal(safeImagePosition("999% 0%"), "50% 50%");
  assert.equal(safeImagePosition("43% 61%"), "43% 61%");
});

test("portable audio controls appear only when a recording and its embedded binary both exist", () => {
  const document = structuredClone(museumExhibition);
  const chapter = document.chapters.find((item) => item.layout === "audio"); assert.ok(chapter);
  chapter.audio.en = { url: "/test-recording.wav", durationSeconds: 1, segments: [{ start: 0, end: 1, text: "Synthetic unit-test fixture; not an exhibition recording." }] };
  const assets = imageAssets();
  assert.doesNotMatch(buildPortableHtml(document, "en", assets), /<audio\b/);
  assets.set("/test-recording.wav", "data:audio/wav;base64,UklGRg==");
  assert.equal((buildPortableHtml(document, "en", assets).match(/<audio\b/g) ?? []).length, 1);
});
