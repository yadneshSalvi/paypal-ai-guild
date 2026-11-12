import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { locales, type ArtifactManifest, type Commission } from "@/contracts/guild";
import { automaticCaptionReviewUnits, captionHumanTimingPolicy, captionReviewRevisionDigest, evaluateCaptionReview, type CaptionReviewDraft, type CaptionReviewRevision } from "@/domain/caption-review";
import { captionAuthorityCeilingSchema, type CaptionTrackSource } from "@/domain/captions";
import { deepgramCaptionArtifactSchema, deepgramSourcesFromPack } from "@/domain/deepgram-captions";
import { planDigest } from "@/domain/fixture";
import { canonical, digest } from "@/domain/primitives";
import { executeCommand, getCommission, saveCommission } from "@/server/commissions";
import { getPool, transaction } from "@/server/db";
import { runNextJob } from "@/server/jobs";
import { assertDeepgramCaptionAcceptable, deepgramCaptionCorrectionProposal } from "@/server/captions/deepgram-contracts";
import type { Session } from "@/server/session";
import { queueCaptions, syntheticEasyReadModel, type CaptionFixture } from "./caption-fixture";
import { amendDeepgramCaptions, ControlledDeepgram, syntheticMeasuredDraft } from "./deepgram-caption-fixture";
import { syntheticPublicationActor, syntheticPublicationDisclosure } from "./web-publication-fixture";

export const syntheticCaptionReviewDisclosure = "SYNTHETIC CAPTION/WEB FIXTURE. Generated tones, controlled recognition and fictional signed listening/acceptance records exercise the complete gates. No person listened or accepted this work; no real model, provider, fluent-language or browser qualification, speech admission or payment is claimed.";

/** Direct test-data insertion only. This is never imported by production and
 * does not submit a human declaration through a product route or command. The
 * marked synthetic values are deliberately realistic inputs to the unchanged
 * integrity checks, rather than an application fixture bypass. */
export async function syntheticCaptionRevision(tenantId: string, commissionId: string, artifact: ArtifactManifest, source: CaptionTrackSource,
  author: Session, draft: CaptionReviewDraft, parent: CaptionReviewRevision | null, attest = false) {
  const content = deepgramCaptionArtifactSchema.parse(artifact.content), track = content.tracks.find(item => item.locale === source.locale && item.key === source.key)!;
  assert.match(draft.note, /synthetic/i);
  const requestId = randomUUID(), input = attest ? { action: "attest", requestId, parentRevisionId: parent!.id, locale: source.locale, key: source.key, artifactHash: artifact.contentHash,
    reviewerName: "SYNTHETIC FIXTURE ACTOR — no person listened", completeRecordingListened: true, completeSourceHeard: true, everyTimingChecked: true, acknowledgeNotFluentReview: true }
    : { action: "save", requestId, parentRevisionId: parent?.id ?? null, locale: source.locale, key: source.key, artifactHash: artifact.contentHash, draft };
  const revision: CaptionReviewRevision = { schemaVersion: "guild.caption-review-revision.v1", id: randomUUID(), tenantId, commissionId, packageId: artifact.packageId,
    artifactId: artifact.id, artifactHash: artifact.contentHash, locale: source.locale, key: source.key, sourceTrackDigest: digest(source), audioHash: source.audioHash, sourceTextHash: source.scriptBytesHash,
    alignmentRunId: track.alignmentRunId, originalReceiptHash: track.receiptHash, policyDigest: digest(captionHumanTimingPolicy), parentRevisionId: parent?.id ?? null, parentRevisionDigest: parent?.digest ?? null,
    requestId, requestHash: digest({ artifactId: artifact.id, input }), actorId: author.id, actorRole: author.role, createdAt: new Date().toISOString(), draft,
    evaluation: evaluateCaptionReview(source, draft, automaticCaptionReviewUnits(source, track.candidate)),
    attestation: attest ? { reviewerName: "SYNTHETIC FIXTURE ACTOR — no person listened", statement: syntheticCaptionReviewDisclosure, humanDeclaredListening: true, fluentReviewed: false } : null,
    digest: "", signature: "" };
  revision.digest = captionReviewRevisionDigest(revision);
  if (attest) assert.equal(revision.evaluation.status, "ready-for-review", "A synthetic statement must not be inserted over an invalid timing draft.");
  revision.signature = createHmac("sha256", process.env.AUTH_SECRET!).update(canonical({ kind: "guild.caption-review.v1", digest: revision.digest })).digest("hex");
  await getPool().query("INSERT INTO guild_caption_review_revisions(id,tenant_id,commission_id,package_id,artifact_id,artifact_hash,locale,track_key,parent_revision_id,request_id,request_hash,actor_id,revision_digest,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
    [revision.id, tenantId, commissionId, artifact.packageId, artifact.id, artifact.contentHash, source.locale, source.key, revision.parentRevisionId, requestId, revision.requestHash, author.id, revision.digest, revision]);
  return revision;
}

