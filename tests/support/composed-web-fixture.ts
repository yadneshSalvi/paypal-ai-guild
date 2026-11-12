import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { locales } from "@/contracts/guild";
import { planDigest } from "@/domain/fixture";
import { webArtifactSchema } from "@/domain/web-audits";
import { getPool, transaction } from "@/server/db";
import { executeCommand, getCommission, saveCommission } from "@/server/commissions";
import { runNextJob } from "@/server/jobs";
import { webContractProposal } from "@/server/web/contracts";
import { fullWebFixture } from "./web-production-fixture";
import { syntheticWebRuntime, syntheticDesignFor, SyntheticWebAudit } from "./synthetic-web";
import { syntheticPublicationActor, syntheticPublicationDisclosure } from "./web-publication-fixture";

/** Retained integration fixture. Every provider/model/browser result is an
 * explicit synthetic transport. The first original design deliberately fails
 * only to exercise application correction/history, never to claim a measured
 * production defect or a real human acceptance. */
export async function composedWebFixture(label: string, progress: (message: string) => void, options: { captionMode?: "whisper" | "deepgram-reviewed"; mediaDirectory?: string } = {}) {
  progress("Building complete synthetic source ancestry through real application jobs.");
  const f = await fullWebFixture({ webProvider: "ostrava", captionMode: options.captionMode, progress, mediaDirectory: options.mediaDirectory }), runtime = await syntheticWebRuntime(), audit = new SyntheticWebAudit(true);
  let commission = await getCommission(f.session, f.commissionId), pkg = commission.packages.find(item => item.kind === "web")!;
  const pack = await webContractProposal(getPool(), commission, pkg, runtime);
  const amended = await executeCommand(f.session, commission.id, { type: "amend_web_contract", commandId: randomUUID(), expectedRevision: commission.revision, packageId: pkg.id,
    contractVersion: pkg.contractVersion, acceptancePackDigest: pack.digest, acknowledgeOriginalSources: true, acknowledgePipelineAndLimits: true }, { webRuntime: runtime });
  assert.ok(amended.ok);
  const approved = await executeCommand(f.session, commission.id, { type: "approve_plan", commandId: randomUUID(), expectedRevision: amended.revision, planDigest: planDigest(amended.commission) }, { webRuntime: runtime });
  assert.ok(approved.ok);
  const originalFetch = globalThis.fetch; let modelCreates = 0, modelReads = 0;
  const outputs = new Map<string, ReturnType<typeof syntheticDesignFor>>();
  globalThis.fetch = async (url, init) => {
    assert.ok(String(url).startsWith("https://api.openai.com/v1/responses"));
    if (init?.method === "POST") {
      modelCreates++; assert.ok(modelCreates <= 2);
      const body = JSON.parse(String(init.body)), input = JSON.parse(body.input[1].content);
      if (modelCreates === 1) assert.equal(input.previous.length, 0);
      else { assert.equal(input.previous.length, 1); assert.equal(input.previous[0].findings.length, 18); }
      const id = "resp_synthetic_composition_" + randomUUID().replaceAll("-", ""), design = syntheticDesignFor(f.source);
      if (modelCreates === 2) design.typography.bodySize = 18;
      outputs.set(id, design); return Response.json({ id, status: "queued", output: [] });
    }
    assert.equal(init?.method ?? "GET", "GET"); modelReads++;
    const id = String(url).split("/").at(-1)!, output = outputs.get(id); assert.ok(output);
    return Response.json({ id, status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }] });
  };
  process.env.OPENAI_API_KEY = "synthetic-composition-never-network"; process.env.OPENAI_MODEL = "gpt-6.1-sol";
  async function queue(type: "produce_package" | "verify_artifact") {
    commission = await getCommission(f.session, commission.id); pkg = commission.packages.find(item => item.kind === "web")!;
    const common = { commandId: randomUUID(), expectedRevision: commission.revision, packageId: pkg.id };
    const result = await executeCommand(f.session, commission.id, type === "produce_package" ? { ...common, type } : { ...common, type, artifactId: pkg.artifactIds.at(-1)! }, { webRuntime: runtime });
    assert.ok(result.ok && result.jobId); return result.jobId;
  }
  async function finish(jobId: string) {
    for (let step = 0; step < 1000; step++) {
      await getPool().query("UPDATE guild_jobs SET available_at=now() WHERE id=$1", [jobId]);
      await getPool().query("UPDATE guild_model_runs SET poll_after=now() WHERE job_id=$1", [jobId]);
      const result = await runNextJob(f.session.tenantId, { media: f.media, audit, webRuntime: runtime });
      if (result?.state !== "queued") { assert.equal(result?.state, "completed", JSON.stringify({ result, saved: (await getPool().query("SELECT error FROM guild_jobs WHERE id=$1", [jobId])).rows[0] })); return; }
    }
    throw Error("The bounded synthetic composed-web fixture did not finish.");
  }
  let producingJob: string, independentJob: string;
  try {
    progress("Retaining the first synthetic failing design and source-linked repair feedback.");
    producingJob = await queue("produce_package"); await finish(producingJob);
    progress("Checking every selected original byte and 18 independent synthetic cases.");
    independentJob = await queue("verify_artifact"); await finish(independentJob);
  } finally { globalThis.fetch = originalFetch; process.env.OPENAI_API_KEY = ""; }
  commission = await getCommission(f.session, commission.id); pkg = commission.packages.find(item => item.kind === "web")!;
  const artifact = commission.artifacts.find(item => item.id === pkg.artifactIds.at(-1))!, web = webArtifactSchema.parse(artifact.content);
  assert.equal(web.candidates.length, 2); assert.equal(web.selectedOrdinal, 2); assert.equal(audit.calls, 54); assert.equal(modelCreates, 2); assert.equal(modelReads, 2);
  const actor = f.captionReview ? { session: f.captionReview.owner, cookie: f.captionReview.cookie } : await syntheticPublicationActor(f.session.tenantId), acceptedIds: string[] = [];
  progress("Adding clearly fictional fixture owner decisions through the isolated test seam.");
  await transaction(async db => {
    for (const item of [{ kind: "web", artifactId: artifact.id, artifactHash: artifact.contentHash, packageId: pkg.id, contractVersion: pkg.contractVersion }, ...web.sources.ancestors]) {
      const sourcePackage = commission.packages.find(value => value.id === item.packageId)!;
      if (sourcePackage.state === "accepted") {
        const existing = (await db.query<{ id: string }>("SELECT id FROM guild_acceptance_decisions WHERE tenant_id=$1 AND commission_id=$2 AND package_id=$3 AND contract_version=$4 AND artifact_id=$5 AND artifact_hash=$6 AND decision='accepted' ORDER BY created_at DESC LIMIT 1", [commission.tenantId, commission.id, item.packageId, item.contractVersion, item.artifactId, item.artifactHash])).rows[0];
        assert.ok(existing && f.captionReview); acceptedIds.push(existing.id); continue;
      }
      assert.ok(sourcePackage.acceptancePack.criteria.every(criterion => criterion.kind !== "deterministic" || !criterion.blocking || criterion.status === "passed"));
      const at = new Date().toISOString(), id = randomUUID(); acceptedIds.push(id);
      const disclosures = { humanReviewed: true, fluentReviewed: false, actorKind: "owner", disclosure: syntheticPublicationDisclosure, mode: "live", syntheticFixture: true,
        ...(item.kind === "translation" ? { languages: Object.fromEntries(locales.map(locale => [locale, { fluentReviewed: false, reviewer: null, reviewedAt: null, disclosure: syntheticPublicationDisclosure,
          curatorAcknowledged: true, acknowledgedAt: at, actorKind: "owner", syntheticFixture: true }])) } : {}) };
      await db.query("INSERT INTO guild_acceptance_decisions(id,tenant_id,commission_id,package_id,contract_version,artifact_id,artifact_hash,criteria_digest,actor_id,decision,review_disclosures,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'accepted',$10,$11)",
        [id, commission.tenantId, commission.id, item.packageId, item.contractVersion, item.artifactId, item.artifactHash, sourcePackage.acceptancePack.digest, actor.session.id, disclosures, at]);
      sourcePackage.state = "accepted"; sourcePackage.acceptedAt = at; sourcePackage.acceptedBy = actor.session.id; sourcePackage.paymentState = "not_eligible";
      for (const criterion of sourcePackage.acceptancePack.criteria.filter(value => value.kind === "human")) { criterion.status = "passed"; criterion.evidence = syntheticPublicationDisclosure; }
    }
    commission.title = "Synthetic composition fixture · " + label; commission.state = "delivered"; commission.revision++; await saveCommission(db, commission);
  });
  assert.equal(commission.payments.capturedMinor, 0); assert.equal(commission.payments.providerPaidMinor, 0);
  return { ...f, originalSession: f.session, owner: actor.session, cookie: actor.cookie, artifactId: artifact.id, selectedOrdinal: web.selectedOrdinal,
    source: web.sources, bundle: web.candidates[web.selectedOrdinal - 1]!.bundle, acceptedIds, producingJob, independentJob,
    disclosure: syntheticPublicationDisclosure, counts: { modelCreates, modelReads, auditCalls: audit.calls, producerReports: 36, independentReports: 18, narrationTracks: 78, captionTracks: 78, imageCreates: f.imageCreates } };
}
