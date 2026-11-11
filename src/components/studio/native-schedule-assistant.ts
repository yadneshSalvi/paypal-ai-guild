"use client";
import { ObjectHelper, OpenAIPlugin, Rectangle, StringHelper, Widget } from "@bryntum/core-enterprise";
import type { Gantt } from "@bryntum/gantt-enterprise";
import DefaultGanttAgent, { type NativeTool, type NativeToolInput } from "@bryntum/gantt-enterprise/lib/Gantt/feature/ai/agents/DefaultGanttAgent.js";
import GanttToolHost from "@bryntum/gantt-enterprise/lib/Gantt/feature/ai/toolhosts/GanttToolHost.js";
import { assistantToolDefinitions, assistantToolSchemas, planningStepsHaveEvidence, type AssistantRunView, type AssistantToolName, type SavedAssistantConversation, type StartAssistant } from "@/scheduling/assistant";
import { formatPlannerMessage, formatPlannerReadOnlyOptions, formatPlannerUserText } from "./planner-message-format";

export interface NativeAssistantCallbacks {
  commissionId: string;
  available: boolean;
  onStatus: (run: AssistantRunView) => void;
  onProposal: (proposalId: string) => Promise<void>;
}
const failedTool = (message: string) => ({ ok: false, error: { code: "GUILD_PLANNING_GATE", message } });
type Restoration = { conversation: SavedAssistantConversation | null; error: string | null };
type VisiblePlan = NonNullable<DefaultGanttAgent["$plan"]>;
interface PlannerPopup {
  width: number; height: number; hidden: boolean; isDestroyed: boolean; element: HTMLElement;
  alignTo(spec?: Record<string, unknown>): void;
  setXY(x: number, y: number): void;
}
interface PlannerButton {
  changeChatPanel(config: Record<string, unknown> | null, old?: PlannerPopup): PlannerPopup | null;
}
const NativeWidget = Widget as unknown as { reconfigure(old: PlannerPopup | undefined, config: object | null, options: { owner: PlannerButton }): PlannerPopup | null };
// The pinned v8 declaration omits Rectangle's four-number public constructor.
const ViewportRectangle = Rectangle as unknown as new (x: number, y: number, width: number, height: number) => Rectangle;
function popupBounds() {
  const viewport = window.visualViewport;
  const width = Math.max(1, Math.min(viewport?.width ?? window.innerWidth, document.documentElement.clientWidth) - 24);
  const height = Math.max(1, Math.min(viewport?.height ?? window.innerHeight, window.innerHeight) - 24);
  const popupWidth = Math.min(460, width), popupHeight = Math.min(680, height);
  return { width: popupWidth, height: popupHeight, left: (viewport?.offsetLeft ?? 0) + 12 + (width - popupWidth) / 2, top: (viewport?.offsetTop ?? 0) + 12 + (height - popupHeight) / 2, viewport: new ViewportRectangle((viewport?.offsetLeft ?? 0) + 12, (viewport?.offsetTop ?? 0) + 12, width, height) };
}
function planMarkup(plan: VisiblePlan) {
  const completed = plan.steps.filter(step => step.completed).length;
  return `<section aria-label="Opening plan checklist" data-native-plan-state="${completed === plan.steps.length ? "complete" : "active"}"><div class="guild-plan-heading"><strong>Our plan</strong><span role="status" aria-live="polite">${completed} of ${plan.steps.length} steps complete</span></div><p>${StringHelper.encodeHtml(plan.goal ?? "Plan the opening")}</p><ol>${plan.steps.map(step => `<li data-state="${step.completed ? "complete" : "pending"}"><span class="guild-plan-mark" aria-hidden="true">${step.completed ? "✓" : step.id}</span><span>${StringHelper.encodeHtml(step.description)}<small>${step.completed ? "Complete · matching tool result saved" : "Pending"}</small></span></li>`).join("")}</ol></section>`;
}
export async function loadNativeConversation(commissionId: string): Promise<Restoration> {
  try {
    const id = sessionStorage.getItem(`guild.schedule-assistant.${commissionId}.conversation`);
    const response = await fetch(`/api/commissions/${commissionId}/schedule/assistant/conversation${id ? `?conversationId=${encodeURIComponent(id)}` : ""}`, { cache: "no-store", signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error("History unavailable");
    const conversation: SavedAssistantConversation = await response.json();
    if (conversation.schemaVersion !== "guild.saved-planning-conversation.v1") throw new Error("History contract changed");
    return { conversation, error: null };
  } catch { return { conversation: null, error: "Saved conversation could not be read. Reload before sending another planning request; the manual schedule remains available." }; }
}
function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException("The saved request is retained.", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  });
}

