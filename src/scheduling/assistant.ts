import { z } from "zod";
import { schedulePatchSchema } from "./persisted";

export const nativePlanSteps = ["Read the current opening plan", "Compare saved provider offers", "Prepare a schedule proposal"] as const;
export const nativeStepEvidence = {
  [nativePlanSteps[0]]: "getOpeningPlan",
  [nativePlanSteps[1]]: "compareRecoveryQuotes",
  [nativePlanSteps[2]]: "proposeOpeningChange",
} as const;
export function planningStepsHaveEvidence(steps: { id: number; description: string }[] | undefined, ids: number[], evidence: ReadonlyMap<string, string>) {
  return !!steps && ids.length > 0 && ids.every(id => {
    const step = steps.find(item => item.id === id), tool = step && nativeStepEvidence[step.description as keyof typeof nativeStepEvidence];
    return !!tool && !!evidence.get(tool);
  });
}
export const assistantToolSchemas = {
  getOpeningPlan: z.strictObject({}),
  compareRecoveryQuotes: z.strictObject({}),
  proposeOpeningChange: z.strictObject({ patch: schedulePatchSchema }),
  askUser: z.strictObject({ question: z.string().min(1).max(240), options: z.array(z.string().min(1).max(120)).min(2).max(3) }),
  createPlan: z.strictObject({ goal: z.string().max(200).optional(), steps: z.array(z.enum(nativePlanSteps)).min(1).max(3).refine(items => new Set(items).size === items.length) }),
  completePlanSteps: z.strictObject({ stepIds: z.array(z.number().int().min(1).max(3)).min(1).max(3) }),
};
export type AssistantToolName = keyof typeof assistantToolSchemas;
const descriptions: Record<AssistantToolName, string> = {
  getOpeningPlan: "Read the current saved contracts, calendar, critical path, capacity and four-hour curator review. Dates are forecasts, not observed completion.",
  compareRecoveryQuotes: "Compare already-issued controlled provider offers with the native engine. This cannot request a new offer, approve a contract or start work.",
  proposeOpeningChange: "Save one revision-bound schedule proposal for the owner to inspect. Use only exact current quote IDs, a valid earliest start, or explicit current-source reconciliation. This changes no contract, authority, acceptance or payment.",
  askUser: "Ask the owner to choose between two or three short options. This ends the current assistant turn. An answer is not Passport approval.",
  createPlan: "Create a visible plan using the supported steps before a request needs multiple actions. Every completed step must have its corresponding successful tool result.",
  completePlanSteps: "Mark visible plan steps complete only after their corresponding server-validated tool result. This never means production, human acceptance or payment completed.",
};
export const assistantToolDefinitions = Object.entries(assistantToolSchemas).map(([name, schema]) => {
  const { $schema: _schema, ...parameters } = z.toJSONSchema(schema, { unrepresentable: "any" });
  return { name: name as AssistantToolName, description: descriptions[name as AssistantToolName], parameters: JSON.parse(JSON.stringify(parameters)) as Record<string, unknown> };
});
const call = z.strictObject({ id: z.string().min(1).max(250), type: z.literal("function"), function: z.strictObject({ name: z.enum(Object.keys(assistantToolSchemas) as [AssistantToolName, ...AssistantToolName[]]), arguments: z.string().max(16000) }) });
export const assistantMessageSchema = z.strictObject({
  role: z.enum(["user", "assistant", "tool", "system"]), content: z.string().max(80000).nullable().optional(),
  tool_calls: z.array(call).max(8).optional(), tool_call_id: z.string().max(250).optional(),
});
export const startAssistantSchema = z.strictObject({
  version: z.literal("guild.planning-request.v2"),
  requestId: z.string().uuid(), conversationId: z.string().uuid(), afterRunId: z.string().uuid().nullable(),
  turn: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("user"), text: z.string().trim().min(1).max(80000) }),
    z.strictObject({ type: z.literal("continue"), callIds: z.array(z.string().min(1).max(250)).min(1).max(8) }),
  ]),
  toolNames: z.array(z.enum(Object.keys(assistantToolSchemas) as [AssistantToolName, ...AssistantToolName[]])).min(1).max(6),
});
export type StartAssistant = z.infer<typeof startAssistantSchema>;
export const assistantToolCommandSchema = z.strictObject({
  runId: z.string().uuid(), callId: z.string().min(1).max(250),
  name: z.enum(Object.keys(assistantToolSchemas) as [AssistantToolName, ...AssistantToolName[]]), args: z.unknown(),
});
export interface AssistantCompletion {
  choices: [{ finish_reason: "stop" | "tool_calls"; message: { role: "assistant"; content: string | null; tool_calls?: z.infer<typeof call>[] } }];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}
export interface AssistantRunView {
  id: string; requestId: string; conversationId: string;
  state: "dispatching" | "running" | "completed" | "failed" | "indeterminate" | "unavailable";
  model: "gpt-6.1-sol"; reasoning: "max";
  result: AssistantCompletion | null; message: string; retryAfterMs: number;
}
export interface AssistantHistory { runs: AssistantRunView[]; total: number; nextBefore: string | null; pending: boolean }
export interface SavedAssistantConversation {
  schemaVersion: "guild.saved-planning-conversation.v1";
  requestContract: "canonical" | "legacy_read_only";
  conversationId: string | null; runs: number; latestRunId: string | null; latestRequestId: string | null; pending: boolean; canAddTurn: boolean;
  messages: { id: string; role: "user" | "assistant"; content: string; createdAt: string; options?: string[] }[];
  plan: { goal?: string; steps: { id: number; description: string; completed: boolean; evidenceId: string | null }[] } | null;
  evidence: { name: AssistantToolName; id: string }[];
  notice: string;
}
