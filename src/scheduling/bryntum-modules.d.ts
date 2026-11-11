// The licensed v8 packages publish one public declaration bundle. These narrow
// imports keep browser widgets out of the server's scheduling-only module graph.
declare module "@bryntum/gantt-enterprise/lib/Gantt/model/ProjectModel.js" {
  import { ProjectModel } from "@bryntum/gantt-enterprise";
  export default ProjectModel;
}

declare module "@bryntum/engine-enterprise/lib/ChronoGraph/chrono/Identifier.js" {
  export class CalculatedValueGen {
    static new(): CalculatedValueGen;
    writeToGraph(graph: unknown, value: unknown): void;
  }
}

declare module "@bryntum/engine-enterprise/lib/Engine/quark/model/scheduler_basic/BaseCalendarMixin.js" {
  export class BaseCalendarMixin {
    constructor(config: {
      unspecifiedTimeIsWorking: boolean;
      intervals: { startDate: Date; endDate: Date; isWorking: boolean }[];
    });
  }
}

declare module "@bryntum/engine-enterprise/lib/Engine/chrono/SchedulingIssueEffect.js" {
  export const EffectResolutionResult: { Cancel: "Cancel"; Resume: "Resume" };
}

// These experimental hooks are pinned to the inspected Enterprise 8.0.0 source.
// Browser qualification checks the whitelist and the native planning controls.
declare module "@bryntum/gantt-enterprise/lib/Gantt/feature/ai/agents/DefaultGanttAgent.js" {
  export interface NativeToolInput { args: unknown; toolCall?: { id: string }; promptContext?: Record<string, unknown> }
  export interface NativeTool { fn: (input: NativeToolInput) => unknown; [key: string]: unknown }
  export default class DefaultGanttAgent {
    constructor(config: Record<string, unknown>);
    static $name: string;
    get agentTools(): Record<string, NativeTool>;
    beforePost?: (body: Record<string, unknown>) => void;
    client: { features: { ai: { chatPanel?: { widgetMap: { guildPlan?: { html: string; hidden: boolean } } } } } };
    $plan?: { goal?: string; steps: { id: number; description: string; completed: boolean }[] };
    processResponse(response: unknown, context: Record<string, unknown>): Promise<unknown>;
  }
}
declare module "@bryntum/gantt-enterprise/lib/Gantt/feature/ai/toolhosts/GanttToolHost.js" {
  import type { NativeTool } from "@bryntum/gantt-enterprise/lib/Gantt/feature/ai/agents/DefaultGanttAgent.js";
  export default class GanttToolHost {
    constructor(config: Record<string, unknown>);
    static $name: string;
    _configuredTools: Record<string, NativeTool>;
    get tools(): Record<string, NativeTool>;
  }
}
