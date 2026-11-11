import { NextResponse } from "next/server";
import { z } from "zod";
import { readScheduleConversation } from "@/server/schedule-assistant";
import { errorResponse } from "@/server/http";
import { requireSession } from "@/server/session";
export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = new URL(request.url).searchParams.get("conversationId");
    return NextResponse.json(await readScheduleConversation(await requireSession(), z.string().uuid().parse((await params).id), id ? z.string().uuid().parse(id) : undefined), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}
