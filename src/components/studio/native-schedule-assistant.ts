"use client";
import { OpenAIPlugin, StringHelper } from "@bryntum/core-enterprise";
import type { Gantt } from "@bryntum/gantt-enterprise";
import DefaultGanttAgent, { type NativeTool, type NativeToolInput } from "@bryntum/gantt-enterprise/lib/Gantt/feature/ai/agents/DefaultGanttAgent.js";
import GanttToolHost from "@bryntum/gantt-enterprise/lib/Gantt/feature/ai/toolhosts/GanttToolHost.js";
import { assistantToolDefinitions, assistantToolSchemas, planningStepsHaveEvidence, type AssistantRunView, type AssistantToolName } from "@/scheduling/assistant";

export interface NativeAssistantCallbacks {
  commissionId: string;
  onStatus: (run: AssistantRunView) => void;
  onProposal: (proposalId: string) => Promise<void>;
}
const failedTool = (message: string) => ({ ok: false, error: { code: "GUILD_PLANNING_GATE", message } });
function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException("The saved request is retained.", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  });
}

/** Use the native panel and plan tools; replace its provider transport and all store mutators. */
export function nativeScheduleAssistant(callbacks: NativeAssistantCallbacks) {
  const base = `/api/commissions/${callbacks.commissionId}/schedule/assistant`;
  const storageKey = `guild.schedule-assistant.${callbacks.commissionId}`;
  const conversationId = sessionStorage.getItem(`${storageKey}.conversation`) ?? crypto.randomUUID();
  sessionStorage.setItem(`${storageKey}.conversation`, conversationId);
  let lastRunId: string | null = null;
  const proof = new Map<string, string>();
  class ProposalToolHost extends GanttToolHost {
    static $name = "GuildProposalToolHost";
    override get tools() { return this._configuredTools; }
  }
  class OpeningAgent extends DefaultGanttAgent {
    static $name = "GuildOpeningAgent";
    showPlan(plan: NonNullable<DefaultGanttAgent["$plan"]>) {
      const widget = this.client.features.ai.chatPanel?.widgetMap.guildPlan;
      if (!widget) return;
      const completed = plan.steps.filter(step => step.completed).length;
      widget.html = `<section aria-label="Opening plan checklist" data-native-plan-state="${completed === plan.steps.length ? "complete" : "active"}"><div class="guild-plan-heading"><strong>Our plan</strong><span role="status" aria-live="polite">${completed} of ${plan.steps.length} steps complete</span></div><p>${StringHelper.encodeHtml(plan.goal ?? "Plan the opening")}</p><ol>${plan.steps.map(step => `<li data-state="${step.completed ? "complete" : "pending"}"><span class="guild-plan-mark" aria-hidden="true">${step.completed ? "✓" : step.id}</span><span>${StringHelper.encodeHtml(step.description)}<small>${step.completed ? "Complete · matching tool result saved" : "Pending"}</small></span></li>`).join("")}</ol></section>`;
      widget.hidden = false;
    }
    override get agentTools() {
      const native = super.agentTools;
      const wrap = (name: "askUser" | "createPlan" | "completePlanSteps"): NativeTool => ({
        ...native[name]!, parameters: assistantToolDefinitions.find(tool => tool.name === name)!.parameters,
        fn: async (input: NativeToolInput) => {
          const parsed = assistantToolSchemas[name].safeParse(input.args);
          if (!parsed.success) return failedTool("Use the supported planning steps and short owner choices.");
          if (name === "createPlan") proof.clear();
          if (name === "completePlanSteps") {
            const { stepIds } = assistantToolSchemas.completePlanSteps.parse(parsed.data);
            if (!planningStepsHaveEvidence(this.$plan?.steps, stepIds, proof)) return failedTool("A plan step needs its matching successful server tool result before it can be marked complete.");
          }
          // The native tool owns this state. Keep its last completed plan visible
          // even though v8 clears $plan after the final step.
          const prior = this.$plan;
          const result = await native[name]!.fn({ ...input, args: parsed.data });
          const plan = this.$plan ?? prior;
          if (name !== "askUser" && plan) this.showPlan(plan);
          return result;
        },
      });
      return { askUser: wrap("askUser"), createPlan: wrap("createPlan"), completePlanSteps: wrap("completePlanSteps") };
    }
    override processResponse(response: unknown, context: Record<string, unknown>) {
      // Do not let the native agent create extra requests just to nudge a plan.
      // Unfinished steps stay visible for the owner's next explicit message.
      context.planNudgeCount = 3;
      return super.processResponse(response, context);
    }
    post(body: Record<string, unknown>) {
      const controller = new AbortController();
      this.beforePost?.(body);
      const promise = (async () => {
        const pending = sessionStorage.getItem(`${storageKey}.pending`);
        if (pending) {
          const response = await fetch(`${base}?requestId=${encodeURIComponent(pending)}`, { cache: "no-store", signal: controller.signal });
          if (response.ok) {
            const run: AssistantRunView = await response.json(); callbacks.onStatus(run);
            if (["completed", "failed", "unavailable"].includes(run.state)) sessionStorage.removeItem(`${storageKey}.pending`);
          }
          throw new Error("An earlier request is retained in Saved assistant responses below. Review it before sending another message; no replacement was sent.");
        }
        const requestId = crypto.randomUUID();
        const tools = body.tools as { function: { name: AssistantToolName } }[];
        const request = { requestId, conversationId, messages: body.messages, toolNames: tools.map(tool => tool.function.name) };
        sessionStorage.setItem(`${storageKey}.pending`, requestId);
        let run: AssistantRunView | undefined;
        try {
          const response = await fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request), signal: controller.signal });
          const data = await response.json();
          if (!response.ok) { sessionStorage.removeItem(`${storageKey}.pending`); throw new Error(data.message ?? "The planning request could not be saved."); }
          run = data;
        } catch (error) {
          if (controller.signal.aborted || !sessionStorage.getItem(`${storageKey}.pending`)) throw error;
          // Recover by request identity; never repeat a possibly dispatched POST.
          const recovered = await fetch(`${base}?requestId=${requestId}`, { cache: "no-store", signal: controller.signal });
          if (!recovered.ok) throw new Error("The request outcome is uncertain. Its identity is retained for review; no replacement was sent.");
          run = await recovered.json();
        }
        const until = Date.now() + 12 * 60_000;
        while (run && ["running", "dispatching"].includes(run.state) && Date.now() < until) {
          callbacks.onStatus(run); await wait(run.retryAfterMs, controller.signal);
          try {
            const response = await fetch(`${base}?runId=${run.id}`, { cache: "no-store", signal: controller.signal });
            if (response.ok) run = await response.json();
          } catch (error) { if (controller.signal.aborted) throw error; }
        }
        if (!run) throw new Error("The saved planning response is unavailable.");
        callbacks.onStatus(run);
        if (run.state !== "completed" || !run.result) {
          if (["failed", "unavailable"].includes(run.state)) sessionStorage.removeItem(`${storageKey}.pending`);
          throw new Error(run.message);
        }
        sessionStorage.removeItem(`${storageKey}.pending`); lastRunId = run.id;
        // Returning only a complete nonempty response prevents the native
        // fallback that would otherwise regenerate an empty/invalid answer.
        return { ok: true, parsedJson: run.result };
      })();
      return Object.assign(promise, { abort: () => controller.abort() });
    }
  }
  const tools = Object.fromEntries(assistantToolDefinitions.filter(tool => ["getOpeningPlan", "compareRecoveryQuotes", "proposeOpeningChange"].includes(tool.name)).map(tool => [tool.name, {
    ...tool, kind: tool.name === "proposeOpeningChange" ? "write" as const : "read" as const, available: true, noStm: true,
    fn: async ({ args, toolCall }: NativeToolInput) => {
      if (!lastRunId || !toolCall?.id) return failedTool("Only an exact saved assistant response can invoke a planning tool.");
      try {
        const response = await fetch(`${base}/tools`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId: lastRunId, callId: toolCall.id, name: tool.name, args }) });
        const result = await response.json();
        if (!response.ok || !result.ok) return failedTool(result.message ?? "The planning tool did not finish.");
        proof.set(tool.name, result.evidenceId);
        if (tool.name === "proposeOpeningChange" && result.data?.proposal?.id) await callbacks.onProposal(result.data.proposal.id);
        return result;
      } catch { return failedTool("The connection paused. Refresh the saved proposal before trying another action."); }
    },
  }]));
  const config = {
    apiPlugin: OpenAIPlugin, agent: OpeningAgent, toolHost: ProposalToolHost, tools,
    model: "gpt-6.1-sol", planning: true, promptUrl: base, manageChatHistory: true,
    timeout: 15 * 60_000, debugMode: false, showNoConnectionIcon: false,
    undo: false, redo: false, mentions: false, autoReadAloud: false, availableApis: [],
    chatButton: { text: "Plan with Guild", cls: "guild-native-assistant", tooltip: "Read, compare and propose with Guild",
      chatPanel: { title: "Plan the opening", cls: "guild-native-planner-popup", width: "min(460px, calc(100vw - 24px))", height: "min(680px, calc(100dvh - 24px))", animateTyping: !matchMedia("(prefers-reduced-motion: reduce)").matches,
        tools: { settingsTool: false },
        items: { guildPlan: { type: "widget", weight: -100, cls: "guild-native-plan", hidden: true, html: "" } },
      } },
    delayStatusTexts: ["Reading the saved opening plan…", "Considering working time and review…", "The original request is still working…"],
  };
  // v8's public declaration omits agent/toolHost and types a tool's fn without
  // its actual staged argument. These hooks require native browser qualification.
  type NativeConfig = Exclude<NonNullable<NonNullable<ConstructorParameters<typeof Gantt>[0]>["features"]>["ai"], boolean | string | undefined>;
  return config as unknown as NativeConfig;
}
