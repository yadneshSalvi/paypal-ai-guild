import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ArtifactManifest, Commission, Locale } from "../../src/contracts/guild";
import { locales } from "../../src/contracts/guild";
import { narrationAcceptancePack, narrationScripts } from "../../src/domain/narration";
import { narrationEstimate } from "../../src/domain/speech";
import { translationAcceptancePack, translationLocales } from "../../src/domain/translation";
import { SpeechGatewayError, type SpeechGateway, type SpeechObserver, type SpeechReceipt, type SpeechRequest } from "../../src/server/media/speech-gateway";
import { TranscriptionGatewayError, type TranscriptionGateway } from "../../src/server/media/transcription-gateway";
import type { PrivateBlobGateway, StoredBlob } from "../../src/server/media/blob-store";
import { createSession } from "../../src/server/session";
import { createCommission, executeCommand, getCommission, saveCommission } from "../../src/server/commissions";
import { getPool, transaction } from "../../src/server/db";
import { planDigest } from "../../src/domain/fixture";
import { digest, DomainError } from "../../src/domain/primitives";
import { museumSources } from "../../src/exhibition/museum";
import { runNextJob } from "../../src/server/jobs";
import { qualifiedAudioEngine } from "../../src/server/media/audio-qualification";
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
export const code = (value: string) => (error: unknown) => error instanceof DomainError && error.code === value;
export const fullFixtureKeys = ["loc-det-4a12861", "loc-det-4a16836", "loc-det-4a20344", "loc-det-4a25770", ...Array.from({length: 9}, (_, i) => `fixture-label-${i + 5}`)];
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
export async function fresh(labelCount = 1) {
  const keys = labelCount === 13 ? fullFixtureKeys : ["welcome"];
  const { session } = await createSession(), sources = museumSources.slice(0, 1);
  const c = await createCommission(session, { commandId: randomUUID(), title: "Synthetic audio boundary fixture", museum: "Disposable fixture museum", objective: "Exercise original speech bytes, approved scripts, independent measurements and review boundaries with synthetic transport fixtures only.", capMinor: 64000, languages: locales, sourceIds: sources.map(source => source.id) }, sources);
  const researchContent = { labels: keys.map(id => ({ id, title: "Fixture", body: bodies.en })) };
  const manifest = (packageId: string, content: Record<string, unknown>): ArtifactManifest => ({ id: randomUUID(), packageId, title: "Synthetic integration fixture; not actual production", mediaType: "application/json", contentHash: digest(content), downloadUrl: "/fixture", previewUrl: null, sourceIds: sources.map(source => source.id), createdAt: new Date().toISOString(), provenance: { mode: "live", label: "Synthetic isolated transport fixture only", sourceId: randomUUID(), observedAt: new Date().toISOString(), sandbox: false }, reviewStatus: "Fixture only; no human review", content });
  const research = manifest("research", researchContent), pack = translationAcceptancePack(research), binding = { packageId: "research", contractVersion: 1, artifactId: research.id, artifactHash: research.contentHash, reviewKind: "automated_review", reviewId: randomUUID() };
  const source = manifest("translation", { schemaVersion: "guild.translation.v2", contractDigest: pack.digest, glossaryDigest: pack.parameters!.glossaryDigest, translations: Object.fromEntries(locales.map(locale => [locale, Object.fromEntries(keys.map(key => [key, { title: locale === "ja" ? "記録" : locale === "ar" ? "السجل" : "Fixture", body: bodies[locale] }]))])), localeMetadata: translationLocales, arabicDirection: "rtl", sourceArtifactId: research.id, sourceArtifactHash: research.contentHash, inputBindings: [binding], fluentHumanReviewed: false, limitations: ["Synthetic small integration fixture only. No actual translation or fluent review is asserted."], modelRuns: locales.filter(locale => locale !== "en").map(locale => ({ id: randomUUID(), locale, model: "synthetic-fixture" })) });
  await transaction(async db => {
    c.artifacts.push(research, source);
    const translation = c.packages.find(item => item.id === "translation")!; translation.acceptancePack = pack; translation.artifactIds = [source.id]; translation.state = "awaiting_acceptance";
    for (const criterion of pack.criteria) { criterion.status = criterion.kind === "deterministic" ? "passed" : "review"; criterion.evidence = "Synthetic precondition in a disposable integration schema, not external qualification."; }
    c.packages.find(item => item.id === "narration")!.inputPolicy = "reviewed_drafts";
    c.revision++; await saveCommission(db, c);
    await db.query("INSERT INTO guild_verifications(id,tenant_id,commission_id,package_id,contract_version,artifact_id,artifact_hash,criteria_digest,result) VALUES($1,$2,$3,'translation',1,$4,$5,$6,$7)", [randomUUID(), c.tenantId, c.id, source.id, source.contentHash, digest(pack), pack]);
  });
  await executeCommand(session, c.id, { type: "record_automated_review", commandId: randomUUID(), expectedRevision: c.revision, packageId: "translation", artifactId: source.id, artifactHash: source.contentHash, contractVersion: 1, criteriaDigest: digest(pack), findings: "Synthetic automated annotation for an isolated transport test. No human review, fluent review, actual generated speech or earned payment is represented.", acknowledgeLimitations: true });
  return { session, commissionId: c.id, source: (await getCommission(session, c.id)).artifacts.find(item => item.id === source.id)! };
}
export type Fixture = Awaited<ReturnType<typeof fresh>>;
export async function amend(f: Fixture, override: Record<string, unknown> = {}) {
  const c = await getCommission(f.session, f.commissionId), pkg = c.packages.find(item => item.id === "narration")!;
  return executeCommand(f.session, c.id, { type: "amend_narration_contract", commandId: randomUUID(), expectedRevision: c.revision, packageId: pkg.id, contractVersion: pkg.contractVersion, acceptancePackDigest: narrationAcceptancePack(f.source, await qualifiedAudioEngine()).digest, sourceArtifactId: f.source.id, sourceArtifactHash: f.source.contentHash, acknowledgeAiVoice: true, ...override });
}
export async function approve(f: Fixture) { const c = await getCommission(f.session, f.commissionId); await executeCommand(f.session, c.id, { type: "approve_plan", commandId: randomUUID(), expectedRevision: c.revision, planDigest: planDigest(c) }); }
export async function queue(f: Fixture, type: "produce_package" | "verify_artifact" = "produce_package") {
  const c = await getCommission(f.session, f.commissionId), pkg = c.packages.find(item => item.id === "narration")!;
  const result = await executeCommand(f.session, c.id, type === "produce_package" ? { type, commandId: randomUUID(), expectedRevision: c.revision, packageId: pkg.id } : { type, commandId: randomUUID(), expectedRevision: c.revision, packageId: pkg.id, artifactId: pkg.artifactIds.at(-1)! });
  assert.ok(result.ok && result.jobId); return result.jobId;
}
export async function runnable(jobId: string) { await getPool().query("UPDATE guild_jobs SET available_at=now() WHERE id=$1", [jobId]); }
export async function finish(f: Fixture, jobId: string, dependencies: Parameters<typeof runNextJob>[1]) {
  for (let step = 0; step < 500; step++) { await runnable(jobId); const result = await runNextJob(f.session.tenantId, dependencies); if (result?.state !== "queued") return result; }
  throw new Error("Bounded synthetic job did not finish");
}
export class MemoryMedia implements PrivateBlobGateway {
  files = new Map<string, StoredBlob>(); puts = 0; reads = 0;
  constructor(readonly spoolDirectory?: string) {}
  async put(pathname: string, bytes: Buffer, mediaType: string) {
    this.puts++; assert.equal(this.files.has(pathname), false, "an immutable object is never overwritten");
    const value = { pathname, bytes: Buffer.from(bytes), mediaType, etag: sha(bytes) };
    if (this.spoolDirectory) {
      await mkdir(this.spoolDirectory, { recursive: true, mode: 0o700 });
      const file = sha(pathname) + ".bin";
      await writeFile(resolve(this.spoolDirectory, file), value.bytes, { flag: "wx", mode: 0o600 });
      await appendFile(resolve(this.spoolDirectory, "spool-index.jsonl"), JSON.stringify({ pathname, file, mediaType, etag: value.etag, bytes: value.bytes.length, hash: sha(value.bytes), disclosure: "Synthetic fixture object retained immediately; no real provider or listening claim." }) + "\n", { mode: 0o600 });
    }
    this.files.set(pathname, value); return { pathname, etag: value.etag };
  }
  async read(pathname: string) { this.reads++; return this.files.get(pathname) ?? null; }
}
export class SyntheticSpeech implements SpeechGateway {
  calls = 0; responses = 0; inputs: SpeechRequest[] = [];
  constructor(readonly mode: "ok" | "lost" | "short" | "long_ar" | "targeted_fail" | "partial_ar" | "lost_second" | "remaining_ar" = "ok", readonly beforeDispatch?: () => Promise<void>) {}
  async generate(request: SpeechRequest, observer: SpeechObserver) {
    this.calls++; this.inputs.push(request); assert.equal(request.model, "gpt-realtime-2.1"); assert.equal(request.voice, "marin");
    const sessionId = `sess_fixture_${request.operationId}`, responseId = `resp_fixture_${request.operationId}`;
    await observer.session?.(sessionId, request.model); await this.beforeDispatch?.(); await observer.dispatch(); this.responses++; await observer.response?.(responseId);
    const recordingKey = (await getPool().query("SELECT operation_key FROM guild_speech_runs WHERE id=$1", [request.operationId])).rows[0].operation_key.split(":").at(-1);
    const seconds = narrationEstimate(request.text, request.locale) * (this.mode === "short" && this.calls === 1 ? 0.55 : (this.mode === "remaining_ar" && request.locale === "ar" && recordingKey === fullFixtureKeys[0] || this.mode === "long_ar" && request.locale === "ar" || ["targeted_fail", "partial_ar"].includes(this.mode) && request.locale === "ar" && ["welcome", ...fullFixtureKeys.slice(0, 4)].includes(recordingKey)) ? 1.6 : 1), pcm = Buffer.alloc(Math.round(24000 * seconds) * 2);
    for (let i = 0; i < pcm.length / 2; i++) { const t = i / 24000, envelope = 0.3 + 0.5 * Math.sin(t * Math.PI) ** 2; pcm.writeInt16LE(Math.round(12000 * envelope * (Math.sin(t * 2 * Math.PI * 220) + 0.2 * Math.sin(t * 2 * Math.PI * 440))), i * 2); }
    for (let offset = 0, sequence = 0; offset < pcm.length; offset += 96000, sequence++) { await observer.chunk?.(sequence, `event_${sequence}`, pcm.subarray(offset, offset + 96000)); if (this.mode === "lost" || this.mode === "lost_second" && this.calls === 2) throw new SpeechGatewayError("SYNTHETIC_CONNECTION_LOST", true); }
    const receipt: SpeechReceipt = { model: request.model, voice: request.voice, sessionId, responseId, transcript: this.mode === "targeted_fail" && request.locale === "en" && ["welcome", "loc-det-4a25770"].includes(recordingKey) ? request.text.replace("Fixture", "Fixtuure") : request.text, sampleRate: 24000, byteLength: pcm.length, contentHash: sha(pcm), latencyMs: 1, usage: { fixture: true } };
    await observer.complete?.(receipt); return { pcm, receipt };
  }
}
export class SyntheticAsr implements TranscriptionGateway {
  calls = 0;
  constructor(readonly source: ArtifactManifest, readonly unknownFirst = false) {}
  async transcribe(bytes: Buffer, locale: Locale) {
    this.calls++; assert.ok(bytes.length); if (this.unknownFirst && this.calls === 1) throw new TranscriptionGatewayError("SYNTHETIC_LOST_ASR", false);
    const text = narrationScripts(this.source).find(item => item.locale === locale)!.text, rawBody = JSON.stringify({ text, languages: [{ code: locale }] });
    return { model: "gpt-transcribe" as const, text, languages: [locale], rawBody, bodyHash: sha(rawBody), providerRequestId: null, latencyMs: 1 };
  }
}
export async function ready(f: Fixture) { await amend(f); await approve(f); }


