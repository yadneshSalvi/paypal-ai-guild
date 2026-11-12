import { z } from "zod";
import { errorResponse, readJson } from "@/server/http";
import { requireSameOrigin, requireSession, rateLimit } from "@/server/session";
import { ownedWebJob } from "@/server/web/evidence";
import { recoverOriginalHostedWebAudit } from "@/server/web/hosted-recovery";
import { getPool } from "@/server/db";
import { DomainError } from "@/domain/primitives";

export const runtime = "nodejs";
export const maxDuration = 300;
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const session = await requireSession(), jobId = z.string().uuid().parse((await params).id);
    const input = z.object({ caseId: z.string().uuid() }).strict().parse(await readJson(request, 1024));
    await ownedWebJob(session, jobId);
    const owned = await getPool().query("SELECT id FROM guild_web_audit_cases WHERE tenant_id=$1 AND job_id=$2 AND id=$3", [session.tenantId, jobId, input.caseId]);
    if (!owned.rowCount) throw new DomainError("WEB_CASE_NOT_FOUND", "That original browser case is not part of this workspace's exact web job.", 404, false);
    await rateLimit(`hosted-browser-original-read:${session.tenantId}`, 60);
    return Response.json(await recoverOriginalHostedWebAudit(session.tenantId, input.caseId), { headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (error) { return errorResponse(error); }
}
