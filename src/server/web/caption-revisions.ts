import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { locales, type ArtifactInputBinding, type ArtifactManifest, type Commission, type WorkPackage } from "@/contracts/guild";
import { renderCaptionVtt } from "@/domain/caption-alignment";
import { deepgramCaptionArtifactSchema } from "@/domain/deepgram-captions";
import { digest, DomainError } from "@/domain/primitives";
import { acceptedWebCaptionProvenanceSchema, webEffectiveCaptionTimingsHash, type AcceptedWebCaptionProvenance } from "@/domain/web-caption-provenance";
import type { WebLabel } from "@/domain/web-exhibition";
import { readDeepgramCaptionApprovalHistory, validateDeepgramCaptionJob } from "../captions/deepgram-contracts";
import { deepgramCaptionVttMetadata } from "../captions/deepgram-production";
import { captionOwnedArtifact } from "../captions/sources";

type Db = Pool | PoolClient;
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const recordHash = (value: unknown) => digest(JSON.parse(JSON.stringify(value)));
function fail(message: string): never { throw new DomainError("WEB_CAPTION_REVIEW_BINDING", message, 422, false); }
interface Decision { id: string; actor_id: string; criteria_digest: string; review_disclosures: Record<string, unknown>; created_at: Date }
const listeningDisclosure = "Accepted under the explicitly reviewed human-correction contract. Named listening declarations and independent structural checks do not establish automatic ASR qualification or fluent-language review. The curator explicitly acknowledges each language’s review limits.";

/** Read only. A review draft or an automated review is insufficient for this
 * capability, even when the enclosing web contract permits other checked drafts.
 * Historical evidence never borrows current dispatch authority or renews it. */
