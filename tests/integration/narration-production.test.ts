import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { ArtifactManifest, Locale } from "../../src/contracts/guild";
import { locales } from "../../src/contracts/guild";
import { isolatedPostgres } from "../support/postgres";
import { narrationAcceptancePack, narrationScripts } from "../../src/domain/narration";
import { narrationEstimate } from "../../src/domain/speech";
import { translationAcceptancePack, translationLocales } from "../../src/domain/translation";
import { SpeechGatewayError, type SpeechGateway, type SpeechObserver, type SpeechReceipt, type SpeechRequest } from "../../src/server/media/speech-gateway";
import { TranscriptionGatewayError, type TranscriptionGateway } from "../../src/server/media/transcription-gateway";
import type { PrivateBlobGateway, StoredBlob } from "../../src/server/media/blob-store";

const cleanup = await isolatedPostgres("guild_narration_test"); after(cleanup);
const { createSession } = await import("../../src/server/session");
const { createCommission, executeCommand, getCommission, saveCommission } = await import("../../src/server/commissions");
const { getPool, transaction } = await import("../../src/server/db");
const { planDigest } = await import("../../src/domain/fixture");
const { digest, DomainError } = await import("../../src/domain/primitives");
const { museumSources } = await import("../../src/exhibition/museum");
const { runNextJob } = await import("../../src/server/jobs");
const { qualifiedAudioEngine } = await import("../../src/server/media/audio-qualification");
const { artifactEvidence } = await import("../../src/server/artifact-evidence");
const { readCompletedSpeech } = await import("../../src/server/media/speech-runs");
const { readOwnedMedia } = await import("../../src/server/media/objects");
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const code = (value: string) => (error: unknown) => error instanceof DomainError && error.code === value;

