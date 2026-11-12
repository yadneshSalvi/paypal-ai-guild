import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { webAuditRequestSchema, type WebAuditRequest } from "@/domain/web-audits";
import type { WebSources } from "@/domain/web-exhibition";
import { webAuthoritySchema } from "@/domain/web-exhibition";
import { digest, DomainError } from "@/domain/primitives";
import { getPool, transaction } from "../db";
import { requireProductionLease, requireVerificationLease, type ProductionLease } from "../production-authority";
import { ProductionContinuation, ProductionReviewRequired } from "../production-continuation";
import type { PrivateBlobGateway } from "../media/blob-store";
import { readWebBundle, webOriginalReader } from "./bundles";
import { LocalWebAuditGateway, WebAuditAttemptError, type WebAuditGateway } from "./audit-gateway";
import { readWebAuditCase, retainWebAuditFiles, saveWebAuditObservation, type WebAuditRow } from "./audit-store";
import { boundWebAuditRequest } from "./audit-request";
import { requireWebVerificationAuthority } from "./authority";
import { installedWebRuntime } from "./capability";

function fail(code: string, message: string): never { throw new ProductionReviewRequired(code, message); }
async function caseAuthority(db: PoolClient, context: ProductionLease, packageId: string, bundleId: string, request: WebAuditRequest) {
  const authority = request.mode === "producer" ? await requireProductionLease(db, context, packageId) : request.mode === "independent" ? await requireVerificationLease(db, context) : null;
  if (!authority?.package || authority.package.kind !== "web" || authority.package.id !== packageId) fail("WEB_AUDIT_AUTHORITY", "This browser case does not belong to the exact owned web job.");
  const bundle = await readWebBundle(context.tenantId, bundleId, db);
  const expected = boundWebAuditRequest(context, authority.commission, authority.package, authority.job, bundle, request.mode as "producer" | "independent", request.locale, request.viewport);
  if (digest(request) !== digest(expected)) fail("WEB_AUDIT_AUTHORITY", "The browser request changed its exact job, source, original deadline, renderer, capability or candidate.");
  if (request.mode === "independent") {
    await requireWebVerificationAuthority(db, authority.commission, authority.package);
    const artifact = authority.commission.artifacts.find(item => item.id === authority.job.input.artifactId);
    const content = artifact?.content as { schemaVersion?: string; selectedOrdinal?: number; candidates?: { ordinal: number; bundleId: string }[] } | undefined;
    if (content?.schemaVersion !== "guild.exhibition.v2" || !content.candidates?.some(item => item.ordinal === content.selectedOrdinal && item.bundleId === bundleId))
      fail("WEB_AUDIT_AUTHORITY", "Independent browser measurements must inspect this exact artifact's selected original bundle.");
  }
  return authority;
}
/** One committed intent precedes one process. Uncertain cases are never rerun. */
export async function runWebAudit(context: ProductionLease, packageId: string, bundleId: string, sources: WebSources, rawRequest: WebAuditRequest, dependencies: { storage?: PrivateBlobGateway; audit?: WebAuditGateway } = {}) {
  const request = webAuditRequestSchema.parse(rawRequest);
  let row = (await getPool().query<WebAuditRow>("SELECT * FROM guild_web_audit_cases WHERE tenant_id=$1 AND job_id=$2 AND case_key=$3", [context.tenantId, context.jobId, request.caseId])).rows[0];
  if (row) {
    if (row.request_hash !== digest(request) || digest(row.request) !== row.request_hash || row.package_id !== packageId || row.mode !== request.mode) fail("WEB_AUDIT_REQUEST_CHANGED", "This saved browser case belongs to different exact inputs or authority.");
    if (row.state === "received") return readWebAuditCase(context.tenantId, row.id);
    if (row.state !== "prepared") fail(row.failure_code ?? "WEB_AUDIT_OUTCOME_UNKNOWN", "The original browser case needs review. Its request and partial findings remain saved without a rerun.");
  }
  if ((context.externalCalls ?? 0) >= 1) throw new ProductionContinuation("Continuing with the next original browser case", 1);
  const bundle = await readWebBundle(context.tenantId, bundleId);
  if (digest(bundle.manifest) !== digest(request.bundle) || bundle.manifest.sourceDigest !== digest(sources)) fail("WEB_AUDIT_BUNDLE_CHANGED", "The browser case differs from its exact stored source and bundle.");
  if (!row) row = await transaction(async db => {
    const authority = await caseAuthority(db, context, packageId, bundleId, request);
    const inserted = await db.query<WebAuditRow>("INSERT INTO guild_web_audit_cases(id,tenant_id,commission_id,package_id,contract_version,job_id,case_key,mode,request_hash,request,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'prepared') ON CONFLICT(tenant_id,job_id,case_key) DO NOTHING RETURNING *", [randomUUID(), context.tenantId, authority.commission.id, packageId, authority.package!.contractVersion, context.jobId, request.caseId, request.mode, digest(request), request]);
    return inserted.rows[0] ?? (await db.query<WebAuditRow>("SELECT * FROM guild_web_audit_cases WHERE tenant_id=$1 AND job_id=$2 AND case_key=$3", [context.tenantId, context.jobId, request.caseId])).rows[0]!;
  });
  if (!row || row.request_hash !== digest(request)) fail("WEB_AUDIT_REQUEST_CHANGED", "Another exact request already owns this case.");
  const original = await webOriginalReader(context.tenantId, row.commission_id, sources, dependencies.storage);
  let claimed = false;
  const beforeLaunch = async () => {
    const dispatch = await transaction(async db => {
      const authority = await caseAuthority(db, context, packageId, bundleId, request);
      const current = (await db.query<WebAuditRow>("SELECT * FROM guild_web_audit_cases WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [context.tenantId, row.id])).rows[0];
      if (!current || current.state !== "prepared" || current.request_hash !== digest(request)) fail("WEB_AUDIT_OUTCOME_UNKNOWN", "The original browser case already has a dispatch intent. It cannot be rerun.");
      // Expensive identity/cache reads precede this point. Give this one bounded
      // case a fresh worker lease; its work authority and deadline stay unchanged.
      await db.query("UPDATE guild_jobs SET lease_until=now()+interval '6 minutes' WHERE id=$1 AND tenant_id=$2 AND lease_token=$3 AND state='running'", [context.jobId, context.tenantId, context.leaseToken]);
      await db.query("UPDATE guild_web_audit_cases SET state='dispatching',dispatched_at=now(),updated_at=now() WHERE id=$1 AND tenant_id=$2", [row.id, context.tenantId]);
      return { workerId: context.leaseToken!, originalDeadline: webAuthoritySchema.parse(authority.package!.acceptancePack.parameters?.authority).expiresAt };
    });
    claimed = true;
    return dispatch;
  };
  const beforeBrowser = async () => {
    if (!claimed) fail("WEB_AUDIT_DISPATCH_REQUIRED", "The hosted browser command needs its original exclusive dispatch claim.");
    await transaction(async db => {
      await caseAuthority(db, context, packageId, bundleId, request);
      const current = (await db.query<WebAuditRow>("SELECT * FROM guild_web_audit_cases WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [context.tenantId, row.id])).rows[0];
      if (!current || current.state !== "dispatching" || !current.dispatched_at || current.request_hash !== digest(request)) fail("WEB_AUDIT_OUTCOME_UNKNOWN", "The original browser claim changed while its hosted runtime was prepared. No browser command was sent.");
      // This extends only the existing worker lease. The original work deadline,
      // actor, Passport and dispatch timestamp are rechecked and never renewed.
      await db.query("UPDATE guild_jobs SET lease_until=now()+interval '6 minutes' WHERE id=$1 AND tenant_id=$2 AND lease_token=$3 AND state='running'", [context.jobId, context.tenantId, context.leaseToken]);
    });
  };
  context.externalCalls = (context.externalCalls ?? 0) + 1;
  try {
    let gateway = dependencies.audit;
    if (!gateway) {
      const runtime = await (context.webRuntime ?? installedWebRuntime).read();
      gateway = runtime.execution === "hosted" ? new (await import("./hosted-gateway")).HostedWebAuditGateway({ runtime: context.webRuntime }) : new LocalWebAuditGateway();
    }
    const measured = await gateway.run({ id: row.id, tenantId: context.tenantId, jobId: context.jobId, bundleId, request, manifest: bundle.manifest,
      read: async file => bundle.authored.get(file.path) ?? original(file), beforeLaunch, beforeBrowser });
    if (!claimed) fail("WEB_AUDIT_DISPATCH_REQUIRED", "A browser observation cannot precede its exact owned dispatch intent.");
    const receipt = await saveWebAuditObservation(row, measured.result, measured.files);
    // The hosted adapter records cleanup uncertainty separately. A saved native
    // observation remains received even when stopping compute cannot be confirmed.
    await measured.afterSave?.().catch(() => undefined);
    return receipt;
  } catch (error) {
    if (!claimed && error instanceof ProductionContinuation) throw error;
    if (!claimed && error instanceof DomainError && error.recoverable && error.status >= 500) throw new ProductionContinuation("Waiting to read the same original files before launching the browser case", 15);
    const code = error instanceof WebAuditAttemptError || error instanceof DomainError ? error.code : "WEB_AUDIT_OUTCOME_UNKNOWN";
    await transaction(async db => {
      if (error instanceof WebAuditAttemptError) await retainWebAuditFiles(db, row, error.files);
      // A competing caller that lost beforeLaunch does not own the committed
      // dispatch. It must not poison another worker's in-flight original case.
      await db.query("UPDATE guild_web_audit_cases SET state=$1,failure_code=$2,original_failure_code=coalesce(original_failure_code,$2),updated_at=now() WHERE id=$3 AND tenant_id=$4 AND state=$5", [claimed ? "indeterminate" : "failed", code, row.id, context.tenantId, claimed ? "dispatching" : "prepared"]);
    });
    fail(code, error instanceof WebAuditAttemptError || error instanceof DomainError ? error.message : "The original browser attempt could not be durably confirmed. Preserve its exact identity and partial evidence; no automatic rerun or extra model response is allowed.");
  }
}
