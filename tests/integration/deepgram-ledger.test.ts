import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { isolatedPostgres } from "../support/postgres";
const cleanup = await isolatedPostgres("guild_deepgram_ledger_test"); after(cleanup);
const { getPool } = await import("../../src/server/db");
const { createSession } = await import("../../src/server/session");
const { createCommission } = await import("../../src/server/commissions");
const { digest, DomainError } = await import("../../src/domain/primitives");
const { deepgramLocaleModels } = await import("../../src/domain/deepgram-caption-alignment");
const { DeepgramTimestampGateway, DeepgramGatewayError } = await import("../../src/server/captions/deepgram-gateway");
const { runDeepgramOnce, readDeepgramRun } = await import("../../src/server/captions/deepgram-runs");
type Scope = import("../../src/server/captions/deepgram-runs").DeepgramRunScope;
type Input = import("../../src/server/captions/deepgram-gateway").DeepgramTimestampInput;
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;
// Never admit a real network transport from this isolated database suite.
globalThis.fetch = async () => { throw new Error("External network is disabled in this synthetic transport suite."); };
const model = deepgramLocaleModels.en;
const response = () => ({ metadata: { request_id: randomUUID(), duration: 3, channels: 1, models: [model.uuid], model_info: { [model.uuid]: { name: "general", arch: "nova-3", version: model.version } } },
  results: { channels: [{ alternatives: [{ transcript: "The harbour.", confidence: .97, words: [{ word: "the", start: .1, end: .7, confidence: .99 }, { word: "harbour", start: .8, end: 2.8, confidence: .96, punctuated_word: "harbour." }] }] }] } });
async function fixture() {
  const { session } = await createSession();
  const c = await createCommission(session, { commandId: randomUUID(), title: "Synthetic Deepgram durability", museum: "Disposable test museum", objective: "Exercise transport durability with synthetic bytes and fake recognition; no external recognition, acceptance or payment.", capMinor: 64000, languages: ["en", "pt", "es", "fr", "ja", "ar"], sourceIds: [] }, []);
  const jobId = randomUUID(), producingJobId = randomUUID(), mediaId = randomUUID(), bytes = Buffer.from("synthetic transport bytes; not a recording");
  for (const [id, pkg] of [[jobId, "captions"], [producingJobId, "narration"]]) await getPool().query("INSERT INTO guild_jobs(id,tenant_id,commission_id,business_key,type,state,input) VALUES($1,$2,$3,$4,'produce_package','completed',$5)", [id, c.tenantId, c.id, "synthetic:" + id, { packageId: pkg, fixtureOnly: true }]);
  await getPool().query("INSERT INTO guild_media_objects(id,tenant_id,commission_id,job_id,package_id,operation_key,media_type,content_hash,byte_length,blob_pathname,metadata,state) VALUES($1,$2,$3,$4,'narration','synthetic','audio/wav',$5,$6,$7,$8,'ready')", [mediaId, c.tenantId, c.id, producingJobId, sha(bytes), bytes.length, "synthetic/" + mediaId, { synthetic: true }]);
  const scope: Scope = { tenantId: c.tenantId, commissionId: c.id, jobId, packageId: "captions", mediaId, producingJobId, sourceArtifactHash: digest("synthetic source artifact"), sourceTextHash: digest("The harbour."), agreementDigest: digest("synthetic agreement, not an approval"), authorityExpiresAt: new Date(Date.now() + 60000).toISOString(), operationKey: "en:welcome" };
  const input: Input = { requestId: randomUUID(), bytes, locale: "en", mimeType: "audio/wav" };
  let checks = 0;
  const authorizer = { async authorize(_db: unknown, received: Readonly<Scope>) { checks++; assert.deepEqual(received, scope); } };
  return { scope, input, authorizer, checks: () => checks };
}

test("one claimed dispatch survives replay and historical reads without provider credentials", async () => {
  const f = await fixture(); let calls = 0;
  const gateway = new DeepgramTimestampGateway({ apiKey: () => "fake-no-network", fetch: async () => {
    calls++; const row = (await getPool().query("SELECT state,dispatched_at FROM guild_alignment_runs WHERE id=$1", [f.input.requestId])).rows[0];
    assert.equal(row.state, "dispatching"); assert.ok(row.dispatched_at);
    return new Response(JSON.stringify(response()));
  } });
  const first = await runDeepgramOnce(f.scope, f.input, f.authorizer, gateway);
  assert.equal(calls, 1); assert.equal(f.checks(), 2); assert.equal(first.row.state, "received"); assert.equal(first.productionAccepted, false);
  const replay = await runDeepgramOnce(f.scope, f.input, { authorize: async () => { throw Error("Historical reads must not need fresh authority"); } }, new DeepgramTimestampGateway({ apiKey: () => undefined }));
  assert.deepEqual(replay.receipt, first.receipt); assert.equal(replay.evidenceHash, first.evidenceHash); assert.equal(calls, 1);
  await assert.rejects(readDeepgramRun(randomUUID(), first.row.id), code("DEEPGRAM_RUN_NOT_FOUND"));
  await assert.rejects(runDeepgramOnce({ ...f.scope, sourceTextHash: digest("changed") }, f.input, f.authorizer, gateway), code("DEEPGRAM_OPERATION_CHANGED"));
});