export async function exhaustedTargetedFixture(labelCount = 13) {
  const f = await fresh(labelCount); await ready(f);
  const media = new MemoryMedia(), transcription = new SyntheticAsr(f.source);
  for (let round = 0; round < 2; round++) {
    const dependencies = { media, transcription, speech: new SyntheticSpeech("partial_ar") };
    assert.equal((await finish(f, await queue(f), dependencies))?.state, "completed");
    assert.equal((await finish(f, await queue(f, "verify_artifact"), dependencies))?.state, "completed");
  }
  async function note(reason: string) { const c = await getCommission(f.session, f.commissionId); await executeCommand(f.session, c.id, { type: "request_correction", commandId: randomUUID(), expectedRevision: c.revision, packageId: "narration", reason }); }
  await note("Synthetic fixture: preserve full source scripts and all measured thresholds; use the explicit Arabic 165–175 words/minute delivery cue for one full additional round.");
  const c = await getCommission(f.session, f.commissionId), pkg = c.packages.find(item => item.id === "narration")!;
  const { narrationCorrectionProposal } = await import("../../src/server/narration-corrections");
  const proposal = await narrationCorrectionProposal(getPool(), c, pkg);
  await executeCommand(f.session, c.id, { type: "agree_narration_correction", commandId: randomUUID(), expectedRevision: c.revision, packageId: pkg.id, contractVersion: pkg.contractVersion, proposalDigest: proposal.digest, acknowledgeOneRun: true });
  await approve(f);
  const dependencies = { media, transcription, speech: new SyntheticSpeech("targeted_fail") };
  assert.equal((await finish(f, await queue(f), dependencies))?.state, "completed");
  assert.equal((await finish(f, await queue(f, "verify_artifact"), dependencies))?.state, "completed");
  await note("Synthetic targeted fixture: retain every passing original and replace only the exact failed Arabic timing or English reported-transcript recordings once. Keep the original scripts, measured standard, source review, price and authority expiry.");
  if (labelCount === 13 && process.env.GUILD_TARGETED_FIXTURE_EXPORT) {
    const { writeFile } = await import("node:fs/promises");
    const tables = ["guild_tenants", "guild_sessions", "guild_commissions", "guild_artifacts", "guild_events", "guild_jobs", "guild_commands", "guild_approval_receipts", "guild_verifications", "guild_budget_reservations", "guild_contract_amendments", "guild_artifact_reviews", "guild_media_objects", "guild_speech_runs", "guild_transcription_runs", "guild_production_parts"];
    const rows: Record<string, unknown[]> = {};
    for (const table of tables) rows[table] = (await getPool().query(`SELECT * FROM ${table} WHERE ${table === "guild_tenants" ? "id" : "tenant_id"}=$1`, [f.session.tenantId])).rows;
    await writeFile(process.env.GUILD_TARGETED_FIXTURE_EXPORT, JSON.stringify({ provenance: "Synthetic disposable fixtures only; no commissioned media, human review or financial evidence", session: f.session, commissionId: f.commissionId, authSecret: process.env.AUTH_SECRET, sessionSecret: process.env.JUDGE_SESSION_SECRET, rows, media: [...media.files.values()].map(item => ({ ...item, bytes: item.bytes.toString("base64") })) }), { mode: 0o600 });
  }
  return { ...f, media, transcription };
}

