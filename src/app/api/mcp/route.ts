import { handleGuildMcpHttp } from "@/server/provider-market/mcp";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = handleGuildMcpHttp;
export const GET = handleGuildMcpHttp;
export const DELETE = handleGuildMcpHttp;
