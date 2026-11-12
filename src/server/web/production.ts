import { locales } from "@/contracts/guild";
import { webArtifactSchema, webAuditSummary, webCandidateSchema, type WebCandidate } from "@/domain/web-audits";
import { checkedWebDesign, webAuditPolicy, webModelPolicy } from "@/domain/web-exhibition";
import { digest, DomainError } from "@/domain/primitives";
import { renderWebFiles } from "@/exhibition/generated/render";
import { getPool, transaction } from "../db";
import { generateStructured, type ModelContext } from "../models";
import { requireProductionLease } from "../production-authority";
import { ProductionContinuation, ProductionReviewRequired } from "../production-continuation";
import { savedProductionPart, saveProductionPart } from "../production-parts";
import type { PrivateBlobGateway } from "../media/blob-store";
import type { WebAuditGateway } from "./audit-gateway";
import { runWebAudit } from "./audits";
import { createWebAuditRequest } from "./audit-request";
import { saveWebBundle } from "./bundles";
import { installedWebRuntime } from "./capability";
import { validateWebJob, type WebJobInput } from "./contracts";
import { validateWebCandidate, webCandidateInputHash, webDesignRequest } from "./design";
import { validateWebArtifactRecord } from "./artifact";

export async function produceWeb(context: ModelContext, packageId: string, dependencies: { storage?: PrivateBlobGateway; audit?: WebAuditGateway } = {}) {
  const { commission, package: pkg, job } = await transaction(db => requireProductionLease(db, context, packageId));
  if (!pkg || pkg.kind !== "web") throw new ProductionReviewRequired("WEB_CONTRACT_REQUIRED", "This producer needs the current exact measured exhibition agreement.");
  const input = job.input as WebJobInput, bound = await validateWebJob(getPool(), commission, pkg, { id: context.jobId, input }, true, context.webRuntime), runtime = await (context.webRuntime ?? installedWebRuntime).read();
  const candidates: WebCandidate[] = [];
  for (let ordinal = 1; ordinal <= bound.pipeline.maximumDesignResponsesPerJob; ordinal++) {
    const key = `web:candidate:${ordinal}:complete`, inputHash = webCandidateInputHash(pkg, context.jobId, ordinal, input);
    try {
      let candidate = await savedProductionPart(context, key, inputHash, webCandidateSchema);
      if (!candidate) {
        if (process.env.OPENAI_MODEL !== webModelPolicy.model) throw new DomainError("WEB_MODEL_UNAVAILABLE", "The exact agreed design model is not configured; another model cannot substitute for it.", 503);
        const request = await webDesignRequest(pkg, input, ordinal, candidates, context.tenantId);
        const result = await generateStructured(context, request.name, request.instruction, request.data, request.schema);
        const design = checkedWebDesign(result.data, bound.sources), rendered = renderWebFiles(bound.sources, design, runtime.authored);
        const bundleId = await saveWebBundle(context, pkg.id, ordinal, rendered.bundle, rendered.authored);
        const model = (await getPool().query<{ input_hash: string; output_hash: string; provider_response_id: string }>("SELECT input_hash,output_hash,provider_response_id FROM guild_model_runs WHERE tenant_id=$1 AND job_id=$2 AND id=$3 AND operation_key=$4 AND status='completed'", [context.tenantId, context.jobId, result.runId, request.name])).rows[0];
        if (!model || model.input_hash !== request.inputHash || model.output_hash !== digest(design)) throw new ProductionReviewRequired("WEB_MODEL_BINDING", "The saved original design no longer matches its frozen request and output.");
        const producerAudits: WebCandidate["producerAudits"] = [];
        if (bound.commercial.providerId === "ostrava") for (const locale of locales) for (const viewport of webAuditPolicy.viewports) {
          const auditRequest = await createWebAuditRequest(context, commission, pkg, bundleId, "producer", locale, viewport);
          producerAudits.push(await runWebAudit(context, pkg.id, bundleId, bound.sources, auditRequest, dependencies));
        }
        candidate = webCandidateSchema.parse({ ordinal, design, designDigest: digest(design), bundleId, bundle: rendered.bundle,
          model: { runId: result.runId, model: result.model, inputHash: model.input_hash, outputHash: model.output_hash, providerResponseId: model.provider_response_id }, producerAudits });
        await validateWebCandidate(getPool(), context, commission.id, pkg, input, candidate, candidates);
        candidate = await saveProductionPart(context, key, inputHash, candidate, webCandidateSchema);
      } else await validateWebCandidate(getPool(), context, commission.id, pkg, input, candidate, candidates);
      candidates.push(candidate);
      const measured = webAuditSummary(candidate.producerAudits);
      if (bound.commercial.providerId === "formwork" || !measured.complete || measured.axe && measured.lighthouse && measured.interaction) break;
    } catch (error) {
      if (error instanceof ProductionContinuation) {
        const completed = (await getPool().query<{ count: string }>("SELECT count(*) FROM guild_web_audit_cases WHERE tenant_id=$1 AND job_id=$2 AND case_key LIKE $3 AND state='received'", [context.tenantId, context.jobId, `producer:${ordinal}:%`])).rows[0]!.count;
        throw new ProductionContinuation(`Exhibition · design ${ordinal} of at most ${bound.pipeline.maximumDesignResponsesPerJob}; ${completed} of ${bound.commercial.providerId === "ostrava" ? 18 : 0} producer browser cases retained. ${error.step}.`, error.retryAfterSeconds);
      }
      throw error;
    }
  }
  const content = webArtifactSchema.parse({ schemaVersion: "guild.exhibition.v2", contractDigest: pkg.acceptancePack.digest, sourceDigest: digest(bound.sources), sources: bound.sources,
    productionJobId: context.jobId, providerId: bound.commercial.providerId, providerPolicyDigest: bound.commercial.providerPolicyDigest, pipelineVersion: bound.pipeline.version,
    attempt: bound.attempt, correction: bound.correction, inputBindings: bound.inputBindings, candidates, selectedOrdinal: candidates.length,
    originalMediaUnchanged: true, newNarration: false, fluentHumanReviewed: false, humanExperienceReviewed: false,
    limitations: ["This bounded design uses original metadata and previously supplied image descriptions; it does not newly inspect pixels or claim curator fidelity review.",
      "All supplied labels, original recordings, timed captions and source-linked easy read remain unchanged. Prior blind recognition and language advisories remain attached to their original artifacts.",
      bound.commercial.providerId === "formwork" ? "Formwork produced one original design without a producer accessibility audit. The separate independent 18-case audit is still required." : "Studio Ostrava retained every design and original 18-case self-audit, stopping after a measured pass, incomplete engine outcome or its third pass. A separate independent audit is still required.",
      "Human keyboard, screen-reader, visual, crop, language and listening review remain separate. No acceptance, publication or payment is asserted."] });
  await validateWebArtifactRecord(getPool(), commission, pkg, { id: context.jobId, input }, content);
  await transaction(db => requireProductionLease(db, context, pkg.id));
  const last = candidates.at(-1)!;
  return { content: content as unknown as Record<string, unknown>, runId: last.model.runId, model: last.model.model,
    title: `${bound.commercial.providerId === "ostrava" ? "Studio Ostrava" : "Formwork"} · complete six-language exhibition`, sourceIds: bound.sources.photographs.map(item => item.id),
    provenanceLabel: `${bound.commercial.providerId === "ostrava" ? "Studio Ostrava" : "Formwork"} design · original source and recordings · independent checks pending` };
}
