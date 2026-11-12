import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { digest, DomainError } from "@/domain/primitives";
import type { Commission } from "@/contracts/guild";
import type { PublicationProposal } from "@/domain/web-publication";
import type { Session } from "@/server/session";
import type { PrivateBlobGateway } from "@/server/media/blob-store";
import { isolatedPostgres } from "../support/postgres";
import { loadPublicationFixture } from "../support/load-publication-fixture";

const retained = process.env.GUILD_PUBLICATION_TEST_FIXTURE;
const cleanup = retained ? null : await isolatedPostgres("guild_publication_test");
const { publicationFixture, syntheticPublicationActor, syntheticPublicationDisclosure } = await import("../support/web-publication-fixture");
const f = retained ? await loadPublicationFixture(retained, "http") : await publicationFixture("contract");
const { getPool } = await import("@/server/db");
const { prepareExhibitionPublication, publishExhibition, withdrawExhibition, publicationWorkspace, publicationEditionReceipt, publicationSha } = await import("@/server/web/publications");
const { publicExhibitionResponse } = await import("@/server/web/publication-http");
const { webExportBundle } = await import("@/server/web/exports");
const pool = getPool(), actor = f.owner, originalSession = "originalSession" in f ? f.originalSession : f.session;
const originalFetch = globalThis.fetch; let externalRequests = 0;
globalThis.fetch = async () => { externalRequests++; throw Error("No external transport is available in publication contract tests."); };
after(async () => { globalThis.fetch = originalFetch; if (cleanup) await cleanup(); else await pool.end(); });
const workspace = () => publicationWorkspace(actor, f.commissionId);
const prepareInput = (revision: number, olderEditions: "keep" | "withdraw" = "keep") => ({ commandId: randomUUID(), expectedRevision: revision, artifactId: f.artifactId, selectedOrdinal: f.selectedOrdinal, olderEditions, editionNote: "Synthetic publication contract test; fictional acceptance only." });
async function prepare(older: "keep" | "withdraw" = "keep") {
  const current = await workspace(), result = await prepareExhibitionPublication(actor, f.commissionId, prepareInput(current.revision, older), f.media);
  assert.equal(result.kind, "prepared"); return result.proposal;
}
const publishInput = (proposal: PublicationProposal) => ({ commandId: randomUUID(), expectedRevision: proposal.expectedRevision, proposalId: proposal.id, proposalDigest: proposal.digest, acknowledgePublicFiles: true });
async function publish(proposal: PublicationProposal) {
  const result = await publishExhibition(actor, f.commissionId, publishInput(proposal), f.media); assert.equal(result.kind, "published"); return result;
}
const withdrawInput = (editionId: string, revision: number) => ({ commandId: randomUUID(), editionId, expectedRevision: revision, reason: "Synthetic curator withdrawal; no real person reviewed this fixture.", acknowledgeCopiesRemain: true });
const read = (id: string, path = "index.html", headers: Record<string, string> = {}, method = "GET", media: PrivateBlobGateway = f.media) => publicExhibitionResponse(id, path.split("/"), new Request(`http://localhost/published/${id}/${path}`, { headers, method }), media);
const denied = (code?: string, status = 422) => (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.status, status); if (code) assert.equal(error.code, code); return true; };
async function effects() {
  const values = await pool.query("SELECT (SELECT count(*) FROM guild_jobs WHERE tenant_id=$1) jobs,(SELECT count(*) FROM guild_model_runs WHERE tenant_id=$1) models,(SELECT count(*) FROM guild_speech_runs WHERE tenant_id=$1) speech,(SELECT count(*) FROM guild_transcription_runs WHERE tenant_id=$1) recognition,(SELECT count(*) FROM guild_web_audit_cases WHERE tenant_id=$1) audits,(SELECT count(*) FROM guild_acceptance_decisions WHERE tenant_id=$1) acceptances,(SELECT count(*) FROM guild_budget_reservations WHERE tenant_id=$1) reservations", [actor.tenantId]);
  const snapshot = (await pool.query<{ snapshot: Commission }>("SELECT snapshot FROM guild_commissions WHERE id=$1 AND tenant_id=$2", [f.commissionId, actor.tenantId])).rows[0]!.snapshot;
  return { ...values.rows[0], payments: digest(snapshot.payments), mandates: digest(snapshot.mandates), revision: snapshot.revision, mediaPuts: f.media.puts };
}