/** Four synthetic submissions, then a single actual-file duration failure. */
export async function exhaustedFollowupFixture(saveNote = true) {
  const f = await exhaustedTargetedFixture(13);
  const { narrationTargetedCorrectionProposal } = await import("../../src/server/narration-targeted-corrections");
  let c = await getCommission(f.session, f.commissionId);
  const pkg = c.packages.find(item => item.id === "narration")!, proposal = await narrationTargetedCorrectionProposal(getPool(), c, pkg);
  await executeCommand(f.session, c.id, { type: "agree_narration_targeted_correction", commandId: randomUUID(), expectedRevision: c.revision, packageId: pkg.id, contractVersion: pkg.contractVersion, proposalDigest: proposal.digest, acknowledgeExactScope: true });
  await approve(f);
  const dependencies = { media: f.media, transcription: f.transcription, speech: new SyntheticSpeech("remaining_ar") };
  const targetedJobId = await queue(f);
  assert.equal((await finish(f, targetedJobId, dependencies))?.state, "completed");
  const verificationJobId = await queue(f, "verify_artifact");
  assert.equal((await finish(f, verificationJobId, dependencies))?.state, "completed");
  assert.equal(dependencies.speech.calls, 5);
  if (saveNote) {
    c = await getCommission(f.session, c.id);
    await executeCommand(f.session, c.id, { type: "request_correction", commandId: randomUUID(), expectedRevision: c.revision, packageId: pkg.id, reason: "Synthetic follow-up fixture: the new independent report retains one duration failure, ar/loc-det-4a12861. Preserve all 77 passing recordings, including both original full-round files and targeted replacements, with their true producing identities. Review one newly agreed cue and one original stream under the unchanged standard, original expiry and exact $87/$540/$640 terms. No human listening, acceptance or payment is established." });
  }
  return { ...f, targetedJobId, verificationJobId };
}