test("concurrent workers cannot dispatch twice or mark the owning worker unknown", async () => {
  const f = await fixture(); let calls = 0, entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const gateway = new DeepgramTimestampGateway({ apiKey: () => "fake", fetch: async () => { calls++; entered(); await gate; return new Response(JSON.stringify(response())); } });
  const first = runDeepgramOnce(f.scope, f.input, f.authorizer, gateway); await started;
  await assert.rejects(runDeepgramOnce(f.scope, f.input, f.authorizer, gateway), code("DEEPGRAM_ORIGINAL_PENDING"));
  assert.equal((await readDeepgramRun(f.scope.tenantId, f.input.requestId)).row.state, "dispatching");
  release(); assert.equal((await first).row.state, "received"); assert.equal(calls, 1);
});

test("lost and partially received originals remain held without another POST", async () => {
  for (const partial of [false, true]) {
    const f = await fixture(); let calls = 0, reads = 0;
    const gateway = new DeepgramTimestampGateway({ apiKey: () => "fake", fetch: async () => {
      calls++; if (!partial) throw Error("Synthetic connection loss");
      return new Response(new ReadableStream({ pull(controller) { if (!reads++) controller.enqueue(Buffer.from("original partial response")); else controller.error(Error("Synthetic stream loss")); } }));
    } });
    await assert.rejects(runDeepgramOnce(f.scope, f.input, f.authorizer, gateway), error => error instanceof DeepgramGatewayError && !error.definitive);
    const saved = await readDeepgramRun(f.scope.tenantId, f.input.requestId); assert.equal(saved.row.state, "indeterminate");
    assert.equal(saved.receipt?.bodyComplete ?? false, false);
    if (partial) assert.equal(Buffer.from(saved.receipt!.rawBodyBase64, "base64").toString(), "original partial response");
    await assert.rejects(runDeepgramOnce(f.scope, f.input, f.authorizer, gateway), code("DEEPGRAM_ORIGINAL_PENDING")); assert.equal(calls, 1);
  }
});

test("expired scopes, changed owned audio and refused current authority send zero requests", async () => {
  for (const mutation of ["expiry", "audio", "tenant", "authority"] as const) {
    const f = await fixture(); let calls = 0;
    const gateway = new DeepgramTimestampGateway({ apiKey: () => "fake", fetch: async () => { calls++; return new Response(JSON.stringify(response())); } });
    if (mutation === "expiry") f.scope.authorityExpiresAt = new Date(0).toISOString();
    if (mutation === "audio") f.input.bytes = Buffer.from("different bytes");
    if (mutation === "tenant") f.scope.tenantId = randomUUID();
    const authorizer = mutation === "authority" ? { authorize: async () => { throw new DomainError("REFUSED", "Synthetic authority refusal", 422, false); } } : f.authorizer;
    await assert.rejects(runDeepgramOnce(f.scope, f.input, authorizer, gateway)); assert.equal(calls, 0);
    assert.equal((await getPool().query("SELECT count(*)::int AS n FROM guild_alignment_runs WHERE id=$1", [f.input.requestId])).rows[0].n, 0);
  }
});

test("revocation between preparation and dispatch preserves a resumable original without calling the provider", async () => {
  const f = await fixture(); let checks = 0, calls = 0;
  const gateway = new DeepgramTimestampGateway({ apiKey: () => "fake", fetch: async () => { calls++; return new Response(JSON.stringify(response())); } });
  await assert.rejects(runDeepgramOnce(f.scope, f.input, { authorize: async () => { if (++checks === 2) throw new DomainError("REVOKED", "Synthetic revocation", 422, false); } }, gateway), code("REVOKED"));
  const saved = await readDeepgramRun(f.scope.tenantId, f.input.requestId); assert.equal(saved.row.state, "prepared"); assert.equal(saved.row.dispatched_at, null); assert.equal(calls, 0);
});

