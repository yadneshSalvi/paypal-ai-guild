import { marketAgentCardResponse } from "@/server/provider-market/a2a-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, { params }: { params: Promise<{ providerId: string }> }) {
  return marketAgentCardResponse((await params).providerId);
}
