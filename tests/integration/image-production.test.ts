import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { isolatedPostgres } from "../support/postgres";
import type { Commission } from "../../src/contracts/guild";
import type { ImageArtifact, ImageDescription } from "../../src/domain/images";
import type { PrivateBlobGateway, StoredBlob } from "../../src/server/media/blob-store";

const cleanup = await isolatedPostgres("guild_image_test"); after(cleanup);
process.env.OPENAI_API_KEY = "fixture-image-key-never-sent-on-network";
process.env.OPENAI_MODEL = "fixture-image-model";
const { createSession } = await import("../../src/server/session");
const { createCommission, executeCommand, getCommission, saveCommission } = await import("../../src/server/commissions");
const { getPool, transaction } = await import("../../src/server/db");
const { planDigest, acceptancePack } = await import("../../src/domain/fixture");
const { imageAcceptancePack } = await import("../../src/domain/images");
const { museumSources } = await import("../../src/exhibition/museum");
const { runNextJob } = await import("../../src/server/jobs");
const { storeMedia, readOwnedMedia, privateMediaResponse } = await import("../../src/server/media/objects");
const { DomainError, digest } = await import("../../src/domain/primitives");
const originalFetch = globalThis.fetch; afterEach(() => { globalThis.fetch = originalFetch; });
const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;
const bytesHash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

class MemoryPrivateStore implements PrivateBlobGateway {
  files = new Map<string, StoredBlob>(); writes: string[] = []; reads: string[] = []; loseNextWrite = false; unavailable = false;
  async put(pathname: string, bytes: Buffer, mediaType: string) {
    this.writes.push(pathname); assert.equal(this.files.has(pathname), false, "immutable uploads must not overwrite an existing file");
    const etag = bytesHash(bytes); this.files.set(pathname, { pathname, bytes: Buffer.from(bytes), mediaType, etag });
    if (this.loseNextWrite) { this.loseNextWrite = false; throw new TypeError("Fixture upload response lost after persistence"); }
    return { pathname, etag };
  }
  async read(pathname: string, maximumBytes: number) {
    this.reads.push(pathname); if (this.unavailable) throw new TypeError("Fixture store unavailable");
    const file = this.files.get(pathname); if (!file) return null;
    assert.ok(file.bytes.length <= maximumBytes);
    return { ...file, bytes: Buffer.from(file.bytes) };
  }
}

function description(sourceId: string): ImageDescription {
  return { sourceId, alt: { en: "Synthetic fixture description of the supplied photograph.", pt: "Descrição sintética da fotografia fornecida para este teste.", es: "Descripción sintética de la fotografía proporcionada para esta prueba.", fr: "Description synthétique de la photographie fournie pour ce test.", ja: "これは提供された写真の検証用の合成説明であり、実際のレビューではありません。", ar: "هذا وصف اصطناعي للصورة المقدمة للتحقق فقط وليس مراجعة بشرية." }, visibleFeatures: ["Synthetic test output, not a real provider observation."], uncertainties: ["This fixture does not establish image-description quality."], framingReason: "This synthetic fixture keeps the complete source frame for deterministic checks." };
}
function imageTransport() {
  const requests: { method: string; sourceId?: string; url: string }[] = [], responses = new Map<string, ImageDescription>();
  globalThis.fetch = async (input, init) => {
    const url = String(input), method = init?.method ?? "GET";
    assert.ok(url.startsWith("https://api.openai.com/v1/responses"), "fixture must never contact another service");
    if (method === "POST") {
      const request = JSON.parse(String(init?.body)), parts = request.input[1].content;
      assert.equal(request.background, true); assert.equal(request.store, false); assert.equal(request.reasoning.effort, "max");
      const data = JSON.parse(parts[0].text), image = parts.find((part: { type: string }) => part.type === "input_image");
      assert.equal(image.detail, "high"); assert.ok(image.image_url.startsWith("data:image/webp;base64,"));
      assert.equal(bytesHash(Buffer.from(image.image_url.split(",")[1], "base64")), data.source.contentHash);
      assert.equal(data.contract.version, "2.0.0"); assert.equal(data.treatment.generativePixelChanges, false);
      const id = `resp_image_fixture_${randomUUID().replaceAll("-", "")}`;
      responses.set(id, description(data.source.id)); requests.push({ method, sourceId: data.source.id, url });
      return Response.json({ id, status: "queued", output: [] });
    }
    const id = url.split("/").at(-1)!, output = responses.get(id); assert.ok(output);
    requests.push({ method, url });
    return Response.json({ id, status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }] });
  };
  return requests;
}

