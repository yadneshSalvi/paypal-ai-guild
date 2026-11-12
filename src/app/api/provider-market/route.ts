import { z } from "zod";
import { getPool } from "@/server/db";
import { errorResponse } from "@/server/http";
import { privateMcpResponse } from "@/server/provider-market/mcp-http";
import { marketSnapshot } from "@/server/provider-market/snapshot";
import { requireSession } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Reading the exchange does not dispatch a worker, provider or discovery. */
export async function GET(request: Request) {
  try {
    const session = await requireSession(), value = new URL(request.url).searchParams.get("commission");
    const commissionId = value ? z.string().uuid().parse(value) : undefined;
    return privateMcpResponse(Response.json(await marketSnapshot(getPool(), session, commissionId)));
  } catch (error) { return privateMcpResponse(errorResponse(error)); }
}
