import { z } from "zod";
import { locales, type ArtifactManifest } from "@/contracts/guild";
import { alignCaptionTrack, renderCaptionVtt, timestampCapability } from "@/domain/caption-alignment";
import { captionAcceptancePack, captionArtifactSchema, captionAuthorityCeilingSchema, captionSourcesFromPack, checkEasyRead, easyReadStandard, type CaptionSources, type CaptionTrack, type CaptionTrackSource, type EasyReadFile } from "@/domain/captions";
import { completeNarrationArtifactSchema } from "@/domain/narration";
import { digest, DomainError } from "@/domain/primitives";
import { getPool, transaction } from "../db";
import { requireVerificationLease, type ProductionLease } from "../production-authority";
import { ProductionContinuation, ProductionReviewRequired } from "../production-continuation";
import { savedProductionPart, saveProductionPart } from "../production-parts";
import type { PrivateBlobGateway } from "../media/blob-store";
import { readOwnedMedia } from "../media/objects";
import { measureNarration } from "../media/audio-processing";
import { qualifiedAudioEngine } from "../media/audio-qualification";
import { readAlignmentRecord } from "./alignment-runs";
import { readCaptionApprovalHistory } from "./approval-history";
import { captionEasyReadRequest } from "./easy-read";
import { validateCaptionJob } from "./contracts";
import { captionOwnedArtifact } from "./sources";
import { captionVttMetadata } from "./production";

const fileCheckSchema = z.object({ locale: z.enum(locales), key: z.string(), mediaId: z.string().uuid(), source: z.boolean(), alignment: z.boolean(), vtt: z.boolean(),
  measuredDurationSeconds: z.number().nullable(), originalAudioHash: z.string().nullable(), rawResponseHash: z.string().nullable(), cueCount: z.number().int().nonnegative(), evidence: z.array(z.string()), checkedAt: z.string().datetime() }).strict();
type FileCheck = z.infer<typeof fileCheckSchema>;
export const captionVerifierVersion = "northlight.independent-bytes-and-timings.v1";

async function fileCheck(context: ProductionLease, commissionId: string, packageId: string, producingJobId: string, contractDigest: string, sources: CaptionSources, source: CaptionTrackSource, track: CaptionTrack, storage?: PrivateBlobGateway): Promise<FileCheck> {
  const result: FileCheck = { locale: source.locale, key: source.key, mediaId: source.mediaId, source: false, alignment: false, vtt: false, measuredDurationSeconds: null,
    originalAudioHash: null, rawResponseHash: null, cueCount: 0, evidence: [], checkedAt: new Date().toISOString() };
  if ((context.externalCalls ?? 0) >= 1) throw new ProductionContinuation("Reading the next original caption file", 1);
  try {
    context.externalCalls = (context.externalCalls ?? 0) + 1;
    const original = await readOwnedMedia(context.tenantId, source.mediaId, storage), actual = await measureNarration(original.bytes);
    result.measuredDurationSeconds = actual.durationSeconds; result.originalAudioHash = actual.contentHash;
    const { row, receipt, receiptHash } = await readAlignmentRecord(context.tenantId, track.alignmentRunId);
    result.rawResponseHash = receipt.bodyHash;
    if (row.state !== "received" || row.job_id !== producingJobId || row.commission_id !== commissionId || row.package_id !== packageId || row.media_id !== source.mediaId
      || row.request.sourceDigest !== digest(sources) || row.request.sourceTrackDigest !== digest(source) || row.request.contractDigest !== contractDigest
      || row.request.originalAudio.contentHash !== actual.contentHash || row.request.originalAudio.scriptHash !== source.scriptBytesHash || row.request.originalAudio.byteLength !== original.bytes.length
      || digest(row.request.prompt) !== digest(source.prompt) || receiptHash !== track.receiptHash || track.sourceTrackDigest !== digest(source)
      || original.row.commission_id !== commissionId || original.row.job_id !== source.origin.productionJobId || original.row.package_id !== source.origin.packageId
      || actual.contentHash !== source.audioHash || actual.durationSeconds !== source.durationSeconds || original.bytes.length !== source.byteLength) {
      result.evidence.push("The original audio, producing request, prompt or complete raw receipt differs from the submitted source binding."); return result;
    }
    result.source = true;
    // Recompute from the retained raw body after its independent byte/schema
    // check. The artifact's words, timings, cues and passed flags are assertions.
    const recomputed = receipt.statusCode === 200 && receipt.parsed && receipt.bodyComplete
      ? alignCaptionTrack({ locale: source.locale, sourceText: source.text, audioDurationSeconds: actual.durationSeconds, response: receipt.parsed })
      : null;
    if (!recomputed || digest(recomputed) !== digest(track.alignment) || recomputed.status !== "aligned") {
      result.evidence.push(recomputed?.status === "failed" ? `${recomputed.codes.join(", ")}: ${recomputed.diagnostics.join(" ")}` : "The raw response or recomputed complete alignment does not match the submission. No supplied timing was inferred or repaired."); return result;
    }
    result.alignment = true; result.cueCount = recomputed.cues.length;
    if (!track.vtt || track.vtt.url !== `/api/media/${track.vtt.mediaId}`) { result.evidence.push("The aligned recording has no exact downloadable VTT object."); return result; }
    context.externalCalls = (context.externalCalls ?? 0) + 1;
    const vtt = await readOwnedMedia(context.tenantId, track.vtt.mediaId, storage), rendered = Buffer.from(renderCaptionVtt(recomputed.cues), "utf8");
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(vtt.bytes);
    result.vtt = vtt.row.commission_id === commissionId && vtt.row.package_id === packageId && vtt.row.job_id === producingJobId && vtt.row.media_type === "text/vtt"
      && vtt.row.operation_key === `caption:${source.locale}:${source.key}:vtt` && vtt.row.content_hash === track.vtt.contentHash && vtt.bytes.length === track.vtt.byteLength
      && vtt.bytes.equals(rendered) && Buffer.from(decoded, "utf8").equals(rendered) && digest(vtt.row.metadata) === digest(captionVttMetadata(contractDigest, sources, source, { ...track, alignment: recomputed }));
    result.evidence.push(result.vtt ? "Actual original audio and VTT bytes match their hashes; all complete source text and exact word-boundary cues satisfy the frozen language limits." : "The actual VTT bytes, storage identity or source/audio/timing metadata differ from the exact independently rendered file.");
    return result;
  } catch (error) {
    if (error instanceof ProductionContinuation) throw error;
    if (error instanceof DomainError && error.status >= 500 && error.recoverable) throw new ProductionContinuation("The private store is unavailable; checks will read the same original bytes", 15);
    result.evidence.push(error instanceof DomainError ? `${error.code}: ${error.message}` : "The original audio or VTT could not be independently decoded. No unverified file was substituted.");
    return result;
  }
}

