import { handleAgentAccessRead } from "@/server/provider-access/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) { return handleAgentAccessRead(request, "provider"); }
export const HEAD = GET;

