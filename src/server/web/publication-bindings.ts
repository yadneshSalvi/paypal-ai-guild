import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { locales, type AcceptancePack, type ArtifactManifest, type Commission } from "@/contracts/guild";
import { webAuditReceiptSchema, webAuditSummary, webMeasuredPack } from "@/domain/web-audits";
import { webRendererCapabilitySchema, type WebFile } from "@/domain/web-exhibition";
import { publicationBindingSchema, publicationKinds, type PublicationAcceptance } from "@/domain/web-publication";
import { canonical, digest, DomainError } from "@/domain/primitives";
import { webZipChunks } from "@/exhibition/generated/zip";
import { captionOwnedArtifact, reviewEvidence } from "../captions/sources";
import type { PrivateBlobGateway } from "../media/blob-store";
import type { Session } from "../session";
import { webExportBundle } from "./exports";
import { readWebSourceApproval } from "./source-history";
import { validateWebJob } from "./contracts";
import { validateWebArtifactRecord } from "./artifact";
import { readWebAuditCaseDetails } from "./audit-store";
import { boundWebAuditRequest } from "./audit-request";
import { readWebBundle } from "./bundles";
import { acceptedWebCaptionRevisions } from "./caption-revisions";

const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const recordHash = (value: unknown) => digest(JSON.parse(JSON.stringify(value)));
function fail(code: string, message: string): never { throw new DomainError(code, message, 422, false); }
interface Decision {
  id: string; package_id: string; contract_version: number; artifact_id: string; artifact_hash: string;
  criteria_digest: string; actor_id: string; decision: string; review_disclosures: Record<string, unknown>; created_at: Date;
}
interface Verification { id: string; criteria_digest: string; result: AcceptancePack; created_at: Date }

/** Acceptance is checked separately from the original draft/review lineage. A
 * later curator decision never rewrites what the producing agents actually used. */
