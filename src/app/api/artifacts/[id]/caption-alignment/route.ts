import { z } from "zod";
import { requireSession } from "@/server/session";
import { captionAlignmentEvidence } from "@/server/captions/evidence";
import { errorResponse } from "@/server/http";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = z.string().uuid().parse((await params).id), runId = z.string().uuid().parse(new URL(request.url).searchParams.get("runId"));
    const evidence = await captionAlignmentEvidence(await requireSession(), id, runId);
    return Response.json(evidence, { headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": `attachment; filename="guild-caption-response-${runId}.json"` } });
  } catch (error) { return errorResponse(error); }
}
