import { z } from "zod";
import { requireSession } from "@/server/session";
import { artifactEvidence } from "@/server/artifact-evidence";
import { errorResponse } from "@/server/http";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = z.string().uuid().parse((await params).id), evidence = await artifactEvidence(await requireSession(), id);
    return Response.json(evidence, { headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": `attachment; filename="guild-evidence-${id}.json"` } });
  } catch (error) { return errorResponse(error); }
}
