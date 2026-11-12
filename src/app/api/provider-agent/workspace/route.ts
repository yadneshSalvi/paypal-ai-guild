import { handleProviderWorkspaceRead } from "@/server/provider-access/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) { return handleProviderWorkspaceRead(request, true); }
export const HEAD = GET;

