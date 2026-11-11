import { NextResponse } from "next/server";
import { z } from "zod";
import { startAssistantSchema } from "@/scheduling/assistant";
import { readScheduleAssistant, startScheduleAssistant } from "@/server/schedule-assistant";
import { errorResponse, readJson } from "@/server/http";
import { rateLimit, requireSameOrigin, requireSession } from "@/server/session";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const query = new URL(request.url).searchParams, id = query.get("runId"), requestId = query.get("requestId"), before = query.get("before");
    const selector = id || requestId || before ? z.strictObject({ id: z.string().uuid().optional(), requestId: z.string().uuid().optional(), before: z.string().uuid().optional() }).refine(value => Object.keys(value).length === 1).parse({ ...(id ? { id } : {}), ...(requestId ? { requestId } : {}), ...(before ? { before } : {}) }) : undefined;
    return NextResponse.json(await readScheduleAssistant(await requireSession(), z.string().uuid().parse((await params).id), selector), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request); const session = await requireSession(); await rateLimit(`schedule-ai:${session.tenantId}`, 30);
    return NextResponse.json(await startScheduleAssistant(session, z.string().uuid().parse((await params).id), startAssistantSchema.parse(await readJson(request, 262144))));
  } catch (error) { return errorResponse(error); }
}
