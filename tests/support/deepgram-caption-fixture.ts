import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { Commission, Locale } from "@/contracts/guild";
import { planDigest } from "@/domain/fixture";
import { deepgramLocaleModels } from "@/domain/deepgram-caption-alignment";
import { deepgramSourcesFromPack } from "@/domain/deepgram-captions";
import type { CaptionTrackSource } from "@/domain/captions";
import { blankCaptionReviewUnits, type CaptionReviewDraft, type CaptionReviewUnit } from "@/domain/caption-review";
import { executeCommand, getCommission } from "@/server/commissions";
import { getPool } from "@/server/db";
import { runNextJob } from "@/server/jobs";
import { deepgramCaptionContractProposal } from "@/server/captions/deepgram-contracts";
import { DeepgramTimestampGateway, type DeepgramTimestampInput } from "@/server/captions/deepgram-gateway";
import type { CaptionFixture } from "./caption-fixture";

export async function amendDeepgramCaptions(f: CaptionFixture) {
  const c = await getCommission(f.session, f.commissionId), pkg = c.packages.find(item => item.kind === "captions")!, pack = await deepgramCaptionContractProposal(getPool(), c, pkg);
  const result = await executeCommand(f.session, c.id, { type: "amend_deepgram_caption_contract", commandId: randomUUID(), expectedRevision: c.revision, packageId: pkg.id, contractVersion: pkg.contractVersion, acceptancePackDigest: pack.digest, acknowledgeReviewOnly: true, acknowledgeNoRecognitionRetry: true });
  assert.ok(result.ok);
  await executeCommand(f.session, c.id, { type: "approve_plan", commandId: randomUUID(), expectedRevision: result.revision, planDigest: planDigest(result.commission) });
  return pack;
}
export async function finishDeepgram(f: CaptionFixture, jobId: string, deepgram: DeepgramTimestampGateway) {
  for (let i = 0; i < 1000; i++) {
    await getPool().query("UPDATE guild_jobs SET available_at=now() WHERE id=$1", [jobId]);
    await getPool().query("UPDATE guild_model_runs SET poll_after=now() WHERE job_id=$1 AND poll_after IS NOT NULL", [jobId]);
    const result = await runNextJob(f.session.tenantId, { media: f.media, deepgram });
    if (result?.state !== "queued") return result;
  }
  throw new Error("Bounded synthetic Deepgram workflow did not complete");
}

/** Controlled transport and synthetic times exercise integration only. They
 * must never count as model, language, listening or alignment qualification. */
export class ControlledDeepgram extends DeepgramTimestampGateway {
  calls = 0; seen: { locale: Locale; audioHash: string; endpoint: string }[] = [];
  constructor(readonly mode: "ok" | "disagreements" | "silence" | "lost" | "partial" | "unavailable" = "disagreements", readonly beforeClaim?: (input: DeepgramTimestampInput) => Promise<void>) {
    let transport!: typeof fetch;
    super({ apiKey: () => "synthetic-controlled-gateway-not-a-provider-key", fetch: (...args) => transport(...args) });
    transport = (async (url: string | URL | Request, init?: RequestInit) => this.respond(String(url), init)) as typeof fetch;
  }
  override transcribe(input: DeepgramTimestampInput, beforeDispatch: () => Promise<void>) {
    return super.transcribe(input, async () => { await this.beforeClaim?.(input); await beforeDispatch(); });
  }
  private async respond(endpoint: string, init?: RequestInit) {
    const url = new URL(endpoint), locale = url.searchParams.get("language") as Locale, audioHash = createHash("sha256").update(Buffer.from(init!.body as Uint8Array)).digest("hex");
    assert.equal(url.origin + url.pathname, "https://api.deepgram.com/v1/listen"); assert.equal(init?.method, "POST");
    assert.equal(url.searchParams.get("version"), deepgramLocaleModels[locale].version);
    assert.ok(!["prompt", "keywords", "keyterm", "replace"].some(key => url.searchParams.has(key))); this.calls++; this.seen.push({ locale, audioHash, endpoint });
    if (this.mode === "lost") throw new Error("Synthetic lost dispatch; no provider endpoint was contacted");
    if (this.mode === "unavailable") return new Response('{"error":"synthetic disabled capability"}', { status: 404 });
    if (this.mode === "partial") { let chunks = 0; return new Response(new ReadableStream({ pull(controller) { if (!chunks++) controller.enqueue(new TextEncoder().encode('{"metadata":')); else controller.error(new Error("Synthetic incomplete body")); } })); }
    const row = (await getPool().query<{ snapshot: Commission; request: { scope: { mediaId: string } } }>("SELECT c.snapshot,a.request FROM guild_alignment_runs a JOIN guild_commissions c ON c.id=a.commission_id AND c.tenant_id=a.tenant_id WHERE a.state='dispatching' AND a.request->'wire'->>'audioHash'=$1 AND a.request->'wire'->>'locale'=$2 ORDER BY a.dispatched_at DESC LIMIT 1", [audioHash, locale])).rows[0]!;
    const source = deepgramSourcesFromPack(row.snapshot.packages.find(item => item.kind === "captions")!.acceptancePack).tracks.find(item => item.mediaId === row.request.scope.mediaId)!;
    const units = blankCaptionReviewUnits(source), draft = syntheticMeasuredDraft(source, units);
    const words = draft.units.map(unit => ({ word: source.text.slice(unit.sourceStart, unit.sourceEnd).trim(), start: unit.startMs! / 1000, end: unit.endMs! / 1000, confidence: 0.9 }));
    if (this.mode === "disagreements" && ["ar", "ja"].includes(locale)) words[0]!.word = locale === "ar" ? "اختلاف" : "別";
    const silent = this.mode === "silence", id = randomUUID(), model = deepgramLocaleModels[locale];
    return Response.json({ metadata: { request_id: id, duration: source.durationSeconds, channels: 1, models: [model.uuid], model_info: { [model.uuid]: { name: "Synthetic pinned model metadata fixture", version: model.version, arch: "nova-3" } } },
      results: { channels: [{ alternatives: [{ transcript: silent ? "" : words.map(word => word.word).join(locale === "ja" ? "" : " "), confidence: 0.9, words: silent ? [] : words }] }] } }, { headers: { "dg-request-id": id } });
  }
}

/** The generated numbers are only for synthetic tests, never listening evidence. */
export function syntheticMeasuredDraft(source: Pick<CaptionTrackSource, "locale" | "text" | "durationSeconds">, initial: CaptionReviewUnit[] = blankCaptionReviewUnits(source)): CaptionReviewDraft {
  const units = structuredClone(initial), weights = units.map(unit => [...new Intl.Segmenter(source.locale, { granularity: "grapheme" }).segment(source.text.slice(unit.sourceStart, unit.sourceEnd))].length), total = weights.reduce((a, b) => a + b, 0);
  const available = Math.floor(source.durationSeconds * 1000) - 100; let cursor = 0;
  return { disposition: "recognition_difference", note: "Synthetic disposable workflow fixture. These numbers and test declarations are not actual listening or acoustic qualification.", units: units.map((unit, i) => { const startMs = Math.round(cursor / total * available); cursor += weights[i]!; return { ...unit, heard: "heard", startMs, endMs: Math.round(cursor / total * available), origin: "manual", providerWordIndex: null }; }) };
}
