import { z } from "zod";
import { locales } from "@/contracts/guild";
import { captionAuthorityCeilingSchema, checkEasyRead, easyReadStandard, type CaptionSources, type CaptionTrackSource } from "@/domain/captions";
import { deepgramCaptionAcceptancePack, deepgramCaptionArtifactSchema, deepgramSourcesFromPack, type DeepgramCaptionTrack } from "@/domain/deepgram-captions";
import { automaticCaptionReviewUnits, evaluateCaptionReview } from "@/domain/caption-review";
import { buildDeepgramCaptionCandidate } from "@/domain/deepgram-source-mapping";
import { deepgramTimestampCapability } from "@/domain/deepgram-caption-alignment";
import { renderCaptionVtt } from "@/domain/caption-alignment";
import { completeNarrationArtifactSchema } from "@/domain/narration";
import { digest, DomainError } from "@/domain/primitives";
import { getPool, transaction } from "../db";
import { requireVerificationLease, type ProductionLease } from "../production-authority";
import { savedProductionPart, saveProductionPart } from "../production-parts";
import { ProductionContinuation, ProductionReviewRequired } from "../production-continuation";
import { readOwnedMedia } from "../media/objects";
import type { PrivateBlobGateway } from "../media/blob-store";
import { measureNarration } from "../media/audio-processing";
import { qualifiedAudioEngine } from "../media/audio-qualification";
import { captionOwnedArtifact } from "./sources";
import { readDeepgramRun } from "./deepgram-runs";
import { readDeepgramCaptionApprovalHistory, validateDeepgramCaptionJob } from "./deepgram-contracts";
import { readCaptionReviewRevision } from "./review";
import { deepgramCaptionVttMetadata } from "./deepgram-production";
import { captionEasyReadRequest } from "./easy-read";

export const deepgramCaptionVerifierVersion = "northlight.independent-deepgram-and-review-bytes.v1";
const fileCheckSchema = z.object({ locale: z.enum(locales), key: z.string(), mediaId: z.string().uuid(), source: z.boolean(), alignment: z.boolean(), vtt: z.boolean(),
  automaticAlignment: z.boolean(), listeningAttested: z.boolean(), timingSource: z.enum(["deepgram-exact-source", "attributed-listening"]), measuredDurationSeconds: z.number().nullable(),
  originalAudioHash: z.string().nullable(), rawResponseHash: z.string().nullable(), cueCount: z.number().int().nonnegative(), reviewRevisionId: z.string().nullable(),
  evidence: z.array(z.string()), checkedAt: z.string().datetime() }).strict();
type FileCheck = z.infer<typeof fileCheckSchema>;

