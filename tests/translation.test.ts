import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { locales, type Locale } from "../src/contracts/guild";
import { exhibitionCopy } from "../src/exhibition/locales";
import { backTranslationSimilarity, blindBackTranslationInstruction, translationLocales, translationTextChecks, type TranslationText } from "../src/domain/translation";
import { identifyTranslationLanguages } from "../src/server/localization/translation-checks";
import { GeminiVerifierBatchGateway, VerifierBatchError, geminiBatchPayload, geminiResponseSchema, parseBatchObservation, type VerifierBatchRequest } from "../src/server/localization/gemini-batch-gateway";

const sample = (): Record<Locale, TranslationText> => Object.fromEntries(locales.map(locale => [locale, { arrival: { title: exhibitionCopy[locale].chapters.arrival.title, body: exhibitionCopy[locale].chapters.arrival.body } }])) as unknown as Record<Locale, TranslationText>;
const originalFetch = globalThis.fetch; afterEach(() => { globalThis.fetch = originalFetch; });

test("full translation checks preserve exact keys, English, scripts and explicit direction while detecting concrete mutations", () => {
  const texts = sample(), normal = translationTextChecks(texts, texts.en, translationLocales);
  assert.equal(normal.keys, true); assert.equal(normal.exactEnglish, true); assert.equal(normal.metadataMatches, true); assert.ok(normal.scripts.every(item => item.passed)); assert.equal(normal.placeholders.length, 0);
  const changed = structuredClone(texts); changed.ar.arrival!.body = texts.en.arrival!.body; changed.pt.arrival!.body += " {{museum_name}}"; changed.fr.extra = { title: "Unexpected", body: "This extra entry is not in the agreed key set." };
  const result = translationTextChecks(changed, texts.en, { ar: { direction: "ltr" } });
  assert.equal(result.keys, false); assert.equal(result.metadataMatches, false); assert.ok(result.placeholders.some(item => item.locale === "ar")); assert.ok(result.placeholders.some(item => item.locale === "pt")); assert.ok(result.scripts.some(item => item.locale === "ar" && !item.passed));
  changed.fr.arrival!.body = `\u202e${changed.fr.arrival!.body}`;
  assert.ok(translationTextChecks(changed, texts.en, translationLocales).scripts.some(item => item.locale === "fr" && !item.passed));
});

test("the agreed glossary is enforced per corresponding source label without inferring semantic equivalence", () => {
  const texts = sample(); texts.en.arrival!.body += " Detroit Publishing Co. retains its archival identification.";
  const missing = translationTextChecks(texts, texts.en, translationLocales).glossary.filter(item => item.term === "Detroit Publishing Co.");
  assert.equal(missing.length, 5); assert.ok(missing.every(item => item.term === "Detroit Publishing Co."));
  for (const locale of locales.filter(item => item !== "en")) texts[locale].arrival!.body += " (Detroit Publishing Co.)";
  assert.equal(translationTextChecks(texts, texts.en, translationLocales).glossary.filter(item => item.term === "Detroit Publishing Co.").length, 0);
});

test("the independent pinned detector identifies all six sample bodies and rejects wrong-language and short samples", () => {
  const texts = sample(), readings = identifyTranslationLanguages(texts, ["arrival"]);
  assert.equal(readings.length, 6); assert.ok(readings.every(item => item.passed), JSON.stringify(readings));
  texts.pt.arrival!.body = texts.es.arrival!.body; texts.ja.arrival!.body = "短い見出し";
  const wrong = identifyTranslationLanguages(texts, ["arrival"]);
  assert.equal(wrong.find(item => item.locale === "pt")!.passed, false); assert.equal(wrong.find(item => item.locale === "ja")!.sufficient, false);
});

test("the back-translation statistic is bounded, repeatable and explicitly weak on a negation mutation", () => {
  assert.equal(backTranslationSimilarity("same words", "same words").score, 1);
  assert.equal(backTranslationSimilarity("harbor ships", "mountain snow").score, 0);
  const result = backTranslationSimilarity("The archive identifies the photographer and gives an exact date for this photograph.", "The archive never identifies the photographer and never gives an exact date for this photograph.");
  assert.ok(result.score > 0.85); assert.equal(result.advisory, true, "a high lexical score must never become human acceptance");
});

