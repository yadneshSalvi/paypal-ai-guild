import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { evaluateSchedule } from "../src/scheduling/model";
import { modelledRecoveryOptions, openingRecoveryFixture } from "../src/scheduling/opening-fixture";

const require = createRequire(import.meta.url);
const versions = Object.fromEntries(["gantt", "scheduler", "engine", "core"].map(product => {
  const name = `@bryntum/${product}-enterprise`;
  const version = require(`${name}/package.json`).version as string;
  assert.equal(version, "8.0.0");
  return [name, version];
}));
const results = await Promise.all(modelledRecoveryOptions.map(async option => ({
  modelledOption: option, evaluation: await evaluateSchedule(openingRecoveryFixture(option.id)),
})));
assert.equal(results[0]!.evaluation.completionAt, "2026-11-23T16:00:00.000Z");
assert.equal(results[0]!.evaluation.scheduleFeasible, false);
assert.equal(results[1]!.evaluation.completionAt, "2026-11-19T16:00:00.000Z");
assert.equal(results[1]!.evaluation.scheduleFeasible, true);
assert.equal(results[1]!.evaluation.openingSlack.wallClockHours, 23);
const sourceFiles = [
  "src/scheduling/contracts.ts", "src/scheduling/configuration.ts", "src/scheduling/model.ts",
  "src/scheduling/bryntum-modules.d.ts", "src/scheduling/opening-fixture.ts", "tests/scheduling.test.ts", "scripts/qualify-scheduling.ts",
];
const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async path => [path, createHash("sha256").update(await readFile(path)).digest("hex")])));
console.log(JSON.stringify({
  schemaVersion: "guild.scheduling-qualification.v1", recordedAt: new Date().toISOString(), executionMode: "local_engine_only",
  versions, sourceHashes, results,
  scope: ["native Gantt Enterprise ProjectModel", "IANA working calendars", "finish-to-start dependencies", "native resource allocation", "native critical paths and baselines", "isolated immutable input simulations"],
  notEstablished: [
    "Shared rendered Gantt and Scheduler views or browser license qualification", "Native AI panel or validated command gateway",
    "Authentic provider quotes, expiry checks, awards or agreed availability", "Human review, accepted production or payment",
    "Persisted schedule revision and approval workflow", "Hosted runtime and clean-install parity",
  ],
}, null, 2));
