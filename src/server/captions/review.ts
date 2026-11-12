import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { ArtifactManifest, Commission, Locale } from "@/contracts/guild";
import { captionArtifactSchema, type CaptionTrackSource } from "@/domain/captions";
import { deepgramCaptionArtifactSchema } from "@/domain/deepgram-captions";
import { buildDeepgramCaptionCandidate } from "@/domain/deepgram-source-mapping";
import { automaticCaptionReviewUnits, blankCaptionReviewUnits, captionHumanTimingPolicy, captionReviewCommandSchema, captionReviewRevisionDigest, evaluateCaptionReview, type CaptionReviewCommand, type CaptionReviewRevision, type CaptionReviewUnit } from "@/domain/caption-review";
import { canonical, digest, DomainError } from "@/domain/primitives";
import { appendEvent, saveCommission } from "../commissions";
import { getPool, transaction } from "../db";
import type { Session } from "../session";
import { requireCaptionActor } from "./authority";
import { readAlignmentRecord } from "./alignment-runs";
import { readDeepgramRun } from "./deepgram-runs";

type Db = Pool | PoolClient;
function fail(code: string, message: string): never { throw new DomainError(code, message, 422, false); }
function signature(value: CaptionReviewRevision) {
  if (!process.env.AUTH_SECRET) fail("CAPTION_REVIEW_CONFIGURATION", "Private review signing is not configured.");
  return createHmac("sha256", process.env.AUTH_SECRET!).update(canonical({ kind: "guild.caption-review.v1", digest: value.digest })).digest("hex");
}
export interface CaptionObservationWord { word: string; rawStart: number; rawEnd: number; startMs: number; endMs: number; confidence: number | null }
interface Target { manifest: ArtifactManifest; commissionId: string; source: CaptionTrackSource; runId: string; receiptHash: string;
  automatic: CaptionReviewUnit[] | null; transcript: string | null; words: CaptionObservationWord[]; provider: string; rawBodyHash: string; codes: string[] }

/** A single operation may inspect every track. Validate the complete immutable
 * artifact once for that operation; receipts and review signatures are still
 * read and checked for each exact track using the caller's transaction client.
 * Never retain this reader across a request, lease or authority check. */
