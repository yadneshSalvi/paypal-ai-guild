import { randomUUID } from "node:crypto";
import type { Commission } from "@/contracts/guild";
import { normalizePayments } from "@/domain/payments";
import { digest, DomainError } from "@/domain/primitives";
import { appendEvent, getCommission, saveCommission } from "@/server/commissions";
import { getPool, transaction } from "@/server/db";
import type { Session } from "@/server/session";
import { projectPayments } from "./projection";
import type { PaymentRuntime } from "./runtime";

/** Commit admission before loading external modules, model selection or provider transport. */
export async function inspectOwnedOrder(session: Session, commissionId: string, runtime: PaymentRuntime): Promise<void> {
  if (!["judge", "owner", "operator"].includes(session.role)) throw new DomainError("PAYMENT_ROLE", "Payment evidence belongs to the commission's curator.", 403, false);
  await getCommission(session, commissionId);
  const admission = await transaction(async db => {
    const c = (await db.query<{ snapshot: Commission }>("SELECT snapshot FROM guild_commissions WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [session.tenantId, commissionId])).rows[0]!.snapshot;
    const owned = (await db.query<{ resource_id: string }>("SELECT resource_id FROM guild_payment_resources WHERE tenant_id=$1 AND commission_id=$2 AND kind='order' ORDER BY observed_at DESC LIMIT 1", [session.tenantId, c.id])).rows[0];
    if (!owned) throw new DomainError("ORDER_REQUIRED", "Create a PayPal checkout before asking the read agent to inspect its order.", 422);
    await db.query("UPDATE guild_payment_tool_runs SET state='failed',failure_code='READ_INTERRUPTED',updated_at=now() WHERE tenant_id=$1 AND commission_id=$2 AND state='running' AND created_at<now()-interval '6 minutes'", [session.tenantId, c.id]);
    const running = (await db.query("SELECT id FROM guild_payment_tool_runs WHERE tenant_id=$1 AND commission_id=$2 AND resource_id=$3 AND tool='get_order' AND state='running'", [session.tenantId, c.id, owned.resource_id])).rows[0];
    if (running) return null;
    const id = randomUUID();
    await db.query("INSERT INTO guild_payment_tool_runs(id,tenant_id,commission_id,tool,resource_id,evidence,state,input_hash) VALUES($1,$2,$3,'get_order',$4,'{}','running',$5)", [id, c.tenantId, c.id, owned.resource_id, digest({ model: process.env.OPENAI_MODEL, orderId: owned.resource_id, tool: "get_order", prompt: "guild.payment_reader.v1" })]);
    return { id, orderId: owned.resource_id };
  });
  if (!admission) return;
  try {
    await projectPayments(session.tenantId, commissionId, runtime);
    const { createReadToolkit, chooseReadTool, invokeOwnedOrderTool, normalizeOrderEvidence } = await import("./toolkit");
    const toolkit = createReadToolkit();
    const selected = await chooseReadTool(toolkit, admission.orderId);
    await getPool().query("UPDATE guild_payment_tool_runs SET model_response_id=$2,updated_at=now() WHERE id=$1", [admission.id, selected.responseId]);
    const raw = await invokeOwnedOrderTool(toolkit, selected.call, admission.orderId);
    const evidence = normalizeOrderEvidence(raw, admission.orderId, admission.id, selected.model);
    await transaction(async db => {
      const current = (await db.query<{ snapshot: Commission }>("SELECT snapshot FROM guild_commissions WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [commissionId, session.tenantId])).rows[0]!.snapshot;
      await db.query("UPDATE guild_payment_tool_runs SET evidence=$2,state='completed',failure_code=NULL,updated_at=now() WHERE id=$1", [admission.id, evidence]);
      normalizePayments(current).toolEvidence.push(evidence);
      appendEvent(current, "payment.toolkit_read", "The read agent checked PayPal", `get_order returned ${evidence.status}. ${evidence.captures.length} capture record${evidence.captures.length === 1 ? "" : "s"} are attached as read evidence.`, "Payment evidence agent", null, evidence.provenance);
      const agent = current.agents.find(a => a.id === "settlement");
      if (agent) { agent.summary = "Read the owned PayPal order through the Agent Toolkit."; for (const tool of agent.tools) if (tool.name === "get_order") tool.used = true; }
      current.revision++; await saveCommission(db, current);
    });
  } catch (error) {
    await getPool().query("UPDATE guild_payment_tool_runs SET state='failed',failure_code=$2,updated_at=now() WHERE id=$1", [admission.id, error instanceof DomainError ? error.code : "TOOLKIT_READ_FAILED"]);
    if (error instanceof DomainError) throw error;
    throw new DomainError("TOOLKIT_READ_FAILED", "The read agent could not finish. Its failed attempt is saved; no payment mutation was requested.", 503);
  } finally { await projectPayments(session.tenantId, commissionId, runtime); }
}
