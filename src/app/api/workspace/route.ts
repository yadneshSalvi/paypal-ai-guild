import { after, NextResponse } from "next/server";
import { requireSession } from "@/server/session";
import { workspace } from "@/server/workspace";
import { errorResponse } from "@/server/http";
import { z } from "zod";
import { runNextJob } from "@/server/jobs";
export const dynamic="force-dynamic";
export const maxDuration=300;
export async function GET(request:Request){try{
  const requested=new URL(request.url).searchParams.get("commission"),session=await requireSession();
  const snapshot=await workspace(session,requested?z.string().uuid().parse(requested):undefined);
  if(snapshot.commission.jobs.some(job=>job.state==="queued"||job.state==="running"))after(async()=>{await runNextJob(session.tenantId);});
  return NextResponse.json(snapshot,{headers:{"Cache-Control":"private, no-store"}});
}catch(error){return errorResponse(error);}}
