import ProjectModel from "@bryntum/gantt-enterprise/lib/Gantt/model/ProjectModel.js";
import type { Baseline, TaskModel } from "@bryntum/gantt-enterprise";
import { CalculatedValueGen } from "@bryntum/engine-enterprise/lib/ChronoGraph/chrono/Identifier.js";
import { BaseCalendarMixin } from "@bryntum/engine-enterprise/lib/Engine/quark/model/scheduler_basic/BaseCalendarMixin.js";
import { EffectResolutionResult } from "@bryntum/engine-enterprise/lib/Engine/chrono/SchedulingIssueEffect.js";
import { digest, DomainError } from "../domain/primitives";
import { buildBryntumProjectConfig } from "./configuration";
import { scheduleSnapshotSchema, type ScheduleEvaluation, type ResourceConflict, type ScheduleSnapshot } from "./contracts";

const HOUR = 3_600_000;

// The public declaration bundle omits these allocation internals. This small
// version-pinned boundary follows v8 ResourceHistogram's native calculation path.
interface NativeCalendar {
  calculateDurationMs(start: Date, end: Date): number;
  getWorkingTimeRanges(start: Date, end: Date): { startDate: Date; endDate: Date }[];
}
interface NativeAllocation {
  $: { allocation: unknown };
  allocation: { total: {
    tick: { startDate: Date; endDate: Date };
    isOverallocated: boolean;
    units: number;
    assignments: Set<{ eventId: string }>;
  }[] };
}
interface NativeAllocationProject {
  calendar: NativeCalendar;
  calendarManagerStore: { allRecords: NativeCalendar[]; getById(id: string): NativeCalendar };
  getGraph(): {
    addIdentifier(identifier: CalculatedValueGen): CalculatedValueGen;
    readAsync(identifier: unknown): Promise<unknown>;
    removeEntity(entity: NativeAllocation): void;
  };
  resourceStore: { getById(id: string): { $original: unknown; addEntity(entity: NativeAllocation): void } };
  resourceAllocationInfoClass: {
    "new"(config: { ticks: CalculatedValueGen; resource: unknown; includeInactiveEvents: false; includeCost: false; respectStoreFilters: false }): NativeAllocation;
  };
}

function workingHours(calendar: NativeCalendar, from: Date, to: Date): number {
  return to >= from ? calendar.calculateDurationMs(from, to) / HOUR : -calendar.calculateDurationMs(to, from) / HOUR;
}

async function capacityConflicts(project: NativeAllocationProject, snapshot: ScheduleSnapshot, taskDates: Date[]): Promise<ResourceConflict[]> {
  if (snapshot.resources.length === 0) return [];
  const start = new Date(snapshot.startAt), end = new Date(snapshot.horizonEndAt);
  // Split at every task and working-calendar boundary. Averaging a busy half-hour
  // across a whole day must not hide a simultaneous capacity violation.
  const boundaries = new Set([start.getTime(), end.getTime(), ...taskDates.map(date => date.getTime())]);
  for (const calendar of project.calendarManagerStore.allRecords) {
    for (const range of calendar.getWorkingTimeRanges(start, end)) {
      boundaries.add(Math.max(start.getTime(), range.startDate.getTime()));
      boundaries.add(Math.min(end.getTime(), range.endDate.getTime()));
    }
  }
  const dates = [...boundaries].sort((a, b) => a - b);
  const graph = project.getGraph();
  const ticks = graph.addIdentifier(CalculatedValueGen.new());
  ticks.writeToGraph(graph, new BaseCalendarMixin({
    unspecifiedTimeIsWorking: false,
    intervals: dates.slice(1).map((date, index) => ({ startDate: new Date(dates[index]!), endDate: new Date(date), isWorking: true })),
  }));
  const conflicts: ResourceConflict[] = [];
  for (const resource of snapshot.resources) {
    const nativeResource = project.resourceStore.getById(resource.id);
    const report = project.resourceAllocationInfoClass.new({
      ticks, resource: nativeResource.$original, includeInactiveEvents: false, includeCost: false, respectStoreFilters: false,
    });
    nativeResource.addEntity(report);
    try {
      await graph.readAsync(report.$.allocation);
      for (const interval of report.allocation.total) if (interval.isOverallocated) {
        conflicts.push({
          resourceId: resource.id, startAt: interval.tick.startDate.toISOString(), endAt: interval.tick.endDate.toISOString(),
          taskIds: [...new Set([...interval.assignments].map(assignment => String(assignment.eventId)))].sort(),
          allocatedUnits: interval.units, capacityUnits: resource.capacityUnits,
        });
      }
    } finally { graph.removeEntity(report); }
  }
  return conflicts;
}

