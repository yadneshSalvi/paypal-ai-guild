import {z} from "zod";
import {requireSession} from "@/server/session";
import {errorResponse} from "@/server/http";
import {webAuditEvidence,webAuditFindings} from "@/server/web/evidence";
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){try{
  const id=z.string().uuid().parse((await params).id),query=new URL(request.url).searchParams,caseId=z.string().uuid().parse(query.get("caseId"));
  if(query.get("view")==="findings")return Response.json(await webAuditFindings(await requireSession(),id,caseId),{headers:{"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}});
  const value=await webAuditEvidence(await requireSession(),id,caseId,query.get("file")??undefined),headers={"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff","Content-Type":"application/json; charset=utf-8"};
  return value.kind==="file"?new Response(new Uint8Array(value.bytes),{headers:{...headers,"Content-Disposition":`attachment; filename="guild-browser-${caseId}-${value.path}"`,"X-Guild-Observation-State":value.state}}):Response.json(value.value,{headers:{...headers,"Content-Disposition":`attachment; filename="guild-browser-${caseId}-index.json"`}});
}catch(error){return errorResponse(error);}}
