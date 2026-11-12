import { createHash } from "node:crypto";
import { z } from "zod";
import { locales } from "@/contracts/guild";
import { webAuditSummary, webMeasuredPack, type WebAuditReceipt } from "@/domain/web-audits";
import { webAuditPolicy, webSourcesFromPack, type WebFile } from "@/domain/web-exhibition";
import { digest, DomainError } from "@/domain/primitives";
import { getPool, transaction } from "../db";
import { requireVerificationLease, type ProductionLease } from "../production-authority";
import { ProductionContinuation } from "../production-continuation";
import { savedProductionPart, saveProductionPart } from "../production-parts";
import type { PrivateBlobGateway } from "../media/blob-store";
import { captionOwnedArtifact } from "../captions/sources";
import { readWebApprovalHistory } from "./approval-history";
import { validateWebArtifactRecord } from "./artifact";
import { readWebBundle, webOriginalReader } from "./bundles";
import { validateWebJob } from "./contracts";
import type { WebAuditGateway } from "./audit-gateway";
import { createWebAuditRequest } from "./audit-request";
import { runWebAudit } from "./audits";

export const webVerifierVersion = "guild.independent-original-files-and-browser.v1";
const fileCheckSchema = z.object({ path: z.string(), contentHash: z.string(), byteLength: z.number().int().positive(), mediaId: z.string().uuid().nullable(), passed: z.boolean(), evidence: z.string(), checkedAt: z.string().datetime() }).strict();
type FileCheck = z.infer<typeof fileCheckSchema>;
async function checkFile(context: ProductionLease, file: WebFile, read: (file: WebFile) => Promise<Buffer>): Promise<FileCheck> {
  if (file.mediaId && (context.externalCalls ?? 0) >= 1) throw new ProductionContinuation("Reading the next exact original exhibition file", 1);
  const result: FileCheck = { path: file.path, contentHash: file.contentHash, byteLength: file.byteLength, mediaId: file.mediaId, passed: false, evidence: "The original bytes have not been checked.", checkedAt: new Date().toISOString() };
  try {
    if (file.mediaId) context.externalCalls = (context.externalCalls ?? 0) + 1;
    const bytes = await read(file), hash = createHash("sha256").update(bytes).digest("hex");
    result.passed = bytes.length === file.byteLength && hash === file.contentHash;
    result.evidence = result.passed ? "Original stored identity, byte length and SHA-256 match the immutable portable manifest." : "The actual original bytes differ from their exact declared hash or length.";
  } catch (error) {
    if (error instanceof DomainError && error.recoverable && error.status >= 500) throw new ProductionContinuation("The private store is unavailable; the same original bytes will be read later", 15);
    result.evidence = error instanceof DomainError ? `${error.code}: ${error.message}` : "This exact original file could not be read. No alternate file was substituted.";
  }
  return result;
}
export async function verifyWeb(context: ProductionLease, dependencies: { storage?: PrivateBlobGateway; audit?: WebAuditGateway } = {}) {
  const { commission, package: pkg, artifact } = await transaction(db => requireVerificationLease(db, context));
  const sources = webSourcesFromPack(pkg.acceptancePack), checks: FileCheck[] = [], cases: WebAuditReceipt[] = [];
  const report = { schemaVersion: "guild.web-verification.v1", verifierVersion: webVerifierVersion, artifactId: artifact.id, artifactHash: artifact.contentHash, contractDigest: pkg.acceptancePack.digest,
    sourceDigest: digest(sources), sourceVerified: false, producingApprovalVerified: false, producerPipelineVerified: false, files: checks, cases, expectedCases: 18,
    evidence: [] as string[], originalMediaUnchanged: true, newModelRequests: 0, newRecognitionRequests: 0, fluentHumanReviewed: false, humanExperienceReviewed: false };
  const result = () => ({ pack: webMeasuredPack(pkg.acceptancePack, report.sourceVerified && report.producingApprovalVerified && report.producerPipelineVerified, checks.length > 0 && checks.every(item => item.passed), cases), report: { ...report, summary: webAuditSummary(cases) } });
  let value: Awaited<ReturnType<typeof validateWebArtifactRecord>>;
  try {
    await captionOwnedArtifact(getPool(), commission, artifact.id, artifact.contentHash);
    const historical = await readWebApprovalHistory(getPool(), commission, pkg, artifact);
    const bound = await validateWebJob(getPool(), historical.snapshot, historical.package, historical.job, false);
    value = await validateWebArtifactRecord(getPool(), historical.snapshot, historical.package, historical.job, artifact.content);
    if (digest(bound.correction) !== digest(value.correction) || bound.attempt !== value.attempt) throw new DomainError("WEB_JOB_BINDING", "The original producing attempt differs from its exact approved snapshot.", 422, false);
    report.sourceVerified = true; report.producingApprovalVerified = true; report.producerPipelineVerified = true;
  } catch (error) {
    if (error instanceof DomainError && error.recoverable && error.status >= 500) throw new ProductionContinuation("Waiting to read the same original web evidence", 15);
    report.evidence.push(error instanceof DomainError ? `${error.code}: ${error.message}` : "The complete original web source, producing approval or retained design/audit pipeline could not be verified.");
    return result();
  }
  const selected = value.candidates[value.selectedOrdinal - 1]!, stored = await readWebBundle(context.tenantId, selected.bundleId);
  const original = await webOriginalReader(context.tenantId, commission.id, sources, dependencies.storage), read = async (file: WebFile) => stored.authored.get(file.path) ?? original(file);
  for (const file of stored.manifest.files) {
    const inputHash = digest({ version: webVerifierVersion, artifactHash: artifact.contentHash, bundleId: selected.bundleId, manifestHash: digest(stored.manifest), file }), key = `web-file:${file.path}`;
    try { checks.push(await savedProductionPart(context, key, inputHash, fileCheckSchema) ?? await saveProductionPart(context, key, inputHash, await checkFile(context, file, read), fileCheckSchema)); }
    catch (error) { if (error instanceof ProductionContinuation) throw new ProductionContinuation(`Exhibition checks · ${checks.length} of ${stored.manifest.files.length} exact files measured. ${error.step}.`, error.retryAfterSeconds); throw error; }
  }
  if (!checks.every(item => item.passed)) { report.evidence.push("The independent browser could not receive a complete exact bundle. All file failures and the full 18-case denominator remain retained."); return result(); }
  for (const locale of locales) for (const viewport of webAuditPolicy.viewports) {
    try { const request = await createWebAuditRequest(context, commission, pkg, selected.bundleId, "independent", locale, viewport); cases.push(await runWebAudit(context, pkg.id, selected.bundleId, sources, request, dependencies)); }
    catch (error) { if (error instanceof ProductionContinuation) throw new ProductionContinuation(`Exhibition browser checks · ${cases.length} of 18 original cases retained. ${error.step}.`, error.retryAfterSeconds); throw error; }
  }
  report.evidence.push("All 18 independently dispatched browser cases are retained with full native axe/Lighthouse JSON and each required interaction observation. Earlier producer findings remain separate and unchanged.");
  return result();
}