test("complete HTTP refusal is retained; recomputing a tampered receipt hash cannot forge its signature", async () => {
  const f = await fixture(); let calls = 0;
  const gateway = new DeepgramTimestampGateway({ apiKey: () => "fake", fetch: async () => { calls++; return new Response('{"err_code":"RATE_LIMIT"}', { status: 429 }); } });
  const saved = await runDeepgramOnce(f.scope, f.input, f.authorizer, gateway);
  assert.equal(saved.receipt!.parseFailure, "HTTP_STATUS"); assert.equal(saved.row.state, "received"); assert.equal(saved.productionAccepted, false);
  await runDeepgramOnce(f.scope, f.input, f.authorizer, gateway); assert.equal(calls, 1);
  const observed = (await getPool().query("SELECT receipt FROM guild_alignment_observations WHERE run_id=$1", [f.input.requestId])).rows[0].receipt;
  observed.receipt.observedAt = new Date().toISOString(); observed.receipt.latencyMs += 1;
  await getPool().query("UPDATE guild_alignment_observations SET receipt=$1,receipt_hash=$2 WHERE run_id=$3", [observed, digest(observed), f.input.requestId]);
  await assert.rejects(readDeepgramRun(f.scope.tenantId, f.input.requestId), code("DEEPGRAM_EVIDENCE_CHANGED"));
});

test("a different operation label cannot resubmit the same recording in the same job", async () => {
  const f = await fixture(); let calls = 0;
  const gateway = new DeepgramTimestampGateway({ apiKey: () => "fake", fetch: async () => { calls++; return new Response(JSON.stringify(response())); } });
  await runDeepgramOnce(f.scope, f.input, f.authorizer, gateway);
  const alias = { ...f.scope, operationKey: "en:renamed" };
  await assert.rejects(runDeepgramOnce(alias, { ...f.input, requestId: randomUUID() }, { authorize: async () => {} }, gateway), code("DEEPGRAM_MEDIA_ALREADY_PREPARED"));
  assert.equal(calls, 1);
});

test("retaining a late original response requires no new actor authorization and cannot claim acceptance", async () => {
  const f = await fixture(); let allowed = true, checks = 0;
  const gateway = new DeepgramTimestampGateway({ apiKey: () => "fake", fetch: async () => { allowed = false; return new Response(JSON.stringify(response())); } });
  const result = await runDeepgramOnce(f.scope, f.input, { authorize: async () => { checks++; assert.equal(allowed, true); } }, gateway);
  assert.equal(checks, 2); assert.equal(result.row.state, "received"); assert.equal(result.productionAccepted, false);
  assert.equal((await readDeepgramRun(f.scope.tenantId, result.row.id)).evidenceHash, result.evidenceHash);
});

test("missing provider configuration leaves no prepared operation", async () => {
  const f = await fixture();
  await assert.rejects(runDeepgramOnce(f.scope, f.input, f.authorizer, new DeepgramTimestampGateway({ apiKey: () => undefined })), error => error instanceof DeepgramGatewayError && error.code === "DEEPGRAM_CONFIGURATION");
  assert.equal(f.checks(), 0);
  assert.equal((await getPool().query("SELECT count(*)::int AS n FROM guild_alignment_runs WHERE id=$1", [f.input.requestId])).rows[0].n, 0);
});

test("all prepared and failed attempts count toward the bounded 78-recording capacity", async () => {
  const f = await fixture();
  const { deepgramTimestampCapability } = await import("../../src/domain/deepgram-caption-alignment");
  for (let i = 0; i < 78; i++) {
    const mediaId = randomUUID(), runId = randomUUID();
    await getPool().query("INSERT INTO guild_media_objects(id,tenant_id,commission_id,job_id,package_id,operation_key,media_type,content_hash,byte_length,blob_pathname,metadata,state) SELECT $1,tenant_id,commission_id,job_id,package_id,$2,media_type,content_hash,byte_length,$3,metadata,state FROM guild_media_objects WHERE id=$4", [mediaId, "capacity:" + i, "synthetic/" + mediaId, f.scope.mediaId]);
    await getPool().query("INSERT INTO guild_alignment_runs(id,tenant_id,commission_id,package_id,job_id,media_id,capability_version,operation_key,input_hash,request,state) VALUES($1,$2,$3,'captions',$4,$5,$6,$7,$8,$9,$10)", [runId, f.scope.tenantId, f.scope.commissionId, f.scope.jobId, mediaId, deepgramTimestampCapability.version, "synthetic-capacity:" + i, digest({ i }), { syntheticCapacityRow: true }, i % 2 ? "prepared" : "failed"]);
  }
  let calls = 0;
  const gateway = new DeepgramTimestampGateway({ apiKey: () => "fake", fetch: async () => { calls++; return new Response(JSON.stringify(response())); } });
  await assert.rejects(runDeepgramOnce(f.scope, f.input, f.authorizer, gateway), code("DEEPGRAM_CAPACITY"));
  assert.equal(calls, 0);
});