export async function captionReviewTargets(db: Db, tenantId: string, artifactId: string) {
  const row = (await db.query<{ commission_id: string; package_id: string; content_hash: string; manifest: ArtifactManifest }>("SELECT commission_id,package_id,content_hash,manifest FROM guild_artifacts WHERE tenant_id=$1 AND id=$2", [tenantId, artifactId])).rows[0];
  if (!row || row.manifest.id !== artifactId || row.manifest.packageId !== row.package_id || row.manifest.contentHash !== row.content_hash || digest(row.manifest.content) !== row.content_hash)
    fail("CAPTION_REVIEW_ARTIFACT", "This exact retained caption artifact is unavailable in the owner workspace.");
  const value = row.manifest.content.schemaVersion === "guild.captions.v3" ? deepgramCaptionArtifactSchema.parse(row.manifest.content) : captionArtifactSchema.parse(row.manifest.content);
  if (digest(value.sources) !== value.sourceDigest) fail("CAPTION_REVIEW_SOURCE", "The review must identify one exact complete source register.");
  return async (locale: Locale, key: string): Promise<Target> => {
  const source = value.sources.tracks.find(item => item.locale === locale && item.key === key), track = value.tracks.find(item => item.locale === locale && item.key === key);
  if (!source || !track || track.sourceTrackDigest !== digest(source)) fail("CAPTION_REVIEW_SOURCE", "The review must identify one exact complete source track.");
  const common = { manifest: row.manifest, commissionId: row.commission_id, source, runId: track.alignmentRunId, receiptHash: track.receiptHash };
  if (value.schemaVersion === "guild.captions.v3") {
    const exact = value.tracks.find(item => item.locale === locale && item.key === key)!;
    const saved = await readDeepgramRun(tenantId, track.alignmentRunId, db), scope = saved.row.request.scope, wire = saved.row.request.wire;
    if (!saved.receipt || saved.evidenceHash !== track.receiptHash || saved.row.state !== "received" || saved.row.job_id !== exact.observationJobId
      || saved.row.commission_id !== row.commission_id || saved.row.package_id !== row.package_id || scope.mediaId !== source.mediaId || scope.producingJobId !== source.origin.productionJobId
      || scope.sourceArtifactHash !== value.sources.narration.artifactHash || scope.sourceTextHash !== source.scriptBytesHash || scope.agreementDigest !== value.contractDigest
      || wire.audioHash !== source.audioHash || wire.audioBytes !== source.byteLength || wire.locale !== locale || wire.mimeType !== "audio/mpeg")
      fail("CAPTION_REVIEW_OBSERVATION", "The review's original signed recognition does not bind this exact recording, source and producing agreement.");
    const candidate = buildDeepgramCaptionCandidate({ sourceText: source.text, locale, audioDurationSeconds: source.durationSeconds, response: saved.receipt.parsed });
    if (digest(candidate) !== digest(exact.candidate)) fail("CAPTION_REVIEW_CANDIDATE", "The submitted candidate differs from the original signed response. Retain it for integrity review.");
    return { ...common, automatic: automaticCaptionReviewUnits(source, candidate), transcript: saved.receipt.parsed?.results.channels[0]?.alternatives[0]?.transcript ?? null,
      words: candidate.timing.words, provider: "Deepgram Nova3 · blind recognition", rawBodyHash: saved.receipt.bodyHash,
      codes: [...candidate.codes, ...candidate.timing.issues.map(item => `${item.code}${item.wordIndex === undefined ? "" : `:${item.wordIndex + 1}`}`)] };
  }
  const saved = await readAlignmentRecord(tenantId, track.alignmentRunId, db);
  if (saved.receiptHash !== track.receiptHash || saved.row.job_id !== value.productionJobId || saved.row.commission_id !== row.commission_id || saved.row.package_id !== row.package_id
    || saved.row.media_id !== source.mediaId || saved.row.request.sourceTrackDigest !== digest(source) || saved.row.request.sourceDigest !== value.sourceDigest
    || saved.row.request.contractDigest !== value.contractDigest || saved.row.request.originalAudio.contentHash !== source.audioHash)
    fail("CAPTION_REVIEW_OBSERVATION", "The retained Whisper observation differs from this original recording and agreement.");
  return { ...common, automatic: null, transcript: saved.receipt.parsed?.text ?? null,
    words: saved.receipt.parsed?.words.map(word => ({ word: word.word, rawStart: word.start, rawEnd: word.end, startMs: Math.round(word.start * 1000), endMs: Math.round(word.end * 1000), confidence: null })) ?? [],
    provider: "Original Whisper prompted alignment · historical evidence", rawBodyHash: saved.receipt.bodyHash,
    codes: "alignment" in track && track.alignment.status === "failed" ? track.alignment.codes : [] };
  };
}

/** Read the original private receipt first. Artifact-ready flags are not evidence. */
export async function captionReviewTarget(db: Db, tenantId: string, artifactId: string, locale: Locale, key: string): Promise<Target> {
  return (await captionReviewTargets(db, tenantId, artifactId))(locale, key);
}

