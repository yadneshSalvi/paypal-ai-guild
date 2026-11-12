import { digest, DomainError } from "@/domain/primitives";
import { getPool, transaction } from "../db";
import { readWebAuditCase, retainWebAuditFiles, saveWebAuditObservation, type WebAuditRow } from "./audit-store";
import { WebAuditAttemptError } from "./audit-gateway";
import { HostedWebAuditGateway } from "./hosted-gateway";

/** Historical result collection is deliberately independent of runNextJob's
 * current authority gates. It cannot requeue a job, change a deadline, accept an
 * artifact, or call the new-attempt gateway method. */
export async function recoverOriginalHostedWebAudit(tenantId: string, caseId: string, gateway: Pick<HostedWebAuditGateway, "recover"> = new HostedWebAuditGateway()) {
  const row = (await getPool().query<WebAuditRow>("SELECT * FROM guild_web_audit_cases WHERE tenant_id=$1 AND id=$2", [tenantId, caseId])).rows[0];
  if (!row || !row.dispatched_at || row.request_hash !== digest(row.request) || !["dispatching", "indeterminate", "received"].includes(row.state))
    throw new DomainError("WEB_HOSTED_ORIGINAL_REQUIRED", "Read-only recovery needs this workspace's original dispatched hosted browser case.", 404, false);
  if (row.state === "dispatching" && (await getPool().query("SELECT id FROM guild_jobs WHERE tenant_id=$1 AND id=$2 AND state='running' AND lease_until>now()", [tenantId, row.job_id])).rowCount)
    throw new DomainError("WEB_HOSTED_BROWSER_PENDING", "The original worker still owns this browser case. Its result remains pending; recovery cannot overtake active work.", 409, false);
  try {
    const original = await gateway.recover(row);
    const receipt = await saveWebAuditObservation(row, original.result, original.files, original.recovery);
    await original.afterSave?.().catch(() => undefined);
    return { version: "guild.web-hosted-recovery.v1", caseId, jobId: row.job_id, state: "received" as const, receipt,
      disclosure: "The exact original browser observation was retained. No new browser, production, acceptance, publication, payment or authority renewal was dispatched." };
  } catch (error) {
    if (error instanceof WebAuditAttemptError) {
      await transaction(async db => {
        const current = (await db.query<WebAuditRow>("SELECT * FROM guild_web_audit_cases WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [tenantId, caseId])).rows[0];
        if (!current || current.request_hash !== row.request_hash || current.dispatched_at?.toISOString() !== row.dispatched_at?.toISOString()) throw new DomainError("WEB_HOSTED_IDENTITY_CHANGED", "The original browser dispatch changed while its historical result was read.", 422, false);
        await retainWebAuditFiles(db, current, error.files);
        await db.query("UPDATE guild_web_audit_cases SET state='indeterminate',failure_code=$1,original_failure_code=coalesce(original_failure_code,failure_code,$1),updated_at=now() WHERE tenant_id=$2 AND id=$3 AND state IN ('dispatching','indeterminate')", [error.code, tenantId, caseId]);
      });
      throw new DomainError(error.code, error.message, 422, false);
    }
    throw error;
  }
}
/** At most one original read per continuation; no new worker lease is claimed.
 * Unknown creation/command IDs require deliberate owned investigation and never
 * become a replacement create or browser command in this recovery queue. */
export async function recoverNextOriginalHostedWebAudit() {
  const row = (await getPool().query<{ tenant_id: string; case_id: string }>("SELECT h.tenant_id,h.case_id FROM guild_web_hosted_attempts h JOIN guild_web_audit_cases a ON a.id=h.case_id AND a.tenant_id=h.tenant_id JOIN guild_jobs j ON j.id=h.job_id AND j.tenant_id=h.tenant_id WHERE h.original_command_id IS NOT NULL AND a.state IN ('dispatching','indeterminate') AND (a.state='indeterminate' OR j.state<>'running' OR j.lease_until<now()) AND h.updated_at<now()-interval '30 seconds' ORDER BY h.updated_at,h.case_id LIMIT 1")).rows[0];
  if (!row) return null;
  try { const result = await recoverOriginalHostedWebAudit(row.tenant_id, row.case_id); return { caseId: row.case_id, state: result.state }; }
  catch (error) { return { caseId: row.case_id, state: "held", code: error instanceof DomainError ? error.code : "WEB_HOSTED_READ_UNKNOWN" }; }
}
