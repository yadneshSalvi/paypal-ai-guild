import { z } from "zod";
import { requireSession } from "@/server/session";
import { getArtifact } from "@/server/commissions";
import { errorResponse } from "@/server/http";
export async function GET(_request:Request,{params}:{params:Promise<{id:string}>}){try{
  const artifact=await getArtifact(await requireSession(),z.string().uuid().parse((await params).id));
  return new Response(JSON.stringify({manifest:{...artifact,content:undefined},content:artifact.content},null,2),{headers:{"Content-Type":"application/json; charset=utf-8","Content-Disposition":`attachment; filename="guild-${artifact.packageId}-${artifact.contentHash.slice(0,12)}.json"`,"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}});
}catch(error){return errorResponse(error);}}
