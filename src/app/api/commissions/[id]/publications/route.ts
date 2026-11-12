import { requireSession } from "@/server/session";
import { publicationWorkspace } from "@/server/web/publications";
import { publicationError, publicationJson } from "@/server/web/publication-api";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { return publicationJson(await publicationWorkspace(await requireSession(), (await params).id)); }
  catch (error) { return publicationError(error); }
}
