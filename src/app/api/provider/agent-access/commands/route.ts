import { handleAgentAccessCommand } from "@/server/provider-access/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function POST(request: Request) { return handleAgentAccessCommand(request, "provider"); }