interface Row { id: string; tenant_id: string; commission_id: string; package_id: string; artifact_id: string; artifact_hash: string; locale: Locale; track_key: string; parent_revision_id: string | null; request_id: string; request_hash: string; actor_id: string; revision_digest: string; revision: CaptionReviewRevision }
function checkedRow(row: Row, target: Target) {
  const r = row.revision;
  if (!r || r.schemaVersion !== "guild.caption-review-revision.v1" || row.id !== r.id || row.tenant_id !== r.tenantId || row.commission_id !== r.commissionId || row.package_id !== r.packageId
    || row.artifact_id !== r.artifactId || row.artifact_hash !== r.artifactHash || row.locale !== r.locale || row.track_key !== r.key || row.parent_revision_id !== r.parentRevisionId
    || row.request_id !== r.requestId || row.request_hash !== r.requestHash || row.actor_id !== r.actorId || row.revision_digest !== r.digest || captionReviewRevisionDigest(r) !== r.digest
    || r.artifactId !== target.manifest.id || r.artifactHash !== target.manifest.contentHash || r.commissionId !== target.commissionId || r.packageId !== target.manifest.packageId
    || r.locale !== target.source.locale || r.key !== target.source.key || r.sourceTrackDigest !== digest(target.source) || r.audioHash !== target.source.audioHash || r.sourceTextHash !== target.source.scriptBytesHash
    || r.alignmentRunId !== target.runId || r.originalReceiptHash !== target.receiptHash || r.policyDigest !== digest(captionHumanTimingPolicy)
    || !/^[a-f0-9]{64}$/.test(r.signature) || !timingSafeEqual(Buffer.from(r.signature), Buffer.from(signature(r)))
    || digest(r.evaluation) !== digest(evaluateCaptionReview(target.source, r.draft, target.automatic)))
    fail("CAPTION_REVIEW_CHANGED", "This retained review no longer matches its signed author, complete source, original observation and measured draft.");
  if (r.attestation && (!["judge", "owner"].includes(r.actorRole) || !r.attestation.humanDeclaredListening || r.attestation.fluentReviewed !== false || r.evaluation.status !== "ready-for-review"))
    fail("CAPTION_REVIEW_ATTRIBUTION", "A system annotation or incomplete draft cannot be presented as human listening review.");
  return r;
}

/** Verifies every ancestor of the append-only correction chain. Expiry never
 * prevents reading original evidence, and the read cannot send a provider call. */
export async function readCaptionReviewRevision(db: Db, tenantId: string, id: string, target?: Target): Promise<CaptionReviewRevision> {
  const row = (await db.query<Row>("SELECT * FROM guild_caption_review_revisions WHERE tenant_id=$1 AND id=$2", [tenantId, id])).rows[0];
  if (!row) fail("CAPTION_REVIEW_MISSING", "That attributed review is not in this owner workspace.");
  const exact = target ?? await captionReviewTarget(db, tenantId, row.artifact_id, row.locale, row.track_key), original = checkedRow(row, exact);
  let current = original; const seen = new Set([current.id]);
  while (current.parentRevisionId) {
    if (seen.has(current.parentRevisionId) || seen.size > 100) fail("CAPTION_REVIEW_CHAIN", "The retained review ancestry is invalid.");
    const parent = (await db.query<Row>("SELECT * FROM guild_caption_review_revisions WHERE tenant_id=$1 AND id=$2", [tenantId, current.parentRevisionId])).rows[0];
    if (!parent) fail("CAPTION_REVIEW_CHAIN", "An earlier review revision is missing.");
    const checked = checkedRow(parent, exact);
    if (checked.digest !== current.parentRevisionDigest || current.attestation && (checked.attestation || digest(checked.draft) !== digest(current.draft)))
      fail("CAPTION_REVIEW_CHAIN", "The listening attestation must refer to its exact prior saved draft.");
    seen.add(checked.id); current = checked;
  }
  if (current.parentRevisionDigest !== null || current.attestation) fail("CAPTION_REVIEW_CHAIN", "A review must begin with an explicitly saved draft.");
  return original;
}

