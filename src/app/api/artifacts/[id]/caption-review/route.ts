import { z } from "zod";
import { locales } from "@/contracts/guild";
import { captionReviewCommandSchema } from "@/domain/caption-review";
import { DomainError } from "@/domain/primitives";
import { errorResponse, readJson } from "@/server/http";
import { requireSameOrigin, requireSession, rateLimit } from "@/server/session";
import { getPool } from "@/server/db";
import { captionReviewWorkspace, readCaptionReviewRevision, saveCaptionReview } from "@/server/captions/review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params, session = await requireSession(), url = new URL(request.url), locale = z.enum(locales).parse(url.searchParams.get("locale")), key = z.string().min(1).max(160).parse(url.searchParams.get("key"));
    const workspace = await captionReviewWorkspace(session, z.string().uuid().parse(id), locale, key);
    const revisionId = url.searchParams.get("revisionId"), download = url.searchParams.get("download");
    if (download) {
      if (!revisionId) throw new DomainError("CAPTION_REVIEW_REQUIRED", "Choose the exact saved revision to export.", 422, false);
      const revision = await readCaptionReviewRevision(getPool(), session.tenantId, z.string().uuid().parse(revisionId));
      if (revision.artifactId !== id || revision.locale !== locale || revision.key !== key) throw new DomainError("CAPTION_REVIEW_BINDING", "That revision belongs to a different original track.", 422, false);
      if (download === "vtt") {
        if (!revision.evaluation.vtt || revision.evaluation.status !== "ready-for-review") throw new DomainError("CAPTION_REVIEW_INCOMPLETE", "This draft has unresolved wording or timing. No complete VTT is inferred.", 422, false);
        return new Response(revision.evaluation.vtt, { headers: { "Content-Type": "text/vtt; charset=utf-8", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": `attachment; filename="guild-review-${locale}-${revision.id}.vtt"` } });
      }
      if (download !== "json") throw new DomainError("CAPTION_REVIEW_EXPORT", "Choose the saved JSON evidence or complete review VTT.", 400, false);
      return Response.json({ revision, source: workspace.source, provider: workspace.provider, rawBodyHash: workspace.rawBodyHash, productionAccepted: false }, { headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": `attachment; filename="guild-review-${revision.id}.json"` } });
    }
    return Response.json(workspace, { headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const session = await requireSession(), { id } = await context.params;
    await rateLimit(`caption-review:${session.tenantId}`, 600);
    const input = captionReviewCommandSchema.parse(await readJson(request, 512 * 1024));
    const revision = await saveCaptionReview(session, z.string().uuid().parse(id), input);
    return Response.json({ revision }, { headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (error) { return errorResponse(error); }
}
