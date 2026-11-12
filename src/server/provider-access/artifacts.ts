import { canonical, DomainError } from "@/domain/primitives";
import { transaction } from "../db";
import type { Session } from "../session";
import type { MarketTaskRow } from "../provider-market/delegation";
import { privateMcpResponse } from "../provider-market/mcp-http";
import { marketCommission, taskView } from "../provider-market/snapshot";
import { boundTaskArtifact } from "../provider-market/task-artifacts";
import { requireAccessActor } from "./identity";

/** Separate provider route, same exact task/artifact integrity boundary. */
export async function providerArtifactResponse(request: Request, session: Session, taskId: string, artifactId: string): Promise<Response> {
  const result = await transaction(async db => {
    await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const actor = await requireAccessActor(db, session, "provider");
    const task = (await db.query<MarketTaskRow>("SELECT * FROM guild_market_tasks WHERE id=$1 AND provider_id=$2", [taskId, actor.provider!.id])).rows[0];
    if (!task) throw new DomainError("MARKET_ARTIFACT_NOT_FOUND", "This artifact is not available through an owned provider task.", 404, false);
    const c = await marketCommission(db, task.tenant_id, task.commission_id), bound = await boundTaskArtifact(db, task, c);
    if (bound.withheld || !bound.artifact || bound.artifact.id !== artifactId) {
      throw new DomainError("MARKET_ARTIFACT_BINDING", "This output does not bind the original task's exact artifact. It is withheld for integrity review.", 422, false);
    }
    const view = await taskView(db, task, c, false);
    return { version: "guild.provider-task-artifact.v1", taskId: task.id, originalJobId: task.original_job_id,
      binding: task.binding, bindingDigest: task.binding_digest, artifact: bound.artifact,
      verification: view.artifacts[0]!.verification, acceptance: view.acceptance, payment: view.payment,
      disclosure: "The exact retained artifact and its separate verification, acceptance and payment records. A completed task does not establish customer acceptance or payout." };
  });
  const body = canonical(result);
  return privateMcpResponse(new Response(request.method === "HEAD" ? null : body, { headers: {
    "Content-Type": "application/json; charset=utf-8", "Content-Length": String(Buffer.byteLength(body)),
    "Content-Disposition": `attachment; filename="guild-task-${taskId}-${result.artifact.contentHash.slice(0, 12)}.json"`,
  } }));
}
