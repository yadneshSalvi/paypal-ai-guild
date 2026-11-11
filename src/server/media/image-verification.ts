import { z } from "zod";
import type { AcceptancePack, ArtifactManifest, Commission, WorkPackage } from "@/contracts/guild";
import { checkImageArtifact, imageAcceptancePack, imageArtifactSchema, imageMeasureSchema, imageTreatment, type ImageArtifact, type TreatedImage } from "@/domain/images";
import { digest, DomainError } from "@/domain/primitives";
import { getPool, transaction } from "../db";
import { requireVerificationLease, type ProductionLease } from "../production-authority";
import { ProductionContinuation, ProductionReviewRequired } from "../production-continuation";
import { savedProductionPart, saveProductionPart } from "../production-parts";
import type { PrivateBlobGateway } from "./blob-store";
import { loadSourceImage, measureImageDerivative, measureSourceImage } from "./image-processing";
import { readOwnedMedia } from "./objects";

const fileCheckSchema = z.object({ sourceId: z.string(), kind: z.enum(["full", "thumbnail"]), mediaId: z.string().uuid(), passed: z.boolean(), evidence: z.string(), measurement: imageMeasureSchema.nullable() }).strict();
type FileCheck = z.infer<typeof fileCheckSchema>;
export interface ImageVerificationResult { pack: AcceptancePack; report: { schemaVersion: "guild.image-verification.v2"; artifactId: string; artifactHash: string; checks: FileCheck[] } }

function initialPack(commission: Commission, pkg: WorkPackage, artifact: ArtifactManifest): AcceptancePack {
  const pack = imageAcceptancePack(commission.sourceAssets), checks = checkImageArtifact(artifact.content, commission.sourceAssets, pkg.acceptancePack.digest);
  const integrity = artifact.contentHash === digest(artifact.content);
  for (const criterion of pack.criteria) {
    if (criterion.kind !== "deterministic") { criterion.status = "review"; criterion.evidence = "A curator must compare every source and derivative and review the alt descriptions. No human or fluent-language review is claimed."; continue; }
    const check = checks[criterion.id as keyof typeof checks];
    criterion.status = integrity && check?.passed ? "passed" : "failed";
    criterion.evidence = integrity ? check?.evidence ?? "The agreed check is unavailable." : "The submission no longer matches its immutable artifact hash.";
  }
  return pack;
}

async function productionBinding(context: ProductionLease, commission: Commission, pkg: WorkPackage, artifact: ArtifactManifest, content: ImageArtifact) {
  const stored = (await getPool().query<{ manifest: ArtifactManifest; content_hash: string }>("SELECT manifest,content_hash FROM guild_artifacts WHERE id=$1 AND tenant_id=$2 AND commission_id=$3 AND package_id=$4", [artifact.id, context.tenantId, commission.id, pkg.id])).rows[0];
  if (!stored || stored.content_hash !== artifact.contentHash || digest(stored.manifest.content) !== artifact.contentHash || stored.manifest.provenance.sourceId !== artifact.provenance.sourceId) return null;
  const origin = (await getPool().query<{ job_id: string; input: { packageId?: string; contractVersion?: number }; state: string }>("SELECT m.job_id,j.input,j.state FROM guild_model_runs m JOIN guild_jobs j ON j.id=m.job_id AND j.tenant_id=m.tenant_id WHERE m.id=$1 AND m.tenant_id=$2 AND j.commission_id=$3 AND j.type='produce_package'", [artifact.provenance.sourceId, context.tenantId, commission.id])).rows[0];
  if (!origin || origin.state !== "completed" || origin.input.packageId !== pkg.id || origin.input.contractVersion !== pkg.contractVersion) return null;
  const results = (await getPool().query<{ id: string; model: string; output: unknown; output_hash: string; status: string }>("SELECT id,model,output,output_hash,status FROM guild_model_runs WHERE tenant_id=$1 AND job_id=$2 AND id=ANY($3::uuid[])", [context.tenantId, origin.job_id, content.images.map(item => item.modelRun.id)])).rows;
  if (!content.images.every(item => results.some(run => run.id === item.modelRun.id && run.model === item.modelRun.model && run.status === "completed" && run.output_hash === digest(run.output) && run.output_hash === digest(item.description)))) return null;
  return origin.job_id;
}

