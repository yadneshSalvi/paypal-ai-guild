import { z } from "zod";
import type { AcceptancePack, ArtifactManifest } from "@/contracts/guild";
import { audioEngineSchema, audioMeasurementSchema, narrationAcceptancePack, completeNarrationArtifactSchema, narrationScripts, narrationStandard, type NarrationScript, type NarrationSegment, type NarrationLineage } from "@/domain/narration";
import { digest, DomainError } from "@/domain/primitives";
import { speechErrorRate } from "@/domain/speech";
import { getPool, transaction } from "../db";
import { requireVerificationLease, type ProductionLease } from "../production-authority";
import { ProductionContinuation, ProductionReviewRequired } from "../production-continuation";
import { savedProductionPart, saveProductionPart } from "../production-parts";
import { measureNarration, renderNarration } from "./audio-processing";
import { qualifiedAudioEngine } from "./audio-qualification";
import type { PrivateBlobGateway } from "./blob-store";
import { narrationFileMetadata } from "./narration-metadata";
import { readOwnedMedia } from "./objects";
import { readCompletedSpeech } from "./speech-runs";
import type { TranscriptionGateway } from "./transcription-gateway";
import { transcribeSavedAudio } from "./transcription-runs";
import { validateNarrationTargetedCorrection } from "../narration-targeted-corrections";

const comparisonSchema = z.object({ method: z.string(), expectedUnits: z.number().int().positive(), observedUnits: z.number().int().nonnegative(), editDistance: z.number().int().nonnegative(), errorRate: z.number().nonnegative(), advisory: z.literal(true) }).strict();
const asrSchema = z.discriminatedUnion("available", [z.object({ available: z.literal(false), runId: z.string().uuid().nullable(), code: z.string() }).strict(), z.object({ available: z.literal(true), runId: z.string().uuid(), model: z.literal("gpt-transcribe"), bodyHash: z.string(), text: z.string(), languages: z.array(z.string()), comparison: comparisonSchema, expectedWordingInPrompt: z.literal(false) }).strict()]);
const fileCheckSchema = z.object({ locale: z.enum(["en", "pt", "es", "fr", "ja", "ar"]), key: z.string(), mediaId: z.string().uuid(), source: z.boolean(), audio: z.boolean(), loudness: z.boolean(), duration: z.boolean(), transcript: z.boolean(), evidence: z.array(z.string()).max(16), measurement: audioMeasurementSchema.nullable(), estimateSeconds: z.number(), durationRelativeError: z.number().nullable(), providerTranscript: comparisonSchema.nullable(), independentAsr: asrSchema }).strict();
type FileCheck = z.infer<typeof fileCheckSchema>;
interface Origin { jobId: string; contractVersion: number; inputBindings: unknown; correctionAgreement?: { id: string; digest: string }; expectedInstructionsHash?: string }

