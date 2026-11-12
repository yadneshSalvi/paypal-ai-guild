import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { locales } from "@/contracts/guild";
import { planDigest } from "@/domain/fixture";
import { digest } from "@/domain/primitives";
import { webArtifactSchema } from "@/domain/web-audits";
import { getPool, transaction } from "@/server/db";
import { executeCommand, getCommission, saveCommission } from "@/server/commissions";
import { runNextJob } from "@/server/jobs";
import type { Session } from "@/server/session";
import { webContractProposal } from "@/server/web/contracts";
import { fullWebFixture } from "./web-production-fixture";
import { syntheticDesignFor, syntheticWebRuntime, SyntheticWebAudit } from "./synthetic-web";

export const syntheticPublicationDisclosure = "SYNTHETIC PUBLICATION FIXTURE. Acceptance identities and review flags are fictional test records. No person reviewed or accepted this work; no fluent-language review, real model/browser qualification, commissioned speech or payment is claimed.";
export async function syntheticPublicationActor(tenantId: string, role: Session["role"] = "owner") {
  const id = randomUUID(), token = `synthetic-publication-${randomBytes(24).toString("base64url")}`, expiresAt = new Date(Date.now() + 8 * 3600_000).toISOString();
  await getPool().query("INSERT INTO guild_sessions(id,tenant_id,token_hash,role,expires_at) VALUES($1,$2,$3,$4,$5)", [id, tenantId, createHash("sha256").update(token).digest("hex"), role, expiresAt]);
  return { session: { id, tenantId, role, expiresAt } satisfies Session, cookie: `${token}.${createHmac("sha256", process.env.JUDGE_SESSION_SECRET!).update(token).digest("hex")}` };
}

/** Only imported by isolated tests/scripts. The production policy has no fixture
 * bypass. Seeded humanReviewed:true values exercise that policy as synthetic
 * inputs, and every disclosure explicitly denies real human participation. */
