import { handleInvitationPreview } from "@/server/provider-access/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) { return handleInvitationPreview(request, (await context.params).id); }
export const HEAD = GET;

