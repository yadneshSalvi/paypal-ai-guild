import { handleAgentAccessCommandStatus } from "@/server/provider-access/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ commandId: string }> }) { return handleAgentAccessCommandStatus(request, "provider", (await context.params).commandId); }
export const HEAD = GET;

