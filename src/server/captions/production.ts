import { z } from "zod";
import { locales, type Commission } from "@/contracts/guild";
import { alignCaptionTrack, renderCaptionVtt } from "@/domain/caption-alignment";
import { captionAlignmentSchema, captionArtifactSchema, captionTrackSchema, easyReadFileSchema, easyReadStandard, type CaptionSources, type CaptionTrack, type CaptionTrackSource, type EasyReadFile } from "@/domain/captions";
import { digest, DomainError } from "@/domain/primitives";
import { getPool, transaction } from "../db";
import { generateStructured, type ModelContext } from "../models";
import { requireProductionLease } from "../production-authority";
import { ProductionContinuation, ProductionReviewRequired } from "../production-continuation";
import { savedProductionPart, saveProductionPart } from "../production-parts";
import { readOwnedMedia, storeMedia } from "../media/objects";
import type { PrivateBlobGateway } from "../media/blob-store";
import { validateCaptionJob, type CaptionJobInput } from "./contracts";
import { captionEasyReadRequest } from "./easy-read";
import { runAlignment } from "./alignment-runs";
import type { AlignmentGateway, AlignmentHttpReceipt } from "./alignment-gateway";

const alignedPartSchema = z.object({ alignmentRunId: z.string().uuid(), receiptHash: z.string().regex(/^[a-f0-9]{64}$/), alignment: captionAlignmentSchema }).strict();
export function alignmentFromReceipt(track: CaptionTrackSource, receipt: AlignmentHttpReceipt) {
  return receipt.parsed && receipt.bodyComplete && receipt.statusCode === 200
    ? alignCaptionTrack({ locale: track.locale, sourceText: track.text, audioDurationSeconds: track.durationSeconds, response: receipt.parsed })
    : { status: "failed" as const, codes: [`ALIGNMENT_${receipt.parseFailure ?? "RESPONSE_UNAVAILABLE"}`], diagnostics: ["The original response did not contain complete usable word and segment timestamps. No timings were invented or substituted."] };
}
export function captionVttMetadata(contractDigest: string, sources: CaptionSources, source: CaptionTrackSource, track: Pick<CaptionTrack, "alignmentRunId" | "receiptHash" | "alignment">) {
  if (track.alignment.status !== "aligned") throw new Error("Only aligned captions have a VTT object");
  return { schemaVersion: "northlight.caption-vtt.v1", contractDigest, sourceDigest: digest(sources), sourceTrackDigest: digest(source),
    locale: source.locale, key: source.key, audioMediaId: source.mediaId, audioHash: source.audioHash, originalProducingJobId: source.origin.productionJobId,
    scriptHash: source.scriptBytesHash, sourceArtifactId: sources.narration.artifactId, sourceArtifactHash: sources.narration.artifactHash,
    alignmentRunId: track.alignmentRunId, receiptHash: track.receiptHash, timingsHash: track.alignment.timingsHash, cuesHash: track.alignment.cuesHash,
    promptedAlignmentOnly: true, humanListeningReviewed: false, fluentHumanReviewed: false };
}