async function checkRecording(context: ProductionLease, source: ArtifactManifest, artifactId: string, commissionId: string, packageId: string, contractDigest: string, origin: Origin, script: NarrationScript, item: NarrationSegment, dependencies: { storage?: PrivateBlobGateway; transcription?: TranscriptionGateway }): Promise<FileCheck> {
  const result: FileCheck = { locale: script.locale, key: script.key, mediaId: item.audio.mediaId, source: false, audio: false, loudness: false, duration: false, transcript: false, evidence: [], measurement: null, estimateSeconds: script.estimateSeconds, durationRelativeError: null, providerTranscript: null, independentAsr: { available: false, runId: null, code: "AUDIO_NOT_MEASURED" } };
  try {
    if ((context.externalCalls ?? 0) >= 1) throw new ProductionContinuation("Checking the next complete recording", 1);
    await transaction(db => requireVerificationLease(db, context)); context.externalCalls = (context.externalCalls ?? 0) + 1;
    const { row, bytes } = await readOwnedMedia(context.tenantId, item.audio.mediaId, dependencies.storage);
    const { mediaId: _mediaId, url: _url, ...declared } = item.audio, { audio: _audio, ...segment } = item;
    if (row.commission_id !== commissionId || row.package_id !== packageId || row.job_id !== origin.jobId || row.operation_key !== `narration:${script.locale}:${script.key}:mp3` || row.media_type !== "audio/mpeg" || row.content_hash !== item.audio.contentHash || digest(row.metadata) !== digest(narrationFileMetadata(contractDigest, source, segment, declared, origin.correctionAgreement))) throw new DomainError("NARRATION_FILE_BINDING", "This file does not belong to the exact script, speech run, source and producing contract.", 422, false);
    const speech = await readCompletedSpeech(context.tenantId, item.speechRun.id), { operationId: _operationId, ...request } = speech.row.request;
    const inputHash = digest({ ...request, contractVersion: origin.contractVersion, contractDigest, inputBindings: origin.inputBindings });
    if (origin.expectedInstructionsHash && digest(request.instructions) !== origin.expectedInstructionsHash) throw new DomainError("NARRATION_TARGETED_INSTRUCTIONS", "The new stream does not use the exact per-key instructions reviewed in the targeted agreement.", 422, false);
    if (speech.row.job_id !== origin.jobId || speech.row.package_id !== packageId || speech.row.commission_id !== commissionId || speech.row.input_hash !== inputHash || request.text !== script.text || request.locale !== script.locale || request.model !== narrationStandard.model || request.voice !== narrationStandard.voice || speech.receiptHash !== item.speechRun.receiptHash || speech.receipt.contentHash !== item.speechRun.pcmHash || speech.receipt.model !== item.speechRun.model || speech.receipt.transcript !== item.speechRun.transcript) throw new DomainError("NARRATION_SPEECH_BINDING", "The original stream does not bind this exact source script, locale, model, voice and complete receipt.", 422, false);
    result.source = true;
    // Reconstruct the frozen transform from the saved original stream, then
    // measure the independently retrieved final bytes, not their declaration.
    const rendered = await renderNarration(speech.pcm, script.estimateSeconds), actual = await measureNarration(bytes);
    result.measurement = actual;
    result.audio = digest(actual) === digest(declared) && actual.contentHash === rendered.measurement.contentHash && item.rendering.rawDurationSeconds === rendered.rawDurationSeconds && item.rendering.tempo === rendered.tempo;
    result.loudness = actual.integratedLufs >= -18 && actual.integratedLufs <= -14 && actual.truePeakDbtp <= -1 && actual.clippedSamples === 0;
    result.durationRelativeError = Math.abs(actual.durationSeconds - script.estimateSeconds) / script.estimateSeconds;
    result.duration = result.durationRelativeError <= narrationStandard.durationTolerance;
    result.providerTranscript = speechErrorRate(script.text, speech.receipt.transcript, script.locale);
    result.transcript = result.providerTranscript.errorRate === 0;
    result.evidence.push(result.audio ? "Original private bytes, every encoded frame and every decoded sample match the declared profile and the frozen transform of the complete saved speech stream." : "The original audio or transform differs from the submitted measured declaration.");
    if (!result.loudness) result.evidence.push("The independent loudness, peak or clipping measurement is outside the agreed range.");
    if (!result.duration) result.evidence.push(`Decoded duration differs from the frozen estimate by ${(result.durationRelativeError * 100).toFixed(2)}%. No silence was added and no script was truncated to change this result.`);
    if (!result.transcript) result.evidence.push("The provider transcript differs from the complete normalized script. Its original text is retained for correction.");
    const asr = await transcribeSavedAudio(context, row, bytes, script.locale, dependencies.transcription);
    result.independentAsr = asr.available ? { available: true, runId: asr.runId, model: asr.result.model, bodyHash: asr.result.bodyHash, text: asr.result.text, languages: asr.result.languages, comparison: speechErrorRate(script.text, asr.result.text, script.locale), expectedWordingInPrompt: false } : { ...asr };
    return result;
  } catch (error) {
    if (error instanceof ProductionContinuation || error instanceof ProductionReviewRequired) throw error;
    if (error instanceof DomainError && error.status >= 500 && error.recoverable) throw new ProductionContinuation("The private audio store is unavailable; verification will read the same saved recording", 15);
    result.evidence.push(error instanceof DomainError ? `${error.code}: ${error.message}` : "The original audio could not be independently decoded and measured. No unverified recording was substituted.");
    return result;
  }
}

