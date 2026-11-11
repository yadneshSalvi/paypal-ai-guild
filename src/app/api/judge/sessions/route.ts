import { NextResponse } from "next/server";
import { anonymousBucket,createSession,currentSession,rateLimit,requireSameOrigin,SESSION_COOKIE } from "@/server/session";
import { workspace } from "@/server/workspace";
import { errorResponse } from "@/server/http";
export async function POST(request:Request){try{
  requireSameOrigin(request);await rateLimit(`entry:${anonymousBucket(request)}`,20);
  const existing=await currentSession();if(existing)return NextResponse.json(await workspace(existing));
  const {session,cookie}=await createSession();const response=NextResponse.json(await workspace(session),{status:201});
  response.cookies.set(SESSION_COOKIE,cookie,{httpOnly:true,secure:process.env.NODE_ENV==="production",sameSite:"lax",path:"/",expires:new Date(session.expiresAt)});return response;
}catch(error){return errorResponse(error);}}
