import { handleProviderArtifact } from "@/server/provider-access/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ taskId: string; artifactId: string }> }) { const { taskId, artifactId } = await context.params; return handleProviderArtifact(request, taskId, artifactId, true); }
export const HEAD = GET;

