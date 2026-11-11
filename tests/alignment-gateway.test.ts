import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createWhisperTokenizer } from "@/server/captions/whisper-prompt";
import { AlignmentGatewayError, checkedAlignmentReceipt, OpenAIWhisperTimestampGateway, type AlignmentInput } from "@/server/captions/alignment-gateway";
const tokenizer = createWhisperTokenizer(readFileSync(new URL("../vendor/whisper/multilingual.tiktoken", import.meta.url), "utf8"));
const responseBody = { text: "The harbour.", language: "english", duration: 2.2,
  words: [{ word: "The", start: 0, end: 0.8 }, { word: "harbour.", start: 1, end: 2 }], segments: [{ text: "The harbour.", start: 0, end: 2 }] };
const input = (): AlignmentInput => ({ requestId: randomUUID(), bytes: Buffer.from("synthetic transport bytes, not a recording"), locale: "en", prompt: tokenizer.excerpt("The harbour.", "en") });
const fixtureOptions = { clock: () => new Date("2026-11-11T12:00:00.000Z"), apiKey: () => "fixture-key-no-network" };
const code = (expected: string) => (error: unknown) => error instanceof AlignmentGatewayError && error.code === expected;

test("one original timestamp POST binds exact bytes, prompt and requested granularities", async () => {
  let calls = 0; const original = input();
  const gateway = new OpenAIWhisperTimestampGateway(tokenizer, { ...fixtureOptions, fetch: async (url, init) => {
    calls++; assert.equal(url, "https://api.openai.com/v1/audio/transcriptions"); assert.equal(init?.method, "POST"); assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("X-Client-Request-Id"), original.requestId);
    const form = init?.body as FormData;
    assert.equal(form.get("model"), "whisper-1"); assert.equal(form.get("response_format"), "verbose_json"); assert.equal(form.get("language"), "en");
    assert.equal(form.get("prompt"), original.prompt.text); assert.equal(form.get("temperature"), "0"); assert.deepEqual(form.getAll("timestamp_granularities[]"), ["word", "segment"]);
    assert.deepEqual(Buffer.from(await (form.get("file") as File).arrayBuffer()), original.bytes);
    return new Response(JSON.stringify(responseBody), { status: 200, headers: { "x-request-id": "req_fixture" } });
  } });
  const receipt = await gateway.align(original); assert.equal(calls, 1); assert.equal(receipt.providerRequestId, "req_fixture"); assert.deepEqual(receipt.parsed, responseBody);
  assert.equal(receipt.bodyComplete, true); assert.equal(receipt.parseFailure, null); assert.deepEqual(checkedAlignmentReceipt(receipt), receipt);
  const altered = structuredClone(receipt); altered.parsed!.words[0]!.end = 0.9;
  assert.throws(() => checkedAlignmentReceipt(altered), code("ALIGNMENT_RESPONSE_CHANGED"));
});

test("sunset, availability and changed prompt counters stop before any POST", async () => {
  let calls = 0; const fetcher: typeof fetch = async () => { calls++; throw new Error("must not dispatch"); };
  for (const now of ["2027-02-26T00:00:00.000Z", "2027-02-27T12:00:00.000Z"])
    await assert.rejects(new OpenAIWhisperTimestampGateway(tokenizer, { ...fixtureOptions, fetch: fetcher, clock: () => new Date(now) }).align(input()), code("ALIGNMENT_CAPABILITY_SUNSET"));
  await assert.rejects(new OpenAIWhisperTimestampGateway(tokenizer, { ...fixtureOptions, fetch: fetcher, available: () => false }).align(input()), code("ALIGNMENT_CAPABILITY_UNAVAILABLE"));
  const changed = input(); changed.prompt.tokenCount--;
  await assert.rejects(new OpenAIWhisperTimestampGateway(tokenizer, { ...fixtureOptions, fetch: fetcher }).align(changed), code("ALIGNMENT_PROMPT_CHANGED"));
  assert.equal(calls, 0);
});

test("network ambiguity is held after one POST, while malformed responses retain their exact bytes", async () => {
  let calls = 0;
  await assert.rejects(new OpenAIWhisperTimestampGateway(tokenizer, { ...fixtureOptions, fetch: async () => { calls++; throw new Error("connection lost"); } }).align(input()), code("ALIGNMENT_DISPATCH_UNKNOWN"));
  assert.equal(calls, 1);
  const raw = Uint8Array.from([0xff, 0xfe]);
  const bad = await new OpenAIWhisperTimestampGateway(tokenizer, { ...fixtureOptions, fetch: async () => new Response(raw) }).align(input());
  assert.equal(bad.parseFailure, "UTF8"); assert.equal(bad.parsed, null); assert.deepEqual(Buffer.from(bad.rawBodyBase64, "base64"), Buffer.from(raw));
  const unavailable = await new OpenAIWhisperTimestampGateway(tokenizer, { ...fixtureOptions, fetch: async () => new Response('{"error":"model unavailable"}', { status: 404 }) }).align(input());
  assert.equal(unavailable.parseFailure, "HTTP_STATUS"); assert.equal(unavailable.statusCode, 404); assert.equal(unavailable.bodyComplete, true);
});

test("an oversized original response retains a bounded partial receipt and never fetches again", async () => {
  let calls = 0;
  const gateway = new OpenAIWhisperTimestampGateway(tokenizer, { ...fixtureOptions, fetch: async () => { calls++; return new Response("x".repeat(512 * 1024 + 1)); } });
  await assert.rejects(gateway.align(input()), error => {
    assert.ok(error instanceof AlignmentGatewayError); assert.equal(error.code, "ALIGNMENT_RESPONSE_SIZE");
    assert.equal(error.definitive, false); assert.equal(error.receipt?.bodyComplete, false); assert.equal(error.receipt?.byteLength, 512 * 1024);
    assert.equal(error.receipt?.parseFailure, "INCOMPLETE"); return true;
  });
  assert.equal(calls, 1);
});