export async function publicationFixture(label = "contract", progress: (message: string) => void = () => {}) {
  progress("Building complete synthetic five-family ancestry through application jobs.");
  const f = await fullWebFixture({ webProvider: "formwork" }), runtime = await syntheticWebRuntime(), audit = new SyntheticWebAudit();
  let c = await getCommission(f.session, f.commissionId), pkg = c.packages.find(item => item.kind === "web")!;
  const pack = await webContractProposal(getPool(), c, pkg, runtime);
  const amended = await executeCommand(f.session, c.id, { type: "amend_web_contract", commandId: randomUUID(), expectedRevision: c.revision, packageId: pkg.id, contractVersion: pkg.contractVersion,
    acceptancePackDigest: pack.digest, acknowledgeOriginalSources: true, acknowledgePipelineAndLimits: true }, { webRuntime: runtime });
  assert.ok(amended.ok);
  const approval = await executeCommand(f.session, c.id, { type: "approve_plan", commandId: randomUUID(), expectedRevision: amended.revision, planDigest: planDigest(amended.commission) }, { webRuntime: runtime });
  assert.ok(approval.ok);
  const originalFetch = globalThis.fetch; let modelCreates = 0, modelReads = 0;
  globalThis.fetch = async (url, init) => {
    assert.ok(String(url).startsWith("https://api.openai.com/v1/responses"), "Only the synthetic design transport is available.");
    if (init?.method === "POST") { modelCreates++; return Response.json({ id: "resp_synthetic_publication_original", status: "queued", output: [] }); }
    modelReads++;
    return Response.json({ id: "resp_synthetic_publication_original", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(syntheticDesignFor(f.source)) }] }] });
  };
  process.env.OPENAI_API_KEY = "synthetic-publication-never-network"; process.env.OPENAI_MODEL = "gpt-6.1-sol";
  async function queue(type: "produce_package" | "verify_artifact") {
    c = await getCommission(f.session, c.id); pkg = c.packages.find(item => item.kind === "web")!;
    const common = { commandId: randomUUID(), expectedRevision: c.revision, packageId: pkg.id };
    const result = await executeCommand(f.session, c.id, type === "produce_package" ? { ...common, type } : { ...common, type, artifactId: pkg.artifactIds.at(-1)! }, { webRuntime: runtime });
    assert.ok(result.ok && result.jobId); return result.jobId;
  }
  async function finish(jobId: string) {
    for (let step = 0; step < 1000; step++) {
      await getPool().query("UPDATE guild_jobs SET available_at=now() WHERE id=$1", [jobId]);
      await getPool().query("UPDATE guild_model_runs SET poll_after=now() WHERE job_id=$1", [jobId]);
      const result = await runNextJob(f.session.tenantId, { media: f.media, audit, webRuntime: runtime });
      if (result?.state !== "queued") { assert.equal(result?.state, "completed", JSON.stringify({ result, saved: (await getPool().query("SELECT error FROM guild_jobs WHERE id=$1", [jobId])).rows[0] })); return; }
    }
    throw Error("The bounded synthetic publication fixture job did not finish.");
  }
  try {
    progress("Producing one original Formwork design with a synthetic model transport."); await finish(await queue("produce_package"));
    progress("Verifying every original file and all 18 synthetic independent browser cases."); await finish(await queue("verify_artifact"));
  } finally { globalThis.fetch = originalFetch; process.env.OPENAI_API_KEY = ""; }
  c = await getCommission(f.session, c.id); pkg = c.packages.find(item => item.kind === "web")!;
  const artifact = c.artifacts.find(item => item.id === pkg.artifactIds.at(-1))!, web = webArtifactSchema.parse(artifact.content);
  assert.equal(audit.calls, 18); assert.equal(modelCreates, 1); assert.equal(modelReads, 1);
  const owner = await syntheticPublicationActor(f.session.tenantId), acceptedIds: string[] = [];
  progress("Seeding explicitly fictional owner decisions in the isolated fixture only.");
  await transaction(async db => {
    for (const item of [{ kind: "web", artifactId: artifact.id, artifactHash: artifact.contentHash, packageId: pkg.id, contractVersion: pkg.contractVersion }, ...web.sources.ancestors]) {
      const sourcePackage = c.packages.find(value => value.id === item.packageId)!;
      assert.ok(sourcePackage.acceptancePack.criteria.every(criterion => criterion.kind !== "deterministic" || !criterion.blocking || criterion.status === "passed"));
      const at = new Date().toISOString(), id = randomUUID(); acceptedIds.push(id);
      const disclosures = { humanReviewed: true, fluentReviewed: false, actorKind: "owner", disclosure: syntheticPublicationDisclosure, mode: "live", syntheticFixture: true,
        ...(item.kind === "translation" ? { languages: Object.fromEntries(locales.map(locale => [locale, { fluentReviewed: false, reviewer: null, reviewedAt: null, disclosure: syntheticPublicationDisclosure,
          curatorAcknowledged: true, acknowledgedAt: at, actorKind: "owner", syntheticFixture: true }])) } : {}) };
      await db.query("INSERT INTO guild_acceptance_decisions(id,tenant_id,commission_id,package_id,contract_version,artifact_id,artifact_hash,criteria_digest,actor_id,decision,review_disclosures,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'accepted',$10,$11)", [id, c.tenantId, c.id, item.packageId, item.contractVersion, item.artifactId, item.artifactHash, sourcePackage.acceptancePack.digest, owner.session.id, disclosures, at]);
      sourcePackage.state = "accepted"; sourcePackage.acceptedAt = at; sourcePackage.acceptedBy = owner.session.id; sourcePackage.paymentState = "not_eligible";
      for (const criterion of sourcePackage.acceptancePack.criteria.filter(value => value.kind === "human")) { criterion.status = "passed"; criterion.evidence = syntheticPublicationDisclosure; }
    }
    c.title = `Synthetic publication fixture · ${label}`; c.state = "delivered"; c.revision++; await saveCommission(db, c);
  });
  assert.equal(c.payments.capturedMinor, 0); assert.equal(c.payments.providerPaidMinor, 0);
  return { ...f, owner: owner.session, cookie: owner.cookie, artifactId: artifact.id, selectedOrdinal: web.selectedOrdinal, bundle: web.candidates[web.selectedOrdinal - 1]!.bundle,
    source: web.sources, acceptedIds, disclosure: syntheticPublicationDisclosure, counts: { modelCreates, modelReads, auditCalls: audit.calls, narrationTracks: 78, captionTracks: 78, imageCreates: f.imageCreates } };
}
