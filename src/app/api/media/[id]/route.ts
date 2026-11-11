import { z } from "zod";
import { requireSession } from "@/server/session";
import { errorResponse } from "@/server/http";
import { privateMediaResponse, readOwnedMedia } from "@/server/media/objects";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(), id = z.string().uuid().parse((await params).id);
    const file = await readOwnedMedia(session.tenantId, id);
    return privateMediaResponse(file.row, file.bytes, request);
  } catch (error) { return errorResponse(error); }
}
