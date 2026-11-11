import { z } from "zod";

const identifier = z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/);
const instant = z.iso.datetime();
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const weekdays = z.enum(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
const dateRange = z.strictObject({ startAt: instant, endAt: instant }).refine(
  value => Date.parse(value.endAt) > Date.parse(value.startAt),
  "A calendar interval must end after it starts.",
);

const calendarSchema = z.strictObject({
  id: identifier,
  name: z.string().min(1).max(100),
  workingDays: z.array(weekdays).min(1).max(7),
  startTime: time,
  endTime: time,
  unavailable: z.array(dateRange).max(64),
}).superRefine((calendar, context) => {
  if (new Set(calendar.workingDays).size !== calendar.workingDays.length) {
    context.addIssue({ code: "custom", message: "Working days must be unique." });
  }
  if (calendar.endTime <= calendar.startTime) {
    context.addIssue({ code: "custom", message: "A working shift must end on the same day, after it starts." });
  }
});

/** A forecast is evidence about a model, never an award, acceptance, quote or payment. */
export const scheduleSnapshotSchema = z.strictObject({
  schemaVersion: z.literal("guild.schedule.v1"),
  id: identifier,
  revision: z.number().int().nonnegative(),
  provenance: z.strictObject({
    mode: z.literal("modelled"),
    clock: z.literal("accelerated_fixture"),
    disclosure: z.string().min(1).max(500),
  }),
  timeZone: z.string().max(100).refine(value => {
    try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; }
    catch { return false; }
  }, "Use a supported IANA time zone."),
  startAt: instant,
  horizonEndAt: instant,
  openingAt: instant,
  completionTaskId: identifier,
  projectCalendarId: identifier,
  calendars: z.array(calendarSchema).min(1).max(32),
  resources: z.array(z.strictObject({
    id: identifier,
    name: z.string().min(1).max(100),
    calendarId: identifier,
    capacityUnits: z.number().int().min(1).max(10_000),
  })).max(32),
  tasks: z.array(z.strictObject({
    id: identifier,
    name: z.string().min(1).max(100),
    calendarId: identifier,
    workingHours: z.number().min(0).max(160).multipleOf(0.25),
    // This is the agreed earliest start. Early predecessors cannot change it.
    notBefore: instant,
    resourceId: identifier.optional(),
    allocationUnits: z.number().int().min(1).max(10_000).default(100),
    baseline: z.strictObject({
      startAt: instant,
      endAt: instant,
      workingHours: z.number().min(0).max(160).multipleOf(0.25),
    }).optional(),
  })).min(1).max(64),
  dependencies: z.array(z.strictObject({ fromTaskId: identifier, toTaskId: identifier })).max(256),
}).superRefine((snapshot, context) => {
  const issue = (message: string) => context.addIssue({ code: "custom", message });
  const start = Date.parse(snapshot.startAt), end = Date.parse(snapshot.horizonEndAt);
  if (end <= start || end - start > 62 * 86_400_000) issue("The modelling horizon must be positive and no longer than 62 days.");
  const inHorizon = (date: string) => Date.parse(date) >= start && Date.parse(date) <= end;
  if (!inHorizon(snapshot.openingAt)) issue("Opening must fall within the modelling horizon.");
  for (const [label, records] of [["calendar", snapshot.calendars], ["resource", snapshot.resources], ["task", snapshot.tasks]] as const) {
    if (new Set(records.map(record => record.id)).size !== records.length) issue(`Duplicate ${label} ID.`);
  }
  const calendars = new Set(snapshot.calendars.map(calendar => calendar.id));
  const resources = new Set(snapshot.resources.map(resource => resource.id));
  const tasks = new Set(snapshot.tasks.map(task => task.id));
  if (!calendars.has(snapshot.projectCalendarId)) issue("Unknown project calendar.");
  if (!tasks.has(snapshot.completionTaskId)) issue("Unknown completion task.");
  for (const resource of snapshot.resources) if (!calendars.has(resource.calendarId)) issue(`Unknown calendar for ${resource.id}.`);
  for (const task of snapshot.tasks) {
    if (!calendars.has(task.calendarId)) issue(`Unknown calendar for ${task.id}.`);
    if (task.resourceId && !resources.has(task.resourceId)) issue(`Unknown resource for ${task.id}.`);
    if (!inHorizon(task.notBefore)) issue(`The earliest start for ${task.id} is outside the modelling horizon.`);
    if (task.baseline && (!inHorizon(task.baseline.startAt) || !inHorizon(task.baseline.endAt)
      || Date.parse(task.baseline.endAt) < Date.parse(task.baseline.startAt))) issue(`Invalid baseline for ${task.id}.`);
  }
  const successors = new Map(snapshot.tasks.map(task => [task.id, [] as string[]]));
  const dependencyIds = new Set<string>();
  for (const dependency of snapshot.dependencies) {
    const key = `${dependency.fromTaskId}:${dependency.toTaskId}`;
    if (dependencyIds.has(key)) issue("Duplicate dependency.");
    dependencyIds.add(key);
    if (!tasks.has(dependency.fromTaskId) || !tasks.has(dependency.toTaskId)) issue("A dependency refers to an unknown task.");
    else successors.get(dependency.fromTaskId)!.push(dependency.toTaskId);
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const cycle = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const next of successors.get(id) ?? []) if (cycle(next)) return true;
    visiting.delete(id); visited.add(id);
    return false;
  };
  if (snapshot.tasks.some(task => cycle(task.id))) issue("Dependency cycles are not schedulable.");
  else {
    const completionPaths = new Map<string, boolean>();
    const reachesCompletion = (id: string): boolean => {
      if (completionPaths.has(id)) return completionPaths.get(id)!;
      const reaches = id === snapshot.completionTaskId || (successors.get(id) ?? []).some(reachesCompletion);
      completionPaths.set(id, reaches);
      return reaches;
    };
    if (snapshot.tasks.some(task => !reachesCompletion(task.id))) issue("Every required task must feed the completion task.");
  }
});

export type ScheduleSnapshot = z.infer<typeof scheduleSnapshotSchema>;

export interface ResourceConflict {
  resourceId: string;
  startAt: string;
  endAt: string;
  taskIds: string[];
  allocatedUnits: number;
  capacityUnits: number;
}

export interface ScheduleEvaluation {
  schemaVersion: "guild.schedule-evaluation.v1";
  snapshotId: string;
  snapshotRevision: number;
  snapshotDigest: string;
  engine: { name: "Bryntum Gantt Enterprise"; version: "8.0.0" };
  provenance: ScheduleSnapshot["provenance"];
  timeZone: string;
  completionAt: string;
  openingAt: string;
  openingSlack: { wallClockHours: number; workingHours: number };
  scheduleFeasible: boolean;
  reasons: ("opening_missed" | "resource_capacity_exceeded")[];
  tasks: {
    id: string;
    startAt: string;
    endAt: string;
    workingHours: number;
    critical: boolean;
    totalSlackHours: number;
    baseline: null | { startAt: string; endAt: string; finishVarianceWorkingHours: number };
  }[];
  criticalPaths: string[][];
  resourceConflicts: ResourceConflict[];
}
