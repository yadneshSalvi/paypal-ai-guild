import { z } from "zod";
import { errorResponse } from "@/server/http";
import { requireSession } from "@/server/session";
import { deepgramCaptionJobEvidence } from "@/server/captions/deepgram-evidence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(), { id } = await context.params, url = new URL(request.url);
    const commissionId = z.string().uuid().parse(id), jobId = z.string().uuid().parse(url.searchParams.get("jobId")), runId = url.searchParams.get("runId");
    const result = await deepgramCaptionJobEvidence(session, commissionId, jobId, runId ? z.string().uuid().parse(runId) : undefined);
    return Response.json(result, { headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": `attachment; filename="guild-caption-operations-${runId ?? jobId}.json"` } });
  } catch (error) { return errorResponse(error); }
}