async function fileCheck(context: ProductionLease, commissionId: string, packageId: string, producingJobId: string, originalJobId: string, contractDigest: string, sources: CaptionSources, source: CaptionTrackSource, track: DeepgramCaptionTrack, storage?: PrivateBlobGateway): Promise<FileCheck> {
  const result: FileCheck = { locale: source.locale, key: source.key, mediaId: source.mediaId, source: false, alignment: false, vtt: false, automaticAlignment: false, listeningAttested: false,
    timingSource: track.effective.provenance, measuredDurationSeconds: null, originalAudioHash: null, rawResponseHash: null, cueCount: 0, reviewRevisionId: track.reviewRevision?.id ?? null, evidence: [], checkedAt: new Date().toISOString() };
  if ((context.externalCalls ?? 0) >= 1) throw new ProductionContinuation("Reading the next original recording and caption bytes", 1);
  context.externalCalls = (context.externalCalls ?? 0) + 1;
  try {
    const original = await readOwnedMedia(context.tenantId, source.mediaId, storage), actual = await measureNarration(original.bytes);
    result.measuredDurationSeconds = actual.durationSeconds; result.originalAudioHash = actual.contentHash;
    const saved = await readDeepgramRun(context.tenantId, track.alignmentRunId), scope = saved.row.request.scope, wire = saved.row.request.wire;
    result.rawResponseHash = saved.receipt?.bodyHash ?? null;
    if (!saved.receipt || saved.row.state !== "received" || saved.evidenceHash !== track.receiptHash || saved.row.job_id !== originalJobId || track.observationJobId !== originalJobId
      || saved.row.commission_id !== commissionId || saved.row.package_id !== packageId || scope.mediaId !== source.mediaId || scope.producingJobId !== source.origin.productionJobId
      || scope.sourceArtifactHash !== sources.narration.artifactHash || scope.sourceTextHash !== source.scriptBytesHash || scope.agreementDigest !== contractDigest
      || wire.audioHash !== actual.contentHash || wire.audioBytes !== original.bytes.length || wire.mimeType !== "audio/mpeg" || wire.locale !== source.locale
      || original.row.commission_id !== commissionId || original.row.package_id !== source.origin.packageId || original.row.job_id !== source.origin.productionJobId
      || actual.contentHash !== source.audioHash || actual.durationSeconds !== source.durationSeconds || original.bytes.length !== source.byteLength || track.sourceTrackDigest !== digest(source)) {
      result.evidence.push("The actual original recording, signed response, source or agreement differs from its immutable binding."); return result;
    }
    result.source = true;
    // readDeepgramRun rebuilds the parsed response from signed original bytes.
    const candidate = buildDeepgramCaptionCandidate({ sourceText: source.text, locale: source.locale, audioDurationSeconds: actual.durationSeconds, response: saved.receipt.parsed });
    if (digest(candidate) !== digest(track.candidate)) { result.evidence.push("The submitted automatic candidate differs from the original response re-evaluated against the actual recording."); return result; }
    result.automaticAlignment = candidate.status === "ready-for-review";
    let cues = candidate.cues, status = candidate.status, listeningAttested = false;
    if (track.reviewRevision) {
      const revision = await readCaptionReviewRevision(getPool(), context.tenantId, track.reviewRevision.id);
      const evaluation = evaluateCaptionReview({ ...source, durationSeconds: actual.durationSeconds }, revision.draft, automaticCaptionReviewUnits(source, candidate));
      if (revision.digest !== track.reviewRevision.digest || revision.sourceTrackDigest !== digest(source) || revision.alignmentRunId !== track.alignmentRunId
        || revision.originalReceiptHash !== track.receiptHash || !revision.attestation || digest(evaluation) !== digest(revision.evaluation)) {
        result.evidence.push("The manual correction differs from its exact attributed listening declaration and original observation."); return result;
      }
      status = evaluation.status === "ready-for-review" ? "ready-for-review" : "withheld"; cues = evaluation.cues; listeningAttested = true;
      result.evidence.push(`Timing is attributed to ${revision.attestation.reviewerName}, revision ${revision.id}. The server verifies that declaration’s integrity, not whether a person actually listened. Fluent review is not claimed.`);
    }
    const effective = { status, provenance: track.reviewRevision ? "attributed-listening" : "deepgram-exact-source", cues, cuesHash: digest(cues), listeningAttested, fluentReviewed: false, productionAccepted: false };
    if (digest(effective) !== digest(track.effective) || status !== "ready-for-review") {
      result.evidence.push(`Complete source timing remains unresolved: ${candidate.codes.join(", ") || "the effective cue record differs"}. Recognition disagreement alone does not prove an audible omission.`); return result;
    }
    result.alignment = true; result.listeningAttested = listeningAttested; result.cueCount = cues.length;
    if (!track.vtt || track.vtt.url !== `/api/media/${track.vtt.mediaId}`) { result.evidence.push("The complete track has no exact downloadable VTT."); return result; }
    context.externalCalls = (context.externalCalls ?? 0) + 1;
    const vtt = await readOwnedMedia(context.tenantId, track.vtt.mediaId, storage), expected = Buffer.from(renderCaptionVtt(cues), "utf8"), decoded = new TextDecoder("utf-8", { fatal: true }).decode(vtt.bytes);
    result.vtt = vtt.row.commission_id === commissionId && vtt.row.package_id === packageId && vtt.row.job_id === producingJobId && vtt.row.media_type === "text/vtt"
      && vtt.row.operation_key === `deepgram-caption:${source.locale}:${source.key}:vtt` && vtt.row.content_hash === track.vtt.contentHash && vtt.bytes.length === track.vtt.byteLength
      && vtt.bytes.equals(expected) && Buffer.from(decoded, "utf8").equals(expected) && digest(vtt.row.metadata) === digest(deepgramCaptionVttMetadata(contractDigest, sources, source, track));
    result.evidence.push(result.vtt ? "Actual original audio and VTT bytes match; every source character, ordered measured boundary and language-specific cue limit was independently recomputed." : "Stored VTT bytes or metadata differ from independent rendering.");
    if (!listeningAttested) result.evidence.push("This is an automatic review candidate. A complete named listening declaration remains required before the human-corrected edition can be accepted.");
    return result;
  } catch (error) {
    if (error instanceof ProductionContinuation) throw error;
    if (error instanceof DomainError && error.status >= 500 && error.recoverable) throw new ProductionContinuation("Waiting to read the same immutable caption evidence", 15);
    result.evidence.push(error instanceof DomainError ? `${error.code}: ${error.message}` : "The original audio, raw response, attributed revision or VTT could not be independently decoded."); return result;
  }
}

