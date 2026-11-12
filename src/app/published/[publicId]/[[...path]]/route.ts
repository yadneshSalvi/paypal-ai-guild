import { publicExhibitionFailure, publicExhibitionResponse } from "@/server/web/publication-http";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
async function read(request: Request, { params }: { params: Promise<{ publicId: string; path?: string[] }> }) {
  try { const { publicId, path } = await params; return await publicExhibitionResponse(publicId, path, request); }
  catch (error) { return publicExhibitionFailure(error, request); }
}
export const GET = read;
export const HEAD = read;
