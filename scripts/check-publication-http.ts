import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { PublicationProposal, PublicationWorkspace } from "../src/domain/web-publication";
import { loadPublicationFixture } from "../tests/support/load-publication-fixture";
import { syntheticPublicationActor } from "../tests/support/web-publication-fixture";

const f = await loadPublicationFixture(process.argv[2] ?? "missing-fixture", "http"), origin = "http://localhost:4542";
const { getPool } = await import("../src/server/db"), pool = getPool();
const reportPath = resolve(dirname(f.fixturePath), `http-${new Date().toISOString().replaceAll(":", "-")}.json`);
const report: { version: string; startedAt: string; completedAt?: string; passed?: boolean; fixture: string; disclosure: string; checks: Record<string, unknown>[]; error?: string; before?: unknown; after?: unknown; serverTransport?: unknown } = {
  version: "guild.synthetic-publication-http.v1", startedAt: new Date().toISOString(), fixture: f.label, disclosure: f.disclosure, checks: [],
};
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
async function call(path: string, { cookie, body, method, headers = {}, status = 200, code }: { cookie?: string; body?: unknown; method?: string; headers?: Record<string, string>; status?: number | number[]; code?: string } = {}) {
  const response = await fetch(origin + path, { method: method ?? (body ? "POST" : "GET"), redirect: "manual", headers: { ...(cookie ? { cookie: `${f.cookieName}=${cookie}` } : {}), ...(body ? { origin, "content-type": "application/json" } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const bytes = Buffer.from(await response.arrayBuffer());
  const responseCode = response.status >= 400 && bytes.length > 0 && response.headers.get("content-type")?.includes("application/json") ? JSON.parse(bytes.toString("utf8")).code : null;
  report.checks.push({ path, method: method ?? (body ? "POST" : "GET"), status: response.status, code: responseCode, bytes: bytes.length, sha256: hash(bytes), cacheControl: response.headers.get("cache-control"), contentType: response.headers.get("content-type"), etag: response.headers.get("etag") });
  assert.ok((Array.isArray(status) ? status : [status]).includes(response.status), `${path} returned ${response.status}; expected ${status}: ${response.status >= 400 ? bytes.toString("utf8").slice(0, 300) : ""}`);
  if (code) assert.equal(responseCode, code);
  return { response, bytes, json: () => JSON.parse(bytes.toString("utf8")) };
}
const base = `/api/commissions/${f.commissionId}/publications`;
async function workspace(cookie = f.cookie): Promise<PublicationWorkspace> { return (await call(base, { cookie })).json(); }
async function counts() {
  return (await pool.query("SELECT (SELECT count(*) FROM guild_jobs WHERE tenant_id=$1) jobs,(SELECT count(*) FROM guild_model_runs WHERE tenant_id=$1) models,(SELECT count(*) FROM guild_speech_runs WHERE tenant_id=$1) speech,(SELECT count(*) FROM guild_transcription_runs WHERE tenant_id=$1) recognition,(SELECT count(*) FROM guild_web_audit_cases WHERE tenant_id=$1) audits,(SELECT count(*) FROM guild_acceptance_decisions WHERE tenant_id=$1) acceptances,(SELECT count(*) FROM guild_budget_reservations WHERE tenant_id=$1) reservations,(SELECT md5((snapshot->'payments')::text) FROM guild_commissions WHERE id=$2) payments,(SELECT revision FROM guild_commissions WHERE id=$2) commission_revision", [f.owner.tenantId, f.commissionId])).rows[0];
}
async function prepare(olderEditions: "keep" | "withdraw" = "keep") {
  const current = await workspace(), body = { commandId: randomUUID(), artifactId: f.artifactId, selectedOrdinal: f.selectedOrdinal, expectedRevision: current.revision, olderEditions, editionNote: "Synthetic real-HTTP publication qualification. No real human acceptance is represented." };
  const a = await call(base + "/prepare", { cookie: f.cookie, body }), b = await call(base + "/prepare", { cookie: f.cookie, body });
  assert.deepEqual(a.json(), b.json()); return a.json().proposal as PublicationProposal;
}
const publishInput = (proposal: PublicationProposal) => ({ commandId: randomUUID(), expectedRevision: proposal.expectedRevision, proposalId: proposal.id, proposalDigest: proposal.digest, acknowledgePublicFiles: true });
async function publish(proposal: PublicationProposal) {
  const body = publishInput(proposal), [a, b] = await Promise.all([call(base + "/publish", { cookie: f.cookie, body }), call(base + "/publish", { cookie: f.cookie, body })]);
  assert.deepEqual(a.json(), b.json()); return a.json() as { editionId: string; version: number; revision: number; publicUrl: string };
}
try {
  report.before = await counts();
  await call(base, { status: 401, code: "SESSION_REQUIRED" });
  const anonymous = await call(`/commissions/${f.commissionId}/publication`); assert.ok(!anonymous.bytes.includes(Buffer.from(f.artifactId))); assert.match(anonymous.bytes.toString(), /active owner or judge workspace/);
  const page = await call(`/commissions/${f.commissionId}/publication`, { cookie: f.cookie });
  assert.match(page.bytes.toString(), /Open the doors/); assert.match(page.bytes.toString(), /Synthetic test workspace/); assert.ok(page.bytes.includes(Buffer.from(f.disclosure)));
  const operator = await syntheticPublicationActor(f.owner.tenantId, "operator"), provider = await syntheticPublicationActor(f.owner.tenantId, "provider"), otherOwner = await syntheticPublicationActor(f.owner.tenantId), revoked = await syntheticPublicationActor(f.owner.tenantId), expired = await syntheticPublicationActor(f.owner.tenantId);
  const otherTenant = randomUUID(); await pool.query("INSERT INTO guild_tenants(id,expires_at,mode) VALUES($1,now()+interval '1 hour','judge')", [otherTenant]);
  const foreign = await syntheticPublicationActor(otherTenant);
  assert.equal((await workspace(operator.cookie)).canPublish, false);
  await call(base, { cookie: provider.cookie, status: 403, code: "PUBLICATION_ROLE_REQUIRED" }); await call(base, { cookie: foreign.cookie, status: 404, code: "COMMISSION_NOT_FOUND" });
  await pool.query("UPDATE guild_sessions SET revoked_at=now() WHERE id=$1", [revoked.session.id]); await pool.query("UPDATE guild_sessions SET expires_at=now()-interval '1 second' WHERE id=$1", [expired.session.id]);
  for (const cookie of [revoked.cookie, expired.cookie]) await call(base, { cookie, status: 401, code: "SESSION_REQUIRED" });
  const input = { commandId: randomUUID(), expectedRevision: (await workspace()).revision, artifactId: f.artifactId, selectedOrdinal: f.selectedOrdinal, olderEditions: "keep" };
  await call(base + "/prepare", { cookie: f.cookie, body: input, headers: { origin: "https://unrelated.invalid" }, status: 403, code: "ORIGIN_MISMATCH" });
  await call(base + "/prepare", { cookie: f.cookie, body: input, headers: { "sec-fetch-site": "cross-site" }, status: 403, code: "CROSS_SITE_COMMAND" });
  for (const cookie of [operator.cookie, provider.cookie]) await call(base + "/prepare", { cookie, body: input, status: 403, code: "PUBLICATION_ROLE_REQUIRED" });
  await call(base + "/prepare", { cookie: foreign.cookie, body: input, status: 404, code: "COMMISSION_NOT_FOUND" });
  await call(base + "/prepare", { cookie: f.cookie, body: { ...input, tenantId: f.owner.tenantId }, status: 400 });
  const proposal = await prepare(); assert.equal(proposal.binding.accepted.length, 6); assert.equal(proposal.binding.independent.cases.length, 18);
  for (const source of proposal.binding.accepted) { assert.equal(source.decision.disclosures.syntheticFixture, true); assert.equal(source.decision.disclosure, f.disclosure); }
  await call(base + "/publish", { cookie: f.cookie, body: { ...publishInput(proposal), acknowledgePublicFiles: false }, status: 400 });
  await call(base + "/publish", { cookie: otherOwner.cookie, body: publishInput(proposal), status: 409 });
  const first = await publish(proposal), publicBase = first.publicUrl.slice(0, -"index.html".length), edition = (await workspace()).editions.find(item => item.id === first.editionId)!;
  const firstRoot = await call(publicBase.slice(0, -1), { status: 307 }); assert.equal(firstRoot.response.headers.get("location"), first.publicUrl);
  for (const locale of ["en", "pt", "es", "fr", "ja", "ar"]) {
    const html = await call(first.publicUrl + `?lang=${locale}`); assert.equal(hash(html.bytes), proposal.binding.bundle.files.find(file => file.path === "index.html")!.contentHash);
    assert.match(html.response.headers.get("content-security-policy")!, /default-src 'none'/); assert.match(html.response.headers.get("content-security-policy")!, /script-src 'sha256-/);
    assert.ok(!html.response.headers.get("content-security-policy")!.includes("unsafe-inline")); assert.equal(html.response.headers.get("x-frame-options"), "DENY"); assert.equal(html.response.headers.get("referrer-policy"), "no-referrer");
  }
  // Every file is fetched over actual HTTP through the production original-byte
  // route. Six simultaneous responses exercise the real six-client DB pool.
  const files = [...proposal.binding.bundle.files];
  for (let offset = 0; offset < files.length; offset += 6) await Promise.all(files.slice(offset, offset + 6).map(async file => {
    const result = await call(publicBase + file.path); assert.equal(result.bytes.length, file.byteLength); assert.equal(hash(result.bytes), file.contentHash);
    assert.equal(result.response.headers.get("content-type")!.split(";")[0], file.mediaType); assert.equal(result.response.headers.get("x-content-type-options"), "nosniff"); assert.match(result.response.headers.get("cache-control")!, /no-store/);
    assert.equal(result.response.headers.get("cdn-cache-control"), "no-store");
  }));
  const audio = files.find(file => file.mediaType === "audio/mpeg")!, full = await call(publicBase + audio.path);
  const head = await call(publicBase + audio.path, { method: "HEAD" }); assert.equal(head.bytes.length, 0); assert.equal(head.response.headers.get("etag"), `"sha256-${audio.contentHash}"`);
  // Next 16.4.6's send-response adapter strips Content-Length from Route Handler
  // responses. The header is optional for HEAD; a present value must be exact.
  assert.ok(head.response.headers.get("content-length") === null || head.response.headers.get("content-length") === String(audio.byteLength));
  report.checks.push({ observation: "HEAD metadata", contentLength: head.response.headers.get("content-length"), exactManifestByteLength: audio.byteLength, responseBodyBytes: head.bytes.length, adapter: "next@16.4.6 send-response strips framing headers" });
  const headRange = await call(publicBase + audio.path, { method: "HEAD", headers: { range: "bytes=12-43" } }); assert.equal(headRange.bytes.length, 0); assert.equal(headRange.response.headers.get("content-range"), null); assert.equal(headRange.response.headers.get("etag"), head.response.headers.get("etag"));
  const unknownRange = await call(publicBase + audio.path, { headers: { range: "items=12-43" } }); assert.deepEqual(unknownRange.bytes, full.bytes);
  const partial = await call(publicBase + audio.path, { headers: { range: "bytes=12-43" }, status: 206 }); assert.deepEqual(partial.bytes, full.bytes.subarray(12, 44)); assert.equal(partial.response.headers.get("content-range"), `bytes 12-43/${audio.byteLength}`);
  const suffix = await call(publicBase + audio.path, { headers: { range: "bytes=-32" }, status: 206 }); assert.deepEqual(suffix.bytes, full.bytes.subarray(-32));
  await call(publicBase + audio.path, { headers: { range: `bytes=${audio.byteLength}-` }, status: 416 });
  await call(publicBase + audio.path, { headers: { range: "bytes=0-2,6-8" }, status: 416 });
  await call(publicBase + audio.path, { headers: { "if-none-match": `"older", W/${head.response.headers.get("etag")}` }, status: 304 });
  await call(publicBase + audio.path, { headers: { "if-match": '"wrong"' }, status: 412 });
  const ifRange = await call(publicBase + audio.path, { headers: { range: "bytes=0-31", "if-range": '"old"' } }); assert.deepEqual(ifRange.bytes, full.bytes);
  const manifest = await call(publicBase + "bundle-manifest.json"); assert.equal(hash(manifest.bytes), proposal.binding.portable.manifestHash);
  const archive = await call(publicBase + "exhibition.zip"); assert.equal(hash(archive.bytes), proposal.binding.portable.zipHash); assert.equal(archive.bytes.length, proposal.binding.portable.zipByteLength);
  const receipt = await call(`${base}/${first.editionId}/evidence`, { cookie: f.cookie }); assert.equal(receipt.json().proposal.digest, proposal.digest);
  for (const path of [".env", "private.json", "draft-2/index.html", "assets/audio/unrelated.mp3", "%252e%252e/source-record.json", "assets%2faudio%2funrelated.mp3"])
    await call(publicBase + path, { status: [400, 404] });
  for (const query of ["?artifactId=" + f.artifactId, "?tenantId=" + f.owner.tenantId, "?candidate=2", "?lang=ar&lang=en", "?lang=xx"])
    await call(first.publicUrl + query, { status: 404 });
  const second = await publish(await prepare("keep")); assert.notEqual(second.publicUrl, first.publicUrl);
  const earlier = await call(first.publicUrl); assert.equal(hash(earlier.bytes), files.find(file => file.path === "index.html")!.contentHash);
  const current = await workspace(), withdrawal = { commandId: randomUUID(), editionId: first.editionId, expectedRevision: current.revision, reason: "Synthetic HTTP withdrawal check; fictional curator identity only.", acknowledgeCopiesRemain: true };
  await call(base + "/withdraw", { cookie: operator.cookie, body: withdrawal, status: 403 });
  const [closedA, closedB] = await Promise.all([call(base + "/withdraw", { cookie: f.cookie, body: withdrawal }), call(base + "/withdraw", { cookie: f.cookie, body: withdrawal })]); assert.deepEqual(closedA.json(), closedB.json());
  for (const path of ["index.html", audio.path, "bundle-manifest.json", "exhibition.zip"]) {
    const closed = await call(publicBase + path, { status: 410, headers: { "if-none-match": head.response.headers.get("etag")!, range: "bytes=0-31" } }); assert.match(closed.response.headers.get("cache-control")!, /no-store/);
  }
  const closedHead = await call(publicBase + audio.path, { method: "HEAD", status: 410 }); assert.equal(closedHead.bytes.length, 0);
  const closedPage = await call(first.publicUrl, { status: 410 }); assert.match(closedPage.bytes.toString(), /Previously downloaded copies cannot be recalled/);
  assert.equal((await workspace()).editions.find(item => item.id === first.editionId)!.state, "withdrawn");
  await call(`${base}/${first.editionId}/evidence`, { cookie: f.cookie }); await call(second.publicUrl);
  const third = await publish(await prepare("withdraw")); assert.notEqual(third.publicUrl, first.publicUrl); assert.notEqual(third.publicUrl, second.publicUrl);
  await call(second.publicUrl, { status: 410 }); await call(first.publicUrl, { status: 410 }); await call(third.publicUrl);
  const privateOriginal = await call(`/api/artifacts/${f.artifactId}/exhibition/${f.selectedOrdinal}/index.html?lang=en`, { cookie: f.cookie });
  assert.equal(hash(privateOriginal.bytes), files.find(file => file.path === "index.html")!.contentHash);
  report.after = await counts(); assert.deepEqual(report.after, report.before);
  const transport = (await readFile(resolve(dirname(f.fixturePath), "server-transport.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const denied = transport.filter(item => item.event === "network_denied"); assert.equal(denied.length, 0, "Publication attempted no real provider or network transport.");
  report.serverTransport = { realNetworkAllowed: false, originalSyntheticBlobReads: transport.filter(item => item.event === "original_synthetic_blob_read").length, deniedRequests: denied.length };
  report.passed = true;
} catch (error) { report.passed = false; report.error = error instanceof Error ? error.message : String(error); throw error; }
finally {
  report.completedAt = new Date().toISOString(); await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ reportPath, passed: report.passed, requests: report.checks.filter(item => typeof item.path === "string").length, observations: report.checks.length, disclosure: f.disclosure })); await pool.end();
}
