import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { deepgramLocaleModels, inspectDeepgramTimings } from "@/domain/deepgram-caption-alignment";
import { DeepgramTimestampGateway, DeepgramGatewayError, checkedDeepgramReceipt, deepgramRequestDescriptor, type DeepgramTimestampInput } from "@/server/captions/deepgram-gateway";

const request = (): DeepgramTimestampInput => ({ requestId: randomUUID(), bytes: Buffer.from("Controlled transport fixture, not a recording"), mimeType: "audio/wav", locale: "en" });
const model = deepgramLocaleModels.en, providerId = "abf10438-242e-4b81-9930-40f3710d8166";
const response = () => ({ metadata: { request_id: providerId, duration: 3, channels: 1, models: [model.uuid], model_info: { [model.uuid]: { name: "general", arch: "nova-3", version: model.version as string } } },
  results: { channels: [{ alternatives: [{ transcript: "The harbour.", confidence: .97, words: [{ word: "the", start: .10000001, end: .6999999, confidence: .99 }, { word: "harbour", start: .8, end: 2.8, confidence: .96, punctuated_word: "harbour." }] }] }] } });
const options = { apiKey: () => "controlled-key-no-network", clock: () => new Date("2026-11-11T19:00:00.000Z") };
const code = (expected: string) => (error: unknown) => error instanceof DeepgramGatewayError && error.code === expected;

test("Deepgram sends one exact byte copy after the durable claim; no script, hints or replacement rules", async () => {
  const input = request(), original = Buffer.from(input.bytes); let claimed = false, calls = 0;
  const gateway = new DeepgramTimestampGateway({ ...options, fetch: async (url, init) => {
    calls++; assert.equal(claimed, true); assert.equal(init?.method, "POST"); assert.equal(init?.redirect, "error");
    const endpoint = new URL(String(url)); assert.equal(endpoint.origin + endpoint.pathname, "https://api.deepgram.com/v1/listen");
    assert.deepEqual(Object.fromEntries(endpoint.searchParams), { model: "nova-3", version: model.version, language: "en", punctuate: "true", smart_format: "false", numerals: "false", utterances: "false", mip_opt_out: "true", redact_usage: "true" });
    assert.deepEqual(Buffer.from(init!.body as Uint8Array), original);
    assert.equal(new Headers(init?.headers).get("content-type"), "audio/wav");
    return new Response(JSON.stringify(response()), { headers: { "dg-request-id": providerId } });
  } });
  const expected = deepgramRequestDescriptor(input), receipt = await gateway.transcribe(input, async () => { claimed = true; input.bytes.fill(0); input.locale = "ja"; });
  assert.equal(calls, 1); assert.equal(receipt.locale, "en"); assert.equal(receipt.parseFailure, null);
  assert.deepEqual(checkedDeepgramReceipt(receipt, expected), receipt);
  assert.equal(receipt.audioHash, createHash("sha256").update(original).digest("hex"));
});

test("receipt verification rejects altered raw bytes, parsed timings and request/audio bindings", async () => {
  const input = request(), expected = deepgramRequestDescriptor(input);
  const receipt = await new DeepgramTimestampGateway({ ...options, fetch: async () => new Response(JSON.stringify(response())) }).transcribe(input, async () => {});
  for (const mutate of [
    (r: typeof receipt) => { r.parsed!.results.channels[0]!.alternatives[0]!.words[0]!.start = .2; },
    (r: typeof receipt) => { r.rawBodyBase64 = Buffer.from("changed").toString("base64"); },
    (r: typeof receipt) => { r.bodyComplete = false; },
  ]) { const changed = structuredClone(receipt); mutate(changed); assert.throws(() => checkedDeepgramReceipt(changed, expected), code("DEEPGRAM_RECEIPT_CHANGED")); }
  for (const mutate of [
    (r: typeof receipt) => { r.audioHash = "f".repeat(64); },
    (r: typeof receipt) => { r.requestId = randomUUID(); },
    (r: typeof receipt) => { r.requestHash = "e".repeat(64); },
  ]) { const changed = structuredClone(receipt); mutate(changed); assert.throws(() => checkedDeepgramReceipt(changed, expected), code("DEEPGRAM_REQUEST_CHANGED")); }
});

test("model drift, foreign request identity and extra channels are retained as unqualified raw evidence", async () => {
  const altered = response(); altered.metadata.model_info[model.uuid]!.version = "new-unqualified-version";
  const extra = response(); extra.results.channels.push(structuredClone(extra.results.channels[0]!));
  for (const [body, headers, expected] of [
    [altered, {}, "MODEL_BINDING"], [response(), { "dg-request-id": randomUUID() }, "REQUEST_ID_BINDING"], [extra, {}, "JSON_SCHEMA"],
  ] as const) {
    const receipt = await new DeepgramTimestampGateway({ ...options, fetch: async () => new Response(JSON.stringify(body), { headers }) }).transcribe(request(), async () => {});
    assert.equal(receipt.parseFailure, expected); assert.equal(receipt.parsed, null); assert.equal(receipt.bodyComplete, true);
    assert.deepEqual(JSON.parse(Buffer.from(receipt.rawBodyBase64, "base64").toString()), body);
  }
});

test("missing configuration, invalid input and refused durable claim all prevent dispatch", async () => {
  let calls = 0; const fetcher: typeof fetch = async () => { calls++; throw new Error("Must not dispatch"); };
  await assert.rejects(new DeepgramTimestampGateway({ ...options, apiKey: () => undefined, fetch: fetcher }).transcribe(request(), async () => {}), code("DEEPGRAM_CONFIGURATION"));
  const bad = request(); bad.bytes = Buffer.alloc(0);
  await assert.rejects(new DeepgramTimestampGateway({ ...options, fetch: fetcher }).transcribe(bad, async () => {}), code("DEEPGRAM_INPUT"));
  await assert.rejects(new DeepgramTimestampGateway({ ...options, fetch: fetcher }).transcribe(request(), async () => { throw new Error("already dispatched"); }), /already dispatched/);
  assert.equal(calls, 0);
});

