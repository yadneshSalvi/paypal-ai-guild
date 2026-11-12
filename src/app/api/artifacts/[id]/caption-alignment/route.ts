import { z } from "zod";
import { requireSession } from "@/server/session";
import { captionAlignmentEvidence } from "@/server/captions/evidence";
import { errorResponse } from "@/server/http";
import { getArtifact } from "@/server/commissions";
import { deepgramCaptionAlignmentEvidence } from "@/server/captions/deepgram-evidence";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = z.string().uuid().parse((await params).id), runId = z.string().uuid().parse(new URL(request.url).searchParams.get("runId"));
    const session = await requireSession(), artifact = await getArtifact(session, id);
    const evidence = artifact.content.schemaVersion === "guild.captions.v3" ? await deepgramCaptionAlignmentEvidence(session, id, runId) : await captionAlignmentEvidence(session, id, runId);
    return Response.json(evidence, { headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": `attachment; filename="guild-caption-response-${runId}.json"` } });
  } catch (error) { return errorResponse(error); }
}