/** Creates and destroys an isolated engine project; it never edits the supplied snapshot. */
export async function evaluateSchedule(input: unknown): Promise<ScheduleEvaluation> {
  const snapshot = scheduleSnapshotSchema.parse(input);
  const issues: string[] = [];
  const cancelIssue = ({ continueWithResolutionResult }: { continueWithResolutionResult: Function }) => {
    issues.push("The native scheduling engine could not satisfy the calendars and constraints.");
    continueWithResolutionResult(EffectResolutionResult.Cancel);
  };
  const project = new ProjectModel({
    ...buildBryntumProjectConfig(snapshot),
    listeners: { cycle: cancelIssue, emptyCalendar: cancelIssue, schedulingConflict: cancelIssue },
  });
  try {
    await project.commitAsync();
    if (issues.length) throw new DomainError("SCHEDULE_CONFLICT", issues[0]!, 422);
    const native = project as unknown as NativeAllocationProject;
    const taskDates: Date[] = [];
    const tasks: ScheduleEvaluation["tasks"] = snapshot.tasks.map(task => {
      const record = project.taskStore.getById(task.id) as TaskModel;
      const start = record.startDate, end = record.endDate;
      if (!(start instanceof Date) || !(end instanceof Date) || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
        throw new DomainError("SCHEDULE_UNRESOLVED", "A task has no calculated start or finish.", 422);
      }
      if (start.getTime() < Date.parse(task.notBefore) || end.getTime() > Date.parse(snapshot.horizonEndAt)) {
        throw new DomainError("SCHEDULE_OUT_OF_BOUNDS", "The calculated schedule exceeds its agreed start or modelling horizon.", 422);
      }
      taskDates.push(start, end);
      const baseline = record.baselines.first as Baseline | undefined;
      return {
        id: task.id, startAt: start.toISOString(), endAt: end.toISOString(), workingHours: record.duration,
        critical: record.critical, totalSlackHours: record.totalSlack,
        baseline: task.baseline && baseline ? {
          startAt: baseline.startDate.toISOString(), endAt: baseline.endDate.toISOString(),
          finishVarianceWorkingHours: workingHours(native.calendarManagerStore.getById(task.calendarId), end, baseline.endDate),
        } : null,
      };
    });
    const completionAt = tasks.find(task => task.id === snapshot.completionTaskId)!.endAt;
    const completion = new Date(completionAt), opening = new Date(snapshot.openingAt);
    // Capture calculated task fields before temporary allocation entities dirty
    // the graph. The whole isolated project is destroyed after the report.
    const criticalPaths = project.criticalPaths.map((path: { event: { id: string } }[]) => path.map(node => String(node.event.id)));
    const resourceConflicts = await capacityConflicts(native, snapshot, taskDates);
    const reasons: ScheduleEvaluation["reasons"] = [];
    if (completion > opening) reasons.push("opening_missed");
    if (resourceConflicts.length) reasons.push("resource_capacity_exceeded");
    return {
      schemaVersion: "guild.schedule-evaluation.v1",
      snapshotId: snapshot.id, snapshotRevision: snapshot.revision, snapshotDigest: digest(snapshot),
      engine: { name: "Bryntum Gantt Enterprise", version: "8.0.0" },
      provenance: snapshot.provenance, timeZone: snapshot.timeZone,
      completionAt, openingAt: opening.toISOString(),
      openingSlack: { wallClockHours: (opening.getTime() - completion.getTime()) / HOUR, workingHours: workingHours(native.calendar, completion, opening) },
      scheduleFeasible: reasons.length === 0, reasons, tasks,
      criticalPaths,
      resourceConflicts,
    };
  } finally { project.destroy(); }
}