async function checkFile(context: ProductionLease, commission: Commission, pkg: WorkPackage, item: TreatedImage, kind: "full" | "thumbnail", productionJobId: string, storage?: PrivateBlobGateway): Promise<FileCheck> {
  const file = item[kind], base = { sourceId: item.sourceId, kind, mediaId: file.mediaId };
  try {
    const source = commission.sourceAssets.find(source => source.id === item.sourceId)!;
    const original = await loadSourceImage(source), geometry = await measureSourceImage(original);
    if (geometry.width !== item.sourceWidth || geometry.height !== item.sourceHeight) throw new DomainError("IMAGE_SOURCE_GEOMETRY", "The claimed source geometry does not match the agreed photograph.", 422, false);
    if ((context.externalCalls ?? 0) >= 1) throw new ProductionContinuation("Checking the next saved image file", 1);
    await transaction(db => requireVerificationLease(db, context));
    context.externalCalls = (context.externalCalls ?? 0) + 1;
    const result = await readOwnedMedia(context.tenantId, file.mediaId, storage);
    const { mediaId: _id, url: _url, ...declared } = file;
    const expectedMetadata = { purpose: "museum-image-treatment", kind, sourceId: item.sourceId, sourceHash: item.sourceHash, rightsHash: item.rightsHash, contractDigest: pkg.acceptancePack.digest, measure: declared };
    if (result.row.commission_id !== commission.id || result.row.package_id !== pkg.id || result.row.job_id !== productionJobId || result.row.operation_key !== `image:${item.sourceId}:${kind}` || result.row.content_hash !== file.contentHash || result.row.media_type !== "image/webp" || digest(result.row.metadata) !== digest(expectedMetadata)) throw new DomainError("IMAGE_FILE_BINDING", "This file does not belong to the exact source, contract and production job.", 422, false);
    const actual = await measureImageDerivative(original, result.bytes, kind);
    if (digest(actual) !== digest(declared)) return { ...base, passed: false, measurement: actual, evidence: "Actual decoded dimensions, profile, hash or comparison measurements differ from the submitted declaration." };
    const withinBounds = actual.comparison.normalizedRootMeanSquareError <= imageTreatment.comparison.maximumNormalizedRmse && actual.comparison.dHashDistance <= imageTreatment.comparison.maximumDHashDistance;
    return { ...base, passed: withinBounds, measurement: actual, evidence: withinBounds ? "Read original private bytes; independently decoded geometry, embedded sRGB profile, byte hash and aligned-pixel/perceptual measurements match the agreed submission." : "The independently recomputed pixel/perceptual comparison exceeds the agreed limits. Human review cannot waive this blocking check." };
  } catch (error) {
    if (error instanceof ProductionContinuation || error instanceof ProductionReviewRequired) throw error;
    if (error instanceof DomainError && error.status >= 500 && error.recoverable) throw new ProductionContinuation("The private file store is unavailable; verification will read the same saved object", 15);
    return { ...base, passed: false, measurement: null, evidence: error instanceof DomainError ? `${error.code}: ${error.message}` : "The actual file could not be decoded and independently measured. No verified file was substituted." };
  }
}

export async function verifyImages(context: ProductionLease, storage?: PrivateBlobGateway): Promise<ImageVerificationResult> {
  const { commission, package: pkg, artifact } = await transaction(db => requireVerificationLease(db, context));
  const pack = initialPack(commission, pkg, artifact), checks: FileCheck[] = [];
  const report = { schemaVersion: "guild.image-verification.v2" as const, artifactId: artifact.id, artifactHash: artifact.contentHash, checks };
  const parsed = imageArtifactSchema.safeParse(artifact.content);
  if (!parsed.success || pack.criteria.some(item => item.kind === "deterministic" && item.status === "failed")) return { pack, report };
  const origin = await productionBinding(context, commission, pkg, artifact, parsed.data);
  if (!origin) {
    for (const criterion of pack.criteria.filter(item => item.kind === "deterministic")) { criterion.status = "failed"; criterion.evidence = "The submitted artifact or descriptions do not bind to the exact retained producing job and completed model outputs."; }
    return { pack, report };
  }
  for (const item of parsed.data.images) for (const kind of ["full", "thumbnail"] as const) {
    const partKey = `verify:${item.sourceId}:${kind}`, inputHash = digest({ artifactId: artifact.id, artifactHash: artifact.contentHash, contractVersion: pkg.contractVersion, contractDigest: pkg.acceptancePack.digest, sourceManifest: parsed.data.sourceManifest, treatment: imageTreatment, file: item[kind] });
    try {
      const saved = await savedProductionPart(context, partKey, inputHash, fileCheckSchema);
      checks.push(saved ?? await saveProductionPart(context, partKey, inputHash, await checkFile(context, commission, pkg, item, kind, origin, storage), fileCheckSchema));
    } catch (error) {
      if (error instanceof ProductionContinuation) throw new ProductionContinuation(`Image checks · ${checks.length} of ${parsed.data.images.length * 2} files measured. ${error.step}.`, error.retryAfterSeconds);
      throw error;
    }
  }
  const failures = checks.filter(item => !item.passed), measurements = checks.flatMap(item => item.measurement ? [item.measurement] : []);
  for (const id of ["coverage", "files", "comparison"]) {
    const criterion = pack.criteria.find(item => item.id === id)!;
    criterion.status = failures.length ? "failed" : "passed";
    criterion.evidence = failures.length ? `${failures.length} of ${checks.length} actual file checks failed. ${failures.map(item => `${item.sourceId}/${item.kind}: ${item.evidence}`).join(" ")}` : id === "comparison" ? `All ${checks.length} original files were independently read and measured. Maximum normalized RGB RMSE ${Math.max(...measurements.map(item => item.comparison.normalizedRootMeanSquareError)).toFixed(6)}; maximum difference-hash distance ${Math.max(...measurements.map(item => item.comparison.dHashDistance))}/64. These measurements do not establish historical fidelity.` : `All ${checks.length} immutable files belong to this commission and producing job; their original bytes, dimensions, full-frame ratio, embedded sRGB profile and hashes match the agreed contract.`;
  }
  return { pack, report };
}