async function fresh(options: { sourceCount?: number; legacy?: boolean; queue?: boolean } = {}) {
  const { session } = await createSession(), sources = museumSources.slice(0, options.sourceCount ?? 1);
  let c = await createCommission(session, { commandId: randomUUID(), title: "Private image integration fixture", museum: "Fixture museum", objective: "Test immutable files, actual decoded image checks and recoverable media jobs with synthetic descriptions and no financial requests.", capMinor: 64000, languages: ["en", "pt", "es", "fr", "ja", "ar"], sourceIds: sources.map(source => source.id) }, sources);
  if (options.legacy) await transaction(async db => { c.packages.find(pkg => pkg.kind === "images")!.acceptancePack = acceptancePack("images"); await saveCommission(db, c); });
  await executeCommand(session, c.id, { type: "approve_plan", commandId: randomUUID(), expectedRevision: c.revision, planDigest: planDigest(c) });
  c = await getCommission(session, c.id);
  let jobId: string | null = null;
  if (options.queue !== false) { const queued = await executeCommand(session, c.id, { type: "produce_package", commandId: randomUUID(), expectedRevision: c.revision, packageId: "images" }); assert.ok(queued.ok && queued.jobId); jobId = queued.jobId; }
  return { session, commissionId: c.id, jobId, sources };
}
type Fixture = Awaited<ReturnType<typeof fresh>>;
async function ready(f: Fixture) {
  assert.ok(f.jobId);
  await getPool().query("UPDATE guild_jobs SET available_at=now() WHERE id=$1", [f.jobId]);
  await getPool().query("UPDATE guild_model_runs SET poll_after=now() WHERE job_id=$1", [f.jobId]);
}
async function drive(f: Fixture, store: MemoryPrivateStore, modelRequests: unknown[]) {
  for (let step = 0; step < 40; step++) {
    await ready(f); const before = store.writes.length + store.reads.length + modelRequests.length;
    const result = await runNextJob(f.session.tenantId, { media: store });
    assert.ok(store.writes.length + store.reads.length + modelRequests.length - before <= 1, "one external model or storage request per bounded worker invocation");
    if (result?.state === "completed") return await getCommission(f.session, f.commissionId);
    assert.equal(result?.state, "queued");
    const c = await getCommission(f.session, f.commissionId); assert.equal(c.packages.find(pkg => pkg.kind === "images")!.acceptedAt, null);
  }
  assert.fail("Fixture job did not finish within its expected finite steps");
}
async function verify(f: Fixture, c: Commission) {
  const pkg = c.packages.find(pkg => pkg.kind === "images")!, artifact = c.artifacts.find(artifact => artifact.id === pkg.artifactIds.at(-1))!;
  const queued = await executeCommand(f.session, c.id, { type: "verify_artifact", commandId: randomUUID(), expectedRevision: c.revision, packageId: pkg.id, artifactId: artifact.id });
  assert.ok(queued.ok && queued.jobId); return { ...f, jobId: queued.jobId };
}

