import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."), fixtureFile = resolve(process.argv[2] ?? "missing-fixture");
const fixture = JSON.parse(readFileSync(fixtureFile, "utf8"));
assert.equal(fixture.version, "guild.synthetic-publication-fixture.v1"); assert.match(fixture.label, /^(http|native)-[a-z0-9-]{1,40}$/);
assert.match(fixture.disclosure, /^SYNTHETIC PUBLICATION FIXTURE\./); assert.equal(fixture.cookieName, "guild_publication_v1");
const database = new URL(fixture.databaseUrl);
assert.equal(database.hostname, "127.0.0.1"); assert.equal(database.port, "55496"); assert.equal(database.username, "guild_web_fixture"); assert.equal(database.pathname, "/guild_web_tests");
assert.match(database.searchParams.get("options"), /^-c search_path=guild_publication_fixture_[a-f0-9]{32}$/);
assert.equal(fixture.session.role, "owner");
assert.ok(Date.parse(fixture.session.expiresAt) > Date.now(), "The frozen owner session expired. Do not extend or recreate it implicitly.");
assert.ok(!readdirSync(root).some(name => name.startsWith(".env") && name !== ".env.example"), "Private application environment files are forbidden in this isolated source copy.");
const buildId = readFileSync(resolve(root, ".next/BUILD_ID"), "utf8").trim();
const freezeFile = process.argv[3];
if (freezeFile) {
  const freeze = JSON.parse(readFileSync(resolve(freezeFile), "utf8"));
  assert.equal(freeze.buildId, buildId); assert.equal(freeze.sourceRoot, root);
  for (const item of freeze.files) {
    assert.ok(!item.path.startsWith("/") && !item.path.split("/").includes(".."));
    assert.equal(createHash("sha256").update(readFileSync(resolve(root, item.path))).digest("hex"), item.sha256, `Frozen source/build changed: ${item.path}`);
  }
  for (const item of freeze.symlinks ?? []) {
    assert.ok(!item.path.startsWith("/") && !item.path.split("/").includes(".."));
    assert.equal(readlinkSync(resolve(root, item.path)), item.target, `Frozen dependency link changed: ${item.path}`);
  }
  const frozenFixture = freeze.fixtures.find(item => resolve(item.path) === fixtureFile); assert.ok(frozenFixture);
  assert.equal(createHash("sha256").update(readFileSync(fixtureFile)).digest("hex"), frozenFixture.sha256);
  for (const item of freeze.privateFiles ?? []) {
    assert.ok(!item.path.startsWith("/") && !item.path.split("/").includes(".."));
    assert.equal(createHash("sha256").update(readFileSync(resolve(dirname(resolve(freezeFile)), item.path))).digest("hex"), item.sha256, `Frozen fixture changed: ${item.path}`);
  }
}
const audit = resolve(dirname(fixtureFile), "server-transport.jsonl");
// A small explicit environment prevents inherited provider, browser and original
// database credentials from reaching this synthetic server. No .env is loaded.
const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1",
  DATABASE_URL: fixture.databaseUrl, AUTH_SECRET: fixture.authSecret, JUDGE_SESSION_SECRET: fixture.sessionSecret, GUILD_SESSION_COOKIE: fixture.cookieName,
  BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_publicationfixture_synthetic-only", PUBLICATION_FIXTURE_FILE: fixtureFile, PUBLICATION_FIXTURE_AUDIT: audit,
  PORT: "4542", OPENAI_API_KEY: "", DEEPGRAM_API_KEY: "" };
const child = spawn(process.execPath, ["--import", resolve(root, "scripts/publication-fixture-preload.mjs"), resolve(root, "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", "4542"], { cwd: root, env, stdio: "inherit" });
console.log(JSON.stringify({ event: "synthetic_publication_server", label: fixture.label, sourceRoot: root, port: 4542, pid: child.pid, buildId, fixtureFile, audit, disclosure: fixture.disclosure }));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => { if (signal) console.log(JSON.stringify({ event: "synthetic_publication_server_exit", signal })); process.exitCode = code ?? 0; });