// These small, disposable transport fixtures are never used as commissioned
// speech, language qualification, human review, or payment evidence.
const bodies: Record<Locale, string> = {
  en: "Look slowly at this photograph. The record names a place and a date, while the people and their reasons remain unknown. Keep that uncertainty visible.",
  pt: "Observe esta fotografia com calma. O registro indica um lugar e uma data, mas as pessoas e seus motivos continuam desconhecidos. Preserve essa incerteza.",
  es: "Observe esta fotografía con calma. El registro indica un lugar y una fecha, pero las personas y sus motivos siguen siendo desconocidos. Mantenga esa incertidumbre.",
  fr: "Regardez lentement cette photographie. La notice indique un lieu et une date, mais les personnes et leurs raisons restent inconnues. Gardez cette incertitude visible.",
  ja: "この写真をゆっくり見てください。記録には場所と日付がありますが、人々やその理由はわかりません。この不確かさをそのまま残してください。",
  ar: "انظر إلى هذه الصورة بتأنٍ. يذكر السجل مكانًا وتاريخًا، لكن الأشخاص وأسبابهم لا تزال مجهولة. احتفظ بهذا القدر من عدم اليقين واضحًا.",
};
async function fresh() {
  const { session } = await createSession(), sources = museumSources.slice(0, 1);
  const c = await createCommission(session, { commandId: randomUUID(), title: "Synthetic audio boundary fixture", museum: "Disposable fixture museum", objective: "Exercise original speech bytes, approved scripts, independent measurements and review boundaries with synthetic transport fixtures only.", capMinor: 64000, languages: locales, sourceIds: sources.map(source => source.id) }, sources);
  const researchContent = { labels: [{ id: "welcome", title: "Fixture", body: bodies.en }] };
  const manifest = (packageId: string, content: Record<string, unknown>): ArtifactManifest => ({ id: randomUUID(), packageId, title: "Synthetic integration fixture; not actual production", mediaType: "application/json", contentHash: digest(content), downloadUrl: "/fixture", previewUrl: null, sourceIds: sources.map(source => source.id), createdAt: new Date().toISOString(), provenance: { mode: "live", label: "Synthetic isolated transport fixture only", sourceId: randomUUID(), observedAt: new Date().toISOString(), sandbox: false }, reviewStatus: "Fixture only; no human review", content });
  const research = manifest("research", researchContent), pack = translationAcceptancePack(research), binding = { packageId: "research", contractVersion: 1, artifactId: research.id, artifactHash: research.contentHash, reviewKind: "automated_review", reviewId: randomUUID() };
  const source = manifest("translation", { schemaVersion: "guild.translation.v2", contractDigest: pack.digest, glossaryDigest: pack.parameters!.glossaryDigest, translations: Object.fromEntries(locales.map(locale => [locale, { welcome: { title: locale === "ja" ? "記録" : locale === "ar" ? "السجل" : "Fixture", body: bodies[locale] } }])), localeMetadata: translationLocales, arabicDirection: "rtl", sourceArtifactId: research.id, sourceArtifactHash: research.contentHash, inputBindings: [binding], fluentHumanReviewed: false, limitations: ["Synthetic small integration fixture only. No actual translation or fluent review is asserted."], modelRuns: locales.filter(locale => locale !== "en").map(locale => ({ id: randomUUID(), locale, model: "synthetic-fixture" })) });
  await transaction(async db => {
    c.artifacts.push(research, source);
    const translation = c.packages.find(item => item.id === "translation")!; translation.acceptancePack = pack; translation.artifactIds = [source.id]; translation.state = "awaiting_acceptance";
    for (const criterion of pack.criteria) { criterion.status = criterion.kind === "deterministic" ? "passed" : "review"; criterion.evidence = "Synthetic precondition in a disposable integration schema, not external qualification."; }
    c.packages.find(item => item.id === "narration")!.inputPolicy = "reviewed_drafts";
    c.revision++; await saveCommission(db, c);
    await db.query("INSERT INTO guild_verifications(id,tenant_id,commission_id,package_id,contract_version,artifact_id,artifact_hash,criteria_digest,result) VALUES($1,$2,$3,'translation',1,$4,$5,$6,$7)", [randomUUID(), c.tenantId, c.id, source.id, source.contentHash, digest(pack), pack]);
  });
  await executeCommand(session, c.id, { type: "record_automated_review", commandId: randomUUID(), expectedRevision: c.revision, packageId: "translation", artifactId: source.id, artifactHash: source.contentHash, contractVersion: 1, criteriaDigest: digest(pack), findings: "Synthetic automated annotation for an isolated transport test. No human review, fluent review, actual generated speech or earned payment is represented.", acknowledgeLimitations: true });
  return { session, commissionId: c.id, source };
}
type Fixture = Awaited<ReturnType<typeof fresh>>;
async function amend(f: Fixture, override: Record<string, unknown> = {}) {
  const c = await getCommission(f.session, f.commissionId), pkg = c.packages.find(item => item.id === "narration")!;
  return executeCommand(f.session, c.id, { type: "amend_narration_contract", commandId: randomUUID(), expectedRevision: c.revision, packageId: pkg.id, contractVersion: pkg.contractVersion, acceptancePackDigest: narrationAcceptancePack(f.source, await qualifiedAudioEngine()).digest, sourceArtifactId: f.source.id, sourceArtifactHash: f.source.contentHash, acknowledgeAiVoice: true, ...override });
}
async function approve(f: Fixture) { const c = await getCommission(f.session, f.commissionId); await executeCommand(f.session, c.id, { type: "approve_plan", commandId: randomUUID(), expectedRevision: c.revision, planDigest: planDigest(c) }); }
async function queue(f: Fixture, type: "produce_package" | "verify_artifact" = "produce_package") {
  const c = await getCommission(f.session, f.commissionId), pkg = c.packages.find(item => item.id === "narration")!;
  const result = await executeCommand(f.session, c.id, type === "produce_package" ? { type, commandId: randomUUID(), expectedRevision: c.revision, packageId: pkg.id } : { type, commandId: randomUUID(), expectedRevision: c.revision, packageId: pkg.id, artifactId: pkg.artifactIds.at(-1)! });
  assert.ok(result.ok && result.jobId); return result.jobId;
}
async function runnable(jobId: string) { await getPool().query("UPDATE guild_jobs SET available_at=now() WHERE id=$1", [jobId]); }
async function finish(f: Fixture, jobId: string, dependencies: Parameters<typeof runNextJob>[1]) {
  for (let step = 0; step < 30; step++) { await runnable(jobId); const result = await runNextJob(f.session.tenantId, dependencies); if (result?.state !== "queued") return result; }
  throw new Error("Bounded synthetic job did not finish");
}
class MemoryMedia implements PrivateBlobGateway {
  files = new Map<string, StoredBlob>(); puts = 0; reads = 0;
  async put(pathname: string, bytes: Buffer, mediaType: string) { this.puts++; assert.equal(this.files.has(pathname), false, "an immutable object is never overwritten"); const value = { pathname, bytes: Buffer.from(bytes), mediaType, etag: sha(bytes) }; this.files.set(pathname, value); return { pathname, etag: value.etag }; }
  async read(pathname: string) { this.reads++; return this.files.get(pathname) ?? null; }
}
class SyntheticSpeech implements SpeechGateway {
  calls = 0; responses = 0; inputs: SpeechRequest[] = [];
  constructor(readonly mode: "ok" | "lost" | "short" = "ok", readonly beforeDispatch?: () => Promise<void>) {}
  async generate(request: SpeechRequest, observer: SpeechObserver) {
    this.calls++; this.inputs.push(request); assert.equal(request.model, "gpt-realtime-2.1"); assert.equal(request.voice, "marin");
    const sessionId = `sess_fixture_${request.operationId}`, responseId = `resp_fixture_${request.operationId}`;
    await observer.session?.(sessionId, request.model); await this.beforeDispatch?.(); await observer.dispatch(); this.responses++; await observer.response?.(responseId);
    const seconds = narrationEstimate(request.text, request.locale) * (this.mode === "short" && this.calls === 1 ? 0.55 : 1), pcm = Buffer.alloc(Math.round(24000 * seconds) * 2);
    for (let i = 0; i < pcm.length / 2; i++) { const t = i / 24000, envelope = 0.3 + 0.5 * Math.sin(t * Math.PI) ** 2; pcm.writeInt16LE(Math.round(12000 * envelope * (Math.sin(t * 2 * Math.PI * 220) + 0.2 * Math.sin(t * 2 * Math.PI * 440))), i * 2); }
    for (let offset = 0, sequence = 0; offset < pcm.length; offset += 96000, sequence++) { await observer.chunk?.(sequence, `event_${sequence}`, pcm.subarray(offset, offset + 96000)); if (this.mode === "lost") throw new SpeechGatewayError("SYNTHETIC_CONNECTION_LOST", true); }
    const receipt: SpeechReceipt = { model: request.model, voice: request.voice, sessionId, responseId, transcript: request.text, sampleRate: 24000, byteLength: pcm.length, contentHash: sha(pcm), latencyMs: 1, usage: { fixture: true } };
    await observer.complete?.(receipt); return { pcm, receipt };
  }
}
class SyntheticAsr implements TranscriptionGateway {
  calls = 0;
  constructor(readonly source: ArtifactManifest, readonly unknownFirst = false) {}
  async transcribe(bytes: Buffer, locale: Locale) {
    this.calls++; assert.ok(bytes.length); if (this.unknownFirst && this.calls === 1) throw new TranscriptionGatewayError("SYNTHETIC_LOST_ASR", false);
    const text = narrationScripts(this.source).find(item => item.locale === locale)!.text, rawBody = JSON.stringify({ text, languages: [{ code: locale }] });
    return { model: "gpt-transcribe" as const, text, languages: [locale], rawBody, bodyHash: sha(rawBody), providerRequestId: null, latencyMs: 1 };
  }
}
async function ready(f: Fixture) { await amend(f); await approve(f); }

