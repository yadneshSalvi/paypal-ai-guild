import type { Pool, PoolClient } from "pg";
import type { AcceptancePack, ArtifactInputBinding, Commission, WorkPackage } from "@/contracts/guild";
import { locales } from "@/contracts/guild";
import { captionArtifactSchema, checkEasyRead } from "@/domain/captions";
import { deepgramTimestampCapability } from "@/domain/deepgram-caption-alignment";
import { checkImageArtifact, imageArtifactSchema, imageRightsHash } from "@/domain/images";
import { translationArtifactSchema } from "@/domain/translation";
import { digest, DomainError } from "@/domain/primitives";
import { webSourceSchema, type WebLabel, type WebSources } from "@/domain/web-exhibition";
import { readCaptionApprovalHistory } from "../captions/approval-history";
import { validateCaptionJob } from "../captions/contracts";
import { captionOwnedArtifact, reviewEvidence } from "../captions/sources";
import { resolveProductionInputs } from "../production-inputs";
import { readWebSourceApproval } from "./source-history";
import { acceptedWebCaptionRevisions } from "./caption-revisions";

type Db = Pool | PoolClient;
function fail(message = "The web agreement needs complete passing, hash-bound original research, translation, images, narration and captions."): never { throw new DomainError("WEB_SOURCE_BINDING", message, 422, false); }
interface CaptionReport { schemaVersion: string; sourceVerified: boolean; producingApprovalVerified: boolean; artifactId: string; artifactHash: string; sourceDigest: string; contractDigest: string;
  verifierVersion?: string; timestampCapability?: unknown; newRecognitionRequests?: number; fluentHumanReviewed?: boolean; automatedQualification?: string; semanticReviewRequired?: boolean;
  checks: { locale: string; key: string; mediaId: string; source: boolean; alignment: boolean; vtt: boolean; listeningAttested?: boolean; timingSource?: string;
    reviewRevisionId?: string | null; originalAudioHash?: string | null; rawResponseHash?: string | null; cueCount?: number; measuredDurationSeconds?: number | null }[];
  easyRead: { locale: string; passed: boolean }[]; originalBlindReport: unknown }

