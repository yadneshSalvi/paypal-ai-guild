import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { DomainError, digest } from "../src/domain/primitives";
import { scheduleSnapshotSchema, type ScheduleSnapshot } from "../src/scheduling/contracts";
import { evaluateSchedule } from "../src/scheduling/model";
import { modelledRecoveryOptions, openingRecoveryFixture } from "../src/scheduling/opening-fixture";

const require = createRequire(import.meta.url);
const task = (snapshot: ScheduleSnapshot, id: string) => snapshot.tasks.find(value => value.id === id)!;
const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;

test("qualified native modules are the installed pinned Enterprise 8 packages", () => {
  for (const product of ["gantt", "scheduler", "engine", "core"]) {
    assert.equal(require(`@bryntum/${product}-enterprise/package.json`).version, "8.0.0");
  }
});

test("parallel isolated engine models reproduce both opening-week options and preserve their source snapshots", async () => {
  const economy = openingRecoveryFixture("economy"), accessible = openingRecoveryFixture("accessible");
  const source = JSON.stringify([economy, accessible]);
  const [late, onTime] = await Promise.all([evaluateSchedule(economy), evaluateSchedule(accessible)]);
  assert.equal(JSON.stringify([economy, accessible]), source);
  assert.equal(late.snapshotDigest, digest(economy));
  assert.equal(onTime.snapshotDigest, digest(accessible));
  assert.equal(late.tasks.find(value => value.id === "web")!.endAt, "2026-11-20T20:00:00.000Z");
  assert.equal(late.completionAt, "2026-11-23T16:00:00.000Z");
  assert.deepEqual(late.openingSlack, { wallClockHours: -73, workingHours: -9 });
  assert.deepEqual(late.reasons, ["opening_missed"]);
  assert.equal(late.scheduleFeasible, false);
  assert.equal(onTime.tasks.find(value => value.id === "web")!.endAt, "2026-11-18T20:00:00.000Z");
  assert.equal(onTime.completionAt, "2026-11-19T16:00:00.000Z");
  assert.deepEqual(onTime.openingSlack, { wallClockHours: 23, workingHours: 7 });
  assert.equal(onTime.scheduleFeasible, true);
  assert.deepEqual(onTime.resourceConflicts, []);
  for (const result of [late, onTime]) {
    assert.deepEqual(result.criticalPaths, [["web", "curator"]]);
    assert.equal(result.tasks.find(value => value.id === "curator")!.workingHours, 4);
    assert.equal(result.provenance.mode, "modelled");
  }
  assert.deepEqual(modelledRecoveryOptions.map(option => option.providerPriceMinor), [13_000, 16_000]);
});

test("native baselines report both signs of working-time variance and preserve the agreed dependent start", async () => {
  const input = openingRecoveryFixture("accessible");
  const early = await evaluateSchedule(input);
  assert.equal(early.tasks.find(value => value.id === "images")!.baseline!.finishVarianceWorkingHours, 2);
  assert.equal(early.tasks.find(value => value.id === "web")!.startAt, "2026-11-17T20:00:00.000Z");
  task(input, "images").workingHours = 10;
  const late = await evaluateSchedule(input);
  assert.equal(late.tasks.find(value => value.id === "images")!.endAt, "2026-11-17T16:00:00.000Z");
  assert.equal(late.tasks.find(value => value.id === "images")!.baseline!.finishVarianceWorkingHours, -2);
  assert.equal(late.tasks.find(value => value.id === "web")!.startAt, "2026-11-17T20:00:00.000Z");
});

test("native allocation catches a short overlapping booking instead of averaging it across a day", async () => {
  const input = openingRecoveryFixture("accessible");
  Object.assign(task(input, "images"), { resourceId: "web-provider", notBefore: "2026-11-17T20:30:00.000Z", workingHours: 0.5 });
  input.dependencies = input.dependencies.filter(dependency => dependency.fromTaskId !== "images");
  input.dependencies.push({ fromTaskId: "images", toTaskId: "curator" });
  const busy = await evaluateSchedule(input);
  assert.equal(busy.scheduleFeasible, false);
  assert.deepEqual(busy.reasons, ["resource_capacity_exceeded"]);
  assert.deepEqual(busy.resourceConflicts, [{
    resourceId: "web-provider", startAt: "2026-11-17T20:30:00.000Z", endAt: "2026-11-17T21:00:00.000Z",
    taskIds: ["images", "web"], allocatedUnits: 200, capacityUnits: 100,
  }]);
  input.resources.find(resource => resource.id === "web-provider")!.capacityUnits = 200;
  const available = await evaluateSchedule(input);
  assert.equal(available.scheduleFeasible, true);
  assert.deepEqual(available.resourceConflicts, []);
});