export async function produceCaptions(context: ModelContext, commission: Commission, packageId: string, dependencies: { storage?: PrivateBlobGateway; alignment?: AlignmentGateway } = {}) {
  const pkg = commission.packages.find(item => item.id === packageId)!;
  const job = (await getPool().query<{ id: string; input: CaptionJobInput }>("SELECT id,input FROM guild_jobs WHERE id=$1 AND tenant_id=$2", [context.jobId, context.tenantId])).rows[0];
  if (!job) throw new ProductionReviewRequired("CAPTION_JOB_BINDING", "This caption job is unavailable.");
  const bound = await validateCaptionJob(getPool(), commission, pkg, job), tracks: CaptionTrack[] = [], easyRead: EasyReadFile[] = [];
  for (const source of bound.sources.tracks) {
    const key = `caption:${source.locale}:${source.key}`, partInput = digest({ jobId: job.id, contractDigest: pkg.acceptancePack.digest, sourceDigest: digest(bound.sources), sourceTrackDigest: digest(source), attempt: bound.attempt, correction: bound.correction });
    try {
      const complete = await savedProductionPart(context, `${key}:complete`, partInput, captionTrackSchema);
      if (complete) { tracks.push(complete); continue; }
      let aligned = await savedProductionPart(context, `${key}:alignment`, partInput, alignedPartSchema);
      if (!aligned) {
        if ((context.externalCalls ?? 0) >= 1) throw new ProductionContinuation("Reading the next original audio file", 1);
        context.externalCalls = (context.externalCalls ?? 0) + 1;
        let original: Awaited<ReturnType<typeof readOwnedMedia>>;
        try { original = await readOwnedMedia(context.tenantId, source.mediaId, dependencies.storage); }
        catch (error) { if (error instanceof DomainError && error.recoverable && error.status >= 500) throw new ProductionContinuation("Waiting to read the same original private recording", 15); throw error; }
        const observed = await runAlignment(context, packageId, source, original.bytes, dependencies.alignment);
        aligned = await saveProductionPart(context, `${key}:alignment`, partInput, { alignmentRunId: observed.row.id, receiptHash: observed.receiptHash, alignment: alignmentFromReceipt(source, observed.receipt) }, alignedPartSchema);
      }
      let vtt: CaptionTrack["vtt"] = null;
      if (aligned.alignment.status === "aligned") {
        const media = await storeMedia(context, packageId, `${key}:vtt`, Buffer.from(renderCaptionVtt(aligned.alignment.cues), "utf8"), "text/vtt", captionVttMetadata(pkg.acceptancePack.digest, bound.sources, source, aligned), dependencies.storage);
        vtt = { mediaId: media.id, url: media.url, contentHash: media.contentHash, byteLength: media.byteLength };
      }
      tracks.push(await saveProductionPart(context, `${key}:complete`, partInput, { locale: source.locale, key: source.key, sourceTrackDigest: digest(source), ...aligned, vtt }, captionTrackSchema));
    } catch (error) {
      if (error instanceof ProductionContinuation) throw new ProductionContinuation(`Captions · ${tracks.length} of ${bound.sources.tracks.length} original recordings processed. ${error.step}.`, error.retryAfterSeconds);
      throw error;
    }
  }
  if (process.env.OPENAI_MODEL !== easyReadStandard.model) throw new ProductionReviewRequired("CAPTION_MODEL_BINDING", "The easy-read model differs from the frozen agreement. Retain the original alignments and configure the exact qualified model; no substitute request was sent.");
  for (const locale of locales) {
    const request = captionEasyReadRequest(pkg, locale, bound.sources);
    try {
      const result = await generateStructured(context, request.name, request.instruction, request.data, request.schema);
      const run = (await getPool().query<{ input_hash: string; output_hash: string; provider_response_id: string; provider_output_text: string; output: unknown }>("SELECT input_hash,output_hash,provider_response_id,provider_output_text,output FROM guild_model_runs WHERE tenant_id=$1 AND job_id=$2 AND id=$3 AND operation_key=$4 AND status='completed'", [context.tenantId, context.jobId, result.runId, request.name])).rows[0];
      if (!run || run.input_hash !== request.inputHash || run.output_hash !== digest(result.data) || digest(run.output) !== run.output_hash || digest(JSON.parse(run.provider_output_text)) !== run.output_hash) throw new ProductionReviewRequired("CAPTION_MODEL_RESULT_CHANGED", "The saved easy-read response no longer matches its exact original request and retained text.");
      easyRead.push(easyReadFileSchema.parse({ ...result.data, modelRunId: result.runId, model: result.model, inputHash: run.input_hash, providerResponseId: run.provider_response_id, outputHash: run.output_hash }));
    } catch (error) {
      if (error instanceof ProductionContinuation) throw new ProductionContinuation(`Easy read · ${easyRead.length} of ${locales.length} source-linked language files saved. ${error.step}.`, error.retryAfterSeconds);
      throw error;
    }
  }
  await transaction(db => requireProductionLease(db, context, packageId));
  const content = captionArtifactSchema.parse({ schemaVersion: "guild.captions.v2", contractDigest: pkg.acceptancePack.digest, sourceDigest: digest(bound.sources), sources: bound.sources,
    productionJobId: job.id, attempt: bound.attempt, correction: bound.correction, inputBindings: bound.inputBindings, tracks, easyRead,
    promptedAlignmentOnly: true, independentBlindAsrUnchanged: true, humanListeningReviewed: false, fluentHumanReviewed: false,
    limitations: ["Timestamps come from one original whisper-1 response per exact original recording in this job, using the disclosed bounded source-script excerpt. This is prompted production alignment, not independent transcription proof.",
      "Every cue boundary uses supplied original word timestamps. Missing or ambiguous words/timing are retained as failed tracks; timings, audio and source coverage were not invented or altered.",
      "The original blind narration recognition report remains unchanged. Caption checks and generated easy read do not establish human listening, fluent review, semantic preservation or a calibrated reading grade.",
      "Exact upstream acceptance, curator review and payment remain separate. The $35 award and $5 fee include one separately reviewed correction with a fresh Passport; every attempted job counts and the original authority deadline remains fixed."] });
  const narration = commission.artifacts.find(item => item.id === bound.sources.narration.artifactId)!;
  return { content, runId: easyRead[0]!.modelRunId, model: easyReadStandard.model, title: "Northlight · original-audio captions and easy read", sourceIds: narration.sourceIds };
}
