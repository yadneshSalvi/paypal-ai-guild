import { randomUUID } from "node:crypto";
import { z } from "zod";
import { locales, type Commission } from "@/contracts/guild";
import { easyReadFileSchema, easyReadStandard, captionAuthorityCeilingSchema, type CaptionSources, type CaptionTrackSource, type EasyReadFile } from "@/domain/captions";
import { deepgramCaptionArtifactSchema, deepgramCaptionTrackSchema, deepgramCandidateSchema, type DeepgramCaptionTrack } from "@/domain/deepgram-captions";
import { buildDeepgramCaptionCandidate } from "@/domain/deepgram-source-mapping";
import { renderCaptionVtt } from "@/domain/caption-alignment";
import { digest, DomainError } from "@/domain/primitives";
import { getPool, transaction } from "../db";
import { generateStructured, type ModelContext } from "../models";
import { requireProductionLease } from "../production-authority";
import { ProductionContinuation, ProductionReviewRequired } from "../production-continuation";
import { saveProductionPart, savedProductionPart } from "../production-parts";
import { readOwnedMedia, storeMedia } from "../media/objects";
import type { PrivateBlobGateway } from "../media/blob-store";
import { validateDeepgramCaptionJob, type DeepgramCaptionJobInput } from "./deepgram-contracts";
import { runDeepgramOnce, type DeepgramRunScope } from "./deepgram-runs";
import { DeepgramGatewayError, type DeepgramTimestampGateway } from "./deepgram-gateway";
import { captionEasyReadRequest } from "./easy-read";
import { captionOwnedArtifact } from "./sources";
import { readCaptionReviewRevision } from "./review";

const observedPart = z.object({ alignmentRunId: z.string().uuid(), receiptHash: z.string().regex(/^[a-f0-9]{64}$/), observationJobId: z.string().uuid(), candidate: deepgramCandidateSchema }).strict();
export function deepgramCaptionVttMetadata(contractDigest: string, sources: CaptionSources, source: CaptionTrackSource, track: Pick<DeepgramCaptionTrack, "alignmentRunId" | "receiptHash" | "observationJobId" | "candidate" | "reviewRevision" | "effective">) {
  return { schemaVersion: "northlight.deepgram-caption-vtt.v1", contractDigest, sourceDigest: digest(sources), sourceTrackDigest: digest(source), locale: source.locale, key: source.key,
    audioMediaId: source.mediaId, audioHash: source.audioHash, scriptBytesHash: source.scriptBytesHash, originalProducingJobId: source.origin.productionJobId,
    sourceArtifactId: sources.narration.artifactId, sourceArtifactHash: sources.narration.artifactHash, alignmentRunId: track.alignmentRunId, receiptHash: track.receiptHash,
    observationJobId: track.observationJobId, automaticCandidateHash: digest(track.candidate), reviewRevision: track.reviewRevision, effective: track.effective,
    automatedQualification: "not-qualified", productionAccepted: false };
}

async function recognize(context: ModelContext, commission: Commission, packageId: string, sources: CaptionSources, source: CaptionTrackSource, gateway?: DeepgramTimestampGateway, storage?: PrivateBlobGateway) {
  const pkg = commission.packages.find(item => item.id === packageId)!;
  const original = await readOwnedMedia(context.tenantId, source.mediaId, storage);
  if (original.row.commission_id !== commission.id || original.row.package_id !== source.origin.packageId || original.row.job_id !== source.origin.productionJobId
    || original.row.content_hash !== source.audioHash || original.bytes.length !== source.byteLength || original.row.media_type !== "audio/mpeg")
    throw new ProductionReviewRequired("DEEPGRAM_SOURCE_BINDING", "Only the exact unchanged original recording may enter this review job.");
  const scope: DeepgramRunScope = { tenantId: context.tenantId, commissionId: commission.id, jobId: context.jobId, packageId, mediaId: source.mediaId, producingJobId: source.origin.productionJobId,
    sourceArtifactHash: sources.narration.artifactHash, sourceTextHash: source.scriptBytesHash, agreementDigest: pkg.acceptancePack.digest,
    authorityExpiresAt: captionAuthorityCeilingSchema.parse(pkg.acceptancePack.parameters?.authorityCeiling).expiresAt, operationKey: `caption:${source.locale}:${source.mediaId}` };
  const previous = (await getPool().query<{ id: string }>("SELECT id FROM guild_alignment_runs WHERE tenant_id=$1 AND job_id=$2 AND operation_key=$3", [context.tenantId, context.jobId, `deepgram:${scope.operationKey}`])).rows[0];
  const input = { requestId: previous?.id ?? randomUUID(), bytes: original.bytes, mimeType: "audio/mpeg" as const, locale: source.locale };
  try {
    return await runDeepgramOnce(scope, input, { async authorize(db, received) {
      const authority = await requireProductionLease(db, context, packageId);
      if (!authority.package || authority.package.acceptancePack.version !== "3.0.0" || authority.job.input.captionAttempt !== 1 || authority.package.deepgramCaptionCorrection
        || digest(received) !== digest(scope) || authority.commission.id !== commission.id || authority.package.acceptancePack.digest !== scope.agreementDigest)
        throw new ProductionReviewRequired("DEEPGRAM_DISPATCH_AUTHORITY", "This exact first review job needs its current signed Passport, active actor, source and worker lease. The correction assembly cannot send recognition.");
      const current = await validateDeepgramCaptionJob(db, authority.commission, authority.package, { id: context.jobId, input: authority.job.input });
      if (current.attempt !== 1 || digest(current.sources) !== digest(sources) || !current.sources.tracks.some(item => digest(item) === digest(source)))
        throw new ProductionReviewRequired("DEEPGRAM_DISPATCH_SOURCE", "The complete current source register differs from this original request.");
    } }, gateway);
  } catch (error) {
    if (error instanceof DeepgramGatewayError || error instanceof DomainError) throw new ProductionReviewRequired(error.code,
      error instanceof DomainError ? error.message : "The exact original recognition request needs attention. Its saved identity and any original response remain evidence. No retry or substitute recording was sent.");
    throw error;
  }
}

