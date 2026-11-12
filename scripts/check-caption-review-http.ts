/** Real production-route review concurrency on the separate synthetic HTTP
 * schema. A single uncertain draft is appended; no listening statement is made. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { digest } from "../src/domain/primitives";
import { webArtifactSchema } from "../src/domain/web-audits";
import { captionReviewCommandSchema, type CaptionReviewRevision } from "../src/domain/caption-review";
import { loadComposedCaptionFixture } from "../tests/support/load-composed-caption-fixture";
import { composedCaptionFixtureSnapshot } from "../tests/support/composed-caption-snapshot";

const f = await loadComposedCaptionFixture(process.argv[2] ?? "missing-independent-http-fixture", "http"), origin = "http://localhost:4554";
const { getPool } = await import("../src/server/db"), pool = getPool(), { getCommission } = await import("../src/server/commissions"), { buildWebSources } = await import("../src/server/web/sources");
const target = resolve(dirname(f.fixturePath), `caption-review-http-${new Date().toISOString().replaceAll(":", "-")}.json`);
const endpoint = `/api/artifacts/${f.captionReview.originalArtifactId}/caption-review`, query = "?locale=en&key=welcome";
const report: { version: string; fixture: string; disclosure: string; checks: Record<string, unknown>[]; requests: Record<string, unknown>[]; passed: boolean; before?: unknown; after?: unknown; error?: string } = {
  version: "guild.caption-review-real-http-concurrency.v1", fixture: f.label, disclosure: f.disclosure, checks: [], requests: [], passed: false,
};
async function call(path: string, options: { cookie?: string; body?: unknown; status: number; code?: string; origin?: string }) {
  const response = await fetch(origin + path, { method: options.body ? "POST" : "GET", redirect: "manual", headers: {
    ...(options.cookie ? { cookie: `${f.cookieName}=${options.cookie}` } : {}), ...(options.body ? { origin: options.origin ?? origin, "content-type": "application/json" } : {}),
  }, ...(options.body ? { body: JSON.stringify(options.body) } : {}) });
  const value = await response.json(); report.requests.push({ path, method: options.body ? "POST" : "GET", status: response.status, code: value.code ?? null,
    ...(options.body && typeof options.body === "object" && "requestId" in options.body ? { requestId: options.body.requestId, requestBody: options.body, responseBody: value } : {}) });
  assert.equal(response.status, options.status, JSON.stringify({ code: value.code, message: value.message })); if (options.code) assert.equal(value.code, options.code);
  if (response.status === 200) assert.match(response.headers.get("cache-control") ?? "", /no-store/); return value;
}
const check = (name: string, details: Record<string, unknown> = {}) => { report.checks.push({ name, passed: true, ...details }); console.log(JSON.stringify({ check: name, passed: true })); };
try {
  const c = await getCommission(f.owner, f.commissionId), web = c.packages.find(item => item.kind === "web")!, artifact = c.artifacts.find(item => item.id === f.artifactId)!, content = webArtifactSchema.parse(artifact.content);
  const baseline = await composedCaptionFixtureSnapshot(); report.before = baseline;
  const declarationCount = Number((await pool.query("SELECT count(*) FROM guild_caption_review_revisions WHERE tenant_id=$1 AND revision->'attestation'<>'null'::jsonb", [f.owner.tenantId])).rows[0].count);
  assert.equal(declarationCount, 78);
  const workspace = await call(endpoint + query, { cookie: f.cookie, status: 200 }), parent = workspace.latestRevision as CaptionReviewRevision; assert.ok(parent);
  const draft = structuredClone(parent.draft); draft.disposition = "uncertain";
  draft.note = "SYNTHETIC six-way real-HTTP draft race. No person listened; no declaration or acceptance. The accepted submitted revision stays unchanged.";
  draft.units[0] = { ...draft.units[0]!, heard: "uncertain", startMs: null, endMs: null, origin: "unassigned", providerWordIndex: null };
  const commands = Array.from({ length: 6 }, () => captionReviewCommandSchema.parse({ action: "save", requestId: randomUUID(), parentRevisionId: parent.id, locale: "en", key: "welcome", artifactHash: f.captionReview.originalArtifactHash, draft }));
  const outcomes = await Promise.all(commands.map(async body => {
    const response = await fetch(origin + endpoint, { method: "POST", headers: { origin, "content-type": "application/json", cookie: `${f.cookieName}=${f.cookie}` }, body: JSON.stringify(body) });
    const value = await response.json(); report.requests.push({ path: endpoint, method: "POST", requestId: body.requestId, requestBody: body, responseBody: value, status: response.status, code: value.code ?? null });
    if (response.status === 200) assert.match(response.headers.get("cache-control") ?? "", /no-store/); return { body, status: response.status, value };
  }));
  const success = outcomes.filter(item => item.status === 200); assert.equal(success.length, 1);
  for (const refused of outcomes.filter(item => item.status !== 200)) { assert.equal(refused.status, 409); assert.equal(refused.value.code, "CAPTION_REVIEW_CONFLICT"); }
  const winner = success[0]!, revision = winner.value.revision as CaptionReviewRevision;
  assert.equal(revision.parentRevisionId, parent.id); assert.equal(revision.attestation, null); assert.equal(revision.evaluation.status, "incomplete"); assert.equal(revision.evaluation.cues.length, 0); assert.equal(revision.evaluation.vtt, null);
  check("six simultaneous real route requests save one uncertain draft and preserve five stale409 responses", { successfulDrafts: 1, stale409: 5, newListeningDeclarations: 0, requestIds: commands.map(item => item.requestId) });
  assert.deepEqual(await call(endpoint, { cookie: f.cookie, body: winner.body, status: 200 }), winner.value);
  await call(endpoint, { cookie: f.cookie, body: { ...winner.body, draft: { ...draft, note: "SYNTHETIC changed payload reusing a retained save identity must be refused." } }, status: 422, code: "CAPTION_REVIEW_REQUEST_CHANGED" });
  await call(endpoint, { cookie: f.cookie, body: { ...winner.body, requestId: randomUUID(), artifactHash: "0".repeat(64) }, status: 422, code: "CAPTION_REVIEW_ARTIFACT_CHANGED" });
  check("an unknown-outcome retry returns the exact retained revision while a changed payload or artifact cannot reuse its identity");
  const actors = JSON.parse(await readFile(resolve(dirname(f.fixturePath), "qa-actors.json"), "utf8"));
  await call(endpoint, { body: { ...winner.body, requestId: randomUUID() }, status: 401, code: "SESSION_REQUIRED" });
  await call(endpoint, { cookie: f.cookie, body: { ...winner.body, requestId: randomUUID() }, origin: "https://unrelated.invalid", status: 403, code: "ORIGIN_MISMATCH" });
  await call(endpoint, { cookie: actors.actors.provider.cookie, body: { ...winner.body, requestId: randomUUID() }, status: 422, code: "CAPTION_ACTOR_REQUIRED" });
  await call(endpoint, { cookie: actors.actors.foreign.cookie, body: { ...winner.body, requestId: randomUUID() }, status: 422, code: "CAPTION_REVIEW_ARTIFACT" });
  const unattestable = { action: "attest", requestId: randomUUID(), parentRevisionId: revision.id, locale: "en", key: "welcome", artifactHash: f.captionReview.originalArtifactHash,
    reviewerName: "SYNTHETIC forbidden declaration — no person listened", completeRecordingListened: true, completeSourceHeard: true, everyTimingChecked: true, acknowledgeNotFluentReview: true };
  // Deliberately refused synthetic negative requests. Neither creates a statement.
  for (const cookie of [f.cookie, actors.actors.operator.cookie]) await call(endpoint, { cookie, body: { ...unattestable, requestId: randomUUID() }, status: 422, code: "CAPTION_REVIEW_ATTESTATION" });
  check("the real route preserves origin/tenant/provider boundaries and refuses uncertain or operator listening declarations", { newListeningDeclarations: 0 });
  const current = await call(endpoint + query, { cookie: f.cookie, status: 200 }); assert.equal(current.latestRevision.id, revision.id); assert.equal(current.latestRevision.evaluation.cues.length, 0);
  const exported = await call(endpoint + query + `&revisionId=${revision.id}&download=json`, { cookie: f.cookie, status: 200 }); assert.deepEqual(exported.revision, revision);
  await call(endpoint + query + `&revisionId=${revision.id}&download=vtt`, { cookie: f.cookie, status: 422, code: "CAPTION_REVIEW_INCOMPLETE" });
  const after = await composedCaptionFixtureSnapshot(); report.after = after;
  const changed = after.tables.filter(row => baseline.tables.find(item => item.table === row.table)?.sha256 !== row.sha256).map(row => row.table).sort();
  assert.deepEqual(changed, ["guild_caption_review_revisions", "guild_commissions", "guild_events", "guild_rate_limits"]);
  const final = await getCommission(f.owner, f.commissionId), finalWeb = final.packages.find(item => item.kind === "web")!;
  assert.equal(digest(await buildWebSources(pool, final, finalWeb, content.sources)), content.sourceDigest);
  assert.equal(digest(final.artifacts), digest(c.artifacts)); assert.equal(digest(final.payments), digest(c.payments)); assert.equal(digest(final.packages), digest(c.packages));
  assert.equal((final.packages.find(item => item.kind === "captions")!.acceptancePack.parameters!.authorityCeiling as { expiresAt: string }).expiresAt, f.captionReview.authorityExpiresAt);
  assert.equal(Number((await pool.query("SELECT count(*) FROM guild_caption_review_revisions WHERE tenant_id=$1 AND revision->'attestation'<>'null'::jsonb", [f.owner.tenantId])).rows[0].count), declarationCount);
  check("the later HTTP draft cannot rewrite accepted source/VTT/capability, original evidence, package acceptance/payment or deadlines", { changedTables: changed, unchangedTables: after.tables.length - changed.length, originalFictionalStatements: declarationCount });
  report.passed = true;
} catch (error) { report.error = error instanceof Error ? error.stack : String(error); throw error; }
finally {
  await writeFile(target, JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ reportPath: target, passed: report.passed, checks: report.checks.length, requests: report.requests.length, providerCalls: 0, newListeningDeclarations: 0 })); await pool.end();
}
