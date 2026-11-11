import { z } from "zod";
import type { ArtifactManifest, Locale } from "@/contracts/guild";
import { digest } from "@/domain/primitives";
import { backTranslationSchema, backTranslationSimilarity, blindBackTranslationInstructionV2, researchTranslationSource, translationArtifactSchema, translationStandard } from "@/domain/translation";
import { getPool, transaction } from "../db";
import { requireVerificationLease, type ProductionLease } from "../production-authority";
import { ProductionReviewRequired } from "../production-continuation";
import { initialTranslationChecks } from "./translation-checks";
import { runVerifierBatch } from "./verifier-batches";
import type { VerifierBatchGateway } from "./gemini-batch-gateway";

export async function verifyTranslation(context: ProductionLease, gateway?: VerifierBatchGateway) {
  const { commission, package: pkg, artifact } = await transaction(db => requireVerificationLease(db, context));
  const retained = (await getPool().query<{ content_hash: string; manifest: ArtifactManifest }>("SELECT content_hash,manifest FROM guild_artifacts WHERE tenant_id=$1 AND commission_id=$2 AND id=$3 AND package_id=$4", [context.tenantId, commission.id, artifact.id, pkg.id])).rows[0];
  if (!retained || retained.content_hash !== artifact.contentHash || digest(retained.manifest.content) !== artifact.contentHash || retained.manifest.provenance.sourceId !== artifact.provenance.sourceId) throw new ProductionReviewRequired("TRANSLATION_ARTIFACT_CHANGED", "The current submission differs from the immutable artifact record. No new independent request was sent.");
  const sourceId = pkg.acceptancePack.parameters?.sourceArtifactId;
  const source = (await getPool().query<{ manifest: ArtifactManifest; content_hash: string }>("SELECT manifest,content_hash FROM guild_artifacts WHERE tenant_id=$1 AND commission_id=$2 AND id=$3 AND package_id='research'", [context.tenantId, commission.id, sourceId])).rows[0];
  if (!source || source.content_hash !== pkg.acceptancePack.parameters?.sourceArtifactHash || digest(source.manifest.content) !== source.content_hash) throw new ProductionReviewRequired("TRANSLATION_SOURCE_CHANGED", "The verification contract's exact research artifact is unavailable or changed. No substitute was used.");
  const { pack, report } = initialTranslationChecks(pkg, artifact, source.manifest), parsed = translationArtifactSchema.safeParse(artifact.content);
  const result = { pack, report: { ...report, backTranslation: null as unknown } };
  if (!parsed.success) return result;
  const origin = (await getPool().query<{ job_id: string; input: { packageId: string; contractVersion: number; inputBindings: unknown }; state: string }>("SELECT m.job_id,j.input,j.state FROM guild_model_runs m JOIN guild_jobs j ON j.id=m.job_id AND j.tenant_id=m.tenant_id WHERE m.id=$1 AND m.tenant_id=$2 AND j.commission_id=$3 AND j.type='produce_package'", [artifact.provenance.sourceId, context.tenantId, commission.id])).rows[0];
  const runs = origin ? (await getPool().query<{ id: string; model: string; output: { locale: Locale; labels: unknown }; output_hash: string; status: string }>("SELECT id,model,output,output_hash,status FROM guild_model_runs WHERE tenant_id=$1 AND job_id=$2 AND id=ANY($3::uuid[])", [context.tenantId, origin.job_id, parsed.data.modelRuns.map(item => item.id)])).rows : [];
  const provenance = new Set(parsed.data.modelRuns.map(item => item.id)).size === 5 && parsed.data.modelRuns.some(item => item.id === artifact.provenance.sourceId) && parsed.data.modelRuns.map(item => item.locale).sort().join("|") === "ar|es|fr|ja|pt" && origin?.state === "completed" && origin.input.packageId === pkg.id && origin.input.contractVersion === pkg.contractVersion && digest(origin.input.inputBindings) === digest(parsed.data.inputBindings) && parsed.data.modelRuns.every(item => runs.some(run => run.id === item.id && run.model === item.model && run.status === "completed" && run.output_hash === digest(run.output) && run.output.locale === item.locale && digest(run.output.labels) === digest(parsed.data.translations[item.locale])));
  if (!provenance) { const check = pack.criteria.find(item => item.id === "source")!; check.status = "failed"; check.evidence = "The translation does not bind to five complete original model outputs under this exact contract version."; return result; }
  // Run the advisory even when a deterministic linguistic check fails. Do not
  // hide a provider output or quietly regenerate it to obtain a passing score.
  const english = researchTranslationSource(source.manifest), keys = Object.keys(english), schema = backTranslationSchema(keys);
  const requests = parsed.data.modelRuns.map(run => ({ key: run.locale, instruction: blindBackTranslationInstructionV2, input: { targetLocale: run.locale, labels: parsed.data.translations[run.locale] }, schema: z.toJSONSchema(schema), schemaFormat: translationStandard.backTranslation.schemaFormat }));
  const back = await runVerifierBatch(context, "translation-back-translation-v2", { model: translationStandard.backTranslation.model, temperature: translationStandard.backTranslation.temperature, requests }, schema, gateway);
  const advisory = pack.criteria.find(item => item.id === "back_translation")!;
  if (!back.available) {
    result.report.backTranslation = back; advisory.status = "review"; advisory.evidence = `The original independent batch is retained with ${back.code}. No new request replaced it. Read every locale directly; no back-translation quality claim or human review is inferred.`;
    return result;
  }
  const findings = back.items.map(item => ({ locale: item.key, modelVersion: item.modelVersion, responseId: item.responseId, errorCode: item.errorCode, limitations: item.data?.limitations ?? [], labels: item.data ? keys.map(key => ({ key, source: english[key]!, backTranslation: item.data!.labels[key]!, title: backTranslationSimilarity(english[key]!.title, item.data!.labels[key]!.title), body: backTranslationSimilarity(english[key]!.body, item.data!.labels[key]!.body) })) : [] }));
  const scores = findings.flatMap(item => item.labels.map(label => label.body.score)), complete = findings.length === 5 && findings.every(item => !item.errorCode && item.labels.length === keys.length);
  result.report.backTranslation = { available: true, runId: back.runId, model: back.model, batchBodyHash: back.bodyHash, method: translationStandard.comparison, originalEnglishWithheld: true, findings, complete, humanReviewed: false };
  // Advisory scores stay REVIEW, including when every score exceeds the floor.
  advisory.status = "review";
  advisory.evidence = complete ? `Gemini independently back-translated all ${scores.length} target-language bodies without seeing the original English. ${scores.filter(score => score >= 0.85).length}/${scores.length} reached the proposed lexical F1 floor 0.85; minimum ${Math.min(...scores).toFixed(3)}. This lexical score can miss negation and other meaning errors. Read the full comparisons and per-language calibration; fluent or disclosed curator review remains required.` : "The independent batch returned an incomplete advisory. Available passages and every failed request remain in the report. No semantic pass was inferred.";
  return result;
}