/** Use the native panel and plan tools; replace its provider transport and all store mutators. */
export function nativeScheduleAssistant(callbacks: NativeAssistantCallbacks, restoration: Restoration) {
  const base = `/api/commissions/${callbacks.commissionId}/schedule/assistant`;
  const storageKey = `guild.schedule-assistant.${callbacks.commissionId}`;
  const restored = restoration.conversation;
  if (restored?.latestRequestId && !restored.pending && sessionStorage.getItem(`${storageKey}.pending`) === restored.latestRequestId) sessionStorage.removeItem(`${storageKey}.pending`);
  const conversationId = restored?.conversationId ?? sessionStorage.getItem(`${storageKey}.conversation`) ?? crypto.randomUUID();
  sessionStorage.setItem(`${storageKey}.conversation`, conversationId);
  let lastRunId: string | null = restored?.latestRunId ?? null;
  const proof = new Map<string, string>(restored?.evidence.map(item => [item.name, item.id]));
  let popupListeners: AbortController | undefined, popupFrame: number | undefined;
  const detachPopup = () => { popupListeners?.abort(); popupListeners = undefined; if (popupFrame !== undefined) cancelAnimationFrame(popupFrame); popupFrame = undefined; };
  const sizePopup = (popup: PlannerPopup) => {
    const bounds = popupBounds();
    popup.width = bounds.width; popup.height = bounds.height;
    popup.element.style.setProperty("--guild-planner-height", `${bounds.height}px`);
    return bounds;
  };
  const watchPopup = (popup: PlannerPopup) => {
    detachPopup(); popupListeners = new AbortController();
    const fit = () => {
      if (popupFrame !== undefined) cancelAnimationFrame(popupFrame);
      popupFrame = requestAnimationFrame(() => {
        popupFrame = undefined;
        if (popup.isDestroyed || popup.hidden) return;
        const bounds = sizePopup(popup);
        popup.alignTo({ target: bounds.viewport, align: "c-c", anchor: false, axisLock: false });
        // Cancel ChatButton's anchor tracking, then use the documented native
        // viewport-position API after its automatic show alignment has finished.
        popup.alignTo(); popup.setXY(bounds.left, bounds.top);
      });
    };
    window.addEventListener("resize", fit, { signal: popupListeners.signal });
    window.visualViewport?.addEventListener("resize", fit, { signal: popupListeners.signal });
    window.visualViewport?.addEventListener("scroll", fit, { signal: popupListeners.signal });
    fit();
  };
  async function savedTool(name: AssistantToolName, args: unknown, callId?: string) {
    if (!callbacks.available) return failedTool("The planning provider is unavailable. Saved conversations remain available to read.");
    if (!lastRunId || !callId) return failedTool("Only an exact saved assistant response can invoke a planning tool.");
    try {
      const response = await fetch(`${base}/tools`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId: lastRunId, callId, name, args }) });
      const result = await response.json();
      if (!response.ok || !result.ok) return failedTool(result.message ?? "The planning tool did not finish.");
      if (["getOpeningPlan", "compareRecoveryQuotes", "proposeOpeningChange"].includes(name)) proof.set(name, result.evidenceId);
      if (name === "proposeOpeningChange" && result.data?.proposal?.id) await callbacks.onProposal(result.data.proposal.id);
      return result;
    } catch { return failedTool("The connection paused. Refresh the saved proposal before trying another action."); }
  }
  class ProposalToolHost extends GanttToolHost {
    static $name = "GuildProposalToolHost";
    override get tools() { return this._configuredTools; }
  }
  class OpeningAgent extends DefaultGanttAgent {
    static $name = "GuildOpeningAgent";
    constructor(config: Record<string, unknown>) {
      super(config);
      this.history = restored?.messages.map(item => ({ role: item.role, content: item.content })) ?? [];
      if (restored?.requestContract === "canonical" && restored.plan?.steps.some(step => !step.completed)) this.$plan = structuredClone(restored.plan);
    }
    showPlan(plan: NonNullable<DefaultGanttAgent["$plan"]>) {
      const widget = this.client.features.ai.chatPanel?.widgetMap.guildPlan;
      if (!widget) return;
      widget.html = planMarkup(plan);
      widget.hidden = false;
    }
    override get agentTools() {
      const native = super.agentTools;
      const wrap = (name: "askUser" | "createPlan" | "completePlanSteps"): NativeTool => ({
        ...native[name]!, parameters: assistantToolDefinitions.find(tool => tool.name === name)!.parameters,
        fn: async (input: NativeToolInput) => {
          const parsed = assistantToolSchemas[name].safeParse(input.args);
          if (!parsed.success) return failedTool("Use the supported planning steps and short owner choices.");
          if (name === "completePlanSteps") {
            const { stepIds } = assistantToolSchemas.completePlanSteps.parse(parsed.data);
            if (!planningStepsHaveEvidence(this.$plan?.steps, stepIds, proof)) return failedTool("A plan step needs its matching successful server tool result before it can be marked complete.");
          }
          const saved = await savedTool(name, parsed.data, input.toolCall?.id);
          if (!saved.ok) return saved;
          if (name === "createPlan") proof.clear();
          // The native tool owns this state. Keep its last completed plan visible
          // even though v8 clears $plan after the final step.
          const prior = this.$plan;
          await native[name]!.fn({ ...input, args: parsed.data });
          const plan = this.$plan ?? prior;
          if (name !== "askUser" && plan) this.showPlan(plan);
          return saved;
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
        if (!callbacks.available) throw new Error("The planning provider is unavailable. This saved conversation is read-only; no new request was sent.");
        if (restoration.error) throw new Error(restoration.error);
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
        const messages = body.messages as { role: string; content?: string; tool_call_id?: string }[], last = messages.at(-1);
        let turn: StartAssistant["turn"];
        if (last?.role === "user" && typeof last.content === "string") turn = { type: "user", text: last.content };
        else if (last?.role === "tool") {
          let start = messages.length - 1; while (start > 0 && messages[start - 1]?.role === "tool") start--;
          const callIds = messages.slice(start).map(item => item.tool_call_id);
          if (callIds.some(id => !id)) throw new Error("The native tool continuation lost its original identity.");
          turn = { type: "continue", callIds: callIds as string[] };
        } else throw new Error("Only an explicit user turn or exact saved tool continuation may start a request.");
        const request: StartAssistant = { version: "guild.planning-request.v2", requestId, conversationId, afterRunId: lastRunId, turn, toolNames: tools.map(tool => tool.function.name) };
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
    fn: ({ args, toolCall }: NativeToolInput) => savedTool(tool.name, args, toolCall?.id),
  }]));
  const config = {
    apiPlugin: OpenAIPlugin, agent: OpeningAgent, toolHost: ProposalToolHost, tools,
    model: "gpt-6.1-sol", planning: true, promptUrl: base, manageChatHistory: true,
    timeout: 15 * 60_000, debugMode: false, showNoConnectionIcon: false,
    undo: false, redo: false, mentions: false, autoReadAloud: false, availableApis: [],
    chatButton: { text: "Plan with Guild", cls: "guild-native-assistant", tooltip: "Read, compare and propose with Guild",
      beforeConfigure: (button: PlannerButton) => {
        // Pinned v8 ChatButton otherwise forcibly changes AIChatPopup into a
        // collapsed bottom drawer below 600px. Keep the same real popup across
        // viewport changes; preserve native ownership, events and AI contents.
        button.changeChatPanel = (panel, old) => {
          const popup = panel ? ObjectHelper.merge({
            owner: button, showCloseButton: true, scrollAction: null,
            internalListeners: { visibilityChange: "up.onVisibilityChange" },
          }, panel, { type: "aichatpopup", collapsible: false }) as Record<string, unknown> : null;
          // Panel.updateDrawer activates even for false in this pinned release.
          // Omission preserves its native null default and avoids the updater.
          if (popup) delete popup.drawer;
          return NativeWidget.reconfigure(old, popup, { owner: button });
        };
      },
      chatPanel: { title: "Plan the opening", cls: "guild-native-planner-popup", width: popupBounds().width, height: popupBounds().height, animateTyping: !matchMedia("(prefers-reduced-motion: reduce)").matches,
        // ChatButton's default size animation retains its final inline width and
        // height. Recompute native dimensions on every opening and viewport change.
        showAnimation: false, hideAnimation: false, floating: true, centered: false, anchor: false, draggable: false,
        listeners: {
          beforeShow: ({ source }: { source: PlannerPopup }) => { sizePopup(source); },
          beforeAlign: { prio: -1000, fn: (spec: Record<string, unknown> & { source: PlannerPopup }) => {
            const viewport = sizePopup(spec.source).viewport;
            Object.assign(spec, { target: viewport, constrainTo: viewport, align: "c-c", anchor: false, axisLock: false, offset: 0, inflate: 0, monitorTargetMutation: false, monitorResize: false });
          } },
          show: ({ source }: { source: PlannerPopup }) => { watchPopup(source); },
          hide: detachPopup, destroy: detachPopup,
        },
        formatText: formatPlannerMessage,
        messages: restored?.messages.map(item => ({ id: item.id, text: (item.role === "assistant" ? formatPlannerMessage(item.content) : formatPlannerUserText(item.content)) + (item.options && (!callbacks.available || !restored.canAddTurn) ? formatPlannerReadOnlyOptions(item.options) : ""), fromOther: item.role === "assistant", timestamp: item.createdAt, ...(item.options && restored.canAddTurn && callbacks.available ? { options: item.options } : {}) })) ?? [],
        tools: { settingsTool: false, clearChat: false },
        items: {
          guildHistory: { type: "widget", weight: -120, cls: "guild-native-history", html: `<p role="status">${StringHelper.encodeHtml(restoration.error ?? (!callbacks.available ? "The planning provider is unavailable. You can read the saved conversation and plan; new messages and actions are disabled." : restored?.notice ?? "Plan with the saved contracts and offers."))}</p>` },
          guildNewConversation: { type: "button", weight: -110, text: "New conversation", cls: "guild-native-new-conversation", disabled: !callbacks.available || !!restoration.error || !!restored?.pending || !!sessionStorage.getItem(`${storageKey}.pending`), onAction: () => {
            if (!callbacks.available || sessionStorage.getItem(`${storageKey}.pending`)) return;
            sessionStorage.setItem(`${storageKey}.conversation`, crypto.randomUUID()); window.location.reload();
          } },
          guildPlan: { type: "widget", weight: -100, cls: "guild-native-plan", hidden: !restored?.plan, html: restored?.plan ? planMarkup(restored.plan) : "" },
          messageField: { disabled: !callbacks.available || !!restoration.error || restored?.canAddTurn === false },
        },
      } },
    delayStatusTexts: ["Reading the saved opening plan…", "Considering working time and review…", "The original request is still working…"],
  };
  // v8's public declaration omits agent/toolHost and types a tool's fn without
  // its actual staged argument. These hooks require native browser qualification.
  type NativeConfig = Exclude<NonNullable<NonNullable<ConstructorParameters<typeof Gantt>[0]>["features"]>["ai"], boolean | string | undefined>;
  return config as unknown as NativeConfig;
}