export async function acceptedWebCaptionRevisions(db: Db, c: Commission, pkg: WorkPackage, artifact: ArtifactManifest, binding: ArtifactInputBinding) {
  if (pkg.kind !== "captions" || pkg.acceptancePack.version !== "3.0.0" || binding.reviewKind !== "curator_acceptance"
    || pkg.state !== "accepted" || binding.packageId !== pkg.id || binding.contractVersion !== pkg.contractVersion
    || binding.artifactId !== artifact.id || binding.artifactHash !== artifact.contentHash || !pkg.artifactIds.includes(artifact.id))
    fail("The exact v3 caption correction must have its own curator acceptance before downstream web work. A draft or automated annotation cannot supply that authority.");
  const content = deepgramCaptionArtifactSchema.parse(artifact.content);
  const history = await readDeepgramCaptionApprovalHistory(db, c, pkg, artifact);
  const bound = await validateDeepgramCaptionJob(db, history.snapshot, history.package, history.job, false);
  if (content.attempt !== 2 || !content.correction || !bound.correction || !pkg.deepgramCaptionCorrection
    || digest(bound.correction) !== digest(pkg.deepgramCaptionCorrection) || content.correction.id !== bound.correction.id
    || content.correction.digest !== bound.correction.proposal.digest || content.productionJobId !== history.job.id)
    fail("The accepted caption manifest differs from its one exact agreed correction assembly.");
  const original = await captionOwnedArtifact(db, c, content.correction.baseArtifactId, content.correction.baseArtifactHash), base = deepgramCaptionArtifactSchema.parse(original.content);
  if (base.attempt !== 1 || base.correction || base.productionJobId !== content.originalProductionJobId || base.originalProductionJobId !== base.productionJobId
    || base.contractDigest !== content.contractDigest || base.sourceDigest !== content.sourceDigest || digest(base.sources) !== digest(content.sources)
    || digest(base.easyRead) !== digest(content.easyRead) || content.tracks.length !== content.sources.tracks.length || base.tracks.length !== content.tracks.length
    || new Set(content.tracks.map(track => `${track.locale}/${track.key}`)).size !== content.tracks.length
    || new Set(content.tracks.map(track => track.alignmentRunId)).size !== content.tracks.length)
    fail("The correction must preserve every original source, automatic outcome and easy-read response, including every failed recording.");
  const decision = (await db.query<Decision>("SELECT id,package_id,contract_version,artifact_id,artifact_hash,criteria_digest,actor_id,decision,review_disclosures,created_at FROM guild_acceptance_decisions WHERE tenant_id=$1 AND commission_id=$2 AND id=$3 AND package_id=$4 AND contract_version=$5 AND artifact_id=$6 AND artifact_hash=$7 AND decision='accepted'", [c.tenantId, c.id, binding.reviewId, pkg.id, pkg.contractVersion, artifact.id, artifact.contentHash])).rows[0];
  if (!decision || decision.criteria_digest !== pkg.acceptancePack.digest) fail("The accepted v3 caption identity no longer has its exact retained curator decision.");
  const actor = (await db.query<{ role: string; created_at: Date }>("SELECT role,created_at FROM guild_sessions WHERE tenant_id=$1 AND id=$2", [c.tenantId, decision.actor_id])).rows[0], disclosure = decision.review_disclosures;
  const languages = disclosure.languages as Record<string, Record<string, unknown>> | undefined;
  if (!actor || !["owner", "judge"].includes(actor.role) || actor.created_at > decision.created_at || disclosure.actorKind !== actor.role || disclosure.humanReviewed !== true
    || disclosure.fluentReviewed !== false || disclosure.mode !== "live" || typeof disclosure.disclosure !== "string" || !disclosure.disclosure.trim()
    || !languages || Object.keys(languages).sort().join() !== [...locales].sort().join() || !locales.every(locale => {
      const item = languages[locale];
      return item?.fluentReviewed === false && item.reviewer === null && item.reviewedAt === null && item.curatorAcknowledged === true && item.actorKind === actor.role
        && typeof item.disclosure === "string" && !!item.disclosure.trim() && typeof item.acknowledgedAt === "string" && Number.isFinite(Date.parse(item.acknowledgedAt));
    })) fail("The exact caption edition needs a separate owner/judge acceptance and explicit limits for all six languages. Listening declarations do not perform that decision.");
  const captions = new Map<string, WebLabel["captions"]>(), tracks: AcceptedWebCaptionProvenance["tracks"] = [], declarations = [];
  for (const source of content.sources.tracks) {
    const track = content.tracks.find(item => item.locale === source.locale && item.key === source.key), earlier = base.tracks.find(item => item.locale === source.locale && item.key === source.key);
    const agreed = bound.correction.proposal.revisions.find(item => item.locale === source.locale && item.key === source.key);
    if (!track || !earlier || !agreed || !track.reviewRevision || !track.vtt || track.reviewRevision.id !== agreed.id || track.reviewRevision.digest !== agreed.digest
      || track.sourceTrackDigest !== digest(source) || track.alignmentRunId !== earlier.alignmentRunId || track.receiptHash !== earlier.receiptHash
      || track.observationJobId !== base.productionJobId || earlier.observationJobId !== base.productionJobId || digest(track.candidate) !== digest(earlier.candidate))
      fail("A submitted caption track differs from its exact original observation or agreed effective review revision.");
    const validated = bound.reviewedTracks?.get(`${source.locale}/${source.key}`);
    if (!validated) fail("This exact operation did not validate a complete original receipt and signed review for the accepted track.");
    const { target, revision } = validated;
    if (revision.id !== agreed.id || revision.digest !== agreed.digest || revision.artifactId !== original.id || revision.artifactHash !== original.contentHash || revision.sourceTrackDigest !== digest(source)
      || !revision.attestation || !["owner", "judge"].includes(revision.actorRole) || revision.evaluation.status !== "ready-for-review" || !revision.parentRevisionId || !revision.parentRevisionDigest
      || Date.parse(revision.createdAt) > Date.parse(bound.correction.agreedAt) || Date.parse(revision.createdAt) > decision.created_at.getTime())
      fail("A missing, changed, uncertain or unattributed timing draft cannot enter accepted web captions.");
    // Expiry/revocation after a declaration does not erase it. Its author must
    // nevertheless have held that human role when the original statement was
    // recorded; a later session renewal cannot repair an invalid old statement.
    const author = (await db.query<{ role: string; created_at: Date; expires_at: Date; revoked_at: Date | null }>("SELECT role,created_at,expires_at,revoked_at FROM guild_sessions WHERE tenant_id=$1 AND id=$2", [c.tenantId, revision.actorId])).rows[0];
    const renewal = (await db.query<{ previous_expires_at: Date }>("SELECT previous_expires_at FROM guild_session_renewals WHERE session_id=$1 AND created_at>$2 ORDER BY created_at,request_id LIMIT 1", [revision.actorId, revision.createdAt])).rows[0];
    const declared = Date.parse(revision.createdAt);
    if (!author || author.role !== revision.actorRole || !Number.isFinite(declared) || author.created_at.getTime() > declared
      || (renewal?.previous_expires_at ?? author.expires_at).getTime() <= declared || author.revoked_at && author.revoked_at.getTime() <= declared)
      fail("The listening statement does not retain the correct human actor and original authority at its declared time.");
    const effective = { status: "ready-for-review", provenance: "attributed-listening", cues: revision.evaluation.cues, cuesHash: digest(revision.evaluation.cues), listeningAttested: true, fluentReviewed: false, productionAccepted: false };
    const expected = Buffer.from(renderCaptionVtt(revision.evaluation.cues), "utf8"), timingsHash = webEffectiveCaptionTimingsHash(artifact.contentHash, content, source, track);
    const media = (await db.query<{ job_id: string; operation_key: string; content_hash: string; byte_length: string; media_type: string; metadata: unknown }>("SELECT job_id,operation_key,content_hash,byte_length,media_type,metadata FROM guild_media_objects WHERE tenant_id=$1 AND commission_id=$2 AND package_id=$3 AND id=$4 AND state='ready'", [c.tenantId, c.id, pkg.id, track.vtt.mediaId])).rows[0];
    if (digest(effective) !== digest(track.effective) || track.vtt.url !== `/api/media/${track.vtt.mediaId}` || track.vtt.contentHash !== sha(expected) || track.vtt.byteLength !== expected.length
      || !media || media.job_id !== content.productionJobId || media.operation_key !== `deepgram-caption:${source.locale}:${source.key}:vtt` || media.media_type !== "text/vtt"
      || media.content_hash !== track.vtt.contentHash || Number(media.byte_length) !== expected.length || digest(media.metadata) !== digest(deepgramCaptionVttMetadata(content.contractDigest, content.sources, source, track)))
      fail("The accepted effective cues, VTT identity or original VTT metadata changed. No automatic candidate or substitute file was used.");
    declarations.push({ locale: track.locale, key: track.key, revisionId: revision.id, revisionDigest: revision.digest, actorId: revision.actorId,
      reviewerName: revision.attestation.reviewerName, recordedAt: revision.createdAt, humanDeclaredListening: true, fluentReviewed: false });
    captions.set(`${source.locale}/${source.key}`, { vtt: { mediaId: track.vtt.mediaId, contentHash: track.vtt.contentHash, byteLength: track.vtt.byteLength, mediaType: "text/vtt" },
      alignmentRunId: track.alignmentRunId, receiptHash: track.receiptHash, timingsHash, cuesHash: track.effective.cuesHash, cues: track.effective.cues });
    tracks.push({ locale: source.locale, key: source.key, sourceTrackDigest: digest(source), audioHash: source.audioHash, scriptBytesHash: source.scriptBytesHash,
      alignmentRunId: track.alignmentRunId, receiptHash: track.receiptHash, rawBodyHash: target.rawBodyHash, automaticCandidateHash: digest(track.candidate),
      reviewRevisionId: revision.id, reviewRevisionDigest: revision.digest, parentRevisionId: revision.parentRevisionId, parentRevisionDigest: revision.parentRevisionDigest,
      actorId: revision.actorId, actorRole: revision.actorRole as "owner" | "judge", declaredAt: revision.createdAt, attributionHash: digest(revision.attestation), effectiveTimingsHash: timingsHash,
      cuesHash: track.effective.cuesHash, vtt: { mediaId: track.vtt.mediaId, contentHash: track.vtt.contentHash, byteLength: track.vtt.byteLength } });
  }
  const expectedDisclosure = { version: "guild.caption-acceptance-disclosures.v1", automatedQualification: "not-qualified", declarations, disclosure: listeningDisclosure };
  if (digest(disclosure.captionListening) !== digest(expectedDisclosure)) fail("The caption acceptance did not acknowledge this exact complete set of attributed listening revisions.");
  const synthetic = disclosure.syntheticFixture === true;
  const provenance = acceptedWebCaptionProvenanceSchema.parse({ version: "guild.web-accepted-caption-revisions.v1", artifactId: artifact.id, artifactHash: artifact.contentHash,
    contractDigest: content.contractDigest, sourceDigest: content.sourceDigest, productionJobId: content.productionJobId, originalProductionJobId: content.originalProductionJobId,
    originalArtifactId: original.id, originalArtifactHash: original.contentHash, correctionId: content.correction.id, correctionDigest: content.correction.digest,
    acceptanceId: decision.id, acceptanceRecordHash: recordHash(decision), syntheticFixture: synthetic,
    disclosure: synthetic ? "SYNTHETIC FIXTURE. These declarations and acceptance identities are fictional records over generated tones and controlled recognition. No person listened, accepted or fluent-reviewed this work; no real provider or browser qualification is claimed."
      : "This accepted v3 edition binds the exact named listening declarations, original recognition and effective VTTs. Software verifies their integrity; listening, fluent review and automatic qualification are separate claims.", tracks });
  return { content, history, bound, captions, provenance, synthetic };
}
