import { marketA2AResponse } from "@/server/provider-market/a2a-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function POST(request: Request, { params }: { params: Promise<{ providerId: string }> }) {
  return marketA2AResponse(request, (await params).providerId);
}
