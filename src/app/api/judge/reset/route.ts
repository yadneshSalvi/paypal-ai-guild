import { NextResponse } from "next/server";
import { rateLimit,requireSameOrigin,requireSession } from "@/server/session";
import { seedCommission } from "@/server/commissions";
import { workspace } from "@/server/workspace";
import { errorResponse } from "@/server/http";
export async function POST(request:Request){try{requireSameOrigin(request);const session=await requireSession();await rateLimit(`reset:${session.tenantId}`,10);await seedCommission(session);return NextResponse.json(await workspace(session));}catch(error){return errorResponse(error);}}