test("accepted exhibition publication preserves original work, explicit authority, concurrent decisions and withdrawn public links", { timeout: 600_000 }, async t => {
  const before = await effects(), initial = await workspace(), startRevision = initial.revision; let firstProposal!: PublicationProposal;
  let first!: Awaited<ReturnType<typeof publish>>, second!: Awaited<ReturnType<typeof publish>>;
  await t.test("one transaction client validates the full original ancestry, six decisions, reports and every byte", async () => {
    // A single available client catches accidental nested global-pool reads in
    // the complete validation path, not only in a lightweight route mock.
    pool.options.max = 1;
    try { firstProposal = await prepare(); } finally { pool.options.max = 6; }
    assert.deepEqual(firstProposal.binding.accepted.map(item => item.kind), ["research", "translation", "narration", "images", "captions", "web"]);
    assert.equal(firstProposal.binding.bundle.files.length, 192); assert.equal(firstProposal.binding.independent.cases.length, 18);
    assert.equal(firstProposal.binding.accepted.every(item => item.decision.humanReviewed && !item.decision.fluentReviewed && item.decision.disclosures.syntheticFixture === true), true);
    assert.equal((await workspace()).fixtureDisclosure, syntheticPublicationDisclosure);
    assert.equal((await workspace()).editions.length, initial.editions.length); assert.equal(firstProposal.expectedRevision, startRevision);
  });
  assert.ok(firstProposal, "Admission must pass before testing later mutations.");
  const source = firstProposal.binding.accepted.find(item => item.kind === "translation")!;

  await t.test("operators inspect only; providers, foreign tenants, revoked and expired identities cannot mutate", async () => {
    const operator = await syntheticPublicationActor(actor.tenantId, "operator"), provider = await syntheticPublicationActor(actor.tenantId, "provider"), expired = await syntheticPublicationActor(actor.tenantId), revoked = await syntheticPublicationActor(actor.tenantId);
    assert.equal((await publicationWorkspace(operator.session, f.commissionId)).canPublish, false);
    for (const session of [operator.session, provider.session]) {
      await assert.rejects(prepareExhibitionPublication(session, f.commissionId, prepareInput(startRevision), f.media), denied("PUBLICATION_ROLE_REQUIRED", 403));
      await assert.rejects(publishExhibition(session, f.commissionId, publishInput(firstProposal), f.media), denied("PUBLICATION_ROLE_REQUIRED", 403));
      await assert.rejects(withdrawExhibition(session, f.commissionId, withdrawInput(randomUUID(), 0)), denied("PUBLICATION_ROLE_REQUIRED", 403));
    }
    await assert.rejects(publicationWorkspace(provider.session, f.commissionId), denied("PUBLICATION_ROLE_REQUIRED", 403));
    await pool.query("UPDATE guild_sessions SET expires_at=now()-interval '1 second' WHERE id=$1", [expired.session.id]);
    await pool.query("UPDATE guild_sessions SET revoked_at=now() WHERE id=$1", [revoked.session.id]);
    for (const session of [expired.session, revoked.session]) await assert.rejects(prepareExhibitionPublication(session, f.commissionId, prepareInput(startRevision), f.media), denied("PUBLICATION_ACTOR_INACTIVE", 401));
    const tenant = randomUUID(); await pool.query("INSERT INTO guild_tenants(id,expires_at,mode) VALUES($1,now()+interval '1 hour','judge')", [tenant]);
    const foreign = await syntheticPublicationActor(tenant);
    await assert.rejects(prepareExhibitionPublication(foreign.session, f.commissionId, prepareInput(startRevision), f.media), denied("COMMISSION_NOT_FOUND", 404));
    await assert.rejects(publicationWorkspace(foreign.session, f.commissionId), denied("COMMISSION_NOT_FOUND", 404));
    await assert.rejects(prepareExhibitionPublication({ ...actor, role: "judge" } as Session, f.commissionId, prepareInput(startRevision), f.media), denied("PUBLICATION_ACTOR_INACTIVE", 401));
  });

  await t.test("missing, changed, automated or unsupported fluent acceptance is refused for exact source identities", async () => {
    const original = (await pool.query("SELECT * FROM guild_acceptance_decisions WHERE id=$1 AND tenant_id=$2", [source.decision.id, actor.tenantId])).rows[0]!;
    for (const [name, change, code] of [
      ["missing", { decision: "rejected" }, "PUBLICATION_ACCEPTANCE_REQUIRED"],
      ["changed artifact hash", { artifact_hash: "0".repeat(64) }, "PUBLICATION_ACCEPTANCE_REQUIRED"],
      ["changed criteria", { criteria_digest: "0".repeat(64) }, "PUBLICATION_ACCEPTANCE_REQUIRED"],
      ["human review absent", { review_disclosures: { ...original.review_disclosures, humanReviewed: false } }, "PUBLICATION_HUMAN_ACCEPTANCE"],
      ["human review missing", { review_disclosures: { ...original.review_disclosures, humanReviewed: undefined } }, "PUBLICATION_HUMAN_ACCEPTANCE"],
      ["operator acknowledgment", { review_disclosures: { ...original.review_disclosures, actorKind: "operator" } }, "PUBLICATION_HUMAN_ACCEPTANCE"],
      ["invented fluent review", { review_disclosures: { ...original.review_disclosures, fluentReviewed: true } }, "PUBLICATION_REVIEW_DISCLOSURE"],
      ["missing fluent disclosure", { review_disclosures: { ...original.review_disclosures, fluentReviewed: undefined } }, "PUBLICATION_REVIEW_DISCLOSURE"],
      ["missing language acknowledgment", { review_disclosures: { ...original.review_disclosures, languages: { ...original.review_disclosures.languages, ar: { ...original.review_disclosures.languages.ar, curatorAcknowledged: false } } } }, "PUBLICATION_LANGUAGE_DISCLOSURE"],
    ] as const) {
      const mutated = { ...original, ...change };
      try {
        await pool.query("UPDATE guild_acceptance_decisions SET decision=$2,artifact_hash=$3,criteria_digest=$4,review_disclosures=$5 WHERE id=$1", [original.id, mutated.decision, mutated.artifact_hash, mutated.criteria_digest, mutated.review_disclosures]);
        await assert.rejects(prepareExhibitionPublication(actor, f.commissionId, prepareInput(startRevision), f.media), denied(code), name);
      } finally { await pool.query("UPDATE guild_acceptance_decisions SET decision=$2,artifact_hash=$3,criteria_digest=$4,review_disclosures=$5 WHERE id=$1", [original.id, original.decision, original.artifact_hash, original.criteria_digest, original.review_disclosures]); }
    }
    await assert.rejects(prepareExhibitionPublication(actor, f.commissionId, { ...prepareInput(startRevision), artifactId: source.artifactId }, f.media), denied());
    await assert.rejects(prepareExhibitionPublication(actor, f.commissionId, { ...prepareInput(startRevision), selectedOrdinal: f.selectedOrdinal === 1 ? 2 : 1 }, f.media), (error: unknown) => error instanceof DomainError && [404, 422].includes(error.status));
  });

  await t.test("altered producing command, independent report, raw audit evidence and authored bytes fail without dispatch", async () => {
    const producing = (await pool.query("SELECT command_id,payload_hash FROM guild_commands WHERE tenant_id=$1 AND result->>'jobId'=$2", [actor.tenantId, source.production.jobId])).rows[0]!;
    try {
      await pool.query("UPDATE guild_commands SET payload_hash=$3 WHERE tenant_id=$1 AND command_id=$2", [actor.tenantId, producing.command_id, "0".repeat(64)]);
      await assert.rejects(prepareExhibitionPublication(actor, f.commissionId, prepareInput(startRevision), f.media), denied());
    } finally { await pool.query("UPDATE guild_commands SET payload_hash=$3 WHERE tenant_id=$1 AND command_id=$2", [actor.tenantId, producing.command_id, producing.payload_hash]); }
    const verification = (await pool.query("SELECT result FROM guild_verifications WHERE id=$1", [source.verification.id])).rows[0]!.result;
    try {
      const changed = structuredClone(verification); changed.criteria[0].status = "failed";
      await pool.query("UPDATE guild_verifications SET result=$2 WHERE id=$1", [source.verification.id, changed]);
      await assert.rejects(prepareExhibitionPublication(actor, f.commissionId, prepareInput(startRevision), f.media), denied());
    } finally { await pool.query("UPDATE guild_verifications SET result=$2 WHERE id=$1", [source.verification.id, verification]); }
    const jobId = firstProposal.binding.independent.jobId, output = (await pool.query("SELECT output FROM guild_jobs WHERE id=$1", [jobId])).rows[0]!.output;
    try {
      const changed = structuredClone(output); changed.report.files.pop();
      await pool.query("UPDATE guild_jobs SET output=$2 WHERE id=$1", [jobId, changed]);
      await assert.rejects(prepareExhibitionPublication(actor, f.commissionId, prepareInput(startRevision), f.media), denied("PUBLICATION_WEB_REPORT"));
    } finally { await pool.query("UPDATE guild_jobs SET output=$2 WHERE id=$1", [jobId, output]); }
    const caseId = firstProposal.binding.independent.cases[0]!.id, audit = (await pool.query("SELECT path,bytes FROM guild_web_audit_files WHERE case_id=$1 ORDER BY path LIMIT 1", [caseId])).rows[0]!;
    try {
      const changed = Buffer.from(audit.bytes); changed[0] = changed[0]! ^ 1;
      await pool.query("UPDATE guild_web_audit_files SET bytes=$3 WHERE case_id=$1 AND path=$2", [caseId, audit.path, changed]);
      await assert.rejects(prepareExhibitionPublication(actor, f.commissionId, prepareInput(startRevision), f.media), denied("WEB_AUDIT_EVIDENCE_CHANGED", 409));
    } finally { await pool.query("UPDATE guild_web_audit_files SET bytes=$3 WHERE case_id=$1 AND path=$2", [caseId, audit.path, audit.bytes]); }
    const authored = (await pool.query("SELECT bytes FROM guild_web_bundle_files WHERE bundle_id=$1 AND path='index.html'", [firstProposal.binding.bundleId])).rows[0]!.bytes;
    try {
      const changed = Buffer.from(authored); changed[0] = changed[0]! ^ 1;
      await pool.query("UPDATE guild_web_bundle_files SET bytes=$2 WHERE bundle_id=$1 AND path='index.html'", [firstProposal.binding.bundleId, changed]);
      await assert.rejects(prepareExhibitionPublication(actor, f.commissionId, prepareInput(startRevision), f.media), denied("WEB_BUNDLE_BINDING"));
    } finally { await pool.query("UPDATE guild_web_bundle_files SET bytes=$2 WHERE bundle_id=$1 AND path='index.html'", [firstProposal.binding.bundleId, authored]); }
    assert.equal((await workspace()).editions.length, initial.editions.length);
  });

  await t.test("proposal actor, digest, expiry and changed acceptance are rechecked at publication", async () => {
    const judge = await syntheticPublicationActor(actor.tenantId, "judge");
    await assert.rejects(publishExhibition(judge.session, f.commissionId, publishInput(firstProposal), f.media), denied("PUBLICATION_PROPOSAL_CHANGED", 409));
    await assert.rejects(publishExhibition(actor, f.commissionId, { ...publishInput(firstProposal), proposalDigest: "0".repeat(64) }, f.media), denied("PUBLICATION_LEDGER_CHANGED"));
    const now = Date.now; Date.now = () => Date.parse(firstProposal.expiresAt) + 1;
    try { await assert.rejects(publishExhibition(actor, f.commissionId, publishInput(firstProposal), f.media), denied("PUBLICATION_PROPOSAL_EXPIRED", 409)); } finally { Date.now = now; }
    const original = source.decision.disclosures;
    try {
      await pool.query("UPDATE guild_acceptance_decisions SET review_disclosures=$2 WHERE id=$1", [source.decision.id, { ...original, disclosure: syntheticPublicationDisclosure + " Changed after proposal." }]);
      await assert.rejects(publishExhibition(actor, f.commissionId, publishInput(firstProposal), f.media), denied("PUBLICATION_BINDING_CHANGED"));
    } finally { await pool.query("UPDATE guild_acceptance_decisions SET review_disclosures=$2 WHERE id=$1", [source.decision.id, original]); }
    assert.equal((await workspace()).editions.length, initial.editions.length);
  });

  await t.test("concurrent duplicate commands produce one immutable edition and reject identifier reuse", async () => {
    const input = prepareInput(startRevision), [a, b] = await Promise.all([prepareExhibitionPublication(actor, f.commissionId, input, f.media), prepareExhibitionPublication(actor, f.commissionId, input, f.media)]);
    assert.deepEqual(a, b); assert.equal(a.kind, "prepared");
    await assert.rejects(prepareExhibitionPublication(actor, f.commissionId, { ...input, editionNote: "Different exact request" }, f.media), denied("PUBLICATION_COMMAND_CHANGED", 409));
    const command = publishInput(a.proposal), results = await Promise.all([publishExhibition(actor, f.commissionId, command, f.media), publishExhibition(actor, f.commissionId, command, f.media)]);
    assert.deepEqual(results[0], results[1]); assert.equal(results[0]!.kind, "published"); first = results[0];
    const current = await workspace(); assert.equal(current.editions.length, initial.editions.length + 1); assert.equal(current.history.length, initial.history.length + 1); assert.equal(current.revision, startRevision + 1);
    await assert.rejects(publishExhibition(actor, f.commissionId, publishInput(firstProposal), f.media), denied("PUBLICATION_STALE", 409));
    await assert.rejects(prepareExhibitionPublication(actor, f.commissionId, prepareInput(startRevision), f.media), denied("PUBLICATION_STALE", 409));
  });

  await t.test("public originals, manifest, portable archive, validators, HEAD and private receipts retain exact bytes", async () => {
    const edition = (await workspace()).editions[0]!, original = await webExportBundle(actor, f.artifactId, f.selectedOrdinal, f.media);
    for (const type of ["text/html", "text/css", "application/javascript", "application/json", "font/woff2", "image/webp", "audio/mpeg", "text/vtt"]) {
      const file = edition.binding.bundle.files.find(item => item.mediaType === type)!;
      const response = await read(edition.publicId, file.path), bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(response.status, 200); assert.equal(publicationSha(bytes), file.contentHash); assert.deepEqual(bytes, await original.read(file));
      assert.match(response.headers.get("cache-control")!, /no-store/); assert.equal(response.headers.get("x-content-type-options"), "nosniff"); assert.equal(response.headers.get("content-type")!.split(";")[0], type);
    }
    const audio = edition.binding.bundle.files.find(item => item.mediaType === "audio/mpeg")!, full = await original.read(audio), range = await read(edition.publicId, audio.path, { range: "bytes=0-31" });
    assert.equal(range.status, 206); assert.deepEqual(Buffer.from(await range.arrayBuffer()), full.subarray(0, 32));
    const head = await read(edition.publicId, audio.path, {}, "HEAD"); assert.equal(await head.text(), ""); assert.equal(head.headers.get("content-length"), String(audio.byteLength));
    assert.equal((await read(edition.publicId, audio.path, { "if-none-match": head.headers.get("etag")! })).status, 304);
    const manifest = await read(edition.publicId, "bundle-manifest.json"); assert.equal(publicationSha(Buffer.from(await manifest.arrayBuffer())), edition.binding.portable.manifestHash);
    const zip = await read(edition.publicId, "exhibition.zip"); assert.equal(publicationSha(Buffer.from(await zip.arrayBuffer())), edition.binding.portable.zipHash);
    for (const path of ["private.json", "draft-2/index.html", "source-record.json.bak", "assets/audio/unknown.mp3"])
      await assert.rejects(read(edition.publicId, path), denied("PUBLICATION_PATH", 404));
    await assert.rejects(read("0".repeat(48)), denied("PUBLICATION_NOT_FOUND", 404));
    const receipt = await publicationEditionReceipt(actor, f.commissionId, edition.id); assert.equal(receipt.accepted.length, 6); assert.equal(receipt.proposal.digest, edition.proposalDigest);
    assert.equal(receipt.accepted.find(item => item.kind === "web")!.independent!.id, edition.binding.independent.jobId);
  });

  await t.test("a new edition keeps earlier bytes and an explicit withdrawal preserves private history and originals", async () => {
    second = await publish(await prepare("keep"));
    const current = await workspace(), a = current.editions.find(item => item.id === first.editionId)!, b = current.editions.find(item => item.id === second.editionId)!;
    assert.equal(a.state, "earlier"); assert.equal(b.state, "current"); assert.notEqual(a.publicId, b.publicId);
    assert.deepEqual(Buffer.from(await (await read(a.publicId)).arrayBuffer()), Buffer.from(await (await read(b.publicId)).arrayBuffer()));
    const command = withdrawInput(a.id, current.revision), results = await Promise.all([withdrawExhibition(actor, f.commissionId, command), withdrawExhibition(actor, f.commissionId, command)]);
    assert.deepEqual(results[0], results[1]); assert.equal((await workspace()).history.filter(item => item.editionId === a.id && item.action === "withdrawn").length, 1);
    for (const [path, headers, method] of [["index.html", {}, "GET"], ["exhibition.zip", {}, "GET"], ["bundle-manifest.json", { "if-none-match": `"sha256-${a.binding.portable.manifestHash}"` }, "GET"], [a.binding.bundle.files.find(file => file.mediaType === "audio/mpeg")!.path, { range: "bytes=0-31" }, "HEAD"]] as const)
      await assert.rejects(read(a.publicId, path, headers, method), denied("PUBLICATION_WITHDRAWN", 410));
    assert.equal((await read(b.publicId)).status, 200);
    assert.equal((await publicationEditionReceipt(actor, f.commissionId, a.id)).events.length, 2);
    const privateCopy = await webExportBundle(actor, f.artifactId, f.selectedOrdinal, f.media); assert.equal(publicationSha(await privateCopy.read(privateCopy.manifest.files.find(file => file.path === "index.html")!)), a.binding.bundle.files.find(file => file.path === "index.html")!.contentHash);
    await assert.rejects(withdrawExhibition(actor, f.commissionId, withdrawInput(a.id, (await workspace()).revision)), denied("PUBLICATION_ALREADY_WITHDRAWN", 409));
  });

  await t.test("the deliberate replace policy withdraws old links and a publish-versus-withdrawal race has one winner", async () => {
    const third = await publish(await prepare("withdraw")), current = await workspace();
    assert.equal(current.editions.find(item => item.id === second.editionId)!.state, "withdrawn");
    const proposal = await prepare("keep"), outcomes = await Promise.allSettled([publishExhibition(actor, f.commissionId, publishInput(proposal), f.media), withdrawExhibition(actor, f.commissionId, withdrawInput(third.editionId, current.revision))]);
    assert.equal(outcomes.filter(item => item.status === "fulfilled").length, 1); assert.equal(outcomes.filter(item => item.status === "rejected").length, 1);
    for (const result of outcomes) if (result.status === "rejected") assert.ok(denied("PUBLICATION_STALE", 409)(result.reason));
    assert.equal((await workspace()).revision, current.revision + 1);
  });

  await t.test("current production expiry, disconnected providers and a revoked producer never rewrite historical reads or grant work", async () => {
    const original = (await pool.query<{ snapshot: Commission }>("SELECT snapshot FROM guild_commissions WHERE id=$1", [f.commissionId])).rows[0]!.snapshot;
    const later = structuredClone(original); later.approvedPlanDigest = null;
    for (const mandate of later.mandates) { mandate.expiresAt = "2000-01-01T00:00:00.000Z"; mandate.status = "expired"; }
    for (const provider of later.providers) provider.endpoint = null;
    try {
      await pool.query("UPDATE guild_commissions SET snapshot=$2 WHERE id=$1", [f.commissionId, later]);
      await pool.query("UPDATE guild_sessions SET revoked_at=now() WHERE id=$1", [originalSession.id]);
      const proposal = await prepare("keep"); assert.equal(digest(proposal.binding), digest(firstProposal.binding));
      const next = await publish(proposal), edition = (await workspace()).editions.find(item => item.id === next.editionId)!;
      const now = Date.now; Date.now = () => now() + 24 * 3600_000;
      try { assert.equal((await read(edition.publicId)).status, 200); } finally { Date.now = now; }
    } finally {
      await pool.query("UPDATE guild_commissions SET snapshot=$2 WHERE id=$1", [f.commissionId, original]);
      await pool.query("UPDATE guild_sessions SET revoked_at=NULL WHERE id=$1", [originalSession.id]);
    }
  });

  await t.test("failed verification releases all six clients before further reads, and concurrent reads finish coherently before withdrawal", async () => {
    let current = await workspace(); if (!current.currentEditionId) { await publish(await prepare()); current = await workspace(); }
    const edition = current.editions.find(item => item.id === current.currentEditionId)!, file = edition.binding.bundle.files.find(item => item.mediaType === "audio/mpeg")!;
    const broken: PrivateBlobGateway = { put: async () => { throw Error("No writes allowed."); }, read: async pathname => { const original = await f.media.read(pathname); assert.ok(original); const bytes = Buffer.from(original.bytes); bytes[0] = bytes[0]! ^ 1; return { ...original, bytes }; } };
    const failed = await Promise.allSettled(Array.from({ length: 6 }, () => read(edition.publicId, file.path, {}, "GET", broken)));
    assert.equal(failed.filter(item => item.status === "rejected").length, 6);
    for (const result of failed) if (result.status === "rejected") assert.ok(denied("MEDIA_CONTENT_MISMATCH")(result.reason));
    assert.equal((await pool.query("SELECT 1 AS released")).rows[0]!.released, 1);
    let entered = 0, release!: () => void, allEntered!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; }), admission = new Promise<void>(resolve => { allEntered = resolve; });
    const held: PrivateBlobGateway = { put: async () => { throw Error("No writes allowed."); }, read: async pathname => { if (++entered === 6) allEntered(); await barrier; return f.media.read(pathname); } };
    const reads = Array.from({ length: 6 }, () => read(edition.publicId, file.path, {}, "GET", held));
    let withdrew = false, withdrawal: ReturnType<typeof withdrawExhibition> | undefined;
    try {
      await Promise.race([admission, delay(10_000).then(() => { throw Error("Six public reads could not reach original storage with the six-client pool."); })]);
      withdrawal = withdrawExhibition(actor, f.commissionId, withdrawInput(edition.id, current.revision)).then(result => { withdrew = true; return result; });
      await delay(100); assert.equal(withdrew, false, "Withdrawal waits for the admitted original-byte responses.");
    } finally { release(); }
    const responses = await Promise.all(reads); for (const response of responses) { assert.equal(response.status, 200); assert.equal(publicationSha(Buffer.from(await response.arrayBuffer())), file.contentHash); }
    assert.ok(withdrawal); await withdrawal;
    await assert.rejects(read(edition.publicId, file.path, { "if-none-match": `"sha256-${file.contentHash}"` }), denied("PUBLICATION_WITHDRAWN", 410));
    assert.equal((await pool.query("SELECT 1 AS released")).rows[0]!.released, 1);
  });

  await t.test("edition, proposal, event, command and response history are append-only and republishing uses a fresh identifier", async () => {
    for (const table of ["guild_web_publication_editions", "guild_web_publication_proposals", "guild_web_publication_events", "guild_web_publication_commands", "guild_web_publication_downloads"])
      await assert.rejects(pool.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [actor.tenantId]), (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "23000");
    const previous = await workspace(), next = await publish(await prepare("keep")), after = await workspace();
    assert.equal(after.editions.length, previous.editions.length + 1); assert.equal(next.version, Math.max(...previous.editions.map(item => item.version)) + 1);
    const edition = after.editions.find(item => item.id === next.editionId)!; assert.ok(previous.editions.every(item => item.publicId !== edition.publicId));
    assert.equal(previous.editions.filter(item => item.state === "withdrawn").every(item => after.editions.find(saved => saved.id === item.id)!.state === "withdrawn"), true);
  });
  assert.equal(externalRequests, 0); assert.deepEqual(await effects(), before, "Publication adds no model, speech, recognition, audit, acceptance, budget or payment work.");
});
