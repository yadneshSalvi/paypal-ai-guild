import { providerMarketCommandSchema } from "@/contracts/provider-market";
import { DomainError } from "@/domain/primitives";
import { errorResponse, readJson } from "@/server/http";
import { executeProviderMarketCommand } from "@/server/provider-market/commands";
import { privateMcpResponse, requireConfiguredOrigin } from "@/server/provider-market/mcp-http";
import { rateLimit, requireSession } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function POST(request: Request) {
  try {
    requireConfiguredOrigin(request, true);
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new DomainError("MARKET_BODY_TYPE", "This decision requires its original JSON request.", 415, false);
    const session = await requireSession(), command = providerMarketCommandSchema.parse(await readJson(request, 32_768));
    await rateLimit(`provider-market:${session.id}`, 300);
    const result = await executeProviderMarketCommand(session, command);
    return privateMcpResponse(Response.json(result, { status: result.ok ? 200 : result.error.unknownOutcome ? 202 : 409 }));
  } catch (error) { return privateMcpResponse(errorResponse(error)); }
}
