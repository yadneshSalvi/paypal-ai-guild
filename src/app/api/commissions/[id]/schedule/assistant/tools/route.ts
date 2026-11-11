import { NextResponse } from "next/server";
import { z } from "zod";
import { assistantToolCommandSchema } from "@/scheduling/assistant";
import { executeScheduleAssistantTool } from "@/server/schedule-assistant";
import { errorResponse, readJson } from "@/server/http";
import { rateLimit, requireSameOrigin, requireSession } from "@/server/session";
export const dynamic = "force-dynamic";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request); const session = await requireSession(); await rateLimit(`schedule-ai-tools:${session.tenantId}`, 90);
    return NextResponse.json(await executeScheduleAssistantTool(session, z.string().uuid().parse((await params).id), assistantToolCommandSchema.parse(await readJson(request))));
  } catch (error) { return errorResponse(error); }
}
