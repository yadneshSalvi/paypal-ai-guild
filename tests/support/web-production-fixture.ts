import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { planDigest } from "@/domain/fixture";
import { digest } from "@/domain/primitives";
import { imageAcceptancePack, type ImageDescription } from "@/domain/images";
import { getPool, transaction } from "@/server/db";
import { executeCommand, getCommission, saveCommission } from "@/server/commissions";
import { buildWebSources } from "@/server/web/sources";
import { readWebSourceApproval } from "@/server/web/source-history";
import { captionFixture, amendCaptions, queueCaptions, finishCaptions, SyntheticAlignment, syntheticEasyReadModel } from "./caption-fixture";
import { finish } from "./narration-fixture";

function description(sourceId: string): ImageDescription {
  return { sourceId, alt: { en: "Synthetic fixture description of the supplied photograph.", pt: "Descrição sintética da fotografia fornecida para este teste.", es: "Descripción sintética de la fotografía proporcionada para esta prueba.", fr: "Description synthétique de la photographie fournie pour ce test.", ja: "これは提供された写真の検証用の合成説明であり、実際のレビューではありません。", ar: "هذا وصف اصطناعي للصورة المقدمة للتحقق فقط وليس مراجعة بشرية." }, visibleFeatures: ["Synthetic test output only."], uncertainties: ["This fixture does not establish description quality."], framingReason: "Retain the complete source frame for deterministic fixture checks." };
}
/** Complete five-family synthetic ancestry. Narration, image, caption production
 * and verification execute actual application jobs using denied/stub transports.
 * Research and translation explicitly retain coherent test-authored histories. */