export async function verifyDeepgramCaptions(context: ProductionLease, storage?: PrivateBlobGateway) {
  const { commission, package: pkg, artifact } = await transaction(db => requireVerificationLease(db, context));
  const retained = await captionOwnedArtifact(getPool(), commission, artifact.id, artifact.contentHash);
  if (digest(retained) !== digest(artifact)) throw new ProductionReviewRequired("DEEPGRAM_ARTIFACT_CHANGED", "The review manifest differs from its retained immutable submission.");
  const sources = deepgramSourcesFromPack(pkg.acceptancePack), pack = deepgramCaptionAcceptancePack(sources, captionAuthorityCeilingSchema.parse(pkg.acceptancePack.parameters?.authorityCeiling));
  const checks: FileCheck[] = [], easyRead: { locale: string; passed: boolean; modelRunId: string; evidence: string[]; semanticReviewRequired: true }[] = [];
  const report = { schemaVersion: "guild.caption-verification.v3", verifierVersion: deepgramCaptionVerifierVersion, artifactId: artifact.id, artifactHash: artifact.contentHash, contractDigest: pack.digest,
    sourceDigest: digest(sources), timestampCapability: deepgramTimestampCapability, originalBlindReport: sources.narration.verificationReport, sourceVerified: false, producingApprovalVerified: false,
    checks, easyRead, evidence: [] as string[], newRecognitionRequests: 0, fluentHumanReviewed: false, automatedQualification: "not-qualified", semanticReviewRequired: true };
  for (const criterion of pack.criteria) { criterion.status = criterion.kind === "deterministic" ? "failed" : "review"; criterion.evidence = criterion.description; }
  const parsed = deepgramCaptionArtifactSchema.safeParse(artifact.content);
  if (!parsed.success || parsed.data.contractDigest !== pack.digest || parsed.data.sourceDigest !== digest(sources) || digest(parsed.data.sources) !== digest(sources) || digest(parsed.data.inputBindings) !== digest(sources.inputBindings)) return { pack, report };
  const value = parsed.data;
  let historical: Awaited<ReturnType<typeof readDeepgramCaptionApprovalHistory>>;
  try {
    historical = await readDeepgramCaptionApprovalHistory(getPool(), commission, pkg, artifact);
    const bound = await validateDeepgramCaptionJob(getPool(), commission, pkg, historical.job, false);
    if (bound.attempt !== value.attempt || (bound.correction?.id ?? null) !== (value.correction?.id ?? null)) throw new DomainError("DEEPGRAM_ARTIFACT_ATTEMPT", "The edition differs from its exact original or corrected attempt.", 422, false);
    const narration = completeNarrationArtifactSchema.parse((await captionOwnedArtifact(getPool(), commission, sources.narration.artifactId, sources.narration.artifactHash)).content);
    if (digest(narration.engine) !== digest(await qualifiedAudioEngine())) throw new DomainError("DEEPGRAM_AUDIO_ENGINE", "The actual measurement engine differs from the original qualified engine.", 422, false);
    if (value.correction) {
      const base = deepgramCaptionArtifactSchema.parse((await captionOwnedArtifact(getPool(), commission, value.correction.baseArtifactId, value.correction.baseArtifactHash)).content);
      if (base.attempt !== 1 || value.originalProductionJobId !== base.productionJobId || digest(base.easyRead) !== digest(value.easyRead)
        || value.tracks.some(track => { const prior = base.tracks.find(item => item.locale === track.locale && item.key === track.key); return !prior || prior.alignmentRunId !== track.alignmentRunId || prior.receiptHash !== track.receiptHash || digest(prior.candidate) !== digest(track.candidate); }))
        throw new DomainError("DEEPGRAM_CORRECTION_LINEAGE", "The correction must retain every original observation and easy-read response unchanged.", 422, false);
      const permitted = bound.correction!.proposal.revisions;
      if (value.tracks.some(track => !permitted.some(item => item.locale === track.locale && item.key === track.key && item.id === track.reviewRevision?.id && item.digest === track.reviewRevision?.digest)))
        throw new DomainError("DEEPGRAM_CORRECTION_LINEAGE", "The corrected edition differs from the exact reviewed revisions in its Passport.", 422, false);
    } else if (value.originalProductionJobId !== value.productionJobId || value.tracks.some(track => track.reviewRevision)) throw new DomainError("DEEPGRAM_CORRECTION_LINEAGE", "An original provider edition cannot claim later human corrections.", 422, false);
    report.sourceVerified = true; report.producingApprovalVerified = true;
  } catch (error) { report.evidence.push(error instanceof DomainError ? `${error.code}: ${error.message}` : "The original producing approval, source or correction lineage could not be verified."); return { pack, report }; }
  const full = value.tracks.length === sources.tracks.length && new Set(value.tracks.map(item => `${item.locale}/${item.key}`)).size === sources.tracks.length
    && new Set(value.tracks.map(item => item.alignmentRunId)).size === sources.tracks.length && new Set(value.easyRead.map(item => item.locale)).size === locales.length;
  if (!full) { report.evidence.push("The complete recording and easy-read denominator differs from the frozen source register."); return { pack, report }; }
  for (const source of sources.tracks) {
    const track = value.tracks.find(item => item.locale === source.locale && item.key === source.key);
    if (!track) { report.evidence.push(`Missing ${source.locale}/${source.key}.`); return { pack, report }; }
    const partKey = `deepgram-check:${source.locale}:${source.key}`, inputHash = digest({ version: deepgramCaptionVerifierVersion, artifactHash: artifact.contentHash, source, track });
    try {
      const saved = await savedProductionPart(context, partKey, inputHash, fileCheckSchema);
      checks.push(saved ?? await saveProductionPart(context, partKey, inputHash, await fileCheck(context, commission.id, pkg.id, value.productionJobId, value.originalProductionJobId, pack.digest, sources, source, track, storage), fileCheckSchema));
    } catch (error) { if (error instanceof ProductionContinuation) throw new ProductionContinuation(`Deepgram checks · ${checks.length} of ${sources.tracks.length} original recordings checked. ${error.step}.`, error.retryAfterSeconds); throw error; }
  }
  for (const locale of locales) {
    const file = value.easyRead.find(item => item.locale === locale)!, request = captionEasyReadRequest(historical.package, locale, sources), failures: string[] = [];
    const run = (await getPool().query<{ model: string; input_hash: string; output_hash: string; output: unknown; provider_output_text: string; provider_response_id: string }>("SELECT model,input_hash,output_hash,output,provider_output_text,provider_response_id FROM guild_model_runs WHERE tenant_id=$1 AND job_id=$2 AND id=$3 AND operation_key=$4 AND status='completed'", [context.tenantId, value.originalProductionJobId, file.modelRunId, request.name])).rows[0];
    const { modelRunId: _id, model: _model, inputHash: _input, providerResponseId: _response, outputHash: _output, ...displayed } = file;
    try {
      const raw = run && request.schema.parse(JSON.parse(run.provider_output_text));
      if (!run || !raw || file.model !== easyReadStandard.model || run.model !== file.model || run.provider_response_id !== file.providerResponseId || run.input_hash !== request.inputHash || file.inputHash !== request.inputHash
        || run.output_hash !== file.outputHash || digest(run.output) !== run.output_hash || digest(raw) !== run.output_hash || digest(displayed) !== run.output_hash) failures.push("The original easy-read response differs from its exact model, saved request or complete retained text.");
      failures.push(...checkEasyRead(file, sources).failures);
    } catch { failures.push("The original easy-read text no longer parses under the frozen locale contract."); }
    easyRead.push({ locale, modelRunId: file.modelRunId, passed: !failures.length, evidence: failures.length ? failures : ["The exact original locale response, complete concept register, source quotes and paragraph limits match. Semantic and fluent review remain separate."], semanticReviewRequired: true });
  }
  const total = sources.tracks.length, count = (field: "source" | "alignment" | "vtt" | "listeningAttested") => checks.filter(item => item[field]).length;
  for (const criterion of pack.criteria) {
    if (["source", "alignment", "vtt"].includes(criterion.id)) { const n = count(criterion.id as "source" | "alignment" | "vtt"); criterion.status = n === total ? "passed" : "failed"; criterion.evidence = `${n}/${total} original tracks pass the independent ${criterion.id} checks. See each original observation and any separately attributed correction.`; }
    if (criterion.id === "coverage") { criterion.status = count("alignment") === total && count("vtt") === total ? "passed" : "failed"; criterion.evidence = `${count("vtt")}/${total} complete source-bound VTTs. Every failed or uncertain recording remains in the denominator.`; }
    if (criterion.id === "listening") { criterion.status = value.attempt === 2 && count("listeningAttested") === total ? "passed" : "failed"; criterion.evidence = `${count("listeningAttested")}/${total} exact named listening declarations checked. These are attributed human statements, not automated proof of listening or fluent-language review.`; }
    if (criterion.id === "easy_read") { const n = easyRead.filter(item => item.passed).length; criterion.status = n === locales.length ? "passed" : "failed"; criterion.evidence = `${n}/${locales.length} original easy-read files pass source-presence checks.`; }
    if (criterion.id === "qualification") { criterion.status = "review"; criterion.evidence = "Automatic six-language alignment remains unqualified. This separately agreed contract requires complete attributed human listening corrections and independent structural checks; acceptance must not claim automatic capability or fluent review."; }
  }
  return { pack, report };
}