export async function syntheticCaptionSourceAcceptances(c: Commission, owner: Session, kinds: string[]) {
  const ids: string[] = [];
  await transaction(async db => {
    for (const pkg of c.packages.filter(item => kinds.includes(item.kind))) {
      const artifact = c.artifacts.find(item => item.id === pkg.artifactIds.at(-1))!;
      assert.ok(artifact && pkg.acceptancePack.criteria.every(item => item.kind !== "deterministic" || !item.blocking || item.status === "passed"));
      const captionListening = pkg.kind === "captions" ? await assertDeepgramCaptionAcceptable(db, c, pkg, artifact) : null;
      const id = randomUUID(), at = new Date().toISOString(); ids.push(id);
      const review = { humanReviewed: true, fluentReviewed: false, actorKind: owner.role, mode: "live", syntheticFixture: true, disclosure: syntheticCaptionReviewDisclosure,
        ...(captionListening ? { captionListening } : {}),
        ...(["translation", "captions"].includes(pkg.kind) ? { languages: Object.fromEntries(locales.map(locale => [locale, { fluentReviewed: false, reviewer: null, reviewedAt: null,
          curatorAcknowledged: true, acknowledgedAt: at, actorKind: owner.role, syntheticFixture: true, disclosure: syntheticCaptionReviewDisclosure }])) } : {}) };
      await db.query("INSERT INTO guild_acceptance_decisions(id,tenant_id,commission_id,package_id,contract_version,artifact_id,artifact_hash,criteria_digest,actor_id,decision,review_disclosures,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'accepted',$10,$11)",
        [id, c.tenantId, c.id, pkg.id, pkg.contractVersion, artifact.id, artifact.contentHash, pkg.acceptancePack.digest, owner.id, review, at]);
      pkg.state = "accepted"; pkg.acceptedAt = at; pkg.acceptedBy = owner.id; pkg.paymentState = "not_eligible";
      for (const criterion of pkg.acceptancePack.criteria.filter(item => item.kind === "human")) { criterion.status = "passed"; criterion.evidence = syntheticCaptionReviewDisclosure; }
    }
    c.revision++; await saveCommission(db, c);
  });
  return ids;
}

