import type { Pool, PoolClient } from "pg";
import { assistantToolSchemas, startAssistantSchema, type AssistantCompletion, type AssistantToolName, type StartAssistant } from "@/scheduling/assistant";
import { digest, DomainError } from "@/domain/primitives";
import { savedScheduleConversation } from "./schedule-conversation";

type Db = Pool | PoolClient;
interface Run {
  id: string; request_id: string; state: string; request_hash: string; request_intent: StartAssistant | null;
  request_body: { input: Record<string, unknown>[] }; canonical_input_hash: string | null;
  result: AssistantCompletion | null;
}
interface Tool { id: string; run_id: string; call_id: string; name: string; args_hash: string; result: { ok: boolean; evidenceId: string; name: string } | null; completed_at: Date | null }
function fail(code: string, message: string): never { throw new DomainError(code, message, 409, false); }

/** Client text is accepted only as a new user turn. All earlier assistant calls
 * and tool results come from exact server records, never a browser transcript. */
export async function canonicalPlanningInput(db: Db, tenantId: string, commissionId: string, command: StartAssistant) {
  const runs = (await db.query<Run>("SELECT id,request_id,state,request_hash,request_intent,request_body,canonical_input_hash,result FROM guild_schedule_ai_runs WHERE tenant_id=$1 AND commission_id=$2 AND conversation_id=$3 ORDER BY created_at,id LIMIT 24", [tenantId, commissionId, command.conversationId])).rows;
  const previous = runs.at(-1);
  if ((previous?.id ?? null) !== command.afterRunId) fail("ASSISTANT_PARENT_CHANGED", "The conversation changed. Read its latest saved response before adding a turn.");
  if (runs.some(run => !run.request_intent)) fail("ASSISTANT_LEGACY_REVIEW", "This earlier conversation is retained for review. Start a new conversation with an explicit user message; its old tools will not be replayed.");
  const restored = await savedScheduleConversation(db, tenantId, commissionId, command.conversationId);
  const rows = runs.length ? (await db.query<Tool>("SELECT id,run_id,call_id,name,args_hash,result,completed_at FROM guild_schedule_ai_tool_results WHERE tenant_id=$1 AND commission_id=$2 AND run_id=ANY($3::uuid[]) ORDER BY created_at,id", [tenantId, commissionId, runs.map(run => run.id)])).rows : [];
  function resultFor(run: Run, call: NonNullable<AssistantCompletion["choices"][0]["message"]["tool_calls"]>[number]) {
    let args: unknown;
    try {
      if (!Object.hasOwn(assistantToolSchemas, call.function.name)) throw new Error("Unknown saved tool");
      args = assistantToolSchemas[call.function.name].parse(JSON.parse(call.function.arguments));
    } catch { fail("ASSISTANT_SAVED_CALL_CHANGED", "The saved assistant call no longer matches the supported contract."); }
    const row = rows.find(item => item.run_id === run.id && item.call_id === call.id && item.name === call.function.name && item.args_hash === digest(args));
    if (!row?.completed_at || !row.result || typeof row.result.ok !== "boolean" || row.result.evidenceId !== row.id || row.result.name !== call.function.name) fail("ASSISTANT_TOOL_RESULT_REQUIRED", "Every pending tool needs its exact saved server result before the conversation can continue.");
    return row.result;
  }
  const input: Record<string, unknown>[] = [];
  function appendTurn(prior: Run | undefined, turn: StartAssistant["turn"]) {
    const message = prior?.result?.choices[0].message, calls = message?.tool_calls ?? [];
    const asking = calls.length === 1 && calls[0]!.function.name === "askUser";
    if (turn.type === "continue") {
      if (!prior || prior.state !== "completed" || !calls.length || asking
        || digest(turn.callIds) !== digest(calls.map(call => call.id))) fail("ASSISTANT_CALL_SEQUENCE", "Continue only the exact pending calls, in their original order. Added, omitted or reordered calls were not dispatched.");
      if (message?.content) input.push({ role: "assistant", content: message.content });
      for (const call of calls) input.push({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments });
      for (const call of calls) input.push({ type: "function_call_output", call_id: call.id, output: JSON.stringify(resultFor(prior, call)) });
    } else {
      if (calls.length && !asking) fail("ASSISTANT_TOOL_CONTINUATION_REQUIRED", "The preceding response has pending tools. Their saved results must be resolved before a new user turn.");
      if (asking) {
        resultFor(prior!, calls[0]!);
        const args = assistantToolSchemas.askUser.parse(JSON.parse(calls[0]!.function.arguments));
        input.push({ role: "assistant", content: [message?.content, args.question].filter(Boolean).join("\n\n") });
      } else if (message?.content) input.push({ role: "assistant", content: message.content });
      input.push({ role: "user", content: turn.text });
    }
  }
  // Rebuild every prior turn from its immutable intent, actual response and
  // matching tool rows. A copied transcript hash alone is not a tool receipt.
  for (const [index, run] of runs.entries()) {
    const parsed = startAssistantSchema.safeParse(run.request_intent), prior = runs[index - 1];
    if (!parsed.success || parsed.data.requestId !== run.request_id || parsed.data.conversationId !== command.conversationId
      || parsed.data.afterRunId !== (prior?.id ?? null) || run.request_hash !== digest({ commissionId, command: parsed.data })
      || !Array.isArray(run.request_body.input) || run.canonical_input_hash !== digest(run.request_body.input)) fail("ASSISTANT_SAVED_HISTORY_CHANGED", "The saved canonical conversation no longer matches its recorded input. Its original evidence needs review.");
    appendTurn(prior, parsed.data.turn);
    if (digest(run.request_body.input.filter(item => item.role !== "developer")) !== digest(input)) fail("ASSISTANT_SAVED_HISTORY_CHANGED", "The saved conversation differs from its exact response and tool history. No replacement request was sent.");
  }
  appendTurn(previous, command.turn);
  if (!input.some(item => item.role === "user") || input.length > 120 || Buffer.byteLength(JSON.stringify(input)) > 512 * 1024) fail("ASSISTANT_CONTEXT_LIMIT", "This saved conversation needs a new explicit user conversation before another request. Its full evidence stays retained.");
  const activePlan = !!previous?.request_intent && restored.plan && restored.plan.steps.some(step => !step.completed);
  const allowed = new Set<AssistantToolName>(["getOpeningPlan", "compareRecoveryQuotes", "proposeOpeningChange", "askUser", activePlan ? "completePlanSteps" : "createPlan"]);
  if (command.toolNames.some(name => !allowed.has(name))) fail("ASSISTANT_PLAN_PHASE", "The requested tool set does not match the saved plan phase.");
  return input;
}