test("provider time off changes the actual engine finish and can make the faster candidate late", async () => {
  const input = openingRecoveryFixture("accessible");
  input.calendars.push({ ...structuredClone(input.calendars[0]!), id: "provider-time-off", unavailable: [{ startAt: "2026-11-18T14:00:00.000Z", endAt: "2026-11-18T22:00:00.000Z" }] });
  input.resources.find(resource => resource.id === "web-provider")!.calendarId = "provider-time-off";
  const result = await evaluateSchedule(input);
  assert.equal(result.tasks.find(value => value.id === "web")!.endAt, "2026-11-19T20:00:00.000Z");
  assert.equal(result.completionAt, "2026-11-20T16:00:00.000Z");
  assert.deepEqual(result.reasons, ["opening_missed"]);
  assert.deepEqual(result.openingSlack, { wallClockHours: -1, workingHours: -1 });
});

for (const scenario of [
  { name: "fall-back", start: "2026-10-30T13:00:00.000Z", release: "2026-10-30T19:00:00.000Z", finish: "2026-11-02T20:00:00.000Z", opening: "2026-11-03T15:00:00.000Z", horizon: "2026-11-05T23:00:00.000Z" },
  { name: "spring-forward", start: "2027-03-12T14:00:00.000Z", release: "2027-03-12T20:00:00.000Z", finish: "2027-03-15T19:00:00.000Z", opening: "2027-03-16T14:00:00.000Z", horizon: "2027-03-18T22:00:00.000Z" },
]) test(`IANA working shifts survive the ${scenario.name} weekend with UTC storage`, async () => {
  const input = openingRecoveryFixture("accessible");
  Object.assign(input, { startAt: scenario.start, horizonEndAt: scenario.horizon, openingAt: scenario.opening, completionTaskId: "web", dependencies: [] });
  input.tasks = [{ ...task(input, "web"), notBefore: scenario.release }];
  input.resources = input.resources.filter(resource => resource.id === "web-provider");
  const result = await evaluateSchedule(input);
  assert.equal(result.completionAt, scenario.finish);
  assert.equal(result.tasks[0]!.workingHours, 8);
});

test("strict snapshots reject broken references, cycles, omitted completion edges and injected authority", () => {
  const mutations: ((input: ScheduleSnapshot) => unknown)[] = [
    input => { input.dependencies.push({ fromTaskId: "curator", toTaskId: "research" }); return input; },
    input => { input.dependencies[0]!.fromTaskId = "missing"; return input; },
    input => { task(input, "web").resourceId = "missing"; return input; },
    input => { input.tasks.push(structuredClone(input.tasks[0]!)); return input; },
    input => { input.dependencies = input.dependencies.filter(dependency => dependency.fromTaskId !== "images"); return input; },
    input => ({ ...input, approved: true, amountMinor: 16_000 }),
    input => ({ ...input, provenance: { ...input.provenance, mode: "production" } }),
    input => ({ ...input, timeZone: "Unknown/Zone" }),
    input => ({ ...input, startAt: "2026-11-12T09:00:00" }),
    input => { input.calendars[0]!.workingDays = ["Mon", "Mon"]; return input; },
  ];
  for (const mutate of mutations) assert.equal(scheduleSnapshotSchema.safeParse(mutate(openingRecoveryFixture("accessible"))).success, false);
});

test("nonintersecting resource and task calendars cancel instead of silently ignoring availability", { timeout: 5_000 }, async () => {
  const input = openingRecoveryFixture("accessible");
  input.calendars.push({ ...structuredClone(input.calendars[0]!), id: "weekend-only", workingDays: ["Sat", "Sun"] });
  input.resources.find(resource => resource.id === "web-provider")!.calendarId = "weekend-only";
  await assert.rejects(evaluateSchedule(input), code("SCHEDULE_CONFLICT"));
});

test("an engine result outside the bounded modelling horizon cannot become feasible", async () => {
  const input = openingRecoveryFixture("economy");
  input.horizonEndAt = "2026-11-20T23:00:00.000Z";
  await assert.rejects(evaluateSchedule(input), code("SCHEDULE_OUT_OF_BOUNDS"));
});
