import type { ScheduleSnapshot } from "./contracts";

export const modelledRecoveryOptions = [
  { id: "economy", name: "Economy replacement", providerPriceMinor: 13_000, workingHours: 24 },
  { id: "accessible", name: "Accessible replacement", providerPriceMinor: 16_000, workingHours: 8 },
] as const;

/** Qualification data: these prices and availability are not provider offers. */
export function openingRecoveryFixture(optionId: typeof modelledRecoveryOptions[number]["id"]): ScheduleSnapshot {
  const option = modelledRecoveryOptions.find(candidate => candidate.id === optionId)!;
  const startAt = "2026-11-12T14:00:00.000Z";
  const specs = [
    ["research", "Research", 8, startAt],
    ["translation", "Translation", 8, startAt],
    ["narration", "Narration", 8, startAt],
    ["captions", "Captions and easy read", 4, startAt],
    ["images", "Image treatment", 6, "2026-11-16T14:00:00.000Z"],
    ["web", option.name, option.workingHours, "2026-11-17T20:00:00.000Z"],
    ["curator", "Curator review", 4, "2026-11-17T20:00:00.000Z"],
  ] as const;
  return {
    schemaVersion: "guild.schedule.v1", id: `opening-${option.id}`, revision: 1,
    provenance: {
      mode: "modelled", clock: "accelerated_fixture",
      disclosure: "Modelled opening-week comparison. No provider quote, completed work, human acceptance or payment is established by this fixture.",
    },
    timeZone: "America/New_York", startAt, horizonEndAt: "2026-11-30T23:00:00.000Z",
    openingAt: "2026-11-20T15:00:00.000Z", completionTaskId: "curator", projectCalendarId: "museum",
    calendars: [{ id: "museum", name: "Museum working hours", workingDays: ["Mon", "Tue", "Wed", "Thu", "Fri"], startTime: "09:00", endTime: "17:00", unavailable: [] }],
    resources: specs.map(([id, name]) => ({ id: `${id}-provider`, name, calendarId: "museum", capacityUnits: 100 })),
    tasks: specs.map(([id, name, workingHours, notBefore]) => ({
      id, name, calendarId: "museum", workingHours, notBefore, resourceId: `${id}-provider`, allocationUnits: 100,
      ...(id === "images" ? { baseline: { startAt: "2026-11-16T14:00:00.000Z", endAt: "2026-11-16T22:00:00.000Z", workingHours: 8 } } : {}),
    })),
    dependencies: [
      ["research", "translation"], ["translation", "narration"], ["narration", "captions"],
      ["research", "web"], ["translation", "web"], ["captions", "web"], ["images", "web"], ["web", "curator"],
    ].map(([fromTaskId, toTaskId]) => ({ fromTaskId: fromTaskId!, toTaskId: toTaskId! })),
  };
}
