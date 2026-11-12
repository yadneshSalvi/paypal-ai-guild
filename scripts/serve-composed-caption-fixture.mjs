import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { verifyCaptionCompositionFreeze } from "./verify-composed-caption-freeze.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."), fixtureFile = resolve(process.argv[2] ?? "missing-fixture");
const fixture = JSON.parse(readFileSync(fixtureFile, "utf8")), database = new URL(fixture.databaseUrl);
assert.equal(fixture.version, "guild.synthetic-composed-caption-web-fixture.v1"); assert.match(fixture.label, /^(http|native)-[a-z0-9-]{1,40}$/);
assert.match(fixture.disclosure, /^SYNTHETIC CAPTION\/WEB FIXTURE\./); assert.equal(fixture.cookieName, "guild_composed_caption_web_v1");
assert.equal(database.hostname, "localhost"); assert.equal(database.port, "55562"); assert.equal(database.username, "guild_caption_web_app"); assert.equal(database.pathname, "/guild_caption_web_tests");
assert.match(database.searchParams.get("options") ?? "", /^-c search_path=guild_caption_web_fixture_[a-f0-9]{32}$/);
assert.ok(isAbsolute(database.searchParams.get("host") ?? "")); assert.match(basename(database.searchParams.get("host") ?? ""), /^guild-caption-web-pg-[a-z0-9_]+$/);
assert.equal(fixture.session.role, "owner"); assert.ok(Date.parse(fixture.session.expiresAt) > Date.now(), "The frozen owner expired; do not change or replace it implicitly.");
assert.ok(!readdirSync(root).some(name => name.startsWith(".env") && name !== ".env.example"));
const buildId = readFileSync(resolve(root, ".next/BUILD_ID"), "utf8").trim(), freezeArgument = process.argv[3];
if (freezeArgument === "--qa-unfrozen") assert.ok(fixture.label.startsWith("http-"), "Only the separate destructive HTTP fixture can run before the final freeze.");
else {
  assert.ok(freezeArgument, "A native launch requires the exact final source/build/dependency freeze.");
  const freezeFile = resolve(freezeArgument), verification = verifyCaptionCompositionFreeze(root, freezeFile, fixtureFile);
  const auditFile = resolve(dirname(fixtureFile), `runtime-cache-launch-${Date.now()}-${process.pid}.json`);
  writeFileSync(auditFile, JSON.stringify(verification, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ event: "caption_composition_freeze_verified", buildId, verifiedFiles: verification.verifiedFiles, verifiedLinks: verification.verifiedLinks,
    generatedRouteCacheFiles: verification.runtimePageCache.files.length, auditFile, disclosure: verification.runtimePageCache.disclosure }));
}
await new Promise((accept, reject) => {
  const probe = net.createServer(); probe.once("error", reject); probe.listen(4554, "127.0.0.1", () => probe.close(accept));
});
const audit = resolve(dirname(fixtureFile), "server-transport.jsonl");
const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1",
  DATABASE_URL: fixture.databaseUrl, AUTH_SECRET: fixture.authSecret, JUDGE_SESSION_SECRET: fixture.sessionSecret, GUILD_SESSION_COOKIE: fixture.cookieName,
  BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_publicationfixture_synthetic-only", PUBLICATION_FIXTURE_FILE: fixtureFile, PUBLICATION_FIXTURE_AUDIT: audit,
  PORT: "4554", OPENAI_API_KEY: "", GEMINI_API_KEY: "", DEEPGRAM_API_KEY: "" };
const child = spawn(process.execPath, ["--import", resolve(root, "scripts/composed-caption-fixture-preload.mjs"), resolve(root, "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", "4554"], { cwd: root, env, stdio: "inherit" });
console.log(JSON.stringify({ event: "synthetic_composed_web_server", label: fixture.label, sourceRoot: root, port: 4554, pid: child.pid, buildId, fixtureFile, audit, disclosure: fixture.disclosure }));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => { if (signal) console.log(JSON.stringify({ event: "synthetic_composed_web_server_exit", signal })); process.exitCode = code ?? 0; });