export async function captionReviewWorkspace(session: Session, artifactId: string, locale: Locale, key: string) {
  if (!["judge", "owner", "operator"].includes(session.role)) throw new DomainError("ROLE_REQUIRED", "Caption evidence belongs to the commission’s owner workspace.", 403, false);
  const target = await captionReviewTarget(getPool(), session.tenantId, artifactId, locale, key);
  const rows = (await getPool().query<Row>("SELECT * FROM guild_caption_review_revisions WHERE tenant_id=$1 AND artifact_id=$2 AND locale=$3 AND track_key=$4 ORDER BY created_at,id", [session.tenantId, artifactId, locale, key])).rows;
  const parentIds = new Set(rows.map(row => row.parent_revision_id)), leaf = rows.find(row => !parentIds.has(row.id));
  const latest = leaf ? await readCaptionReviewRevision(getPool(), session.tenantId, leaf.id, target) : null;
  const c = (await getPool().query<{ snapshot: Commission }>("SELECT snapshot FROM guild_commissions WHERE tenant_id=$1 AND id=$2", [session.tenantId, target.commissionId])).rows[0]?.snapshot;
  const pkg = c?.packages.find(item => item.id === target.manifest.packageId), expiresAt = (pkg?.acceptancePack.parameters?.authorityCeiling as { expiresAt?: string } | undefined)?.expiresAt ?? null;
  return { schemaVersion: "guild.caption-review-workspace.v1", artifactId, artifactHash: target.manifest.contentHash,
    source: target.source, provider: target.provider, recognition: target.transcript, observedWords: target.words, observationCodes: target.codes, rawBodyHash: target.rawBodyHash,
    initialUnits: target.automatic ?? blankCaptionReviewUnits(target.source), latestRevision: latest,
    history: rows.map(row => ({ id: row.id, digest: row.revision_digest, parentRevisionId: row.parent_revision_id, author: row.revision.attestation?.reviewerName ?? row.revision.actorRole, createdAt: row.revision.createdAt, listeningAttested: !!row.revision.attestation })),
    canAttest: ["judge", "owner"].includes(session.role), authorityExpiresAt: expiresAt, authorityExpired: !!expiresAt && Date.parse(expiresAt) <= Date.now(),
    nextAction: expiresAt && Date.parse(expiresAt) <= Date.now()
      ? "Save and export a review draft here. To commission new work, open a separate successor commission and review a fresh bounded Passport. This original deadline stays unchanged."
      : "Listen to the unchanged recording, record any uncertain or unheard wording, then save the measured draft. A named listening attestation is a separate action.",
    policy: captionHumanTimingPolicy, productionAccepted: false };
}

