import { NextResponse } from "next/server";
import { createCommissionSchema } from "@/contracts/guild";
import { createCommission,latestCommission } from "@/server/commissions";
import { errorResponse,readJson } from "@/server/http";
import { requireSameOrigin,requireSession,rateLimit } from "@/server/session";
import { workspace } from "@/server/workspace";
export async function POST(request:Request){try{requireSameOrigin(request);const session=await requireSession();await rateLimit(`create:${session.tenantId}`,10);const input=createCommissionSchema.parse(await readJson(request));await createCommission(session,input,(await latestCommission(session))?.sourceAssets??[]);return NextResponse.json(await workspace(session),{status:201});}catch(error){return errorResponse(error);}}
