import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

test("provider invitation and agent access UI preserves original authority, recovery and one-time tokens", { timeout: 90_000 }, async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."), evidence = process.env.GUILD_PROVIDER_ACCESS_UI_EVIDENCE_DIR ?? await mkdtemp(resolve(tmpdir(), "guild-provider-access-test-"));
  const result = await promisify(execFile)(process.execPath, [resolve(root, "scripts/check-provider-access-ui.mjs"), evidence], {
    cwd: root, env: { NODE_ENV: "test", PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: "en_US.UTF-8", NEXT_TELEMETRY_DISABLED: "1",
      OPENAI_API_KEY: "", GEMINI_API_KEY: "", DEEPGRAM_API_KEY: "", BLOB_READ_WRITE_TOKEN: "", PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "" }, maxBuffer: 1_000_000, timeout: 20_000, killSignal: "SIGTERM",
  });
  const summary = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
  const report = JSON.parse(await readFile(summary.reportPath, "utf8"));
  assert.equal(report.passed, true); assert.ok(report.checks.length >= 35); assert.equal(report.realNetworkCalls, 0); assert.equal(report.databaseCalls, 0);
  assert.equal(report.nativeBrowserClaimed, false); assert.deepEqual(report.changedSources, []); assert.deepEqual(report.consoleErrors, []);
});