export async function saveCaptionReview(session: Session, artifactId: string, raw: CaptionReviewCommand) {
  const input = captionReviewCommandSchema.parse(raw), requestHash = digest({ artifactId, input });
  return transaction(async db => {
    const owner = (await db.query<{ commission_id: string }>("SELECT commission_id FROM guild_artifacts WHERE tenant_id=$1 AND id=$2", [session.tenantId, artifactId])).rows[0];
    if (!owner) fail("CAPTION_REVIEW_ARTIFACT", "The retained caption artifact is unavailable.");
    const c = (await db.query<{ snapshot: Commission }>("SELECT snapshot FROM guild_commissions WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [session.tenantId, owner.commission_id])).rows[0]?.snapshot;
    if (!c) fail("CAPTION_REVIEW_ARTIFACT", "The retained commission is unavailable.");
    await requireCaptionActor(db, session);
    const actor = (await db.query<{ role: Session["role"] }>("SELECT role FROM guild_sessions WHERE id=$1 AND tenant_id=$2", [session.id, session.tenantId])).rows[0];
    if (!actor || actor.role !== session.role) fail("CAPTION_REVIEW_ACTOR", "The current actor’s role differs from the review request.");
    const target = await captionReviewTarget(db, session.tenantId, artifactId, input.locale, input.key);
    if (input.artifactHash !== target.manifest.contentHash) fail("CAPTION_REVIEW_ARTIFACT_CHANGED", "The displayed artifact changed. Reopen its exact retained source before saving.");
    const replay = (await db.query<Row>("SELECT * FROM guild_caption_review_revisions WHERE tenant_id=$1 AND request_id=$2", [session.tenantId, input.requestId])).rows[0];
    if (replay) {
      if (replay.request_hash !== requestHash || replay.actor_id !== session.id) fail("CAPTION_REVIEW_REQUEST_CHANGED", "That save identity already belongs to a different review.");
      return readCaptionReviewRevision(db, session.tenantId, replay.id, target);
    }
    const rows = (await db.query<Row>("SELECT * FROM guild_caption_review_revisions WHERE tenant_id=$1 AND artifact_id=$2 AND locale=$3 AND track_key=$4", [session.tenantId, artifactId, input.locale, input.key])).rows;
    const parents = new Set(rows.map(row => row.parent_revision_id)), leaf = rows.find(row => !parents.has(row.id));
    if ((leaf?.id ?? null) !== input.parentRevisionId) throw new DomainError("CAPTION_REVIEW_CONFLICT", "A newer review was saved. Reopen the retained draft before appending another revision.", 409, false);
    if (rows.length >= 100) fail("CAPTION_REVIEW_CAPACITY", "This track has reached its bounded review history. Export the retained revisions for a separately scoped successor.");
    const previous = leaf ? await readCaptionReviewRevision(db, session.tenantId, leaf.id, target) : null;
    const draft = input.action === "save" ? input.draft : previous?.draft;
    if (!draft) fail("CAPTION_REVIEW_DRAFT_REQUIRED", "Save the exact measured draft before recording listening review.");
    const evaluation = evaluateCaptionReview(target.source, draft, target.automatic);
    if (input.action === "attest" && (!previous || previous.attestation || !["judge", "owner"].includes(session.role) || evaluation.status !== "ready-for-review"))
      fail("CAPTION_REVIEW_ATTESTATION", "A named human can attest only the exact complete saved draft after listening. System actors, uncertain wording and missing timing remain review-required.");
    const revision: CaptionReviewRevision = { schemaVersion: "guild.caption-review-revision.v1", id: randomUUID(), tenantId: session.tenantId, commissionId: c.id, packageId: target.manifest.packageId,
      artifactId, artifactHash: target.manifest.contentHash, locale: input.locale, key: input.key, sourceTrackDigest: digest(target.source), audioHash: target.source.audioHash, sourceTextHash: target.source.scriptBytesHash,
      alignmentRunId: target.runId, originalReceiptHash: target.receiptHash, policyDigest: digest(captionHumanTimingPolicy), parentRevisionId: previous?.id ?? null, parentRevisionDigest: previous?.digest ?? null,
      requestId: input.requestId, requestHash, actorId: session.id, actorRole: session.role, createdAt: new Date().toISOString(), draft, evaluation,
      attestation: input.action === "attest" ? { reviewerName: input.reviewerName, statement: "I listened to the complete original recording, heard the complete immutable source, and checked every submitted timing against the audio. This is my attributed listening declaration; it does not assert fluent-language review, automatic qualification, acceptance or payment.", humanDeclaredListening: true, fluentReviewed: false } : null,
      digest: "", signature: "" };
    revision.digest = captionReviewRevisionDigest(revision); revision.signature = signature(revision);
    await db.query("INSERT INTO guild_caption_review_revisions(id,tenant_id,commission_id,package_id,artifact_id,artifact_hash,locale,track_key,parent_revision_id,request_id,request_hash,actor_id,revision_digest,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
      [revision.id, session.tenantId, c.id, revision.packageId, artifactId, revision.artifactHash, input.locale, input.key, revision.parentRevisionId, input.requestId, requestHash, session.id, revision.digest, revision]);
    appendEvent(c, input.action === "attest" ? "caption.listening_attested" : "caption.review_draft_saved", input.action === "attest" ? "A listening review was attributed" : "A caption review draft was saved",
      `${input.locale}/${input.key} · revision ${revision.id}. ${input.action === "attest" ? revision.attestation!.statement : "Original source, recording and provider observations remain unchanged. This draft records no listening review or acceptance."}`,
      input.action === "attest" ? input.reviewerName : session.role === "operator" ? "System qualification operator" : "Workspace owner", revision.packageId);
    c.revision++; await saveCommission(db, c); return revision;
  });
}
