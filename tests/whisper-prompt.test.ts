import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Locale } from "@/contracts/guild";
import { createWhisperTokenizer, whisperPromptPolicy } from "@/server/captions/whisper-prompt";
const ranks = readFileSync(new URL("../vendor/whisper/multilingual.tiktoken", import.meta.url), "utf8");
const reference: { cases: { locale: Locale; kind: string; text: string; tokens: number[] }[] } = JSON.parse(readFileSync(new URL("./fixtures/whisper-reference-vectors.json", import.meta.url), "utf8"));
const tokenizer = createWhisperTokenizer(ranks);
test("Whisper multilingual encoding equals the pinned official Python reference for all 36 vectors", () => {
  assert.equal(reference.cases.length, 36);
  for (const vector of reference.cases) assert.deepEqual(tokenizer.encode(vector.text), vector.tokens, `${vector.locale}/${vector.kind}`);
});
test("six long scripts retain an exact bounded suffix with explicit offsets and full-source binding", () => {
  for (const vector of reference.cases.filter(item => item.kind === "long")) {
    const excerpt = tokenizer.excerpt(vector.text, vector.locale);
    assert.equal(excerpt.policy.maximumTokens, 224);
    assert.ok(excerpt.boundedTokenCount <= whisperPromptPolicy.maximumTokens);
    assert.ok(excerpt.sourceStart > 0);
    assert.equal(excerpt.text, vector.text.slice(excerpt.sourceStart, excerpt.sourceEnd));
    assert.equal(excerpt.tokenCount, tokenizer.encode(excerpt.text).length);
    assert.equal(excerpt.leadingSpaceTokenCount, tokenizer.encode(` ${excerpt.text}`).length);
    assert.equal(excerpt.completeSourceIncluded, false);
    assert.deepEqual(excerpt, tokenizer.excerpt(vector.text, vector.locale));
  }
});
test("short complete scripts keep their exact bytes; changed ranks or unsupported controls fail closed", () => {
  for (const vector of reference.cases.filter(item => item.kind === "short")) {
    const excerpt = tokenizer.excerpt(vector.text, vector.locale);
    assert.equal(excerpt.text, vector.text);
    assert.equal(excerpt.sourceStart, 0);
    assert.equal(excerpt.completeSourceIncluded, true);
  }
  assert.throws(() => createWhisperTokenizer(ranks + "\n"), /asset changed/);
  for (const text of ["Museum\u0085text", "Museum\ufefftext", "Museum\u00a0text", "<|startofprev|>museum", "\ud800", " ", "x".repeat(6001)]) assert.throws(() => tokenizer.excerpt(text, "en"));
});
