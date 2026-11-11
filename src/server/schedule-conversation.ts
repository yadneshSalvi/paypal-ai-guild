import type { Pool, PoolClient } from "pg";
import { assistantToolSchemas, nativeStepEvidence, startAssistantSchema, type AssistantCompletion, type AssistantRunView, type SavedAssistantConversation, type StartAssistant } from "@/scheduling/assistant";
import { digest } from "@/domain/primitives";

type Db = Pool | PoolClient;
interface Input { type?: string; role?: string; content?: string; call_id?: string; output?: string }
interface Run { id: string; request_id: string; conversation_id: string; state: AssistantRunView["state"]; request_body: { input: Input[] }; request_intent: StartAssistant | null; result: AssistantCompletion | null; created_at: Date }
interface Tool { id: string; run_id: string; call_id: string; name: string; args_hash: string; result: { ok?: boolean; evidenceId?: string; name?: string } | null; completed_at: Date | null }

/** Read-only projection of saved responses and actual server tools. Never polls or executes a tool. */
export async function savedScheduleConversation(db: Db, tenantId: string, commissionId: string, conversationId?: string): Promise<SavedAssistantConversation> {
  const selected = conversationId ?? (await db.query<{ conversation_id: string }>("SELECT conversation_id FROM guild_schedule_ai_runs WHERE tenant_id=$1 AND commission_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1", [tenantId, commissionId])).rows[0]?.conversation_id;
  const empty: SavedAssistantConversation = { schemaVersion: "guild.saved-planning-conversation.v1", requestContract: "canonical", conversationId: selected ?? null, runs: 0, latestRunId: null, latestRequestId: null, pending: false, canAddTurn: true, messages: [], plan: null, evidence: [], notice: "New planning conversation. Proposals need your separate review and Passport approval." };
  if (!selected) return empty;
  const runs = (await db.query<Run>("SELECT id,request_id,conversation_id,state,request_body,request_intent,result,created_at FROM guild_schedule_ai_runs WHERE tenant_id=$1 AND commission_id=$2 AND conversation_id=$3 ORDER BY created_at,id LIMIT 24", [tenantId, commissionId, selected])).rows;
  if (!runs.length) return empty;
  const tools = (await db.query<Tool>("SELECT id,run_id,call_id,name,args_hash,result,completed_at FROM guild_schedule_ai_tool_results WHERE tenant_id=$1 AND commission_id=$2 AND run_id=ANY($3::uuid[]) ORDER BY created_at,id", [tenantId, commissionId, runs.map(run => run.id)])).rows;
  const acknowledged = new Map<string, string>();
  for (const run of runs) for (const input of run.request_body.input) {
    if (input.type !== "function_call_output" || !input.call_id || typeof input.output !== "string") continue;
    const previous = acknowledged.get(input.call_id);
    // Conflicting reported outcomes cannot finish a native plan step.
    acknowledged.set(input.call_id, previous === undefined || previous === input.output ? input.output : "");
  }
  const succeeded = (run: Run, callId: string, name: string, args: unknown) => {
    if (run.request_intent) return tools.some(item => item.run_id === run.id && item.call_id === callId && item.name === name
      && item.args_hash === digest(args) && item.completed_at && item.result?.ok === true && item.result.evidenceId === item.id && item.result.name === name);
    try { return JSON.parse(acknowledged.get(callId) ?? "null")?.ok === true; } catch { return false; }
  };
  const proof = new Map<string, string>(), assistantTexts = new Set<string>();
  let plan: SavedAssistantConversation["plan"] = null;
  for (const run of runs) {
    if (run.state !== "completed" || !run.result) continue;
    const message = run.result.choices[0].message;
    if (message.content) assistantTexts.add(message.content);
    for (const call of message.tool_calls ?? []) {
      let args: unknown; try { args = JSON.parse(call.function.arguments); } catch { continue; }
      const name = call.function.name;
      if (!Object.hasOwn(assistantToolSchemas, name)) continue;
      if (name === "askUser") {
        const parsed = assistantToolSchemas.askUser.safeParse(args);
        if (parsed.success) assistantTexts.add([message.content, parsed.data.question].filter(Boolean).join("\n\n"));
      } else if (name === "createPlan") {
        const parsed = assistantToolSchemas.createPlan.safeParse(args);
        if (!parsed.success || !succeeded(run, call.id, name, parsed.data)) continue;
        proof.clear(); plan = { goal: parsed.data.goal, steps: parsed.data.steps.map((description, index) => ({ id: index + 1, description, completed: false, evidenceId: null })) };
      } else if (name === "completePlanSteps") {
        const parsed = assistantToolSchemas.completePlanSteps.safeParse(args);
        if (!parsed.success || !plan || !succeeded(run, call.id, name, parsed.data)) continue;
        for (const id of parsed.data.stepIds) {
          const step = plan.steps.find(item => item.id === id), tool = step && nativeStepEvidence[step.description as keyof typeof nativeStepEvidence];
          const evidence = tool && proof.get(tool);
          if (step && evidence) { step.completed = true; step.evidenceId = evidence; }
        }
      } else {
        const parsed = assistantToolSchemas[name].safeParse(args);
        const tool = parsed.success && tools.find(item => item.run_id === run.id && item.call_id === call.id && item.name === name
          && item.args_hash === digest(parsed.data) && item.completed_at && item.result?.ok === true && item.result.evidenceId === item.id && item.result.name === name);
        if (tool) proof.set(name, tool.id);
      }
    }
  }
  const latest = runs.at(-1)!, messages: SavedAssistantConversation["messages"] = [];
  if (!latest.request_intent) {
    // Legacy transcripts are display-only. An assistant line must also occur
    // in an actual saved response; browser-supplied tool text is never shown.
    for (const [index, input] of latest.request_body.input.entries()) {
      if (typeof input.content !== "string" || !input.content.trim() || input.content.length > 80000) continue;
      if (input.role !== "user" && (input.role !== "assistant" || !assistantTexts.has(input.content))) continue;
      const origin = runs.find(run => run.request_body.input[index]?.role === input.role && run.request_body.input[index]?.content === input.content) ?? latest;
      messages.push({ id: `${latest.id}-message-${index}`, role: input.role as "user" | "assistant", content: input.content, createdAt: origin.created_at.toISOString() });
    }
  }
  for (const run of latest.request_intent ? runs : [latest]) {
    const intent = startAssistantSchema.safeParse(run.request_intent);
    if (intent.success && intent.data.turn.type === "user") messages.push({ id: `${run.id}-user`, role: "user", content: intent.data.turn.text, createdAt: run.created_at.toISOString() });
    if (run.state !== "completed" || !run.result) continue;
    const message = run.result.choices[0].message, question = message.tool_calls?.find(call => call.function.name === "askUser");
    let text = message.content, options: string[] | undefined;
    if (question) { try { const args = assistantToolSchemas.askUser.parse(JSON.parse(question.function.arguments)); text = [text, args.question].filter(Boolean).join("\n\n"); if (run.id === latest.id && run.request_intent && succeeded(run, question.id, "askUser", args)) options = args.options; } catch { /* Keep any valid saved public text. */ } }
    if (text) messages.push({ id: `${run.id}-answer`, role: "assistant", content: text, createdAt: run.created_at.toISOString(), ...(options ? { options } : {}) });
  }
  const pending = runs.some(run => ["dispatching", "running", "indeterminate"].includes(run.state));
  const calls = latest.result?.choices[0].message.tool_calls ?? [];
  const canAddTurn = !!latest.request_intent && !pending && (!calls.length || calls.length === 1 && calls[0]!.function.name === "askUser" && !!messages.at(-1)?.options);
  return { ...empty, requestContract: latest.request_intent ? "canonical" : "legacy_read_only", runs: runs.length, latestRunId: latest.id, latestRequestId: latest.request_id, messages, plan, pending, canAddTurn,
    evidence: [...proof].map(([name, id]) => ({ name: name as SavedAssistantConversation["evidence"][number]["name"], id })),
    notice: pending ? "An earlier response is pending or held for review. Opening this conversation sends no request and replays no tool. Read its status in Saved assistant responses below."
      : !latest.request_intent ? "Earlier conversation restored for reading. Its original records are unchanged. Choose New conversation to plan again; no old tools will be replayed."
      : !canAddTurn ? "This response has unfinished tool work. Its evidence is retained below. Opening it replays no tool; choose New conversation to make another explicit request."
      : "Saved conversation restored. Completed plan steps link to retained tool results; proposals still need your separate review and Passport approval." };
}
