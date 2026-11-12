import { requireSameOrigin, requireSession } from "@/server/session";
import { readJson } from "@/server/http";
import { publishExhibition } from "@/server/web/publications";
import { publicationError, publicationJson } from "@/server/web/publication-api";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { requireSameOrigin(request); return publicationJson(await publishExhibition(await requireSession(), (await params).id, await readJson(request))); }
  catch (error) { return publicationError(error); }
}