async function acceptedArtifact(db: PoolClient, c: Commission, kind: PublicationAcceptance["kind"], artifact: ArtifactManifest, version: number): Promise<PublicationAcceptance> {
  const history = await readWebSourceApproval(db, c, null, artifact);
  if (history.package.kind !== kind || history.package.contractVersion !== version) fail("PUBLICATION_SOURCE_CHANGED", "An accepted source no longer matches its original producing contract.");
  const decision = (await db.query<Decision>("SELECT id,package_id,contract_version,artifact_id,artifact_hash,criteria_digest,actor_id,decision,review_disclosures,created_at FROM guild_acceptance_decisions WHERE tenant_id=$1 AND commission_id=$2 AND package_id=$3 AND contract_version=$4 AND artifact_id=$5 AND artifact_hash=$6 AND decision='accepted' FOR SHARE", [c.tenantId, c.id, artifact.packageId, version, artifact.id, artifact.contentHash])).rows[0];
  if (!decision || decision.criteria_digest !== history.package.acceptancePack.digest) fail("PUBLICATION_ACCEPTANCE_REQUIRED", `The exact ${kind === "web" ? "exhibition" : kind} artifact needs its own retained acceptance decision before publication.`);
  const actor = (await db.query<{ role: string; created_at: Date }>("SELECT role,created_at FROM guild_sessions WHERE tenant_id=$1 AND id=$2 FOR SHARE", [c.tenantId, decision.actor_id])).rows[0];
  const disclosure = decision.review_disclosures;
  if (!actor || !["owner", "judge"].includes(actor.role) || disclosure.actorKind !== actor.role || disclosure.humanReviewed !== true || disclosure.mode !== "live" || actor.created_at > decision.created_at)
    fail("PUBLICATION_HUMAN_ACCEPTANCE", "Publication needs an existing owner or judge acceptance of every exact artifact. An operator acknowledgment or automated review is not a curator decision.");
  if (disclosure.fluentReviewed !== false || typeof disclosure.disclosure !== "string" || !disclosure.disclosure.trim())
    fail("PUBLICATION_REVIEW_DISCLOSURE", "Keep the original fluent-language limitation explicit. This publication cannot manufacture a language-review claim.");
  if (kind === "translation") {
    const languages = disclosure.languages as Record<string, Record<string, unknown>> | undefined;
    if (!languages || Object.keys(languages).sort().join() !== [...locales].sort().join() || !locales.every(locale => {
      const language = languages[locale];
      return language?.fluentReviewed === false && language.reviewer === null && language.reviewedAt === null && language.curatorAcknowledged === true
        && language.actorKind === actor.role && typeof language.disclosure === "string" && language.disclosure.length > 0 && typeof language.acknowledgedAt === "string" && Number.isFinite(Date.parse(language.acknowledgedAt));
    })) fail("PUBLICATION_LANGUAGE_DISCLOSURE", "Each of the six languages needs its retained curator acknowledgment and its explicit unverified fluent-review disclosure.");
  }
  const evidence = await reviewEvidence(db, c, { packageId: artifact.packageId, contractVersion: version, artifactId: artifact.id, artifactHash: artifact.contentHash, reviewKind: "curator_acceptance", reviewId: decision.id });
  const verification = (await db.query<Verification>("SELECT id,criteria_digest,result,created_at FROM guild_verifications WHERE id=$1 AND tenant_id=$2 AND commission_id=$3 FOR SHARE", [evidence.verificationId, c.tenantId, c.id])).rows[0];
  if (!verification || recordHash(verification) !== evidence.verificationHash || verification.created_at > decision.created_at || digest(verification.result) !== verification.criteria_digest)
    fail("PUBLICATION_VERIFICATION_CHANGED", "A source acceptance no longer has its exact original passing report.");
  const jobs = (await db.query<{ id: string; output: { pack?: AcceptancePack; report?: unknown } }>("SELECT id,output FROM guild_jobs WHERE tenant_id=$1 AND commission_id=$2 AND type='verify_artifact' AND state='completed' AND input->>'artifactId'=$3 AND input->>'artifactHash'=$4 ORDER BY created_at,id FOR SHARE", [c.tenantId, c.id, artifact.id, artifact.contentHash])).rows;
  const verifyingJob = jobs.find(job => job.output?.pack && digest(job.output.pack) === verification.criteria_digest);
  // Research and translation retain their deterministic verification rows. The
  // three media families and web additionally retain the full independent job.
  if (!["research", "translation"].includes(kind) && !verifyingJob) fail("PUBLICATION_VERIFICATION_REQUIRED", `The exact ${kind} source needs its original independent verification job.`);
  return { kind, packageId: artifact.packageId, contractVersion: version, artifactId: artifact.id, artifactHash: artifact.contentHash, artifactManifestHash: digest(artifact), title: artifact.title,
    decision: { id: decision.id, actorId: decision.actor_id, actorRole: actor.role as "owner" | "judge", acceptedAt: decision.created_at.toISOString(), recordHash: recordHash(decision), criteriaDigest: decision.criteria_digest,
      humanReviewed: true, fluentReviewed: false, disclosure: disclosure.disclosure, disclosures: disclosure },
    verification: { id: verification.id, recordHash: recordHash(verification), resultHash: digest(verification.result), criteriaDigest: verification.criteria_digest, createdAt: verification.created_at.toISOString(), jobId: verifyingJob?.id ?? null, outputHash: verifyingJob ? digest(verifyingJob.output) : null },
    production: { jobId: history.job.id, jobHash: recordHash(history.job), snapshotHash: digest(history.snapshot), approvalReceiptHash: history.receiptHash } };
}

