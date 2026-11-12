import { handleApprovalLinkConsume } from "@/server/provider-market/mcp-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return handleApprovalLinkConsume(request, (await context.params).id);
}
