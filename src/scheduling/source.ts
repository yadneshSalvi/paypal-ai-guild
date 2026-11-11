import type { Commission, WorkPackage } from "@/contracts/guild";
import { digest, DomainError } from "@/domain/primitives";
import { scheduleSnapshotSchema, type ScheduleSnapshot } from "./contracts";
import { scheduleSourceSchema, type ScheduleSource } from "./persisted";

export function schedulingContractDigest(pkg: WorkPackage) {
  return digest({ id: pkg.id, contractVersion: pkg.contractVersion, providerId: pkg.providerId,
    providerAwardMinor: pkg.providerAwardMinor, serviceFeeMinor: pkg.serviceFeeMinor, grossMinor: pkg.grossMinor,
    workingHours: pkg.workingHours, dependsOn: pkg.dependsOn, acceptancePackDigest: pkg.acceptancePack.digest,
    inputPolicy: pkg.inputPolicy ?? "accepted" });
}
export function scheduleSource(c: Commission): ScheduleSource {
  return scheduleSourceSchema.parse({ commissionId: c.id, openingAt: c.openingAt, timeZone: c.timezone,
    contracts: c.packages.map(pkg => {
      const provider = c.providers.find(item => item.id === pkg.providerId);
      if (!provider) throw new DomainError("SCHEDULE_PROVIDER", "The contracted provider is unavailable.", 422, false);
      return { packageId: pkg.id, contractVersion: pkg.contractVersion, contractDigest: schedulingContractDigest(pkg),
        acceptancePackDigest: pkg.acceptancePack.digest, providerId: pkg.providerId,
        providerPolicyDigest: provider.policyDigest, providerCapacity: provider.capacity,
        providerAwardMinor: pkg.providerAwardMinor, serviceFeeMinor: pkg.serviceFeeMinor,
        workingHours: pkg.workingHours, dependsOn: pkg.dependsOn,
        artifacts: pkg.artifactIds.map(id => { const item = c.artifacts.find(item => item.id === id);
          if (!item) throw new DomainError("SCHEDULE_ARTIFACT", "The schedule's source artifact is unavailable.", 422, false);
          return { id, hash: item.contentHash }; }),
      };
    }),
  });
}

export const museumWorkingCalendar: ScheduleSnapshot["calendars"][number] = {
  id: "museum", name: "Museum · Monday–Friday, 9–5", workingDays: ["Mon", "Tue", "Wed", "Thu", "Fri"],
  startTime: "09:00", endTime: "17:00", unavailable: [],
};

/** Forecast every remaining contract; never present these dates as observed completion. */
export function forecastFromCommission(c: Commission): ScheduleSnapshot {
  if (c.timezone !== "America/New_York") throw new DomainError("SCHEDULE_TIME_ZONE", "Review a provider calendar for this museum's time zone before planning.", 422, false);
  const startAt = new Date(Date.parse(c.openingAt) - 8 * 86_400_000 - 3_600_000).toISOString();
  const providerIds = [...new Set(c.packages.map(pkg => pkg.providerId))];
  const tasks: ScheduleSnapshot["tasks"] = c.packages.map(pkg => ({
    id: pkg.id, name: pkg.title, calendarId: "museum", workingHours: pkg.workingHours,
    notBefore: startAt, resourceId: pkg.providerId, allocationUnits: 100,
  }));
  tasks.push({ id: "curator", name: "Curator review · four working hours", calendarId: "museum", workingHours: 4, notBefore: startAt, resourceId: "curator", allocationUnits: 100 });
  const dependencies = c.packages.flatMap(pkg => pkg.dependsOn.map(fromTaskId => ({ fromTaskId, toTaskId: pkg.id })));
  // Every terminal branch feeds the curator, including a newly added package.
  for (const pkg of c.packages) if (!dependencies.some(edge => edge.fromTaskId === pkg.id)) dependencies.push({ fromTaskId: pkg.id, toTaskId: "curator" });
  return scheduleSnapshotSchema.parse({ schemaVersion: "guild.schedule.v1", id: `commission-${c.id}`, revision: 1,
    provenance: { mode: "modelled", clock: "accelerated_fixture", disclosure: "Opening-week forecast from the current contracts. Scenario dates model business turnaround; they are not observed completion or authority to work. Quote and Passport expiry use real time." },
    timeZone: c.timezone, startAt, horizonEndAt: new Date(Date.parse(c.openingAt) + 10 * 86_400_000).toISOString(), openingAt: c.openingAt,
    completionTaskId: "curator", projectCalendarId: "museum", calendars: [structuredClone(museumWorkingCalendar)], tasks, dependencies,
    resources: [...providerIds.map(id => ({ id, name: c.providers.find(p => p.id === id)!.name, calendarId: "museum", capacityUnits: c.providers.find(p => p.id === id)!.capacity * 100 })), { id: "curator", name: "Museum curator", calendarId: "museum", capacityUnits: 100 }],
  });
}
