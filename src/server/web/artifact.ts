import type { Pool, PoolClient } from "pg";
import type { Commission, WorkPackage } from "@/contracts/guild";
import { webArtifactSchema, webAuditSummary, type WebCandidate } from "@/domain/web-audits";
import { webProductionPolicies, webSourcesFromPack } from "@/domain/web-exhibition";
import { digest, DomainError } from "@/domain/primitives";
import type { WebJobInput } from "./contracts";
import { validateWebCandidate } from "./design";

/** Every attempted operation remains visible; no hidden design or audit is dropped. */
export async function validateWebArtifactRecord(db: Pool | PoolClient, c: Commission, pkg: WorkPackage, job: { id: string; input: WebJobInput }, raw: unknown) {
  const value = webArtifactSchema.parse(raw), sources = webSourcesFromPack(pkg.acceptancePack), pipeline = webProductionPolicies[value.providerId];
  const fail = (message: string): never => { throw new DomainError("WEB_ARTIFACT_BINDING", message, 422, false); };
  const correction = job.input.webAttempt === 2 ? { id: job.input.webCorrectionId, digest: job.input.webCorrectionDigest } : null;
  if (value.productionJobId !== job.id || value.contractDigest !== pkg.acceptancePack.digest || value.sourceDigest !== digest(sources) || digest(value.sources) !== digest(sources)
    || digest(value.inputBindings) !== digest(sources.inputBindings) || value.providerId !== pkg.providerId || value.providerPolicyDigest !== job.input.webProviderPolicyDigest
    || value.attempt !== job.input.webAttempt || digest(value.correction) !== digest(correction) || value.pipelineVersion !== pipeline.version || job.input.webPipelineDigest !== digest(pipeline)
    || value.candidates.length > pipeline.maximumDesignResponsesPerJob || value.selectedOrdinal !== value.candidates.length) fail("The web artifact changed its exact source, original job, correction or provider pipeline.");
  const previous: WebCandidate[] = [];
  for (const candidate of value.candidates) {
    await validateWebCandidate(db, { tenantId: c.tenantId, jobId: job.id }, c.id, pkg, job.input, candidate, previous);
    previous.push(candidate);
  }
  const last = value.candidates.at(-1)!, summary = webAuditSummary(last.producerAudits);
  if (value.providerId === "ostrava" && summary.complete && !(summary.axe && summary.lighthouse && summary.interaction) && value.candidates.length !== pipeline.maximumDesignResponsesPerJob)
    fail("A complete failing self-audit cannot be represented as a finished bounded revision loop before its declared passes are used.");
  const models = (await db.query<{ id: string; status: string }>("SELECT id,status FROM guild_model_runs WHERE tenant_id=$1 AND job_id=$2 ORDER BY id", [c.tenantId, job.id])).rows;
  const audits = (await db.query<{ id: string; state: string }>("SELECT id,state FROM guild_web_audit_cases WHERE tenant_id=$1 AND job_id=$2 ORDER BY id", [c.tenantId, job.id])).rows;
  const bundles = (await db.query<{ id: string }>("SELECT id FROM guild_web_bundles WHERE tenant_id=$1 AND job_id=$2 ORDER BY id", [c.tenantId, job.id])).rows;
  const expectedModels = value.candidates.map(item => item.model.runId), expectedAudits = value.candidates.flatMap(item => item.producerAudits.map(receipt => receipt.id)), expectedBundles = value.candidates.map(item => item.bundleId);
  if (models.length !== expectedModels.length || models.some(item => item.status !== "completed" || !expectedModels.includes(item.id))
    || audits.length !== expectedAudits.length || audits.some(item => item.state !== "received" || !expectedAudits.includes(item.id))
    || bundles.length !== expectedBundles.length || bundles.some(item => !expectedBundles.includes(item.id))) fail("The submitted pipeline omitted or added an original model, browser or bundle attempt.");
  return value;
}