test("source-bound vision, private files and independent byte checks complete without accepting the work", async () => {
  const f = await fresh({ sourceCount: 2 }), store = new MemoryPrivateStore(), requests = imageTransport();
  let c = await drive(f, store, requests), pkg = c.packages.find(pkg => pkg.kind === "images")!;
  const artifact = c.artifacts.find(artifact => artifact.id === pkg.artifactIds[0])!, content = artifact.content as unknown as ImageArtifact;
  assert.equal(content.images.length, 2); assert.equal(store.writes.length, 4); assert.equal(store.reads.length, 4);
  assert.equal(requests.filter(request => request.method === "POST").length, 2); assert.equal(content.humanFidelityReviewed, false);
  assert.equal(Object.values(content.languageReviews).filter(review => review.fluentReviewed).length, 0);
  assert.equal(pkg.state, "submitted"); assert.equal(pkg.paymentState, "not_eligible"); assert.equal(c.mandates[0]!.reservedMinor, 5000);
  const verification = await verify(f, c), reads = store.reads.length;
  c = await drive(verification, store, requests); pkg = c.packages.find(pkg => pkg.kind === "images")!;
  assert.equal(store.reads.length - reads, 4); assert.equal(pkg.state, "awaiting_acceptance");
  assert.ok(pkg.acceptancePack.criteria.filter(criterion => criterion.kind === "deterministic").every(criterion => criterion.status === "passed"));
  assert.equal(pkg.acceptancePack.criteria.find(criterion => criterion.id === "fidelity")!.status, "review");
  assert.equal(pkg.acceptedAt, null); assert.equal(c.payments.capturedMinor, 0); assert.equal(c.payments.providerPaidMinor, 0);
  const rows = (await getPool().query("SELECT artifact_hash,criteria_digest FROM guild_verifications WHERE commission_id=$1", [c.id])).rows;
  assert.equal(rows.length, 1); assert.equal(rows[0].artifact_hash, artifact.contentHash); assert.equal(rows[0].criteria_digest, digest(pkg.acceptancePack));
  const decisions = await getPool().query("SELECT count(*)::int AS count FROM guild_acceptance_decisions WHERE commission_id=$1", [c.id]); assert.equal(decisions.rows[0].count, 0);
});

test("a lost upload is adopted from its exact original bytes and cannot be overwritten with changed content", async () => {
  const f = await fresh(), store = new MemoryPrivateStore(), requests = imageTransport(); store.loseNextWrite = true;
  const c = await drive(f, store, requests), artifact = c.artifacts[0]!, content = artifact.content as unknown as ImageArtifact;
  assert.equal(store.writes.length, 2); assert.equal(new Set(store.writes).size, 2);
  const item = content.images[0]!, row = (await getPool().query("SELECT * FROM guild_media_objects WHERE id=$1", [item.full.mediaId])).rows[0];
  assert.equal(row.state, "ready"); assert.equal(row.error_code, null);
  const before = store.writes.length;
  await assert.rejects(storeMedia({ jobId: f.jobId!, tenantId: f.session.tenantId }, "images", row.operation_key, Buffer.from("different bytes"), "image/webp", row.metadata, store), code("MEDIA_OPERATION_CHANGED"));
  assert.equal(store.writes.length, before);
  const foreign = await createSession(), reads = store.reads.length;
  await assert.rejects(readOwnedMedia(foreign.session.tenantId, item.full.mediaId, store), code("MEDIA_NOT_FOUND"));
  assert.equal(store.reads.length, reads, "another tenant must not trigger a private object read");
  const file = await readOwnedMedia(f.session.tenantId, item.full.mediaId, store);
  const response = privateMediaResponse(file.row, file.bytes, new Request("https://fixture.invalid/api/media/id", { headers: { Range: "bytes=4-17" } }));
  assert.equal(response.status, 206); assert.equal(response.headers.get("cache-control"), "private, no-store"); assert.equal(response.headers.get("content-type"), "image/webp");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), file.bytes.subarray(4, 18));
  for (const range of ["bytes=-", "bytes=-0", "bytes=3-1", "bytes=99999999-", "bytes=0-2,4-6"]) assert.equal(privateMediaResponse(file.row, file.bytes, new Request("https://fixture.invalid", { headers: { Range: range } })).status, 416);
  const suffix = privateMediaResponse(file.row, file.bytes, new Request("https://fixture.invalid", { headers: { Range: "bytes=-10" } })); assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), file.bytes.subarray(-10));
});

