import { NextResponse } from "next/server";
import { checkoutConfiguration } from "@/server/payments/service";
import { requireSession } from "@/server/session";
import { errorResponse } from "@/server/http";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const config = await checkoutConfiguration(await requireSession());
    if (new URL(request.url).searchParams.get("reader") === "check") {
      const { createReadToolkit } = await import("@/server/payments/toolkit");
      const toolkit = createReadToolkit();
      return NextResponse.json({ ready: true, tools: toolkit.getTools().map(tool => tool.function.name), externalCalls: 0 }, { headers: { "Cache-Control": "private, no-store" } });
    }
    return NextResponse.json(config, { headers: { "Cache-Control": "private, no-store" } });
  }
  catch (error) { return errorResponse(error); }
}