test("the measured voice amendment freezes exact scripts and price before fresh approval; changed source terms reject", async () => {
  const f = await fresh(), before = await getCommission(f.session, f.commissionId), original = structuredClone(before.packages.find(item => item.id === "narration")!);
  await assert.rejects(amend(f, { sourceArtifactHash: "0".repeat(64) }), code("NARRATION_AMENDMENT_CHANGED"));
  await amend(f); let c = await getCommission(f.session, f.commissionId), pkg = c.packages.find(item => item.id === "narration")!;
  assert.equal(pkg.contractVersion, original.contractVersion + 1); assert.equal(pkg.grossMinor, 8700); assert.equal(pkg.providerAwardMinor, 8000); assert.equal(pkg.acceptancePack.version, "2.0.0"); assert.equal(c.approvedPlanDigest, null);
  assert.equal((pkg.acceptancePack.parameters!.scripts as unknown[]).length, 6); assert.equal(pkg.inputPolicy, "reviewed_drafts");
  const history = (await getPool().query("SELECT previous_contract FROM guild_contract_amendments WHERE tenant_id=$1 AND package_id='narration'", [f.session.tenantId])).rows; assert.deepEqual(history[0].previous_contract, original);
  await assert.rejects(queue(f), code("APPROVAL_REQUIRED")); await approve(f); await queue(f);
  c = await getCommission(f.session, f.commissionId); pkg = c.packages.find(item => item.id === "narration")!; assert.equal(pkg.state, "producing"); assert.equal(c.mandates[0]!.reservedMinor, 8700); assert.equal(c.payments.capturedMinor, 0);
});

