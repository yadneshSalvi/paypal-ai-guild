import { handleInvitationClaim } from "@/server/provider-access/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) { return handleInvitationClaim(request, (await context.params).id); }

