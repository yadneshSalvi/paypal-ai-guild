import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { locales } from "../src/contracts/guild";
import { exhibitionCopy } from "../src/exhibition/locales";
import { digest } from "../src/domain/primitives";
import { backTranslationSchema, backTranslationSimilarity, blindBackTranslationInstruction, translationStandard } from "../src/domain/translation";
import { identifyTranslationLanguages } from "../src/server/localization/translation-checks";
import { GeminiVerifierBatchGateway, VerifierBatchError, type BatchObservation, type VerifierBatchRequest } from "../src/server/localization/gemini-batch-gateway";

try { process.loadEnvFile(".env"); } catch { /* Hosting supplies environment. */ }
const schemaTrial = process.argv.includes("--schema-contract-v2");
const directory = schemaTrial ? ".setup-evidence/translation-schema-calibration-v2" : ".setup-evidence/translation-calibration-v1", file = `${directory}/state.json`;
await mkdir(directory, { recursive: true, mode: 0o700 });
const write = (path: string, value: unknown, exclusive = false) => writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, ...(exclusive ? { flag: "wx" } : {}) });
const schema = backTranslationSchema(["arrival"]);
interface State { requestHash: string; state: string; batchId?: string; observation?: BatchObservation; failureCode?: string; pollCount: number; updatedAt: string; retainedRaw?: Record<string, unknown> }
if (process.argv.includes("--prepare")) {
  const source = { arrival: { title: exhibitionCopy.en.chapters.arrival.title, body: exhibitionCopy.en.chapters.arrival.body } };
  const texts = Object.fromEntries(locales.map(locale => [locale, { arrival: { title: exhibitionCopy[locale].chapters.arrival.title, body: exhibitionCopy[locale].chapters.arrival.body } }]));
  const formats = schemaTrial ? ["json_schema", "response_schema"] as const : ["json_schema"] as const;
  const request: VerifierBatchRequest = { operationId: randomUUID(), model: "gemini-3.8-flash", ...(schemaTrial ? { temperature: 1 as const } : {}), requests: formats.flatMap(format => locales.filter(locale => locale !== "en").map(locale => ({ key: schemaTrial ? `${format}_${locale}` : locale, instruction: blindBackTranslationInstruction + (schemaTrial ? ' Return an object with exactly two fields: labels and limitations. labels is an object with every supplied label key, each mapping to an object with exactly title and body, both full English strings. limitations is an array of strings, empty when none. For example: {"labels":{"arrival":{"title":"An English title","body":"The complete English back-translation of the submitted body."}},"limitations":[]}. Do not return null, change the nesting, or add targetLocale to the output.' : ""), input: { targetLocale: locale, labels: texts[locale] }, schema: z.toJSONSchema(schema), ...(schemaTrial ? { schemaFormat: format } : {}) }))) };
  const manifest = { schemaVersion: schemaTrial ? "guild.translation-schema-calibration.v2" : "guild.translation-calibration.v1", registeredAt: new Date().toISOString(), standard: translationStandard, request, requestHash: digest(request), source, texts, method: "All five curated sample translations are back-translated without their original English. Per-language token F1 is a lexical advisory; a deliberate English negation mutation demonstrates its known semantic limitation. This small corpus has no fluent-review ground truth and does not establish detector/model accuracy.", humanReviewed: false, accepted: false, financialWrites: 0 };
  await write(`${directory}/manifest.json`, manifest, true); await write(`${directory}/manifest.hash.json`, { hash: digest(manifest) }, true);
  console.log(JSON.stringify({ registered: true, cases: request.requests.length, source: "Curated sample introduction in five target languages", model: request.model, financialWrites: 0 }));
} else {
  const manifest = JSON.parse(await readFile(`${directory}/manifest.json`, "utf8")), registered = JSON.parse(await readFile(`${directory}/manifest.hash.json`, "utf8"));
  if (digest(manifest) !== registered.hash || digest(manifest.request) !== manifest.requestHash) throw new Error("The calibration inputs changed. No request was sent.");
  let state: State;
  try { state = JSON.parse(await readFile(file, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; state = { requestHash: manifest.requestHash, state: "reserved", pollCount: 0, updatedAt: new Date().toISOString() }; }
  if (state.requestHash !== manifest.requestHash) throw new Error("The original operation does not match these inputs.");
  const gateway = new GeminiVerifierBatchGateway();
  if (process.argv.includes("--run") && state.state === "reserved") {
    state.state = "dispatching"; state.updatedAt = new Date().toISOString(); await write(file, state);
    try { const observation = await gateway.create(manifest.request); state = { ...state, batchId: observation.name, observation, state: observation.done ? observation.state : "running" }; }
    catch (error) { state.failureCode = error instanceof VerifierBatchError ? error.code : "VERIFIER_UNCONFIRMED"; if (error instanceof VerifierBatchError && error.providerName) { state.batchId = error.providerName; state.retainedRaw = error.raw; state.state = "running"; } else state.state = error instanceof VerifierBatchError && error.definitive ? "failed" : "indeterminate"; }
    await write(file, state);
  } else if (process.argv.includes("--poll") && state.batchId && state.state === "running") {
    state.pollCount++; state.updatedAt = new Date().toISOString(); await write(file, state);
    try { const observation = await gateway.get(state.batchId); if (observation.name !== state.batchId) throw new Error("Saved batch identity mismatch."); state = { ...state, observation, failureCode: undefined, state: observation.done ? observation.state : "running" }; }
    catch (error) { state.failureCode = error instanceof VerifierBatchError ? error.code : "VERIFIER_READ_UNCONFIRMED"; if (error instanceof VerifierBatchError && error.raw) state.retainedRaw = error.raw; }
    await write(file, state);
  }
  if (state.state === "succeeded" && state.observation) {
    const results = state.observation.items.map(item => { let value: unknown = null; try { value = item.text ? JSON.parse(item.text) : null; } catch { /* Preserve malformed output in the original observation and count it as unusable. */ } const result = schema.safeParse(value); return { locale: item.key, modelVersion: item.modelVersion, responseId: item.responseId, errorCode: item.errorCode ?? (result.success ? null : "VERIFIER_OUTPUT_SCHEMA"), result: result.success ? result.data : null, comparison: result.success ? backTranslationSimilarity(manifest.source.arrival.body, result.data.labels.arrival!.body) : null }; });
    const summary = { schemaVersion: "guild.translation-calibration-result.v1", completedAt: new Date().toISOString(), manifestHash: registered.hash, batchId: state.batchId, batchBodyHash: state.observation.bodyHash, denominator: manifest.request.requests.length, usableResults: results.filter(item => item.result !== null).length, results, languageFindings: identifyTranslationLanguages(manifest.texts, ["arrival"]), knownLimitation: { provenance: "mutation_test", original: "The record identifies the photographer and gives an exact date.", mutation: "The record does not identify the photographer and does not give an exact date.", comparison: backTranslationSimilarity("The record identifies the photographer and gives an exact date.", "The record does not identify the photographer and does not give an exact date."), conclusion: "Word overlap cannot establish meaning. Negation and uncertainty must be read by a reviewer regardless of score." }, humanReviewed: false, accepted: false, financialWrites: 0 };
    await write(`${directory}/summary.json`, summary);
    console.log(JSON.stringify({ state: state.state, cases: results.length, results: results.map(item => ({ locale: item.locale, model: item.modelVersion, score: item.comparison?.score, errorCode: item.errorCode })), humanReviewed: false, financialWrites: 0 }));
  } else console.log(JSON.stringify({ state: state.state, knownBatch: !!state.batchId, polls: state.pollCount, failureCode: state.failureCode, financialWrites: 0 }));
}
