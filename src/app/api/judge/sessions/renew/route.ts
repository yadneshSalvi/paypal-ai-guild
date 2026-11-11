import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { errorResponse, readJson } from "@/server/http";
import { rateLimit, requireSameOrigin, requireSession, SESSION_COOKIE } from "@/server/session";
import { renewWorkspace } from "@/server/session-renewal";

export async function POST(request:Request) { try {
  requireSameOrigin(request);
  const current=await requireSession();
  await rateLimit(`renew:${current.id}`,10);
  const cookie=(await cookies()).get(SESSION_COOKIE)?.value;
  const session=await renewWorkspace(cookie,await readJson(request,2048));
  const response=NextResponse.json({session,serverTime:new Date().toISOString()});
  response.cookies.set(SESSION_COOKIE,cookie!,{httpOnly:true,secure:process.env.NODE_ENV==="production",sameSite:"lax",path:"/",expires:new Date(session.expiresAt)});
  return response;
} catch(error) { return errorResponse(error); } }