export async function fullWebFixture(options: { webProvider?: "formwork" | "ostrava"; captionMode?: "whisper" | "deepgram-reviewed"; progress?: (message: string) => void; mediaDirectory?: string } = {}) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw Error("Unstubbed network call in synthetic web lifecycle fixture"); };
  const f = await captionFixture(12, { withProducingHistory: true, mediaDirectory: options.mediaDirectory });
  let c = await getCommission(f.session, f.commissionId);
  for (const kind of ["research", "translation"]) {
    const pkg = c.packages.find(item => item.kind === kind)!;
    await readWebSourceApproval(getPool(), c, pkg, c.artifacts.find(item => item.id === pkg.artifactIds.at(-1))!);
  }
  const image = c.packages.find(item => item.kind === "images")!;
  image.acceptancePack = imageAcceptancePack(c.sourceAssets);
  const web = c.packages.find(item => item.kind === "web")!;
  web.inputPolicy = "reviewed_drafts";
  if (options.webProvider === "ostrava") {
    // Explicit synthetic initial commercial choice, before first web production
    // and the next signed approval. Historical source approvals stay unchanged.
    web.providerId = "ostrava"; web.providerAwardMinor = 16000; web.serviceFeeMinor = 1500; web.grossMinor = 17500;
  }
  c.approvedPlanDigest = null; c.state = "awaiting_approval";
  for (const mandate of c.mandates) if (mandate.status === "active") mandate.status = "draft";
  await transaction(async db => { c.revision++; await saveCommission(db, c); });
  await executeCommand(f.session, c.id, { type: "approve_plan", commandId: randomUUID(), expectedRevision: c.revision, planDigest: planDigest(c) });
  process.env.OPENAI_API_KEY = "synthetic-web-lifecycle-never-network"; process.env.OPENAI_MODEL = "gpt-6.1-sol";
  let imageCreates = 0, imageReads = 0;
  const outputs = new Map<string, ImageDescription>();
  globalThis.fetch = async (input, init) => {
    const url = String(input); assert.ok(url.startsWith("https://api.openai.com/v1/responses"));
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)), parts = body.input[1].content; assert.ok(Array.isArray(parts));
      const data = JSON.parse(parts[0].text), id = "resp_synthetic_web_image_" + randomUUID().replaceAll("-", "");
      outputs.set(id, description(data.source.id)); imageCreates++;
      return Response.json({ id, status: "queued", output: [] });
    }
    assert.equal(init?.method ?? "GET", "GET"); const id = url.split("/").at(-1)!, output = outputs.get(id); assert.ok(output); imageReads++;
    return Response.json({ id, status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }] });
  };
  async function queue(type: "produce_package" | "verify_artifact", packageId: string) {
    const current = await getCommission(f.session, c.id), pkg = current.packages.find(item => item.id === packageId)!;
    const common = { commandId: randomUUID(), expectedRevision: current.revision, packageId };
    const result = await executeCommand(f.session, c.id, type === "produce_package" ? { ...common, type } : { ...common, type, artifactId: pkg.artifactIds.at(-1)! });
    assert.ok(result.ok && result.jobId); return result.jobId;
  }
  async function review(packageId: string) {
    const current = await getCommission(f.session, c.id), pkg = current.packages.find(item => item.id === packageId)!, artifact = current.artifacts.find(item => item.id === pkg.artifactIds.at(-1))!;
    assert.ok(pkg.acceptancePack.criteria.every(item => item.kind !== "deterministic" || item.status === "passed"), JSON.stringify(pkg.acceptancePack.criteria));
    return executeCommand(f.session, current.id, { type: "record_automated_review", commandId: randomUUID(), expectedRevision: current.revision, packageId, artifactId: artifact.id, artifactHash: artifact.contentHash, contractVersion: pkg.contractVersion, criteriaDigest: digest(pkg.acceptancePack), findings: "Complete synthetic workflow fixture only. No actual model output, human review, acceptance or payment is represented.", acknowledgeLimitations: true });
  }
  try {
    const imageJob = await queue("produce_package", "images");
    for (let step = 0; step < 250; step++) {
      await getPool().query("UPDATE guild_jobs SET available_at=now() WHERE id=$1", [imageJob]);
      await getPool().query("UPDATE guild_model_runs SET poll_after=now() WHERE job_id=$1", [imageJob]);
      const { runNextJob } = await import("@/server/jobs");
      const result = await runNextJob(f.session.tenantId, { media: f.media });
      if (result?.state === "completed") break;
      assert.equal(result?.state, "queued", JSON.stringify(result)); assert.ok(step < 249);
    }
    assert.equal((await finish(f, await queue("verify_artifact", "images"), { media: f.media }))?.state, "completed");
    await review("images");
    if (options.captionMode === "deepgram-reviewed") {
      const { syntheticReviewedDeepgramCaptions } = await import("./synthetic-caption-review");
      const captionReview = await syntheticReviewedDeepgramCaptions(f, options.progress ?? (() => {}));
      c = await getCommission(f.session, c.id);
      const source = await buildWebSources(getPool(), c, c.packages.find(item => item.kind === "web")!);
      assert.equal(source.requiredKeys.length, 13); assert.equal(source.photographs.length, 12);
      return { ...f, source, imageCreates, imageReads, alignmentCalls: 0, easyReadCalls: captionReview.counts.easyReadCalls, captionReview };
    }
    await amendCaptions(f);
    const alignment = new SyntheticAlignment(), easy = syntheticEasyReadModel();
    try {
      assert.equal((await finishCaptions(f, await queueCaptions(f), alignment))?.state, "completed");
      assert.equal((await finishCaptions(f, await queueCaptions(f, "verify_artifact"), alignment))?.state, "completed");
      await review("captions");
      c = await getCommission(f.session, c.id);
      const source = await buildWebSources(getPool(), c, c.packages.find(item => item.kind === "web")!);
      assert.equal(source.requiredKeys.length, 13); assert.equal(source.photographs.length, 12);
      assert.equal(alignment.calls, 78); assert.equal(easy.count(), 6); assert.equal(imageCreates, 12); assert.equal(imageReads, 12);
      assert.equal(c.payments.capturedMinor, 0); assert.equal(c.payments.providerPaidMinor, 0);
      return { ...f, source, imageCreates, imageReads, alignmentCalls: alignment.calls, easyReadCalls: easy.count(), captionReview: undefined };
    } finally { easy.restore(); }
  } finally { globalThis.fetch = previousFetch; process.env.OPENAI_API_KEY = ""; }
}