const fileCheck = z.object({ path: z.string(), contentHash: z.string(), byteLength: z.number().int().positive(), mediaId: z.string().uuid().nullable(), passed: z.boolean(), evidence: z.string(), checkedAt: z.string().datetime() }).strict();
const independentReport = z.object({ schemaVersion: z.literal("guild.web-verification.v1"), verifierVersion: z.literal("guild.independent-original-files-and-browser.v1"),
  artifactId: z.string().uuid(), artifactHash: z.string(), contractDigest: z.string(), sourceDigest: z.string(), sourceVerified: z.literal(true), producingApprovalVerified: z.literal(true), producerPipelineVerified: z.literal(true),
  files: z.array(fileCheck).min(12).max(450), cases: z.array(webAuditReceiptSchema).length(18), expectedCases: z.literal(18), evidence: z.array(z.string()), originalMediaUnchanged: z.literal(true),
  newModelRequests: z.literal(0), newRecognitionRequests: z.literal(0), fluentHumanReviewed: z.literal(false), humanExperienceReviewed: z.literal(false), summary: z.unknown() }).strict();

function publicRegister(bundle: Awaited<ReturnType<typeof webExportBundle>>) {
  const types: Record<string, string> = { "index.html": "text/html", "reader.css": "text/css", "reader.js": "application/javascript", "theme.css": "text/css", "source-record.json": "application/json", "README.txt": "text/plain",
    "assets/fonts/fraunces-latin.woff2": "font/woff2", "assets/fonts/inter-latin.woff2": "font/woff2", "assets/fonts/noto-naskh-arabic.woff2": "font/woff2", "assets/fonts/Fraunces-OFL.txt": "text/plain", "assets/fonts/Inter-OFL.txt": "text/plain", "assets/fonts/Noto-Naskh-Arabic-OFL.txt": "text/plain" };
  const { sources } = bundle.owned.content;
  const originals = [...sources.photographs.flatMap(photo => [photo.full, photo.thumbnail]), ...locales.flatMap(locale => sources.requiredKeys.flatMap(key => [sources.labels[locale][key]!.audio, sources.labels[locale][key]!.captions.vtt]))];
  const expected = new Map(originals.map(file => [`assets/${file.mediaType === "image/webp" ? "images" : file.mediaType === "audio/mpeg" ? "audio" : "captions"}/${file.mediaId}.${file.mediaType === "image/webp" ? "webp" : file.mediaType === "audio/mpeg" ? "mp3" : "vtt"}`, file]));
  if (bundle.manifest.files.length !== Object.keys(types).length + expected.size) fail("PUBLICATION_FILE_REGISTER", "The public file register contains an extra or missing original file.");
  for (const file of bundle.manifest.files) {
    const original = expected.get(file.path);
    if (file.mediaId === null ? types[file.path] !== file.mediaType : !original || original.mediaId !== file.mediaId || original.contentHash !== file.contentHash || original.byteLength !== file.byteLength || original.mediaType !== file.mediaType)
      fail("PUBLICATION_FILE_REGISTER", "Only the exact selected reader, fonts and source-bound original media may become public. An unrelated file was refused.");
  }
  const renderer = webRendererCapabilitySchema.parse(bundle.history.package.acceptancePack.parameters?.rendererCapability);
  let source: unknown;
  try { source = JSON.parse(bundle.authored.get("source-record.json")!.toString("utf8")); } catch { fail("PUBLICATION_SOURCE_RECORD", "The original public source record is unavailable."); }
  if (digest(source) !== digest({ schemaVersion: "guild.exhibition-source-record.v1", sourceDigest: bundle.owned.content.sourceDigest, designDigest: bundle.candidate.designDigest,
    renderer, sources, design: bundle.candidate.design, originalMediaUnchanged: true, newNarration: false, fluentHumanReviewClaimed: false, acceptanceClaimed: false, paymentClaimed: false }))
    fail("PUBLICATION_SOURCE_RECORD", "The public source record differs from its exact allowlisted source, design and original disclosures.");
  // A structural allowlist excludes sessions, commercial payloads and raw model
  // prompts. Known credential forms are also refused in authored public text.
  const secret = /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{24,}|xox[baprs]-[A-Za-z0-9-]{16,}|Bearer\s+[A-Za-z0-9._~-]{24,}|postgres(?:ql)?:\/\/[^\s"']+)|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i;
  for (const [path, bytes] of bundle.authored) if (!path.endsWith(".woff2") && secret.test(bytes.toString("utf8"))) fail("PUBLICATION_PRIVATE_CONTENT", "A public reader file contains a credential-shaped value. Review the original source; it was not published or silently redacted.");
  return renderer;
}

/** Read-only admission. No production, browser, model, acceptance or payment
 * function is invoked. Historical authority is validated without renewing it. */
export async function bindAcceptedPublication(db: PoolClient, session: Session, c: Commission, artifactId: string, ordinal: number, storage?: PrivateBlobGateway) {
  const bundle = await webExportBundle(session, artifactId, ordinal, storage, db), { content, manifest: artifact } = bundle.owned;
  if (bundle.owned.commission_id !== c.id || content.selectedOrdinal !== ordinal || artifact.provenance.mode !== "live") fail("PUBLICATION_SELECTED_ARTIFACT", "Choose the exact accepted exhibition and its submitted design in this commission.");
  const bound = await validateWebJob(db, bundle.history.snapshot, bundle.history.package, bundle.history.job, false);
  const checked = await validateWebArtifactRecord(db, bundle.history.snapshot, bundle.history.package, bundle.history.job, artifact.content);
  if (digest(bound.sources) !== content.sourceDigest || digest(checked) !== digest(content)) fail("PUBLICATION_SOURCE_CHANGED", "The accepted exhibition differs from its original producing history.");
  const renderer = publicRegister(bundle), accepted: PublicationAcceptance[] = [];
  for (const kind of publicationKinds) {
    const ancestor = kind === "web" ? { artifactId, artifactHash: artifact.contentHash, contractVersion: bundle.history.package.contractVersion } : content.sources.ancestors.find(item => item.kind === kind)!;
    const source = kind === "web" ? artifact : await captionOwnedArtifact(db, c, ancestor.artifactId, ancestor.artifactHash);
    // Normal application changes take the same commission lock. Shared locks
    // additionally hold these exact source records through the publication commit.
    await db.query("SELECT id FROM guild_artifacts WHERE tenant_id=$1 AND commission_id=$2 AND id=$3 FOR SHARE", [c.tenantId, c.id, source.id]);
    accepted.push(await acceptedArtifact(db, c, kind, source, ancestor.contractVersion));
  }
  const webAcceptance = accepted.find(item => item.kind === "web")!;
  const captionSource = content.sources.ancestors.find(item => item.kind === "captions")!;
  const captionArtifact = await captionOwnedArtifact(db, c, captionSource.artifactId, captionSource.artifactHash);
  const captionBinding = content.sources.inputBindings.find(item => item.artifactId === captionArtifact.id && item.artifactHash === captionArtifact.contentHash);
  const captionPackage = c.packages.find(item => item.id === captionArtifact.packageId);
  const captionReview = captionArtifact.content.schemaVersion === "guild.captions.v3" && captionBinding && captionPackage
    ? (await acceptedWebCaptionRevisions(db, c, captionPackage, captionArtifact, captionBinding)).provenance : null;
  if (captionArtifact.content.schemaVersion === "guild.captions.v3" && !captionReview) fail("PUBLICATION_CAPTION_REVIEW_REQUIRED", "The accepted v3 caption edition needs its exact original review and acceptance binding.");
  const job = (await db.query<{ id: string; type: string; input: { packageId: string; contractVersion: number; artifactId: string; artifactHash: string; acceptancePackDigest: string }; output: { pack: AcceptancePack; report: unknown } }>("SELECT id,type,input,output FROM guild_jobs WHERE tenant_id=$1 AND commission_id=$2 AND id=$3 AND state='completed' FOR SHARE", [c.tenantId, c.id, webAcceptance.verification.jobId])).rows[0];
  const parsed = independentReport.safeParse(job?.output.report);
  if (!job || !parsed.success || digest(job.output) !== webAcceptance.verification.outputHash) fail("PUBLICATION_WEB_REPORT", "The accepted exhibition needs its complete original independent file and 18-case browser report.");
  const report = parsed.data, summary = webAuditSummary(report.cases);
  if (report.artifactId !== artifactId || report.artifactHash !== artifact.contentHash || report.contractDigest !== bundle.history.package.acceptancePack.digest || report.sourceDigest !== content.sourceDigest
    || !summary.complete || !summary.axe || !summary.lighthouse || !summary.palette || !summary.interaction || digest(summary) !== digest(report.summary)
    || digest(webMeasuredPack(bundle.history.package.acceptancePack, true, true, report.cases)) !== digest(job.output.pack)
    || report.files.length !== bundle.manifest.files.length || new Set(report.files.map(file => file.path)).size !== report.files.length
    || !bundle.manifest.files.every(file => report.files.some(check => check.path === file.path && check.contentHash === file.contentHash && check.byteLength === file.byteLength && check.mediaId === file.mediaId && check.passed)))
    fail("PUBLICATION_WEB_REPORT", "The independent report does not completely pass the exact selected original files and all 18 measured cases.");
  const saved = await readWebBundle(c.tenantId, bundle.candidate.bundleId, db), cases = [];
  for (const receipt of report.cases) {
    const original = await readWebAuditCaseDetails(c.tenantId, receipt.id, db);
    const request = boundWebAuditRequest({ tenantId: c.tenantId, jobId: job.id }, c, bundle.history.package, job, saved, "independent", receipt.result.locale, receipt.result.viewport);
    if (original.row.job_id !== job.id || original.row.commission_id !== c.id || original.row.mode !== "independent" || original.row.request_hash !== digest(request) || digest(original.receipt) !== digest(receipt))
      fail("PUBLICATION_WEB_REPORT", "A retained independent browser receipt changed its original job, selected design or evidence bytes.");
    cases.push({ id: receipt.id, requestHash: receipt.requestDigest, resultHash: receipt.resultHash, filesHash: digest(receipt.result.files) });
  }
  const bytes = new Map<string, Buffer>();
  for (const file of bundle.manifest.files) bytes.set(file.path, await bundle.read(file));
  const zipHash = createHash("sha256"); let zipByteLength = 0;
  for await (const chunk of webZipChunks(bundle.manifest, async (file: WebFile) => bytes.get(file.path)!)) { zipHash.update(chunk); zipByteLength += chunk.length; }
  const manifestBytes = Buffer.from(canonical(bundle.manifest));
  return publicationBindingSchema.parse({ version: "guild.exhibition-publication-binding.v1", artifactId, artifactHash: artifact.contentHash, artifactManifestHash: digest(artifact), sourceDigest: content.sourceDigest,
    sourceReviewsHash: digest(content.sources.reviews), selectedOrdinal: ordinal, designDigest: bundle.candidate.designDigest, bundleId: bundle.candidate.bundleId, bundleManifestHash: digest(bundle.manifest), bundleFilesDigest: bundle.manifest.filesDigest,
    sourceRecordHash: sha(bytes.get("source-record.json")!), rendererDigest: renderer.digest, bundle: bundle.manifest,
    portable: { manifestPath: "bundle-manifest.json", manifestHash: sha(manifestBytes), manifestByteLength: manifestBytes.length, zipPath: "exhibition.zip", zipHash: zipHash.digest("hex"), zipByteLength }, accepted, ...(captionReview ? { captionReview } : {}),
    independent: { jobId: job.id, outputHash: digest(job.output), reportHash: digest(report), filesHash: digest(report.files), cases },
    disclosures: ["Curator acceptance is separate from the original automated checks. Fluent-language review is not established for any of the six languages.", ...content.limitations, ...Object.values(content.sources.languageReviews).map(item => item.disclosure)].filter((item, index, all) => all.indexOf(item) === index) });
}