test("changed private bytes fail independent verification and cannot earn acceptance", async () => {
  const f = await fresh(), store = new MemoryPrivateStore(), requests = imageTransport(); let c = await drive(f, store, requests);
  const content = c.artifacts[0]!.content as unknown as ImageArtifact, row = (await getPool().query("SELECT blob_pathname FROM guild_media_objects WHERE id=$1", [content.images[0]!.full.mediaId])).rows[0];
  const file = store.files.get(row.blob_pathname)!; file.bytes[40] = file.bytes[40]! ^ 255;
  const verification = await verify(f, c); c = await drive(verification, store, requests);
  const pkg = c.packages.find(pkg => pkg.kind === "images")!; assert.equal(pkg.state, "correction_requested");
  assert.equal(pkg.acceptancePack.criteria.find(criterion => criterion.id === "files")!.status, "failed");
  assert.match(pkg.acceptancePack.criteria.find(criterion => criterion.id === "files")!.evidence!, /MEDIA_CONTENT_MISMATCH/);
  await assert.rejects(executeCommand(f.session, c.id, { type: "accept_package", commandId: randomUUID(), expectedRevision: c.revision, packageId: pkg.id, artifactId: c.artifacts[0]!.id, contractVersion: pkg.contractVersion, acknowledgeReview: true }), code("VERIFICATION_REQUIRED"));
});

test("a verification restart preserves measured parts and re-reads only the remaining original file", async () => {
  const f = await fresh(), store = new MemoryPrivateStore(), requests = imageTransport(); const c = await drive(f, store, requests), verification = await verify(f, c);
  await ready(verification); const initialReads = store.reads.length; assert.equal((await runNextJob(f.session.tenantId, { media: store }))?.state, "queued");
  assert.equal(store.reads.length - initialReads, 1);
  await getPool().query("UPDATE guild_jobs SET state='running',lease_until=now()-interval '1 minute' WHERE id=$1", [verification.jobId]);
  const checked = await drive(verification, store, requests);
  assert.equal(store.reads.length - initialReads, 2); assert.equal(checked.packages.find(pkg => pkg.kind === "images")!.state, "awaiting_acceptance");
  assert.equal(requests.filter(request => request.method === "POST").length, 1); assert.equal(store.writes.length, 2);
});

test("temporary storage loss retains verification while a false production lineage fails without borrowing another job", async () => {
  const f = await fresh(), store = new MemoryPrivateStore(), requests = imageTransport(); let c = await drive(f, store, requests);
  const verification = await verify(f, c); store.unavailable = true;
  await ready(verification); assert.equal((await runNextJob(f.session.tenantId, { media: store }))?.state, "queued");
  c = await getCommission(f.session, c.id); assert.equal(c.packages.find(pkg => pkg.kind === "images")!.state, "verifying");
  store.unavailable = false; c = await drive(verification, store, requests);
  assert.equal(c.packages.find(pkg => pkg.kind === "images")!.state, "awaiting_acceptance");
  // A deliberately mutated fixture is never provider-output evidence.
  await transaction(async db => { const current = (await db.query("SELECT snapshot FROM guild_commissions WHERE id=$1 FOR UPDATE", [c.id])).rows[0].snapshot as Commission; const artifact = current.artifacts[0]!; artifact.provenance.sourceId = randomUUID(); await saveCommission(db, current); });
  c = await getCommission(f.session, c.id); const reads = store.reads.length, second = await verify(f, c); c = await drive(second, store, requests);
  assert.equal(store.reads.length, reads); assert.equal(c.packages.find(pkg => pkg.kind === "images")!.state, "correction_requested");
});

test("revoked approval stops the next image upload while retaining the completed description", async () => {
  const f = await fresh(), store = new MemoryPrivateStore(), requests = imageTransport();
  await ready(f); await runNextJob(f.session.tenantId, { media: store });
  await ready(f); await runNextJob(f.session.tenantId, { media: store });
  let c = await getCommission(f.session, f.commissionId);
  await executeCommand(f.session, c.id, { type: "revoke_mandate", commandId: randomUUID(), expectedRevision: c.revision, mandateId: "passport-design" });
  await ready(f); assert.equal((await runNextJob(f.session.tenantId, { media: store }))?.state, "needs_review");
  assert.equal(store.writes.length, 0); assert.equal(requests.filter(request => request.method === "POST").length, 1);
  c = await getCommission(f.session, c.id); assert.equal(c.artifacts.length, 0);
  const result = (await getPool().query("SELECT output,status FROM guild_model_runs WHERE job_id=$1", [f.jobId])).rows[0]; assert.equal(result.status, "completed"); assert.ok(result.output);
});

