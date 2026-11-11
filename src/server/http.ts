import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { DomainError } from "@/domain/primitives";

export function errorResponse(error:unknown):NextResponse {
  if(error instanceof DomainError)return NextResponse.json({ok:false,code:error.code,message:error.message,recoverable:error.recoverable,currentRevision:null},{status:error.status});
  if(error instanceof ZodError)return NextResponse.json({ok:false,code:"INVALID_INPUT",message:"Please check the form fields and try again.",recoverable:true,currentRevision:null},{status:400});
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : undefined;
  console.error("guild.request_failed", {name:error instanceof Error?error.name:"Unknown",code,frames:error instanceof Error?error.stack?.split("\n").filter(line=>/^\s+at\s/.test(line)).slice(0,5):undefined});
  return NextResponse.json({ok:false,code:"UNAVAILABLE",message:"Guild could not finish that action. Your confirmed work is safe; please try again.",recoverable:true,currentRevision:null},{status:503});
}
export async function readJson(request:Request,maxBytes=32768):Promise<unknown>{
  if(Number(request.headers.get("content-length")??0)>maxBytes)throw new DomainError("BODY_TOO_LARGE","This request is too large.",413,false);
  const reader=request.body?.getReader();if(!reader)throw new DomainError("BODY_REQUIRED","A request body is required.",400,false);
  const chunks:Uint8Array[]=[];let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes){await reader.cancel();throw new DomainError("BODY_TOO_LARGE","This request is too large.",413,false);}chunks.push(value);}
  try{return JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{throw new DomainError("INVALID_JSON","The request could not be read.",400,false);}
}
