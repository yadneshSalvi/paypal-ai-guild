import { requireSession } from "@/server/session";
import { publicationEditionReceipt } from "@/server/web/publications";
import { publicationError, publicationJson } from "@/server/web/publication-api";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string; editionId: string }> }) {
  try {
    const { id, editionId } = await params, result = publicationJson(await publicationEditionReceipt(await requireSession(), id, editionId));
    result.headers.set("Content-Disposition", `attachment; filename="guild-publication-${editionId}.json"`); return result;
  } catch (error) { return publicationError(error); }
}
