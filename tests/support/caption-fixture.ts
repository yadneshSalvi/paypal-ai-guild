import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { locales, type ArtifactManifest, type Commission, type Locale } from "@/contracts/guild";
import { collectionNotes, planDigest } from "@/domain/fixture";
import { digest } from "@/domain/primitives";
import { materializeResearch, researchAcceptancePack, researchSourceSpans, type ResearchDraft } from "@/domain/research";
import { translationAcceptancePack, translationArtifactSchema } from "@/domain/translation";
import { verifyArtifact } from "@/domain/verification";
import { timestampCapability } from "@/domain/caption-alignment";
import { captionSourcesFromPack } from "@/domain/captions";
import { getPool, transaction } from "@/server/db";
import { executeCommand, getCommission, saveCommission } from "@/server/commissions";
import { captionContractProposal } from "@/server/captions/contracts";
import { checkedAlignmentReceipt, AlignmentGatewayError, type AlignmentGateway, type AlignmentHttpReceipt, type AlignmentInput } from "@/server/captions/alignment-gateway";
import { runNextJob } from "@/server/jobs";
import { fresh, ready, queue, finish, MemoryMedia, SyntheticSpeech, SyntheticAsr, type Fixture } from "./narration-fixture";
import { museumSources } from "@/exhibition/museum";
import { syntheticSourceHistory } from "./synthetic-source-history";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
/** Synthetic predecessors exercise provenance; they are never actual language or audio evidence. */
export async function captionFixture(sourceCount: 1 | 12 = 1, options: { withProducingHistory?: boolean; mediaDirectory?: string } = {}) {
  const f = await fresh(), c = await getCommission(f.session, f.commissionId), old = translationArtifactSchema.parse(f.source.content);
  if (sourceCount === 12) {
    c.sourceAssets = museumSources.slice(0, sourceCount);
    c.packages.find(item => item.id === "research")!.acceptancePack = researchAcceptancePack(c.sourceAssets, collectionNotes);
  }
  const spans = researchSourceSpans(c.sourceAssets, collectionNotes), span = spans.find(item => item.id === `${c.sourceAssets[0]!.id}:title`)!;
  const invitation = "Look slowly and make room for questions as you move through this small exhibition. You can pause, return to a detail, or compare the catalogue words with what you notice. Consider how a short description can guide attention while leaving much open. There is no need to settle every question. Allow different readings to remain possible as you decide what to explore next.";
  const draft: ResearchDraft = { labels: ["welcome", ...c.sourceAssets.map(item => item.id)].map(id => {
    const sourceSpan = id === "welcome" ? span : spans.find(item => item.id === `${id}:title`)!;
    const quote = sourceSpan.text.length > 70 ? sourceSpan.text.slice(0, 70).replace(/\s+\S*$/u, "") : sourceSpan.text;
    return { id, title: "Fixture", segments: [
    { kind: "fact", text: `The catalogue title ${quote === sourceSpan.text ? "is" : "begins"} ${quote}.`, citations: [{ spanId: sourceSpan.id, quote }] },
    { kind: "invitation", text: invitation, citations: [] },
    { kind: "uncertainty", text: "The record does not identify every person or explain every detail. Keep uncertainty visible rather than inventing an account.", citations: [] },
  ] }; }), limitations: ["Synthetic disposable caption boundary fixture only; no actual model output or human review."] };
  const content = materializeResearch(draft, spans);
  function manifest(packageId: string, body: Record<string, unknown>): ArtifactManifest {
    const id = randomUUID(); return { id, packageId, title: "Synthetic source fixture only", mediaType: "application/json", contentHash: digest(body), downloadUrl: `/api/artifacts/${id}/download`, previewUrl: null,
      sourceIds: c.sourceAssets.map(item => item.id), createdAt: new Date().toISOString(), provenance: { mode: "live", label: "Synthetic disposable boundary fixture, not commissioned production", sourceId: randomUUID(), observedAt: new Date().toISOString(), sandbox: false }, reviewStatus: "Synthetic automated precondition only", content: body };
  }
  async function saveReviewed(c: Commission, artifact: ArtifactManifest, pack: Commission["packages"][number]["acceptancePack"]) {
    const pkg = c.packages.find(item => item.id === artifact.packageId)!;
    pkg.artifactIds = [artifact.id]; pkg.acceptancePack = pack; pkg.state = "awaiting_acceptance"; c.artifacts.push(artifact);
    if (options.withProducingHistory) await syntheticSourceHistory(c, artifact, f.session);
    await transaction(async db => { c.revision++; await saveCommission(db, c); await db.query("INSERT INTO guild_verifications(id,tenant_id,commission_id,package_id,contract_version,artifact_id,artifact_hash,criteria_digest,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [randomUUID(), c.tenantId, c.id, pkg.id, pkg.contractVersion, artifact.id, artifact.contentHash, digest(pack), pack]); });
    const result = await executeCommand(f.session, c.id, { type: "record_automated_review", commandId: randomUUID(), expectedRevision: c.revision, packageId: pkg.id, artifactId: artifact.id, artifactHash: artifact.contentHash, contractVersion: pkg.contractVersion, criteriaDigest: digest(pack), findings: "Synthetic source precondition in a disposable caption integration schema. No actual generated language, human review, acceptance or payment is represented.", acknowledgeLimitations: true });
    assert.ok(result.ok);
    return { commission: result.commission, review: result.commission.artifactReviews!.at(-1)! };
  }
  const research = manifest("research", content), researchPkg = c.packages.find(item => item.id === "research")!, pack = verifyArtifact(c, researchPkg, research);
  assert.ok(pack.criteria.every(item => item.kind !== "deterministic" || item.status === "passed"), JSON.stringify(pack.criteria));
  const reviewed = await saveReviewed(c, research, pack), labels = content.labels as { id: string; title: string; body: string }[];
  const tpack = translationAcceptancePack(research), translation = manifest("translation", { ...old, contractDigest: tpack.digest, glossaryDigest: tpack.parameters!.glossaryDigest,
    translations: Object.fromEntries(locales.map(locale => [locale, Object.fromEntries(labels.map(label => [label.id, locale === "en" ? { title: label.title, body: label.body } : old.translations[locale].welcome]))])),
    sourceArtifactId: research.id, sourceArtifactHash: research.contentHash, inputBindings: [{ packageId: "research", contractVersion: researchPkg.contractVersion, artifactId: research.id, artifactHash: research.contentHash, reviewKind: "automated_review", reviewId: reviewed.review.id }] });
  for (const item of tpack.criteria) { item.status = item.kind === "deterministic" ? "passed" : "review"; item.evidence = "Synthetic exact ancestor fixture only; actual language qualification is separate."; }
  const next = await saveReviewed(reviewed.commission, translation, tpack);
  next.commission.packages.find(item => item.id === "captions")!.inputPolicy = "reviewed_drafts";
  await transaction(async db => { next.commission.revision++; await saveCommission(db, next.commission); });
  // The proposal must use the persisted JSONB view that the command will read.
  // PostgreSQL preserves values, but object-key iteration order may differ.
  const persisted = await getCommission(f.session, f.commissionId);
  const current: Fixture = { ...f, source: persisted.artifacts.find(item => item.id === translation.id)! };
  await ready(current);
  const media = new MemoryMedia(options.mediaDirectory), speech = new SyntheticSpeech(), transcription = new SyntheticAsr(current.source), dependencies = { media, speech, transcription };
  assert.equal((await finish(current, await queue(current), dependencies))?.state, "completed");
  assert.equal((await finish(current, await queue(current, "verify_artifact"), dependencies))?.state, "completed");
  const measured = await getCommission(f.session, f.commissionId), narration = measured.packages.find(item => item.kind === "narration")!, artifact = measured.artifacts.find(item => item.id === narration.artifactIds.at(-1))!;
  assert.ok(narration.acceptancePack.criteria.every(item => item.kind !== "deterministic" || item.status === "passed"), JSON.stringify(narration.acceptancePack.criteria));
  await executeCommand(f.session, measured.id, { type: "record_automated_review", commandId: randomUUID(), expectedRevision: measured.revision, packageId: narration.id, artifactId: artifact.id, artifactHash: artifact.contentHash, contractVersion: narration.contractVersion, criteriaDigest: digest(narration.acceptancePack), findings: "Synthetic audio and blind-transport check only. Exact fixture bytes passed deterministic controls; no real narration, human listening, fluent review, acceptance or payment is claimed.", acknowledgeLimitations: true });
  return { ...current, media, speech, transcription };
}
export type CaptionFixture = Awaited<ReturnType<typeof captionFixture>>;
export async function amendCaptions(f: CaptionFixture) {
  const c = await getCommission(f.session, f.commissionId), pkg = c.packages.find(item => item.kind === "captions")!, pack = await captionContractProposal(getPool(), c, pkg);
  const result = await executeCommand(f.session, c.id, { type: "amend_caption_contract", commandId: randomUUID(), expectedRevision: c.revision, packageId: pkg.id, contractVersion: pkg.contractVersion, acceptancePackDigest: pack.digest, acknowledgePromptedAlignment: true, acknowledgeOneCorrection: true });
  assert.ok(result.ok);
  await executeCommand(f.session, c.id, { type: "approve_plan", commandId: randomUUID(), expectedRevision: result.revision, planDigest: planDigest(result.commission) });
  return pack;
}
export async function queueCaptions(f: CaptionFixture, type: "produce_package" | "verify_artifact" = "produce_package") {
  const c = await getCommission(f.session, f.commissionId), pkg = c.packages.find(item => item.kind === "captions")!;
  const result = await executeCommand(f.session, c.id, type === "produce_package" ? { type, commandId: randomUUID(), expectedRevision: c.revision, packageId: pkg.id } : { type, commandId: randomUUID(), expectedRevision: c.revision, packageId: pkg.id, artifactId: pkg.artifactIds.at(-1)! });
  assert.ok(result.ok);
  return result.jobId!;
}
export async function finishCaptions(f: CaptionFixture, jobId: string, alignment: AlignmentGateway) {
  for (let i = 0; i < 750; i++) {
    await getPool().query("UPDATE guild_jobs SET available_at=now() WHERE id=$1", [jobId]);
    await getPool().query("UPDATE guild_model_runs SET poll_after=now() WHERE job_id=$1 AND poll_after IS NOT NULL", [jobId]);
    const result = await runNextJob(f.session.tenantId, { media: f.media, alignment });
    if (result?.state !== "queued") return result;
  }
  throw new Error("Bounded synthetic caption job did not finish");
}

export class SyntheticAlignment implements AlignmentGateway {
  calls = 0; inputs: AlignmentInput[] = [];
  constructor(readonly mode: "ok" | "lost" | "malformed" | "wrong_word" | "unavailable" = "ok", readonly hook?: (input: AlignmentInput) => Promise<void>, readonly afterResponse?: () => Promise<void>) {}
  preflight() { /* Synthetic fixture transport only; never reads a real provider key. */ }
  async align(input: AlignmentInput, beforeDispatch?: () => Promise<void>): Promise<AlignmentHttpReceipt> {
    await this.hook?.(input); await beforeDispatch?.(); this.calls++; this.inputs.push(input);
    if (this.mode === "lost") throw new AlignmentGatewayError("SYNTHETIC_ALIGNMENT_LOST", false);
    const row = (await getPool().query("SELECT request FROM guild_alignment_runs WHERE id=$1", [input.requestId])).rows[0];
    const c = (await getPool().query<{ snapshot: Commission }>("SELECT c.snapshot FROM guild_commissions c JOIN guild_alignment_runs a ON a.commission_id=c.id AND a.tenant_id=c.tenant_id WHERE a.id=$1", [input.requestId])).rows[0]!.snapshot;
    const source = captionSourcesFromPack(c.packages.find(item => item.kind === "captions")!.acceptancePack).tracks.find(item => item.mediaId === row.request.originalAudio.mediaId)!;
    // This positive transport fixture supplies lexical words. Punctuation is
    // retained in the complete source, never given an invented word identity.
    const parts = (source.locale === "ja" ? [...new Intl.Segmenter("ja", { granularity: "word" }).segment(source.text)].map(item => item.segment) : source.text.split(/\s+/u))
      .filter(item => /[\p{L}\p{N}\p{M}]/u.test(item));
    const durationMs = Math.floor(source.durationSeconds * 1000), weights = parts.map(part => [...new Intl.Segmenter(source.locale, { granularity: "grapheme" }).segment(part)].length + 1), sum = weights.reduce((a, b) => a + b, 0);
    let cursor = 0;
    const words = parts.map((word, i) => { const start = Math.round(cursor / sum * (durationMs - 100)); cursor += weights[i]!; const end = Math.round(cursor / sum * (durationMs - 100)); return { word, start: start / 1000, end: end / 1000 }; });
    const value = { language: source.locale, duration: source.durationSeconds, text: source.text, words, segments: [{ start: 0, end: durationMs / 1000, text: source.text }] };
    if (this.mode === "wrong_word" && this.calls === 1) value.words[0]!.word = "Changed";
    const raw = Buffer.from(this.mode === "malformed" ? "{" : this.mode === "unavailable" ? '{"error":"synthetic unavailable"}' : JSON.stringify(value)), statusCode = this.mode === "unavailable" ? 404 : 200;
    await this.afterResponse?.();
    return checkedAlignmentReceipt({ schemaVersion: "guild.timestamp-http-receipt.v1", capabilityVersion: timestampCapability.version, model: "whisper-1", requestId: input.requestId, locale: input.locale,
      audioHash: hash(input.bytes), promptHash: input.prompt.textHash, statusCode, providerRequestId: `fixture_${input.requestId}`, rawBodyBase64: raw.toString("base64"), bodyHash: hash(raw), byteLength: raw.length, bodyComplete: true,
      observedAt: new Date().toISOString(), latencyMs: 1, parsed: this.mode === "malformed" || this.mode === "unavailable" ? null : value, parseFailure: this.mode === "unavailable" ? "HTTP_STATUS" : this.mode === "malformed" ? "JSON_SCHEMA" : null });
  }
}

export function syntheticEasyReadModel() {
  const original = globalThis.fetch; let creates = 0;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    assert.equal(String(url), "https://api.openai.com/v1/responses", "only the explicitly stubbed provider endpoint is available in this test"); assert.equal(init?.method, "POST");
    creates++;
    const request = JSON.parse(init!.body as string), input = JSON.parse(request.input[1].content), locale = input.targetLocale as Locale;
    assert.equal(request.model, "gpt-6.1-sol"); assert.equal(request.reasoning.effort, "max"); assert.match(request.text.format.name, /^northlight_easy_read_v1_/);
    const value = { locale, labels: Object.fromEntries(input.requiredKeys.map((key: string) => {
      const concepts = input.registeredConcepts.filter((item: { key: string }) => item.key === key), script = input.translatedScripts.find((item: { key: string }) => item.key === key);
      return [key, { title: script.title, paragraphs: [{ text: locale === "en" ? "Look at this record. Keep its limits and uncertainty visible." : script.text.slice(0, 100), conceptIds: concepts.map((item: { id: string }) => item.id), sourceQuotes: concepts.flatMap((item: { citations: { spanId: string; quote: string }[] }) => item.citations.map(citation => ({ spanId: citation.spanId, quote: citation.quote }))) }] }];
    })), limitations: ["Synthetic schema/source fixture only; no actual model or fluent human review."] };
    return Response.json({ id: `resp_caption_fixture_${creates}`, status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(value) }] }] });
  }) as typeof fetch;
  process.env.OPENAI_API_KEY = "synthetic-caption-test-no-provider-key"; process.env.OPENAI_MODEL = "gpt-6.1-sol";
  return { count: () => creates, restore: () => { globalThis.fetch = original; process.env.OPENAI_API_KEY = ""; } };
}
