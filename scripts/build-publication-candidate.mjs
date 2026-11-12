import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
assert.ok(!readdirSync(root).some(name => name.startsWith(".env") && name !== ".env.example"), "An isolated publication build cannot contain application environment files.");
const child = spawn(process.execPath, [resolve(root, "node_modules/next/dist/bin/next"), "build"], { cwd: root, stdio: "inherit",
  env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" } });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", code => { process.exitCode = code ?? 1; });