/** No provider calls. Exact current inputs resolve to immutable original producers. */
export async function buildWebSources(db: Db, c: Commission, pkg: WorkPackage, frozen?: WebSources): Promise<WebSources> {
  if (pkg.kind !== "web" || c.mode !== "live") fail();
  const inputs = await resolveProductionInputs(db, c, pkg), bindings = frozen?.inputBindings ?? inputs.bindings;
  if (bindings.length !== 4 || inputs.bindings.length !== bindings.length || !inputs.bindings.every(item => bindings.some(binding => binding.packageId === item.packageId && binding.contractVersion === item.contractVersion && binding.artifactId === item.artifactId && binding.artifactHash === item.artifactHash))) fail();
  async function direct(kind: "research" | "translation" | "images" | "captions") {
    const contract = c.packages.find(item => item.kind === kind), binding = bindings.find(item => item.packageId === contract?.id);
    if (!contract || !binding || contract.contractVersion !== binding.contractVersion) fail();
    const artifact = await captionOwnedArtifact(db, c, binding.artifactId, binding.artifactHash);
    await readWebSourceApproval(db, c, contract, artifact);
    return { contract, binding, artifact };
  }
  const research = await direct("research"), translation = await direct("translation"), images = await direct("images"), captions = await direct("captions");
  const translated = translationArtifactSchema.parse(translation.artifact.content), pictures = imageArtifactSchema.parse(images.artifact.content);
  const reviewed = captions.artifact.content.schemaVersion === "guild.captions.v3" ? await acceptedWebCaptionRevisions(db, c, captions.contract, captions.artifact, captions.binding) : null;
  const legacyCaption = reviewed ? null : captionArtifactSchema.parse(captions.artifact.content), caption = reviewed?.content ?? legacyCaption!;
  const captionHistory = reviewed?.history ?? await readCaptionApprovalHistory(db, c, captions.contract, captions.artifact);
  const boundCaption = reviewed?.bound ?? await validateCaptionJob(db, captionHistory.snapshot, captionHistory.package, captionHistory.job, false);
  if (caption.sourceDigest !== digest(boundCaption.sources) || digest(caption.sources) !== digest(boundCaption.sources)
    || caption.sources.research.artifactId !== research.artifact.id || caption.sources.research.artifactHash !== research.artifact.contentHash
    || caption.sources.translation.artifactId !== translation.artifact.id || caption.sources.translation.artifactHash !== translation.artifact.contentHash
    || translated.sourceArtifactId !== research.artifact.id || translated.sourceArtifactHash !== research.artifact.contentHash
    || Object.values(checkImageArtifact(pictures, c.sourceAssets, images.contract.acceptancePack.digest)).some(item => !item.passed)) fail();
  const narration = await captionOwnedArtifact(db, c, caption.sources.narration.artifactId, caption.sources.narration.artifactHash);
  const directReviews = [];
  for (const binding of bindings) directReviews.push(await reviewEvidence(db, c, binding));
  const reviews = [...directReviews];
  for (const original of caption.sources.reviews) {
    const actual = await reviewEvidence(db, c, original as ArtifactInputBinding);
    if (digest(actual) !== digest(original)) fail("A transitive narration/research/translation review differs from the original caption source chain.");
    if (!reviews.some(item => item.reviewId === actual.reviewId && item.artifactId === actual.artifactId)) reviews.push(actual);
  }
  const captionReview = directReviews.find(item => item.artifactId === captions.artifact.id)!;
  const checked = (await db.query<{ result: AcceptancePack; criteria_digest: string }>("SELECT result,criteria_digest FROM guild_verifications WHERE id=$1 AND tenant_id=$2 AND commission_id=$3", [captionReview.verificationId, c.tenantId, c.id])).rows[0];
  const reports = (await db.query<{ id: string; input: { packageId: string; contractVersion: number; acceptancePackDigest: string }; output: { pack: AcceptancePack; report: CaptionReport } }>("SELECT id,input,output FROM guild_jobs WHERE tenant_id=$1 AND commission_id=$2 AND type='verify_artifact' AND state='completed' AND input->>'artifactId'=$3 AND input->>'artifactHash'=$4 AND ($5::uuid IS NULL OR id=$5) ORDER BY created_at DESC,id DESC", [c.tenantId, c.id, captions.artifact.id, captions.artifact.contentHash, frozen?.captionVerification.jobId ?? null])).rows;
  const report = reports.find(item => item.output?.report && checked && digest(item.output.pack) === checked.criteria_digest && digest(checked.result) === checked.criteria_digest);
  const expected = caption.sources.tracks.map(item => `${item.locale}/${item.key}`).sort();
  if (!report || report.output.report.schemaVersion !== (reviewed ? "guild.caption-verification.v3" : "guild.caption-verification.v2") || !report.output.report.sourceVerified || !report.output.report.producingApprovalVerified || report.output.report.artifactId !== captions.artifact.id || report.output.report.artifactHash !== captions.artifact.contentHash
    || report.output.report.sourceDigest !== caption.sourceDigest || report.output.report.contractDigest !== captions.contract.acceptancePack.digest
    || digest(report.output.report.originalBlindReport) !== digest(caption.sources.narration.verificationReport)
    || report.output.report.checks.map(item => `${item.locale}/${item.key}`).sort().join() !== expected.join()
    || report.output.report.checks.some(item => !item.source || !item.alignment || !item.vtt || !caption.sources.tracks.some(track => track.locale === item.locale && track.key === item.key && track.mediaId === item.mediaId))
    || report.output.report.easyRead.length !== locales.length || new Set(report.output.report.easyRead.map(item => item.locale)).size !== locales.length || !locales.every(locale => report.output.report.easyRead.some(item => item.locale === locale && item.passed)) || report.output.report.easyRead.some(item => !item.passed))
    fail("All original caption tracks and six easy-read files need their complete passing independent report. Failed, missing and ambiguous alignments cannot be substituted in the web commission.");
  if (reviewed && (report.input.packageId !== captions.contract.id || report.input.contractVersion !== captions.contract.contractVersion || report.input.acceptancePackDigest !== caption.contractDigest
    || report.output.pack.digest !== caption.contractDigest || report.output.report.verifierVersion !== "northlight.independent-deepgram-and-review-bytes.v1"
    || digest(report.output.report.timestampCapability) !== digest(deepgramTimestampCapability) || report.output.report.newRecognitionRequests !== 0
    || report.output.report.fluentHumanReviewed !== false || report.output.report.automatedQualification !== "not-qualified" || report.output.report.semanticReviewRequired !== true
    || report.output.report.checks.some(check => {
      const provenance = reviewed.provenance.tracks.find(track => track.locale === check.locale && track.key === check.key), source = caption.sources.tracks.find(track => track.locale === check.locale && track.key === check.key);
      return !provenance || !source || check.source !== true || check.alignment !== true || check.vtt !== true || check.listeningAttested !== true || check.timingSource !== "attributed-listening" || check.reviewRevisionId !== provenance.reviewRevisionId
        || check.originalAudioHash !== provenance.audioHash || check.rawResponseHash !== provenance.rawBodyHash || check.cueCount !== reviewed.captions.get(`${check.locale}/${check.key}`)?.cues.length || check.measuredDurationSeconds !== source.durationSeconds;
    }))) fail("The independent v3 report must check this exact accepted effective revision, original recognition and VTT for every recording. A listening declaration alone cannot pass the web source gate.");
  if (caption.tracks.length !== expected.length || new Set(caption.tracks.map(item => `${item.locale}/${item.key}`)).size !== expected.length || caption.easyRead.some(item => !checkEasyRead(item, caption.sources).passed)) fail();
  const labels = {} as WebSources["labels"];
  for (const language of locales) {
    const easy = caption.easyRead.find(item => item.locale === language);
    if (!easy) fail();
    labels[language] = {};
    for (const key of caption.sources.requiredKeys) {
      const original = caption.sources.tracks.find(item => item.locale === language && item.key === key), content = translated.translations[language][key];
      let effective = reviewed?.captions.get(`${language}/${key}`);
      if (!reviewed) {
        const legacy = legacyCaption!.tracks.find(item => item.locale === language && item.key === key);
        if (!original || !legacy || legacy.sourceTrackDigest !== digest(original) || legacy.alignment.status !== "aligned" || !legacy.vtt
          || legacy.alignment.cuesHash !== digest(legacy.alignment.cues) || legacy.alignment.timingsHash !== digest(legacy.alignment.words)) fail();
        effective = { vtt: { mediaId: legacy.vtt.mediaId, contentHash: legacy.vtt.contentHash, byteLength: legacy.vtt.byteLength, mediaType: "text/vtt" },
          alignmentRunId: legacy.alignmentRunId, receiptHash: legacy.receiptHash, timingsHash: legacy.alignment.timingsHash, cuesHash: legacy.alignment.cuesHash, cues: legacy.alignment.cues };
      }
      if (!original || !content || !easy.labels[key] || !effective) fail();
      const value: WebLabel = { title: content.title, body: content.body, transcript: original.text, sourceTrackDigest: digest(original), scriptBytesHash: original.scriptBytesHash,
        audio: { mediaId: original.mediaId, contentHash: original.audioHash, byteLength: original.byteLength, mediaType: "audio/mpeg", durationSeconds: original.durationSeconds,
          origin: { artifactId: original.origin.artifactId, artifactHash: original.origin.artifactHash, productionJobId: original.origin.productionJobId, contractVersion: original.origin.contractVersion, contractDigest: original.origin.contractDigest,
            inputBindingsDigest: original.origin.inputBindingsDigest, approvalPlanDigest: original.origin.approvalPlanDigest, speechRunId: original.origin.speechRunId, speechReceiptHash: original.origin.receiptHash, originalMediaId: original.mediaId, originalMediaHash: original.audioHash } },
        captions: effective, easyRead: easy.labels[key]! };
      labels[language][key] = value;
    }
  }
  const photographs = c.sourceAssets.map(source => {
    const image = pictures.images.find(item => item.sourceId === source.id);
    if (!image || image.sourceHash !== source.contentHash || image.rightsHash !== imageRightsHash(source)) fail();
    return { id: source.id, sourceHash: source.contentHash, rightsHash: image.rightsHash, title: source.title, description: source.description, creator: source.creator, date: source.date, rights: source.rights,
      sourceUrl: source.sourceUrl, rightsUrl: source.rightsUrl, alt: image.description.alt,
      full: { mediaId: image.full.mediaId, contentHash: image.full.contentHash, byteLength: image.full.bytes, mediaType: "image/webp" as const, width: image.full.width, height: image.full.height },
      thumbnail: { mediaId: image.thumbnail.mediaId, contentHash: image.thumbnail.contentHash, byteLength: image.thumbnail.bytes, mediaType: "image/webp" as const, width: image.thumbnail.width, height: image.thumbnail.height } };
  });
  const result = webSourceSchema.parse({ schemaVersion: "guild.exhibition-sources.v1", museum: c.museum, provenance: { mode: "live", label: reviewed ? reviewed.provenance.disclosure : "Original commissioned sources with retained producing approvals and automated checks. Human experience and fluent-language review remain separate." },
    ancestors: [research, translation, images, captions].map(item => ({ kind: item.contract.kind, packageId: item.contract.id, contractVersion: item.binding.contractVersion, artifactId: item.artifact.id, artifactHash: item.artifact.contentHash })).concat([{ kind: "narration", packageId: narration.packageId, contractVersion: caption.sources.narration.contractVersion, artifactId: narration.id, artifactHash: narration.contentHash }]),
    inputBindings: bindings, reviews, captionSourceDigest: caption.sourceDigest, captionProductionJobId: caption.productionJobId, captionVerification: { jobId: report.id, outputHash: digest(report.output) },
    requiredKeys: caption.sources.requiredKeys, photographs, labels,
    languageReviews: Object.fromEntries(locales.map(language => [language, { fluentHumanReviewed: false, disclosure: reviewed ? reviewed.provenance.disclosure : "Original model-produced translations, narration and source-linked easy read; fluent-human and listening review have not been established by these automated checks." }])) });
  if (frozen && digest(result) !== digest(frozen)) fail();
  return result;
}
