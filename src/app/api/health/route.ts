import { NextResponse } from "next/server";
import { getPool } from "@/server/db";
export const dynamic="force-dynamic";
export async function GET(){try{await getPool().query("SELECT 1");return NextResponse.json({service:"guild",status:"ready",schema:"guild.v1",payments:"qualification_pending"});}catch{return NextResponse.json({service:"guild",status:"unavailable"},{status:503});}}
