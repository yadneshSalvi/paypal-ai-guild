import { z } from "zod";
import { requireSession } from "@/server/session";
import { errorResponse } from "@/server/http";
import { webPortableZip } from "@/server/web/exports";

export const dynamic="force-dynamic";
export const maxDuration=300;
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){
  try{
    const id=z.string().uuid().parse((await params).id),query=new URL(request.url).searchParams.get("candidate"),ordinal=query===null?undefined:z.coerce.number().int().min(1).max(3).parse(query);
    const zip=await webPortableZip(await requireSession(),id,ordinal);
    return new Response(zip.stream,{headers:{"Content-Type":"application/zip","Content-Disposition":`attachment; filename="${zip.filename}"`,"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff","X-Guild-Bundle-Digest":zip.manifest.filesDigest}});
  }catch(error){return errorResponse(error);}
}