export async function syntheticReviewedDeepgramCaptions(f: CaptionFixture, progress: (message: string) => void) {
  const owner = await syntheticPublicationActor(f.session.tenantId), originalCommission = await getCommission(f.session, f.commissionId);
  const acceptedIds = await syntheticCaptionSourceAcceptances(originalCommission, owner.session, ["research", "translation", "narration", "images"]);
  await amendDeepgramCaptions(f);
  let c = await getCommission(f.session, f.commissionId), pkg = c.packages.find(item => item.kind === "captions")!;
  const sources = deepgramSourcesFromPack(pkg.acceptancePack), authorityExpiresAt = captionAuthorityCeilingSchema.parse(pkg.acceptancePack.parameters?.authorityCeiling).expiresAt;
  assert.equal(sources.tracks.length, 78);
  const deepgram = new ControlledDeepgram("disagreements"), model = syntheticEasyReadModel(), jobs: string[] = [];
  async function finish(jobId: string) {
    jobs.push(jobId);
    for (let step = 0; step < 1000; step++) {
      await getPool().query("UPDATE guild_jobs SET available_at=now() WHERE id=$1", [jobId]);
      await getPool().query("UPDATE guild_model_runs SET poll_after=now() WHERE job_id=$1 AND poll_after IS NOT NULL", [jobId]);
      const result = await runNextJob(f.session.tenantId, { media: f.media, deepgram });
      if (step % 20 === 0) progress(`Synthetic caption job ${jobs.length}/4 · step ${step}; controlled recognition calls ${deepgram.calls}.`);
      if (result?.state !== "queued") {
        assert.equal(result?.state, "completed", JSON.stringify((await getPool().query("SELECT state,error FROM guild_jobs WHERE id=$1", [jobId])).rows[0])); return;
      }
    }
    throw Error("Bounded synthetic v3 caption job did not complete; the original attempt is retained.");
  }
  process.env.GUILD_ENABLE_DEEPGRAM_REVIEW = "true"; process.env.DEEPGRAM_API_KEY = "synthetic-caption-web-not-a-provider-key";
  try {
    progress("Producing the complete 78-track synthetic v3 original; automatic failures remain original evidence.");
    const originalJob = await queueCaptions(f); await finish(originalJob);
    c = await getCommission(f.session, c.id); pkg = c.packages.find(item => item.kind === "captions")!;
    const originalArtifact = c.artifacts.find(item => item.id === pkg.artifactIds.at(-1))!, original = deepgramCaptionArtifactSchema.parse(originalArtifact.content);
    const originalVerificationJob = await queueCaptions(f, "verify_artifact"); await finish(originalVerificationJob);
    progress("Inserting visibly fictional uncertain draft → complete draft → listening statement histories through the isolated test seam.");
    const declared: CaptionReviewRevision[] = [], earlierDrafts: string[] = [];
    for (const source of sources.tracks) {
      const track = original.tracks.find(item => item.locale === source.locale && item.key === source.key)!;
      const initial = automaticCaptionReviewUnits(source, track.candidate);
      const draft = syntheticMeasuredDraft(source, initial ?? undefined), uncertain = structuredClone(draft);
      uncertain.disposition = "uncertain"; uncertain.note = "SYNTHETIC first draft: uncertainty stays untimed. No person listened or made this annotation.";
      uncertain.units[0] = { ...uncertain.units[0]!, heard: "uncertain", startMs: null, endMs: null, origin: "unassigned", providerWordIndex: null };
      const first = await syntheticCaptionRevision(c.tenantId, c.id, originalArtifact, source, owner.session, uncertain, null);
      const complete = await syntheticCaptionRevision(c.tenantId, c.id, originalArtifact, source, owner.session, draft, first);
      assert.equal(complete.evaluation.status, "ready-for-review", `${source.locale}/${source.key}: ${complete.evaluation.codes.join(",")}`);
      const statement = await syntheticCaptionRevision(c.tenantId, c.id, originalArtifact, source, owner.session, draft, complete, true);
      assert.equal(first.evaluation.status, "incomplete"); assert.equal(first.evaluation.cues.length, 0); assert.equal(complete.evaluation.status, "ready-for-review");
      earlierDrafts.push(first.id, complete.id); declared.push(statement);
    }
    c = await getCommission(f.session, c.id); pkg = c.packages.find(item => item.kind === "captions")!;
    const proposal = await deepgramCaptionCorrectionProposal(getPool(), c, pkg);
    const agreement = await executeCommand(f.session, c.id, { type: "agree_deepgram_caption_review", commandId: randomUUID(), expectedRevision: c.revision, packageId: pkg.id,
      contractVersion: pkg.contractVersion, proposalDigest: proposal.digest, acknowledgeExactRevisions: true });
    assert.ok(agreement.ok);
    const approval = await executeCommand(f.session, c.id, { type: "approve_plan", commandId: randomUUID(), expectedRevision: agreement.revision, planDigest: planDigest(agreement.commission) });
    assert.ok(approval.ok);
    process.env.GUILD_ENABLE_DEEPGRAM_REVIEW = "false"; process.env.DEEPGRAM_API_KEY = ""; process.env.OPENAI_API_KEY = "";
    progress("Assembling the exact agreed synthetic corrections with zero new recognition or model calls.");
    const correctionJob = await queueCaptions(f); await finish(correctionJob);
    const verificationJob = await queueCaptions(f, "verify_artifact"); await finish(verificationJob);
    c = await getCommission(f.session, c.id); pkg = c.packages.find(item => item.kind === "captions")!;
    const correctedArtifact = c.artifacts.find(item => item.id === pkg.artifactIds.at(-1))!, corrected = deepgramCaptionArtifactSchema.parse(correctedArtifact.content);
    assert.equal(digest(original.tracks.map(item => item.candidate)), digest(corrected.tracks.map(item => item.candidate)));
    assert.equal(corrected.originalProductionJobId, originalJob); assert.equal(deepgram.calls, 78); assert.equal(model.count(), 6);
    assert.equal((await getPool().query("SELECT count(*)::int AS n FROM guild_alignment_runs WHERE job_id=$1", [correctionJob])).rows[0].n, 0);
    assert.equal(captionAuthorityCeilingSchema.parse(pkg.acceptancePack.parameters?.authorityCeiling).expiresAt, authorityExpiresAt);
    acceptedIds.push(...await syntheticCaptionSourceAcceptances(c, owner.session, ["captions"]));
    return { owner: owner.session, cookie: owner.cookie, originalArtifactId: originalArtifact.id, originalArtifactHash: originalArtifact.contentHash,
      correctedArtifactId: correctedArtifact.id, correctedArtifactHash: correctedArtifact.contentHash, originalJob, originalVerificationJob, correctionJob, verificationJob,
      authorityExpiresAt, earlierDraftIds: earlierDrafts, declarations: declared.map(item => ({ id: item.id, digest: item.digest, locale: item.locale, key: item.key })), acceptedIds,
      counts: { recognitionCalls: deepgram.calls, easyReadCalls: model.count(), correctionRecognitionCalls: 0, correctionModelCalls: 0, syntheticListeningStatements: declared.length, earlierDrafts: earlierDrafts.length,
        originalAutomaticReady: original.tracks.filter(item => item.candidate.status === "ready-for-review").length, originalWithheld: original.tracks.filter(item => item.candidate.status === "withheld").length },
      disclosure: syntheticCaptionReviewDisclosure, publicationDisclosure: syntheticPublicationDisclosure };
  } finally { model.restore(); process.env.GUILD_ENABLE_DEEPGRAM_REVIEW = "false"; process.env.DEEPGRAM_API_KEY = ""; }
}
