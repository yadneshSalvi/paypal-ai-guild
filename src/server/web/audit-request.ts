import type { Commission, Locale, WorkPackage } from "@/contracts/guild";
import { webAuditRequestSchema, type WebAuditRequest } from "@/domain/web-audits";
import { webAuditCapabilitySchema, webAuthoritySchema, webRendererCapabilitySchema } from "@/domain/web-exhibition";
import { digest, DomainError } from "@/domain/primitives";
import { getPool } from "../db";
import type { ProductionLease } from "../production-authority";
import { readWebBundle } from "./bundles";

type Bundle = Awaited<ReturnType<typeof readWebBundle>>;
interface JobBinding { type: string; input: { packageId?: string; contractVersion?: number; artifactId?: string; artifactHash?: string; acceptancePackDigest?: string } }
/** A browser request is reconstructed from owned rows, never browser-supplied authority. */
export function boundWebAuditRequest(context: Pick<ProductionLease, "tenantId" | "jobId">, c: Pick<Commission, "id">, pkg: WorkPackage, job: JobBinding, bundle: Bundle,
  mode: "producer" | "independent", locale: Locale, viewport: WebAuditRequest["viewport"]): WebAuditRequest {
  const renderer = webRendererCapabilitySchema.parse(pkg.acceptancePack.parameters?.rendererCapability), capability = webAuditCapabilitySchema.parse(pkg.acceptancePack.parameters?.auditCapability);
  const originalDeadline = webAuthoritySchema.parse(pkg.acceptancePack.parameters?.authority).expiresAt;
  if (pkg.kind !== "web" || job.input.packageId !== pkg.id || job.input.contractVersion !== pkg.contractVersion || bundle.row.tenant_id !== context.tenantId
    || bundle.row.commission_id !== c.id || bundle.row.package_id !== pkg.id || bundle.row.contract_version !== pkg.contractVersion
    || mode === "producer" && (job.type !== "produce_package" || bundle.row.job_id !== context.jobId)
    || mode === "independent" && (job.type !== "verify_artifact" || !job.input.artifactId || !job.input.artifactHash || job.input.acceptancePackDigest !== pkg.acceptancePack.digest))
    throw new DomainError("WEB_AUDIT_AUTHORITY", "This browser case is not bound to its exact owned production or independent verification job.", 422, false);
  const authorityDigest = digest({ version: "guild.web-browser-authority.v1", tenantId: context.tenantId, commissionId: c.id, jobId: context.jobId, jobType: job.type,
    packageId: pkg.id, contractVersion: pkg.contractVersion, contractDigest: pkg.acceptancePack.digest, originalDeadline,
    artifact: mode === "independent" ? { id: job.input.artifactId, contentHash: job.input.artifactHash } : null,
    producingJobId: bundle.row.job_id, bundleId: bundle.row.id, ordinal: bundle.row.ordinal, manifestHash: bundle.row.manifest_hash,
    rendererDigest: renderer.digest, capabilityDigest: digest(capability) });
  return webAuditRequestSchema.parse({ version: "guild.web-audit-request.v2", mode, locale, viewport, caseId: `${mode}:${bundle.row.ordinal}:${locale}:${viewport.width}`,
    authorityDigest, rendererDigest: renderer.digest, capability, sourceDigest: bundle.manifest.sourceDigest, designDigest: bundle.manifest.designDigest, bundle: bundle.manifest });
}
export async function createWebAuditRequest(context: ProductionLease, c: Commission, pkg: WorkPackage, bundleId: string, mode: "producer" | "independent", locale: Locale, viewport: WebAuditRequest["viewport"]) {
  const job = (await getPool().query<JobBinding & { commission_id: string }>("SELECT commission_id,type,input FROM guild_jobs WHERE tenant_id=$1 AND id=$2", [context.tenantId, context.jobId])).rows[0];
  if (!job || job.commission_id !== c.id) throw new DomainError("WEB_AUDIT_AUTHORITY", "The original browser job is unavailable.", 422, false);
  return boundWebAuditRequest(context, c, pkg, job, await readWebBundle(context.tenantId, bundleId), mode, locale, viewport);
}
