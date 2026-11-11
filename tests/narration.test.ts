import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { locales, type ArtifactManifest } from "../src/contracts/guild";
import { digest } from "../src/domain/primitives";
import { narrationAcceptancePack, narrationScripts } from "../src/domain/narration";
import { exhibitionCopy } from "../src/exhibition/locales";
import { translationLocales } from "../src/domain/translation";
import { OpenAITranscriptionGateway, TranscriptionGatewayError } from "../src/server/media/transcription-gateway";

const originalFetch = globalThis.fetch, originalKey = process.env.OPENAI_API_KEY;
afterEach(() => { globalThis.fetch = originalFetch; if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey; });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function source(): ArtifactManifest {
  const content = { schemaVersion: "guild.translation.v2", contractDigest: "a".repeat(64), glossaryDigest: "b".repeat(64), translations: Object.fromEntries(locales.map(locale => [locale, Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`label-${i + 1}`, { title: exhibitionCopy[locale].chapters.arrival.title, body: exhibitionCopy[locale].chapters.arrival.body }]))])), localeMetadata: translationLocales, arabicDirection: "rtl", sourceArtifactId: randomUUID(), sourceArtifactHash: "c".repeat(64), inputBindings: [{ packageId: "research", contractVersion: 1, artifactId: randomUUID(), artifactHash: "d".repeat(64), reviewKind: "automated_review", reviewId: randomUUID() }], fluentHumanReviewed: false, limitations: ["Synthetic scope fixture."], modelRuns: locales.filter(locale => locale !== "en").map(locale => ({ id: randomUUID(), locale, model: "synthetic-fixture" })) };
  return { id: randomUUID(), packageId: "translation", title: "Synthetic 13-label contract fixture", mediaType: "application/json", contentHash: digest(content), downloadUrl: "/fixture", previewUrl: null, sourceIds: [], createdAt: new Date().toISOString(), provenance: { mode: "sample", label: "Synthetic contract test", sourceId: null, observedAt: null, sandbox: false }, reviewStatus: "Not production evidence", content };
}

test("the full narration agreement keeps all 78 exact title/body scripts and six language estimates", () => {
  const original = source(), scripts = narrationScripts(original);
  assert.equal(scripts.length, 78); assert.equal(new Set(scripts.map(item => `${item.locale}:${item.key}`)).size, 78);
  for (const item of scripts) { const label = (original.content.translations as any)[item.locale][item.key]; assert.equal(item.text, `${label.title}\n\n${label.body}`); assert.equal(item.textHash, digest(item.text)); assert.ok(item.estimateSeconds > 0); }
  const engine = { package: "ffmpeg-static" as const, packageVersion: "5.3.0" as const, version: "6.0", binaryHash: "e".repeat(64), platform: "fixture/only" }, pack = narrationAcceptancePack(original, engine);
  assert.equal(pack.version, "2.0.0"); assert.equal((pack.parameters!.scripts as unknown[]).length, 78); assert.equal(pack.parameters!.sourceArtifactHash, original.contentHash);
  assert.equal(pack.criteria.filter(item => item.blocking && item.kind === "deterministic").length, 6); assert.equal(pack.criteria.find(item => item.id === "asr")!.blocking, false); assert.equal(pack.criteria.find(item => item.id === "listening")!.kind, "human");
  const changed = structuredClone(original); (changed.content.translations as any).ar['label-1'].body += " تعديل"; changed.contentHash = digest(changed.content);
  assert.notEqual(narrationAcceptancePack(changed, engine).digest, pack.digest, "one changed word changes the agreement");
});

test("a missing locale, old language format or stale source hash cannot become a complete narration agreement", () => {
  const original = source(), missing = structuredClone(original); delete (missing.content.translations as any).ja['label-13']; missing.contentHash = digest(missing.content);
  assert.throws(() => narrationScripts(missing), /same complete label set/);
  const old = structuredClone(original); delete old.content.schemaVersion; old.contentHash = digest(old.content); assert.throws(() => narrationScripts(old), /full language agreement/);
  original.content.extra = "mutated without a new fingerprint"; assert.throws(() => narrationScripts(original), /full language agreement/);
});

test("recognition sends only original audio plus a language hint and retains the exact response bytes", async () => {
  process.env.OPENAI_API_KEY = "synthetic-recognition-key"; let calls = 0;
  const raw = JSON.stringify({ text: "An independent transcription.", languages: [{ code: "en" }], fixture: true });
  globalThis.fetch = async (url, init) => { calls++; assert.equal(url, "https://api.openai.com/v1/audio/transcriptions"); assert.equal(init?.redirect, "error"); const form = init?.body as FormData; assert.deepEqual([...form.keys()].sort(), ["file", "languages[]", "model"]); assert.equal(form.get("model"), "gpt-transcribe"); assert.equal(form.get("languages[]"), "en"); assert.equal(form.has("prompt"), false); assert.equal(form.has("text"), false); return new Response(raw, { headers: { "x-request-id": "fixture-request" } }); };
  const result = await new OpenAITranscriptionGateway().transcribe(Buffer.from("Synthetic bytes; file verification is a separate boundary."), "en");
  assert.equal(calls, 1); assert.equal(result.rawBody, raw); assert.equal(result.bodyHash, hash(raw)); assert.equal(result.text, "An independent transcription."); assert.deepEqual(result.languages, ["en"]);
});

test("malformed or ambiguous recognition remains one observation, with bounded original failure evidence", async () => {
  process.env.OPENAI_API_KEY = "synthetic-recognition-key"; let calls = 0;
  const raw = '{"text":null,"languages":[]}'; globalThis.fetch = async () => { calls++; return new Response(raw); };
  await assert.rejects(new OpenAITranscriptionGateway().transcribe(Buffer.alloc(10), "ja"), error => error instanceof TranscriptionGatewayError && error.rawBody === raw && error.bodyHash === hash(raw) && !error.definitive);
  assert.equal(calls, 1); globalThis.fetch = async () => { calls++; throw new TypeError("Synthetic lost response"); };
  await assert.rejects(new OpenAITranscriptionGateway().transcribe(Buffer.alloc(10), "ar"), error => error instanceof TranscriptionGatewayError && !error.definitive); assert.equal(calls, 2);
});