export async function verifyCaptions(context: ProductionLease, storage?: PrivateBlobGateway) {
  const { commission, package: pkg, artifact } = await transaction(db => requireVerificationLease(db, context));
  const retained = await captionOwnedArtifact(getPool(), commission, artifact.id, artifact.contentHash);
  if (retained.provenance.sourceId !== artifact.provenance.sourceId) throw new ProductionReviewRequired("CAPTION_ARTIFACT_CHANGED", "The caption manifest differs from its immutable retained submission.");
  const sources = captionSourcesFromPack(pkg.acceptancePack), anchor = captionAuthorityCeilingSchema.parse(pkg.acceptancePack.parameters?.authorityCeiling), pack = captionAcceptancePack(sources, anchor), checks: FileCheck[] = [];
  const easyRead: { locale: string; passed: boolean; modelRunId: string; evidence: string[]; semanticReviewRequired: true }[] = [];
  const report = { schemaVersion: "guild.caption-verification.v2", verifierVersion: captionVerifierVersion, artifactId: artifact.id, artifactHash: artifact.contentHash,
    contractDigest: pack.digest, sourceDigest: digest(sources), timestampCapability, originalBlindReport: sources.narration.verificationReport,
    sourceVerified: false, producingApprovalVerified: false, checks, easyRead, evidence: [] as string[], promptedAlignmentOnly: true, newRecognitionRequests: 0,
    humanListeningReviewed: false, fluentHumanReviewed: false, semanticReviewRequired: true };
  for (const criterion of pack.criteria) { criterion.status = criterion.kind === "deterministic" ? "failed" : "review"; criterion.evidence = criterion.kind === "deterministic" ? "The exact complete original artifact and source chain have not passed independent checks." : criterion.description; }
  const parsed = captionArtifactSchema.safeParse(artifact.content);
  if (!parsed.success || parsed.data.contractDigest !== pkg.acceptancePack.digest || parsed.data.sourceDigest !== digest(sources) || digest(parsed.data.sources) !== digest(sources)
    || digest(parsed.data.inputBindings) !== digest(sources.inputBindings)) return { pack, report };
  const value = parsed.data;
  let historical: Awaited<ReturnType<typeof readCaptionApprovalHistory>>;
  try {
    historical = await readCaptionApprovalHistory(getPool(), commission, pkg, artifact);
    const bound = await validateCaptionJob(getPool(), commission, pkg, historical.job, false);
    if (digest(bound.correction) !== digest(value.correction) || bound.attempt !== value.attempt) throw new DomainError("CAPTION_JOB_BINDING", "The producing attempt or correction differs from its exact agreement.", 422, false);
    const narration = completeNarrationArtifactSchema.parse((await captionOwnedArtifact(getPool(), commission, sources.narration.artifactId, sources.narration.artifactHash)).content);
    if (digest(narration.engine) !== digest(await qualifiedAudioEngine())) throw new DomainError("CAPTION_AUDIO_ENGINE", "The original audio engine differs from this verifier's qualified measurement engine.", 422, false);
    report.sourceVerified = true; report.producingApprovalVerified = true;
  } catch (error) {
    report.evidence.push(error instanceof DomainError ? `${error.code}: ${error.message}` : "The original source or producing approval could not be validated."); return { pack, report };
  }
  const fullCoverage = value.tracks.length === sources.tracks.length && new Set(value.tracks.map(track => `${track.locale}/${track.key}`)).size === sources.tracks.length
    && new Set(value.tracks.map(track => track.alignmentRunId)).size === sources.tracks.length && value.easyRead.length === locales.length && new Set(value.easyRead.map(file => file.locale)).size === locales.length;
  if (!fullCoverage) { report.evidence.push("The submission does not contain exactly one unique original alignment per registered recording and one easy-read file per locale."); return { pack, report }; }
  for (const source of sources.tracks) {
    const track = value.tracks.find(item => item.locale === source.locale && item.key === source.key);
    if (!track) { report.evidence.push(`Missing ${source.locale}/${source.key}.`); return { pack, report }; }
    const partKey = `caption-check:${source.locale}:${source.key}`, inputHash = digest({ verifierVersion: captionVerifierVersion, artifactHash: artifact.contentHash, source, track });
    try {
      const saved = await savedProductionPart(context, partKey, inputHash, fileCheckSchema);
      checks.push(saved ?? await saveProductionPart(context, partKey, inputHash, await fileCheck(context, commission.id, pkg.id, value.productionJobId, pkg.acceptancePack.digest, sources, source, track, storage), fileCheckSchema));
    } catch (error) { if (error instanceof ProductionContinuation) throw new ProductionContinuation(`Caption checks · ${checks.length} of ${sources.tracks.length} original files measured. ${error.step}.`, error.retryAfterSeconds); throw error; }
  }
  const originalPackage = historical.package;
  for (const locale of locales) {
    const file = value.easyRead.find(item => item.locale === locale)!, request = captionEasyReadRequest(originalPackage, locale, sources), failures: string[] = [];
    const run = (await getPool().query<{ model: string; input_hash: string; output_hash: string; output: unknown; provider_output_text: string; provider_response_id: string }>("SELECT model,input_hash,output_hash,output,provider_output_text,provider_response_id FROM guild_model_runs WHERE tenant_id=$1 AND job_id=$2 AND id=$3 AND operation_key=$4 AND status='completed'", [context.tenantId, value.productionJobId, file.modelRunId, request.name])).rows[0];
    const { modelRunId: _id, model: _model, inputHash: _input, providerResponseId: _response, outputHash: _output, ...displayed } = file;
    try {
      const raw = run && request.schema.parse(JSON.parse(run.provider_output_text));
      if (!run || !raw || file.model !== easyReadStandard.model || run.model !== file.model || run.provider_response_id !== file.providerResponseId || run.input_hash !== request.inputHash || file.inputHash !== request.inputHash
        || run.output_hash !== file.outputHash || digest(run.output) !== run.output_hash || digest(raw) !== run.output_hash || digest(displayed) !== run.output_hash) failures.push("The exact saved easy-read response, original text, model or request hash differs from the submitted language file.");
      failures.push(...checkEasyRead(file as EasyReadFile, sources).failures);
    } catch { failures.push("The original easy-read text does not parse under the frozen locale schema."); }
    easyRead.push({ locale, modelRunId: file.modelRunId, passed: !failures.length, evidence: failures.length ? failures : ["Exact original structured response, complete key/concept register, permitted verbatim quotes and paragraph limits match. Meaning and reading experience still require review."], semanticReviewRequired: true });
  }
  const total = sources.tracks.length, passing = { source: checks.filter(item => item.source).length, alignment: checks.filter(item => item.alignment).length, vtt: checks.filter(item => item.vtt).length };
  for (const criterion of pack.criteria) {
    if (criterion.id === "source") { criterion.status = report.sourceVerified && report.producingApprovalVerified && passing.source === total ? "passed" : "failed"; criterion.evidence = `${passing.source}/${total} actual original audio files and timestamp requests match their complete producing/source chain. Original blind report ${sources.narration.verificationReport.outputHash} is unchanged.`; }
    if (criterion.id === "coverage") { criterion.status = fullCoverage && passing.alignment === total && passing.vtt === total ? "passed" : "failed"; criterion.evidence = `${passing.vtt}/${total} complete timed-caption files; ${value.easyRead.length}/${locales.length} locale files retained. Failed tracks remain in the full denominator.`; }
    if (criterion.id === "alignment") { criterion.status = passing.alignment === total ? "passed" : "failed"; criterion.evidence = `${passing.alignment}/${total} full scripts align under the unchanged normalization, original word/segment timing and locale limits. Prompted alignment is not blind recognition.`; }
    if (criterion.id === "vtt") { criterion.status = passing.vtt === total ? "passed" : "failed"; criterion.evidence = `${passing.vtt}/${total} actual downloadable VTT byte sequences match independent rendering and audio/script/timing metadata.`; }
    if (criterion.id === "easy_read") { const count = easyRead.filter(item => item.passed).length; criterion.status = count === locales.length ? "passed" : "failed"; criterion.evidence = `${count}/${locales.length} original locale files pass exact key, concept-reference, permitted-quote and paragraph checks. This does not prove semantic preservation or fluent review.`; }
  }
  return { pack, report };
}
