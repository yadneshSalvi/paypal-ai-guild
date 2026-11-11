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
