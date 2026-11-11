import type { ProjectModelConfig } from "@bryntum/gantt-enterprise";
import { scheduleSnapshotSchema, type ScheduleSnapshot } from "./contracts";

/** Both future views must consume the same project, rather than recalculate separate stores. */
export function buildBryntumProjectConfig(input: ScheduleSnapshot): Partial<ProjectModelConfig> {
  const snapshot = scheduleSnapshotSchema.parse(input);
  return {
    timeZone: snapshot.timeZone,
    startDate: new Date(snapshot.startAt),
    hoursPerDay: 8,
    daysPerWeek: 5,
    calendar: snapshot.projectCalendarId,
    maxCalendarRange: Date.parse(snapshot.horizonEndAt) - Date.parse(snapshot.startAt),
    autoSetConstraints: false,
    calendars: snapshot.calendars.map(calendar => ({
      id: calendar.id,
      name: calendar.name,
      unspecifiedTimeIsWorking: false,
      intervals: [
        ...calendar.workingDays.map(day => ({
          recurrentStartDate: `on ${day} at ${calendar.startTime}`,
          recurrentEndDate: `on ${day} at ${calendar.endTime}`,
          isWorking: true,
        })),
        ...calendar.unavailable.map(interval => ({
          startDate: new Date(interval.startAt), endDate: new Date(interval.endAt),
          isWorking: false, priority: 1000,
        })),
      ],
    })),
    tasks: snapshot.tasks.map(task => ({
      id: task.id,
      name: task.name,
      calendar: task.calendarId,
      duration: task.workingHours,
      durationUnit: "hour",
      slackUnit: "hour",
      constraintType: "startnoearlierthan",
      constraintDate: new Date(task.notBefore),
      baselines: task.baseline ? [{
        startDate: new Date(task.baseline.startAt), endDate: new Date(task.baseline.endAt),
        duration: task.baseline.workingHours, durationUnit: "hour",
      }] : [],
    })),
    dependencies: snapshot.dependencies.map((dependency, index) => ({
      id: `dependency-${index}`, fromEvent: dependency.fromTaskId, toEvent: dependency.toTaskId, type: 2,
    })),
    resources: snapshot.resources.map(resource => ({
      id: resource.id, name: resource.name, calendar: resource.calendarId, maxUnits: resource.capacityUnits,
    })),
    assignments: snapshot.tasks.filter(task => task.resourceId).map(task => ({
      id: `assignment-${task.id}`, event: task.id, resource: task.resourceId!, units: task.allocationUnits,
    })),
  };
}
