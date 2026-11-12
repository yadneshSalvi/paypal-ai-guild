import { NextResponse } from "next/server";
import { anonymousBucket,currentSession,requireSameOrigin,SESSION_COOKIE } from "@/server/session";
import { workspace } from "@/server/workspace";
import { errorResponse,readJson } from "@/server/http";
import { sampleEntryRequestSchema } from "@/contracts/sample-entry";
import { DomainError } from "@/domain/primitives";
import { openSampleEntry,openSampleForSession } from "@/server/sample-entry";
export async function POST(request:Request){try{
  requireSameOrigin(request);
  const existing=await currentSession();if(existing&&!["owner","judge","operator"].includes(existing.role))throw new DomainError("ROLE_DENIED","Use your original customer workspace to open a commission.",403,false);
  const requestBody=sampleEntryRequestSchema.parse(await readJson(request,2048));
  if(existing){const result=await openSampleForSession(existing,requestBody);return NextResponse.json(await workspace(result.session,result.commissionId),{status:result.created?201:200});}
  const {session,cookie,commissionId,created}=await openSampleEntry(requestBody,`entry:${anonymousBucket(request)}`);const response=NextResponse.json(await workspace(session,commissionId),{status:created?201:200});
  response.cookies.set(SESSION_COOKIE,cookie,{httpOnly:true,secure:process.env.NODE_ENV==="production",sameSite:"lax",path:"/",expires:new Date(session.expiresAt)});return response;
}catch(error){return errorResponse(error);}}