test("complete six-locale synthetic streams survive worker steps and receive independent audio checks without human acceptance", async () => {
  const f = await fresh(); await ready(f); const speech = new SyntheticSpeech(), media = new MemoryMedia(), transcription = new SyntheticAsr(f.source), dependencies = { speech, media, transcription };
  const producing = await queue(f); assert.equal((await finish(f, producing, dependencies))?.state, "completed"); assert.equal(speech.calls, 6); assert.equal(media.puts, 6);
  let c = await getCommission(f.session, f.commissionId), pkg = c.packages.find(item => item.id === "narration")!, artifact = c.artifacts.find(item => item.id === pkg.artifactIds[0])!;
  assert.equal(artifact.content.schemaVersion, "guild.narration.v2"); assert.equal((artifact.content.segments as unknown[]).length, 6); assert.equal(artifact.content.aiGeneratedVoice, true); assert.equal(artifact.content.humanListeningReviewed, false);
  const chunks = (await getPool().query("SELECT count(*)::int AS count FROM guild_speech_chunks WHERE tenant_id=$1", [f.session.tenantId])).rows[0].count; assert.ok(chunks > 6);
  const checking = await queue(f, "verify_artifact"); assert.equal((await finish(f, checking, dependencies))?.state, "completed");
  c = await getCommission(f.session, f.commissionId); pkg = c.packages.find(item => item.id === "narration")!;
  assert.ok(pkg.acceptancePack.criteria.filter(item => item.kind === "deterministic").every(item => item.status === "passed"), JSON.stringify(pkg.acceptancePack.criteria));
  assert.equal(pkg.acceptancePack.criteria.find(item => item.id === "asr")!.status, "review"); assert.equal(pkg.acceptancePack.criteria.find(item => item.id === "listening")!.status, "review"); assert.equal(pkg.acceptedAt, null); assert.equal(pkg.paymentState, "not_eligible"); assert.equal(transcription.calls, 6); assert.equal(c.payments.capturedMinor, 0);
  await assert.rejects(executeCommand(f.session, c.id, { type: "accept_package", commandId: randomUUID(), expectedRevision: c.revision, packageId: pkg.id, artifactId: artifact.id, contractVersion: pkg.contractVersion, acknowledgeReview: true }), code("INPUT_ACCEPTANCE_REQUIRED"));
  assert.equal((await finish(f, await queue(f, "verify_artifact"), dependencies))?.state, "completed"); assert.equal(transcription.calls, 6, "repeat checks reuse original ASR observations"); assert.equal(speech.calls, 6);
  const evidence = await artifactEvidence(f.session, artifact.id); assert.equal(evidence.independentReports.length, 2);
  const other = (await createSession()).session; await assert.rejects(readOwnedMedia(other.tenantId, (artifact.content.segments as any[])[0].audio.mediaId, media), code("MEDIA_NOT_FOUND"));
});

test("an interrupted original speech stream keeps its bytes and blocks duplicate recordings and new jobs", async () => {
  const f = await fresh(); await ready(f); const speech = new SyntheticSpeech("lost"), dependencies = { speech, media: new MemoryMedia() }, jobId = await queue(f);
  assert.equal((await finish(f, jobId, dependencies))?.state, "needs_review"); assert.equal(speech.calls, 1);
  const row = (await getPool().query("SELECT id,state,provider_response_id,receipt,byte_length FROM guild_speech_runs WHERE tenant_id=$1", [f.session.tenantId])).rows[0]; assert.equal(row.state, "indeterminate"); assert.ok(row.provider_response_id); assert.equal(row.receipt, null);
  assert.equal((await getPool().query("SELECT count(*)::int AS count FROM guild_speech_chunks WHERE tenant_id=$1", [f.session.tenantId])).rows[0].count, 1);
  await assert.rejects(readCompletedSpeech(f.session.tenantId, row.id)); await assert.rejects(queue(f), code("ORIGINAL_SPEECH_RESULT_PENDING"));
  await getPool().query("UPDATE guild_jobs SET state='queued',available_at=now() WHERE id=$1", [jobId]); await finish(f, jobId, dependencies); assert.equal(speech.calls, 1);
  const c = await getCommission(f.session, f.commissionId); assert.deepEqual(c.packages.find(item => item.id === "narration")!.artifactIds, []); assert.equal(c.payments.capturedMinor, 0);
});

