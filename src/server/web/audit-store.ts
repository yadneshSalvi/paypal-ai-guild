import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { webAuditFileSchema, webAuditReceiptSchema, webAuditRequestSchema, type WebAuditReceipt, type WebAuditRequest, type WebAuditResult } from "@/domain/web-audits";
import { canonical, digest } from "@/domain/primitives";
import { getPool, transaction } from "../db";
import { ProductionReviewRequired } from "../production-continuation";
import { validateWebEvidence } from "./audit-evidence";
import { originalHostedObservation } from "./hosted-store";

export interface WebAuditRow { id: string; tenant_id: string; commission_id: string; package_id: string; contract_version: number; job_id: string; case_key: string; mode: "producer" | "independent"; request_hash: string; request: WebAuditRequest; state: "prepared" | "dispatching" | "received" | "failed" | "indeterminate"; failure_code: string | null; dispatched_at: Date | null; original_failure_code?: string | null; recovered_at?: Date | null }
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function fail(message: string): never { throw new ProductionReviewRequired("WEB_AUDIT_EVIDENCE_CHANGED", message); }
function signature(row: WebAuditRow, resultHash: string, manifest: WebAuditResult["files"]) {
  if (!process.env.AUTH_SECRET) throw new Error("AUTH_SECRET required");
  return createHmac("sha256", process.env.AUTH_SECRET).update(canonical({ kind: "guild.browser-measurement-receipt.v1", tenantId: row.tenant_id, commissionId: row.commission_id, jobId: row.job_id,
    packageId: row.package_id, contractVersion: row.contract_version, mode: row.mode, dispatchedAt: row.dispatched_at?.toISOString() ?? null,
    caseId: row.id, caseKey: row.case_key, requestHash: row.request_hash, resultHash, evidenceManifestHash: digest(manifest) })).digest("hex");
}
export async function readWebAuditCaseDetails(tenantId: string, id: string, db: Pool | PoolClient = getPool()) {
  const row = (await db.query<WebAuditRow>("SELECT * FROM guild_web_audit_cases WHERE tenant_id=$1 AND id=$2", [tenantId, id])).rows[0];
  const observation = (await db.query<{ result: unknown; result_hash: string; evidence_manifest: WebAuditResult["files"]; signature: string }>("SELECT result,result_hash,evidence_manifest,signature FROM guild_web_audit_observations WHERE tenant_id=$1 AND case_id=$2", [tenantId, id])).rows[0];
  if (!row || row.state !== "received" || !row.dispatched_at || !observation || row.request_hash !== digest(row.request) || observation.result_hash !== digest(observation.result) || !/^[a-f0-9]{64}$/.test(observation.signature)
    || !timingSafeEqual(Buffer.from(observation.signature), Buffer.from(signature(row, observation.result_hash, observation.evidence_manifest)))) fail("The original browser case or its signed retained report is missing or changed.");
  const raw = (await db.query<{ path: string; byte_length: number; content_hash: string; bytes: Buffer }>("SELECT path,byte_length,content_hash,bytes FROM guild_web_audit_files WHERE tenant_id=$1 AND case_id=$2 ORDER BY path", [tenantId, id])).rows;
  const values = new Map<string, Buffer>();
  for (const file of raw) { if (file.bytes.length !== file.byte_length || hash(file.bytes) !== file.content_hash) fail("An original browser report no longer matches its retained bytes."); values.set(file.path, file.bytes); }
  const result = validateWebEvidence(webAuditRequestSchema.parse(row.request), observation.result, values);
  if (digest(result.files) !== digest(observation.evidence_manifest)) fail("The exact browser evidence manifest changed.");
  return {row,files:values,receipt:webAuditReceiptSchema.parse({ id, requestDigest: row.request_hash, resultHash: observation.result_hash, result })};
}
export async function readWebAuditCase(tenantId:string,id:string,db:Pool|PoolClient=getPool()):Promise<WebAuditReceipt>{return (await readWebAuditCaseDetails(tenantId,id,db)).receipt;}
export async function retainWebAuditFiles(db: PoolClient, row: WebAuditRow, files: Map<string, Buffer>) {
  if (files.size > 200 || [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0) > 64 * 1024 * 1024) fail("The original native evidence exceeded its fixed file/count retention bounds. Earlier bytes remain preserved.");
  for (const [path, bytes] of files) {
    const reference = webAuditFileSchema.parse({ path, byteLength: bytes.length, contentHash: hash(bytes) });
    await db.query("INSERT INTO guild_web_audit_files(case_id,tenant_id,path,byte_length,content_hash,bytes) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(case_id,path) DO NOTHING", [row.id, row.tenant_id, path, bytes.length, reference.contentHash, bytes]);
    const saved = (await db.query<{ content_hash: string; byte_length: number; bytes: Buffer }>("SELECT content_hash,byte_length,bytes FROM guild_web_audit_files WHERE case_id=$1 AND tenant_id=$2 AND path=$3", [row.id, row.tenant_id, path])).rows[0];
    if (!saved || saved.content_hash !== reference.contentHash || saved.byte_length !== reference.byteLength || !saved.bytes.equals(bytes)) fail("Different original evidence already owns this case and path. Earlier bytes were not overwritten.");
  }
}
/** Retain observations even if authority expires while the read-only measurement runs. */
export interface OriginalHostedObservationRecovery { bindingDigest: string; sessionId: string; commandId: string; originalDispatchedAt: string }
export async function saveWebAuditObservation(row: WebAuditRow, raw: unknown, files: Map<string, Buffer>, recovery?: OriginalHostedObservationRecovery) {
  const result = validateWebEvidence(row.request, raw, files), resultHash = digest(result);
  await transaction(async db => {
    const dispatched = (await db.query<WebAuditRow>("SELECT * FROM guild_web_audit_cases WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [row.tenant_id, row.id])).rows[0];
    if (!dispatched || !dispatched.dispatched_at || !["dispatching", "received", ...(recovery ? ["indeterminate"] : [])].includes(dispatched.state) || dispatched.request_hash !== digest(row.request)
      || digest(dispatched.request) !== dispatched.request_hash || dispatched.job_id !== row.job_id) fail("A browser result needs its exact original committed dispatch intent. No observation can manufacture a new attempt.");
    const hosted = await originalHostedObservation(db, dispatched);
    if (recovery && (!hosted || digest(hosted.binding) !== recovery.bindingDigest || hosted.session?.id !== recovery.sessionId || hosted.commands.browser?.id !== recovery.commandId || hosted.binding.originalDispatchedAt !== recovery.originalDispatchedAt))
      fail("Read-only recovery needs the exact original signed hosted session, command and dispatch timestamp.");
    if (hosted && (!hosted.session || !hosted.commands.browser || !hosted.evidence || hosted.evidence.resultHash !== resultHash || hosted.evidence.nativeFilesDigest !== digest(result.files)))
      fail("The hosted observation is not bound to its retained original browser command and exact native evidence.");
    await retainWebAuditFiles(db, dispatched, files);
    await db.query("INSERT INTO guild_web_audit_observations(case_id,tenant_id,result_hash,result,evidence_manifest,signature) VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT(case_id) DO NOTHING", [row.id, row.tenant_id, resultHash, result, JSON.stringify(result.files), signature(dispatched, resultHash, result.files)]);
    const saved = (await db.query<{ result_hash: string }>("SELECT result_hash FROM guild_web_audit_observations WHERE case_id=$1 AND tenant_id=$2", [row.id, row.tenant_id])).rows[0];
    if (!saved || saved.result_hash !== resultHash) fail("A different original browser result is already retained for this case.");
    await db.query("UPDATE guild_web_audit_cases SET state='received',original_failure_code=coalesce(original_failure_code,failure_code),failure_code=NULL,recovered_at=CASE WHEN $3 THEN coalesce(recovered_at,now()) ELSE recovered_at END,completed_at=coalesce(completed_at,now()),updated_at=now() WHERE id=$1 AND tenant_id=$2", [row.id, row.tenant_id, !!recovery]);
  });
  return readWebAuditCase(row.tenant_id, row.id);
}