test("the measured pack amendment preserves original terms and requires a fresh full-plan approval", async () => {
  const f = await fresh({ legacy: true, queue: false }), before = await getCommission(f.session, f.commissionId), oldPackage = before.packages.find(pkg => pkg.kind === "images")!, proposal = imageAcceptancePack(before.sourceAssets);
  await assert.rejects(executeCommand(f.session, before.id, { type: "produce_package", commandId: randomUUID(), expectedRevision: before.revision, packageId: "images" }), code("IMAGE_CONTRACT_REQUIRED"));
  const command = { type: "amend_image_contract" as const, commandId: randomUUID(), expectedRevision: before.revision, packageId: "images", contractVersion: oldPackage.contractVersion, acceptancePackDigest: proposal.digest };
  assert.equal((await executeCommand(f.session, before.id, command)).ok, true);
  assert.equal((await executeCommand(f.session, before.id, command)).ok, true, "the same owner command returns its original decision");
  let c = await getCommission(f.session, before.id); const revised = c.packages.find(pkg => pkg.kind === "images")!;
  assert.equal(revised.contractVersion, 2); assert.equal(revised.acceptancePack.digest, proposal.digest); assert.equal(revised.grossMinor, oldPackage.grossMinor);
  assert.deepEqual(c.packages.filter(pkg => pkg.kind !== "images"), before.packages.filter(pkg => pkg.kind !== "images"));
  assert.equal(c.approvedPlanDigest, null); assert.equal(c.state, "awaiting_approval");
  await assert.rejects(executeCommand(f.session, c.id, { type: "produce_package", commandId: randomUUID(), expectedRevision: c.revision, packageId: "images" }), code("APPROVAL_REQUIRED"));
  const history = (await getPool().query("SELECT previous_contract,proposed_contract FROM guild_contract_amendments WHERE commission_id=$1", [c.id])).rows;
  assert.equal(history.length, 1); assert.deepEqual(history[0].previous_contract, oldPackage); assert.equal(history[0].proposed_contract.acceptancePack.digest, proposal.digest);
  await executeCommand(f.session, c.id, { type: "approve_plan", commandId: randomUUID(), expectedRevision: c.revision, planDigest: planDigest(c) });
  c = await getCommission(f.session, c.id); const queued = await executeCommand(f.session, c.id, { type: "produce_package", commandId: randomUUID(), expectedRevision: c.revision, packageId: "images" }); assert.ok(queued.ok && queued.jobId);
  c = await getCommission(f.session, c.id); assert.equal(c.mandates[0]!.reservedMinor, 5000);
});

test("an image amendment cannot invalidate running work or change an existing checkout agreement", async () => {
  for (const condition of ["running", "billing"] as const) {
    const f = await fresh({ legacy: true, queue: false }); let c = await getCommission(f.session, f.commissionId);
    if (condition === "running") { await executeCommand(f.session, c.id, { type: "produce_package", commandId: randomUUID(), expectedRevision: c.revision, packageId: "research" }); c = await getCommission(f.session, c.id); }
    else { const approval = (await getPool().query("SELECT id FROM guild_approval_receipts WHERE commission_id=$1 ORDER BY created_at DESC LIMIT 1", [c.id])).rows[0]; await getPool().query("INSERT INTO guild_payment_intents(id,tenant_id,commission_id,business_key,kind,approval_id,command,binding) VALUES($1,$2,$3,$4,'fixture_never_dispatched',$5,'{}','{}')", [randomUUID(), f.session.tenantId, c.id, `fixture:${randomUUID()}`, approval.id]); }
    await assert.rejects(executeCommand(f.session, c.id, { type: "amend_image_contract", commandId: randomUUID(), expectedRevision: c.revision, packageId: "images", contractVersion: 1, acceptancePackDigest: imageAcceptancePack(c.sourceAssets).digest }), code(condition === "running" ? "AMENDMENT_WORK_RUNNING" : "AMENDMENT_BILLING_STARTED"));
    const saved = await getCommission(f.session, c.id); assert.equal(saved.packages.find(pkg => pkg.kind === "images")!.contractVersion, 1); assert.equal(saved.approvedPlanDigest, c.approvedPlanDigest);
  }
});