test("current authority is checked again after the speech session opens and before response dispatch", async () => {
  const f = await fresh(); await ready(f);
  const speech = new SyntheticSpeech("ok", async () => { await transaction(async db => { const c = await getCommission(f.session, f.commissionId); c.mandates.find(item => item.id === "passport-localization")!.status = "revoked"; c.revision++; await saveCommission(db, c); }); });
  assert.equal((await finish(f, await queue(f), { speech, media: new MemoryMedia() }))?.state, "needs_review"); assert.equal(speech.calls, 1); assert.equal(speech.responses, 0);
  const row = (await getPool().query("SELECT dispatched_at,provider_response_id FROM guild_speech_runs WHERE tenant_id=$1", [f.session.tenantId])).rows[0]; assert.equal(row.dispatched_at, null); assert.equal(row.provider_response_id, null);
});

test("changed private audio bytes fail independent checks despite an unchanged manifest", async () => {
  const f = await fresh(); await ready(f); const media = new MemoryMedia(), speech = new SyntheticSpeech(), transcription = new SyntheticAsr(f.source), dependencies = { media, speech, transcription };
  await finish(f, await queue(f), dependencies); const first = [...media.files.values()][0]!; first.bytes = Buffer.from("mutated fixture bytes, never provider output");
  await finish(f, await queue(f, "verify_artifact"), dependencies); const c = await getCommission(f.session, f.commissionId), pkg = c.packages.find(item => item.id === "narration")!;
  assert.equal(pkg.acceptancePack.criteria.find(item => item.id === "audio")!.status, "failed"); assert.equal(pkg.state, "correction_requested"); assert.equal(transcription.calls, 5); assert.equal(pkg.acceptedAt, null); assert.equal(c.payments.capturedMinor, 0);
});

test("duration remains a measured failure when a complete provider transcript covers audio that is too short", async () => {
  const f = await fresh(); await ready(f); const dependencies = { media: new MemoryMedia(), speech: new SyntheticSpeech("short"), transcription: new SyntheticAsr(f.source) };
  await finish(f, await queue(f), dependencies); await finish(f, await queue(f, "verify_artifact"), dependencies);
  const c = await getCommission(f.session, f.commissionId), pkg = c.packages.find(item => item.id === "narration")!;
  assert.equal(pkg.acceptancePack.criteria.find(item => item.id === "duration")!.status, "failed"); assert.equal(pkg.acceptancePack.criteria.find(item => item.id === "transcript")!.status, "passed"); assert.equal(pkg.acceptedAt, null);
});

test("ambiguous independent recognition is retained as advisory and never recreated by repeated checks", async () => {
  const f = await fresh(); await ready(f); const transcription = new SyntheticAsr(f.source, true), dependencies = { media: new MemoryMedia(), speech: new SyntheticSpeech(), transcription };
  await finish(f, await queue(f), dependencies); await finish(f, await queue(f, "verify_artifact"), dependencies); await finish(f, await queue(f, "verify_artifact"), dependencies);
  assert.equal(transcription.calls, 6); const rows = (await getPool().query("SELECT state,response_body,response_body_hash,request FROM guild_transcription_runs WHERE tenant_id=$1 ORDER BY created_at", [f.session.tenantId])).rows;
  assert.equal(rows[0].state, "indeterminate"); assert.equal(rows[0].response_body, null); assert.equal(rows[0].request.expectedWordingInPrompt, false); assert.equal("text" in rows[0].request, false);
  for (const row of rows.slice(1)) { assert.equal(row.state, "completed"); assert.equal(sha(row.response_body), row.response_body_hash); }
  const c = await getCommission(f.session, f.commissionId), pkg = c.packages.find(item => item.id === "narration")!; assert.equal(pkg.acceptancePack.criteria.find(item => item.id === "asr")!.status, "review"); assert.match(pkg.acceptancePack.criteria.find(item => item.id === "asr")!.evidence!, /5\/6/); assert.equal(pkg.acceptedAt, null);
});

test("changing an upstream draft after the first recording preserves it and stops further speech", async () => {
  const f = await fresh(); await ready(f); const speech = new SyntheticSpeech(), dependencies = { speech, media: new MemoryMedia() }, jobId = await queue(f);
  assert.equal((await runNextJob(f.session.tenantId, dependencies))?.state, "queued"); assert.equal(speech.calls, 1);
  await transaction(async db => { const c = await getCommission(f.session, f.commissionId); c.packages.find(item => item.id === "translation")!.artifactIds = []; c.revision++; await saveCommission(db, c); });
  assert.equal((await finish(f, jobId, dependencies))?.state, "needs_review"); assert.equal(speech.calls, 1);
  const rows = (await getPool().query("SELECT state,receipt_hash FROM guild_speech_runs WHERE tenant_id=$1", [f.session.tenantId])).rows; assert.equal(rows.length, 1); assert.equal(rows[0].state, "completed"); assert.ok(rows[0].receipt_hash);
});
