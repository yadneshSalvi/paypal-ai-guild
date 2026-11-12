import { after,NextResponse } from "next/server";
import { z } from "zod";
import { commissionCommandSchema } from "@/contracts/guild";
import { executeCommand } from "@/server/commissions";
import { errorResponse,readJson } from "@/server/http";
import { rateLimit,requireSameOrigin,requireSession } from "@/server/session";
import { runNextJob } from "@/server/jobs";
export const runtime="nodejs";
export const maxDuration=800;
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){try{
  requireSameOrigin(request);const session=await requireSession();const id=z.string().uuid().parse((await params).id);
  const command=commissionCommandSchema.parse(await readJson(request));await rateLimit(`commands:${session.tenantId}`,300);
  if(["produce_package","compile_brief"].includes(command.type))await rateLimit(`generation:${session.tenantId}`,32,480);
  const result=await executeCommand(session,id,command);
  if(result.ok&&result.jobId)after(async()=>{await runNextJob(session.tenantId);});
  return NextResponse.json(result,{status:result.ok?200:409});
}catch(error){return errorResponse(error);}}