const request = (): VerifierBatchRequest => ({ operationId: randomUUID(), model: "gemini-3.8-flash", requests: [{ key: "pt", instruction: blindBackTranslationInstruction, input: { targetLocale: "pt", labels: sample().pt }, schema: { type: "object", properties: { labels: { type: "object" } } } }] });
test("Gemini batch transport sends bounded blind inputs and strictly binds terminal response identities", async () => {
  process.env.GEMINI_API_KEY = "fixture-only-no-network";
  const input = request(), payload = geminiBatchPayload(input);
  assert.equal(payload.batch.inputConfig.requests.requests[0]!.metadata.key, "pt");
  assert.equal(payload.batch.inputConfig.requests.requests[0]!.request.contents[0]!.parts[0]!.text.includes(exhibitionCopy.en.chapters.arrival.body), false);
  const calls: string[] = [];
  globalThis.fetch = async (url, init) => { calls.push(String(url)); assert.equal(init?.redirect, "error"); assert.equal(new Headers(init?.headers).get("x-goog-api-key"), "fixture-only-no-network"); return Response.json({ name: "batches/fixture_one", metadata: { state: "BATCH_STATE_PENDING" }, done: false }); };
  const gateway = new GeminiVerifierBatchGateway(); assert.equal((await gateway.create(input)).name, "batches/fixture_one"); await gateway.get("batches/fixture_one");
  assert.deepEqual(calls, ["https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:batchGenerateContent", "https://generativelanguage.googleapis.com/v1beta/batches/fixture_one"]);
  assert.throws(() => gateway.get("https://attacker.invalid/batches/x"), VerifierBatchError);
  const raw = { name: "batches/fixture_one", metadata: { state: "BATCH_STATE_SUCCEEDED" }, done: true, response: { inlinedResponses: { inlinedResponses: [{ metadata: { key: "pt" }, response: { modelVersion: "gemini-3.8-flash", responseId: "fixture-response-one", candidates: [{ finishReason: "STOP", content: { parts: [{ text: "{\"labels\":{}}" }] } }], usageMetadata: { totalTokenCount: 200 } } }] } } };
  assert.equal(parseBatchObservation(raw).items[0]!.modelVersion, "gemini-3.8-flash");
  raw.response.inlinedResponses.inlinedResponses.push(raw.response.inlinedResponses.inlinedResponses[0]!);
  assert.throws(() => parseBatchObservation(raw), /confirmed batch observation/);
});

test("a response carrying a known batch name keeps it even when later fields are malformed", async () => {
  globalThis.fetch = async () => Response.json({ name: "batches/retain-this-id", metadata: { state: "FUTURE_STATE" } });
  await assert.rejects(new GeminiVerifierBatchGateway().create(request()), error => error instanceof VerifierBatchError && error.providerName === "batches/retain-this-id" && error.definitive === false);
  let writes = 0; globalThis.fetch = async () => { writes++; throw new TypeError("fixture lost response"); };
  await assert.rejects(new GeminiVerifierBatchGateway().create(request()), error => error instanceof VerifierBatchError && !error.definitive); assert.equal(writes, 1);
});

test("the qualified responseSchema recipe preserves required nested fields and is separate from the retained JSON-schema trial", () => {
  const input = request(); input.temperature = 1;
  input.requests[0]!.schemaFormat = "response_schema";
  input.requests[0]!.schema = { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { labels: { type: "object", properties: { arrival: { type: "object", properties: { title: { type: "string", minLength: 1, maxLength: 600 }, body: { type: "string", minLength: 20, maxLength: 6000 } }, required: ["title", "body"], additionalProperties: false } }, required: ["arrival"], additionalProperties: false } }, required: ["labels"], additionalProperties: false };
  const config = geminiBatchPayload(input).batch.inputConfig.requests.requests[0]!.request.generationConfig;
  assert.equal(config.temperature, 1); assert.ok("responseSchema" in config); assert.equal("responseJsonSchema" in config, false);
  assert.equal(config.responseSchema?.type, "OBJECT"); assert.deepEqual(config.responseSchema?.propertyOrdering, ["labels"]); assert.deepEqual(config.responseSchema?.required, ["labels"]);
  const properties = config.responseSchema?.properties as Record<string, any>;
  assert.equal(properties.labels.properties.arrival.properties.body.type, "STRING"); assert.equal(properties.labels.properties.arrival.properties.body.minLength, "20");
  assert.throws(() => geminiResponseSchema({ type: "string", unsupportedConstraint: true }), VerifierBatchError);
  assert.ok("responseJsonSchema" in geminiBatchPayload(request()).batch.inputConfig.requests.requests[0]!.request.generationConfig, "old saved requests retain their original transport recipe");
});