export async function verifyNarration(context: ProductionLease, dependencies: { storage?: PrivateBlobGateway; transcription?: TranscriptionGateway } = {}) {
  const { commission, package: pkg, artifact } = await transaction(db => requireVerificationLease(db, context));
  const retained = (await getPool().query<{ content_hash: string; manifest: ArtifactManifest }>("SELECT content_hash,manifest FROM guild_artifacts WHERE tenant_id=$1 AND commission_id=$2 AND id=$3 AND package_id=$4", [context.tenantId, commission.id, artifact.id, pkg.id])).rows[0];
  if (!retained || retained.content_hash !== artifact.contentHash || digest(retained.manifest.content) !== artifact.contentHash || retained.manifest.provenance.sourceId !== artifact.provenance.sourceId) throw new ProductionReviewRequired("NARRATION_ARTIFACT_CHANGED", "The current narration differs from its immutable submitted artifact. The original recording evidence is retained.");
  const sourceId = z.string().uuid().safeParse(pkg.acceptancePack.parameters?.sourceArtifactId);
  const source = sourceId.success ? (await getPool().query<{ manifest: ArtifactManifest; content_hash: string }>("SELECT manifest,content_hash FROM guild_artifacts WHERE tenant_id=$1 AND commission_id=$2 AND id=$3 AND package_id='translation'", [context.tenantId, commission.id, sourceId.data])).rows[0] : null;
  if (!source || source.content_hash !== pkg.acceptancePack.parameters?.sourceArtifactHash || digest(source.manifest.content) !== source.content_hash) throw new ProductionReviewRequired("NARRATION_SOURCE_CHANGED", "This narration check needs the exact original translation. No newer source draft was substituted.");
  const engine = audioEngineSchema.parse(pkg.acceptancePack.parameters?.engine), activeEngine = await qualifiedAudioEngine();
  if (digest(engine) !== digest(activeEngine)) throw new ProductionReviewRequired("NARRATION_ENGINE_CHANGED", "The agreed audio engine differs from this host. Retain the original report and qualify the exact engine before new measurements.");
  const pack: AcceptancePack = narrationAcceptancePack(source.manifest, engine), checks: FileCheck[] = [];
  const report = { schemaVersion: pkg.narrationTargetedCorrection ? "guild.narration-verification.v3" : "guild.narration-verification.v2", artifactId: artifact.id, artifactHash: artifact.contentHash, sourceArtifactHash: source.content_hash, engine, checks, humanListeningReviewed: false, fluentHumanReviewed: false, ...(pkg.narrationTargetedCorrection ? { mixedLineage: { agreementId: pkg.narrationTargetedCorrection.id, registerDigest: pkg.narrationTargetedCorrection.proposal.scope.registerDigest, replacements: pkg.narrationTargetedCorrection.proposal.scope.replacementRecordings, carried: pkg.narrationTargetedCorrection.proposal.scope.carriedRecordings, verified: false, recordings: [] as NarrationLineage[] } } : {}) };
  for (const criterion of pack.criteria) { criterion.status = criterion.kind === "deterministic" ? "failed" : "review"; criterion.evidence = criterion.kind === "deterministic" ? "The submission has not yet matched its full original source, coverage and producing-job evidence." : criterion.description; }
  const parsed = completeNarrationArtifactSchema.safeParse(artifact.content), scripts = narrationScripts(source.manifest);
  if (!parsed.success || artifact.contentHash !== digest(artifact.content) || pkg.acceptancePack.digest !== pack.digest || parsed.data.contractDigest !== pack.digest || digest(parsed.data.standard) !== digest(narrationStandard) || digest(parsed.data.engine) !== digest(engine) || parsed.data.sourceArtifactId !== source.manifest.id || parsed.data.sourceArtifactHash !== source.content_hash) return { pack, report };
  const items = parsed.data.segments;
  if (items.length !== scripts.length || new Set(items.map(item => `${item.locale}:${item.key}`)).size !== scripts.length || new Set(items.map(item => item.audio.mediaId)).size !== scripts.length || new Set(items.map(item => item.speechRun.id)).size !== scripts.length || !scripts.every(script => items.some(item => item.locale === script.locale && item.key === script.key && item.title === script.title && item.text === script.text && item.textHash === script.textHash && item.estimateSeconds === script.estimateSeconds && item.audio.url === `/api/media/${item.audio.mediaId}`))) return { pack, report };
  const original = (await getPool().query<{ job_id: string; input: { packageId: string; contractVersion: number; inputBindings: unknown; correctionAgreementId?: string; correctionAgreementDigest?: string; targetedAgreementId?: string; targetedAgreementDigest?: string }; state: string }>("SELECT s.job_id,j.input,j.state FROM guild_speech_runs s JOIN guild_jobs j ON j.id=s.job_id AND j.tenant_id=s.tenant_id WHERE s.id=$1 AND s.tenant_id=$2 AND j.commission_id=$3 AND j.type='produce_package' AND s.state='completed'", [artifact.provenance.sourceId, context.tenantId, commission.id])).rows[0];
  if (!original || original.state !== "completed" || original.input.packageId !== pkg.id || original.input.contractVersion !== pkg.contractVersion || digest(original.input.inputBindings) !== digest(parsed.data.inputBindings) || !parsed.data.inputBindings.some(item => item.artifactId === source.manifest.id && item.artifactHash === source.content_hash)) return { pack, report };
  const expectedAgreement = pkg.narrationCorrection ? { id: pkg.narrationCorrection.id, digest: pkg.narrationCorrection.proposal.digest } : null;
  if (parsed.data.schemaVersion === "guild.narration.v2" && (pkg.narrationTargetedCorrection || digest(parsed.data.correctionAgreement ?? null) !== digest(expectedAgreement) || (expectedAgreement && (original.input.correctionAgreementId !== expectedAgreement.id || original.input.correctionAgreementDigest !== expectedAgreement.digest)))) return { pack, report };
  const origin: Origin = { jobId: original.job_id, contractVersion: original.input.contractVersion, inputBindings: original.input.inputBindings, ...(expectedAgreement ? { correctionAgreement: expectedAgreement } : {}) };
  const origins = new Map<string, Origin>();
  if (parsed.data.schemaVersion === "guild.narration.v3") {
    const agreement = pkg.narrationTargetedCorrection;
    if (!agreement || parsed.data.lineage.length !== scripts.length || new Set(parsed.data.lineage.map(item => `${item.locale}/${item.key}`)).size !== scripts.length || digest(parsed.data.targetedCorrection) !== digest({ agreementId: agreement.id, agreementDigest: agreement.proposal.digest, registerDigest: agreement.proposal.scope.registerDigest, assemblyJobId: original.job_id, contractVersion: pkg.contractVersion })) return { pack, report };
    await validateNarrationTargetedCorrection(getPool(), commission, pkg, { id: original.job_id, input: original.input }, true);
    const priorJobs = (await getPool().query<{ id: string; input: { inputBindings: unknown }; state: string }>("SELECT id,input,state FROM guild_jobs WHERE tenant_id=$1 AND commission_id=$2 AND type='produce_package' AND id=ANY($3::uuid[])", [context.tenantId, commission.id, [...new Set(parsed.data.lineage.map(item => item.productionJobId))]])).rows;
    for (const item of items) {
      const entry = agreement.proposal.scope.register.find(entry => entry.locale === item.locale && entry.key === item.key), declared = parsed.data.lineage.find(entry => entry.locale === item.locale && entry.key === item.key);
      if (!entry || !declared) return { pack, report };
      const carried = entry.action === "carry_forward";
      const expected: NarrationLineage = { locale: item.locale, key: item.key, mode: carried ? "carried" : "replacement", productionJobId: carried ? entry.productionJobId : original.job_id, contractVersion: carried ? entry.contractVersion : pkg.contractVersion, contractDigest: carried ? entry.contractDigest : pkg.acceptancePack.digest, inputBindingsDigest: carried ? entry.inputBindingsDigest : digest(original.input.inputBindings), mediaId: item.audio.mediaId, speechRunId: item.speechRun.id, originalArtifactId: carried ? entry.artifactId : null, originalArtifactHash: carried ? entry.artifactHash : null, ...(carried ? entry.correctionAgreement ? { correctionAgreement: entry.correctionAgreement } : {} : { correctionAgreement: { id: agreement.id, digest: agreement.proposal.digest } }) };
      const job = priorJobs.find(job => job.id === declared.productionJobId);
      if (digest(declared) !== digest(expected) || !job || job.state !== "completed" || digest(job.input.inputBindings) !== declared.inputBindingsDigest || carried && digest(item) !== entry.segmentHash || !carried && (item.audio.mediaId === entry.mediaId || item.speechRun.id === entry.speechRunId)) return { pack, report };
      origins.set(`${item.locale}/${item.key}`, { jobId: declared.productionJobId, contractVersion: declared.contractVersion, inputBindings: job.input.inputBindings, ...(declared.correctionAgreement ? { correctionAgreement: declared.correctionAgreement } : {}), ...(!carried ? { expectedInstructionsHash: entry.replacementInstructionsHash! } : {}) });
    }
    report.mixedLineage!.recordings = parsed.data.lineage;
  }
  for (const script of scripts) {
    const item = items.find(item => item.locale === script.locale && item.key === script.key)!;
    const fileOrigin = origins.get(`${script.locale}/${script.key}`) ?? origin;
    const partKey = `verify:narration:${script.locale}:${script.key}`, inputHash = digest({ artifactId: artifact.id, artifactHash: artifact.contentHash, contractVersion: pkg.contractVersion, contractDigest: pack.digest, script, item, origin: fileOrigin });
    try {
      const saved = await savedProductionPart(context, partKey, inputHash, fileCheckSchema);
      checks.push(saved ?? await saveProductionPart(context, partKey, inputHash, await checkRecording(context, source.manifest, artifact.id, commission.id, pkg.id, pack.digest, fileOrigin, script, item, dependencies), fileCheckSchema));
    } catch (error) { if (error instanceof ProductionContinuation) throw new ProductionContinuation(`Narration checks · ${checks.length} of ${scripts.length} recordings measured. ${error.step}.`, error.retryAfterSeconds); throw error; }
  }
  if (report.mixedLineage) report.mixedLineage.verified = checks.length === scripts.length && checks.every(item => item.source);
  for (const criterion of pack.criteria.filter(item => item.kind === "deterministic")) {
    const field = criterion.id === "coverage" ? "source" : criterion.id as "source" | "audio" | "loudness" | "duration" | "transcript";
    const failed = checks.filter(item => !item[field]); criterion.status = failed.length ? "failed" : "passed";
    criterion.evidence = failed.length ? `${failed.length}/${checks.length} recordings need correction for this criterion: ${failed.map(item => `${item.locale}/${item.key}`).join(", ")}. The full original-file report is retained.` : criterion.id === "transcript" ? `Every normalized script unit matches the provider-reported transcript in all ${checks.length} recordings. This is not a listening or independent speech-recognition result.` : criterion.id === "duration" ? `All ${checks.length} decoded recordings are within ±10% of their frozen script estimates; maximum deviation ${(Math.max(...checks.map(item => item.durationRelativeError ?? 0)) * 100).toFixed(2)}%.` : criterion.id === "loudness" ? `All ${checks.length} original recordings independently meet −18 to −14 LUFS, ≤−1 dBTP and zero clipped samples.` : `All ${checks.length} exact recordings retain their full original speech receipts, script hashes, producing-job identity and independently checked final bytes.`;
  }
  const available = checks.flatMap(item => item.independentAsr.available ? [item.independentAsr] : []), advisory = pack.criteria.find(item => item.id === "asr")!;
  advisory.evidence = `${available.length}/${checks.length} original audio files have retained independent gpt-transcribe results without expected text in a prompt; ${available.filter(item => item.comparison.errorRate <= 0.1).length} meet the proposed ≤10% error-rate target. Every missing or failed result stays visible. These language-specific comparisons remain advisory, and listening review is still required.`;
  return { pack, report };
}