export async function produceDeepgramCaptions(context: ModelContext, commission: Commission, packageId: string, dependencies: { storage?: PrivateBlobGateway; deepgram?: DeepgramTimestampGateway } = {}) {
  const pkg = commission.packages.find(item => item.id === packageId)!;
  const job = (await getPool().query<{ id: string; input: DeepgramCaptionJobInput }>("SELECT id,input FROM guild_jobs WHERE tenant_id=$1 AND id=$2", [context.tenantId, context.jobId])).rows[0];
  if (!job) throw new ProductionReviewRequired("DEEPGRAM_REVIEW_JOB_BINDING", "The exact saved review job is unavailable.");
  const bound = await validateDeepgramCaptionJob(getPool(), commission, pkg, job), tracks: DeepgramCaptionTrack[] = [];
  const base = bound.correction ? deepgramCaptionArtifactSchema.parse((await captionOwnedArtifact(getPool(), commission, bound.correction.proposal.baseArtifactId, bound.correction.proposal.baseArtifactHash)).content) : null;
  for (const source of bound.sources.tracks) {
    const key = `deepgram-caption:${source.locale}:${source.key}`, partInput = digest({ jobId: job.id, contractDigest: pkg.acceptancePack.digest, sourceDigest: digest(bound.sources), sourceTrackDigest: digest(source), attempt: bound.attempt, correction: bound.correction?.proposal.digest ?? null });
    try {
      const complete = await savedProductionPart(context, `${key}:complete`, partInput, deepgramCaptionTrackSchema);
      if (complete) { tracks.push(complete); continue; }
      let observed = await savedProductionPart(context, `${key}:observation`, partInput, observedPart);
      if (!observed) {
        if (base) {
          const carried = base.tracks.find(item => item.locale === source.locale && item.key === source.key)!;
          observed = await saveProductionPart(context, `${key}:observation`, partInput, { alignmentRunId: carried.alignmentRunId, receiptHash: carried.receiptHash, observationJobId: carried.observationJobId, candidate: carried.candidate }, observedPart);
        } else {
          if ((context.externalCalls ?? 0) >= 1) throw new ProductionContinuation("Reading the next original recording", 1);
          context.externalCalls = (context.externalCalls ?? 0) + 1;
          const original = await recognize(context, commission, packageId, bound.sources, source, dependencies.deepgram, dependencies.storage);
          if (!original.receipt || !original.evidenceHash) throw new ProductionReviewRequired("DEEPGRAM_ORIGINAL_PENDING", "The original request has no complete retained observation. It was not resent.");
          if ([401, 403, 404, 410, 429].includes(original.receipt.statusCode)) throw new ProductionReviewRequired("DEEPGRAM_PROVIDER_HELD", "The provider declined this original request. Its exact response remains saved; further dispatch is held without retry.");
          observed = await saveProductionPart(context, `${key}:observation`, partInput, { alignmentRunId: original.row.id, receiptHash: original.evidenceHash, observationJobId: job.id,
            candidate: buildDeepgramCaptionCandidate({ sourceText: source.text, locale: source.locale, audioDurationSeconds: source.durationSeconds, response: original.receipt.parsed }) }, observedPart);
        }
      }
      const reviewRef = bound.correction?.proposal.revisions.find(item => item.locale === source.locale && item.key === source.key);
      const reviewed = reviewRef ? await readCaptionReviewRevision(getPool(), context.tenantId, reviewRef.id) : null;
      const cues = reviewed ? reviewed.evaluation.cues : observed.candidate.cues;
      const effective: DeepgramCaptionTrack["effective"] = { status: reviewed ? reviewed.evaluation.status === "ready-for-review" ? "ready-for-review" : "withheld" : observed.candidate.status,
        provenance: reviewed ? "attributed-listening" : "deepgram-exact-source", cues, cuesHash: digest(cues), listeningAttested: !!reviewed?.attestation, fluentReviewed: false, productionAccepted: false };
      const partial = { locale: source.locale, key: source.key, sourceTrackDigest: digest(source), ...observed, reviewRevision: reviewed ? { id: reviewed.id, digest: reviewed.digest } : null, effective };
      let vtt: DeepgramCaptionTrack["vtt"] = null;
      if (effective.status === "ready-for-review") {
        const media = await storeMedia(context, packageId, `${key}:vtt`, Buffer.from(renderCaptionVtt(cues), "utf8"), "text/vtt", deepgramCaptionVttMetadata(pkg.acceptancePack.digest, bound.sources, source, partial), dependencies.storage);
        vtt = { mediaId: media.id, url: media.url, contentHash: media.contentHash, byteLength: media.byteLength };
      }
      tracks.push(await saveProductionPart(context, `${key}:complete`, partInput, { ...partial, vtt }, deepgramCaptionTrackSchema));
    } catch (error) {
      if (error instanceof ProductionContinuation) throw new ProductionContinuation(`Deepgram review · ${tracks.length} of ${bound.sources.tracks.length} original recordings retained. ${error.step}.`, error.retryAfterSeconds);
      if (error instanceof DomainError && error.recoverable && error.status >= 500) throw new ProductionContinuation("Waiting to read the same private caption evidence", 15);
      throw error;
    }
  }
  const easyRead: EasyReadFile[] = base ? base.easyRead : [];
  if (!base) {
    if (process.env.OPENAI_MODEL !== easyReadStandard.model) throw new ProductionReviewRequired("CAPTION_MODEL_BINDING", "Configure the exact agreed easy-read model before continuing. Original recognition remains retained.");
    for (const locale of locales) {
      const request = captionEasyReadRequest(pkg, locale, bound.sources);
      try {
        const result = await generateStructured(context, request.name, request.instruction, request.data, request.schema);
        const run = (await getPool().query<{ input_hash: string; output_hash: string; provider_response_id: string; provider_output_text: string; output: unknown }>("SELECT input_hash,output_hash,provider_response_id,provider_output_text,output FROM guild_model_runs WHERE tenant_id=$1 AND job_id=$2 AND id=$3 AND operation_key=$4 AND status='completed'", [context.tenantId, context.jobId, result.runId, request.name])).rows[0];
        if (!run || run.input_hash !== request.inputHash || run.output_hash !== digest(result.data) || digest(run.output) !== run.output_hash || digest(JSON.parse(run.provider_output_text)) !== run.output_hash)
          throw new ProductionReviewRequired("CAPTION_MODEL_RESULT_CHANGED", "The original easy-read response differs from its frozen request and retained text.");
        easyRead.push(easyReadFileSchema.parse({ ...result.data, modelRunId: result.runId, model: result.model, inputHash: run.input_hash, providerResponseId: run.provider_response_id, outputHash: run.output_hash }));
      } catch (error) { if (error instanceof ProductionContinuation) throw new ProductionContinuation(`Easy read · ${easyRead.length} of ${locales.length} source-linked language files saved. ${error.step}.`, error.retryAfterSeconds); throw error; }
    }
  }
  await transaction(db => requireProductionLease(db, context, packageId));
  const correction = bound.correction ? { id: bound.correction.id, digest: bound.correction.proposal.digest, baseArtifactId: bound.correction.proposal.baseArtifactId, baseArtifactHash: bound.correction.proposal.baseArtifactHash } : null;
  const content = deepgramCaptionArtifactSchema.parse({ schemaVersion: "guild.captions.v3", contractDigest: pkg.acceptancePack.digest, sourceDigest: digest(bound.sources), sources: bound.sources,
    productionJobId: job.id, originalProductionJobId: base?.originalProductionJobId ?? job.id, attempt: bound.attempt, inputBindings: bound.sources.inputBindings, correction, tracks, easyRead,
    sourceTextSupplied: false, independentBlindAsrUnchanged: true, fluentHumanReviewed: false, productionAccepted: false, automatedQualification: "not-qualified",
    limitations: ["Deepgram receives the exact original audio without a source prompt. It performs blind recognition, not supplied-text alignment. Every complete and failed source track remains in the register.",
      "Raw boundaries and nearest-millisecond display values remain distinct. Invalid intervals and text disagreements are retained. No title, spelling, numeral, script or diacritic is silently removed to create a match.",
      "Saved review drafts and human listening declarations are separately attributed; fluent-language review, automatic capability qualification, source acceptance and payment remain separate.",
      "The correction edition reuses original observations and easy-read responses. It sends no recognition, narration or model request, retains the first artifact and does not renew the original authority."] });
  const narration = commission.artifacts.find(item => item.id === bound.sources.narration.artifactId)!;
  return { content, runId: easyRead[0]!.modelRunId, model: easyReadStandard.model, title: correction ? "Northlight · attributed caption correction edition" : "Northlight · six-language Deepgram review edition",
    sourceIds: narration.sourceIds, provenanceLabel: correction ? "Assembled from attributed review · original audio and recognition retained" : "Deepgram-assisted review · automatic qualification open" };
}
