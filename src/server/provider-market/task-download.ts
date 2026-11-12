import { z } from "zod";
import { canonical, DomainError } from "@/domain/primitives";
import { getPool, transaction } from "../db";
import { errorResponse } from "../http";
import type { MarketTaskRow } from "./delegation";
import { approvalBrowserSession, privateMcpResponse, requireConfiguredOrigin } from "./mcp-http";
import { authenticateProtocol } from "./protocol-auth";
import { boundProvider, requireMarketSession } from "./registry";
import { marketCommission, taskView } from "./snapshot";
import { boundTaskArtifact } from "./task-artifacts";

const id = z.string().uuid();
/** Export only the original output of one explicitly owned provider task.
 * Provider owners do not inherit access to the customer's other artifacts. */
export async function handleTaskArtifactDownload(request: Request, rawTaskId: unknown, rawArtifactId: unknown): Promise<Response> {
  try {
    requireConfiguredOrigin(request);
    const taskId = id.parse(rawTaskId), artifactId = id.parse(rawArtifactId), bearer = request.headers.has("authorization");
    const browser = bearer ? null : await approvalBrowserSession(request);
    const hint = (await getPool().query<MarketTaskRow>("SELECT * FROM guild_market_tasks WHERE id=$1", [taskId])).rows[0];
    const principal = bearer ? await authenticateProtocol(request, "a2a", hint?.provider_id ?? "unavailable") : null;
    const session = principal?.session ?? browser!;
    const result = await transaction(async db => {
      await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await requireMarketSession(db, session);
      const task = (await db.query<MarketTaskRow>("SELECT * FROM guild_market_tasks WHERE id=$1", [taskId])).rows[0];
      const provider = await boundProvider(db, session, false);
      const allowed = task && (principal ? task.tenant_id === session.tenantId && task.actor_id === session.id
        : session.role === "provider" ? provider === task.provider_id : ["owner", "judge", "operator"].includes(session.role) && session.tenantId === task.tenant_id);
      if (!allowed || !task) throw new DomainError("MARKET_ARTIFACT_NOT_FOUND", "This artifact is not available through an owned provider task.", 404, false);
      if (principal?.operation) {
        const op = (await db.query("SELECT id FROM guild_market_operations WHERE id=$1 AND tenant_id=$2 AND actor_id=$3 AND provider_id=$4 AND thread_id=$5 AND kind='delegate_task'",
          [principal.operation.operationId, task.tenant_id, session.id, task.provider_id, task.thread_id])).rows[0];
        if (principal.operation.mode !== "read" || !op) throw new DomainError("SERVICE_SCOPE", "This credential cannot export that original task's artifact.", 403, false);
      }
      const c = await marketCommission(db, task.tenant_id, task.commission_id), bound = await boundTaskArtifact(db, task, c);
      if (bound.withheld || !bound.artifact || bound.artifact.id !== artifactId) throw new DomainError("MARKET_ARTIFACT_BINDING", "This output does not bind the original task's exact artifact. It is withheld for integrity review.", 422, false);
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
  } catch (error) { return privateMcpResponse(errorResponse(error)); }
}