test("a lost response is unknown after exactly one attempt, with no automatic retry", async () => {
  let calls = 0;
  await assert.rejects(new DeepgramTimestampGateway({ ...options, fetch: async () => { calls++; throw new Error("lost connection, private content"); } }).transcribe(request(), async () => {}), error => {
    assert.ok(error instanceof DeepgramGatewayError); assert.equal(error.code, "DEEPGRAM_DISPATCH_UNKNOWN"); assert.equal(error.definitive, false); assert.equal(error.receipt, null); assert.doesNotMatch(error.message, /private content/); return true;
  }); assert.equal(calls, 1);
});

test("HTTP errors, invalid UTF8 and truncated streams retain original bytes", async () => {
  for (const [raw, status, failure] of [[Buffer.from('{"err_code":"RATE_LIMIT"}'), 429, "HTTP_STATUS"], [Buffer.from([0xff, 0xfe]), 200, "UTF8"], [Buffer.from("not json"), 200, "JSON_SCHEMA"]] as const) {
    const receipt = await new DeepgramTimestampGateway({ ...options, fetch: async () => new Response(raw, { status }) }).transcribe(request(), async () => {});
    assert.equal(receipt.parseFailure, failure); assert.deepEqual(Buffer.from(receipt.rawBodyBase64, "base64"), raw);
  }
  let read = 0;
  await assert.rejects(new DeepgramTimestampGateway({ ...options, fetch: async () => new Response(new ReadableStream({ pull(controller) { if (!read++) controller.enqueue(Buffer.from("partial")); else controller.error(new Error("interrupted")); } })) }).transcribe(request(), async () => {}), error => {
    assert.ok(error instanceof DeepgramGatewayError); assert.equal(error.code, "DEEPGRAM_RESPONSE_UNKNOWN"); assert.equal(error.receipt?.parseFailure, "INCOMPLETE"); assert.equal(Buffer.from(error.receipt!.rawBodyBase64, "base64").toString(), "partial"); return true;
  });
});

test("oversized responses keep a bounded partial receipt without a second request", async () => {
  let calls = 0;
  await assert.rejects(new DeepgramTimestampGateway({ ...options, fetch: async () => { calls++; return new Response("x".repeat(512 * 1024 + 1)); } }).transcribe(request(), async () => {}), error => {
    assert.ok(error instanceof DeepgramGatewayError); assert.equal(error.code, "DEEPGRAM_RESPONSE_SIZE"); assert.equal(error.receipt?.byteLength, 512 * 1024); assert.equal(error.receipt?.bodyComplete, false); return true;
  }); assert.equal(calls, 1);
});

test("timing inspection preserves raw floats and records bounded rounding without claiming source coverage", () => {
  const raw = response(), snapshot = structuredClone(raw), result = inspectDeepgramTimings({ response: raw, locale: "en", audioDurationSeconds: 3 });
  assert.equal(result.status, "measured"); assert.equal(result.words[0]?.rawStart, .10000001); assert.equal(result.words[0]?.startMs, 100);
  assert.ok(result.maximumDisplacementSeconds <= .0005); assert.equal(result.sourceCoverage, "not-established"); assert.equal(result.productionAccepted, false); assert.deepEqual(raw, snapshot);
});

test("raw overlap is never repaired by rounding; zero duration, bounds and collapsed intervals remain failures", () => {
  const cases: Array<[number, number, number, string]> = [[.6999998, 2.8, 3, "WORD_OVERLAP"], [.8, .8, 3, "WORD_NONPOSITIVE"], [.8, 3.2, 3, "WORD_AFTER_AUDIO"], [.80001, .80002, 3, "QUANTIZED_WORD_NONPOSITIVE"], [.8, 2.9999, 2.9999, "QUANTIZED_WORD_AFTER_AUDIO"]];
  for (const [start, end, duration, code] of cases) {
    const raw = response(); raw.results.channels[0]!.alternatives[0]!.words[1]!.start = start; raw.results.channels[0]!.alternatives[0]!.words[1]!.end = end;
    const result = inspectDeepgramTimings({ response: raw, locale: "en", audioDurationSeconds: duration });
    assert.equal(result.status, "withheld"); assert.ok(result.issues.some(x => x.code === code), code); assert.equal(result.words[1]?.rawEnd, end);
  }
});

test("silence, duration disagreement, wrong locale model and invalid duration cannot become caption approval", () => {
  const empty = response(); empty.results.channels[0]!.alternatives[0]!.transcript = ""; empty.results.channels[0]!.alternatives[0]!.words = [];
  const cases = [inspectDeepgramTimings({ response: empty, locale: "en", audioDurationSeconds: 3 }), inspectDeepgramTimings({ response: response(), locale: "en", audioDurationSeconds: 4 }), inspectDeepgramTimings({ response: response(), locale: "ar", audioDurationSeconds: 3 }), inspectDeepgramTimings({ response: response(), locale: "en", audioDurationSeconds: NaN })];
  assert.deepEqual(cases.map(x => x.issues[0]?.code), ["DEEPGRAM_NO_SPEECH", "DEEPGRAM_DURATION", "DEEPGRAM_MODEL_BINDING", "AUDIO_DURATION"]);
  assert.ok(cases.every(x => x.status === "withheld" && !x.productionAccepted));
});
