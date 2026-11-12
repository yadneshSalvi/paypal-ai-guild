import { z } from "zod";
import { requireSession } from "@/server/session";
import { errorResponse } from "@/server/http";
import { DomainError } from "@/domain/primitives";
import { webExportBundle, webFileResponse } from "@/server/web/exports";

export const dynamic="force-dynamic";
export const maxDuration=60;
export async function GET(request:Request,{params}:{params:Promise<{id:string;path:string[]}>}){
  try{
    const input=await params,id=z.string().uuid().parse(input.id),[ordinal,...parts]=input.path;
    if(!/^[1-3]$/.test(ordinal??"")||!parts.length)throw new DomainError("WEB_FILE_NOT_FOUND","Choose a retained exhibition design and its exact original file.",404,false);
    const filePath=parts.join("/"),bundle=await webExportBundle(await requireSession(),id,Number(ordinal)),file=bundle.manifest.files.find(item=>item.path===filePath);
    if(!file)throw new DomainError("WEB_FILE_NOT_FOUND","That file is not in this exact portable exhibition.",404,false);
    return webFileResponse(file,await bundle.read(file),request);
  }catch(error){return errorResponse(error);}
}
