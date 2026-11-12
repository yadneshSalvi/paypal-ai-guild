import {z} from "zod";
import {requireSession} from "@/server/session";
import {errorResponse} from "@/server/http";
import {webJobEvidence} from "@/server/web/evidence";
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){try{
  const id=z.string().uuid().parse((await params).id),value=await webJobEvidence(await requireSession(),id,new URL(request.url).searchParams.get("view")==="recovery");
  return Response.json(value,{headers:{"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff","Content-Disposition":`attachment; filename="guild-web-job-${id}.json"`}});
}catch(error){return errorResponse(error);}}
