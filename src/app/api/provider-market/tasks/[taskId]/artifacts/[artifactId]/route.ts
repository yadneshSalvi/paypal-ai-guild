import { handleTaskArtifactDownload } from "@/server/provider-market/task-download";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ taskId: string; artifactId: string }> }) {
  const { taskId, artifactId } = await context.params;
  return handleTaskArtifactDownload(request, taskId, artifactId);
}
export const HEAD = GET;
