import { NextResponse } from "next/server";
import { z } from "zod";
import { scheduleCommandSchema } from "@/scheduling/persisted";
import { executeScheduleCommand, schedulingWorkspace } from "@/server/scheduling";
import { errorResponse, readJson } from "@/server/http";
import { rateLimit, requireSameOrigin, requireSession } from "@/server/session";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { return NextResponse.json(await schedulingWorkspace(await requireSession(), z.string().uuid().parse((await params).id)), { headers: { "Cache-Control": "private, no-store" } }); }
  catch (error) { return errorResponse(error); }
}
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request); const session = await requireSession();
    await rateLimit(`schedule:${session.tenantId}`, 90);
    return NextResponse.json(await executeScheduleCommand(session, z.string().uuid().parse((await params).id), scheduleCommandSchema.parse(await readJson(request))));
  } catch (error) { return errorResponse(error); }
}
