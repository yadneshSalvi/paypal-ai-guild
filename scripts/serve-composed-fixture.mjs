import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."), fixtureFile = resolve(process.argv[2] ?? "missing-fixture");
const fixture = JSON.parse(readFileSync(fixtureFile, "utf8")), database = new URL(fixture.databaseUrl);
assert.equal(fixture.version, "guild.synthetic-composed-web-fixture.v1"); assert.match(fixture.label, /^(http|native)-[a-z0-9-]{1,40}$/);
assert.match(fixture.disclosure, /^SYNTHETIC PUBLICATION FIXTURE\./); assert.equal(fixture.cookieName, "guild_composed_web_v1");
assert.equal(database.hostname, "localhost"); assert.equal(database.port, "55561"); assert.equal(database.username, "guild_composed_app"); assert.equal(database.pathname, "/guild_composed_web_tests");
assert.match(database.searchParams.get("options") ?? "", /^-c search_path=guild_composition_fixture_[a-f0-9]{32}$/);
assert.ok(isAbsolute(database.searchParams.get("host") ?? "")); assert.match(basename(database.searchParams.get("host") ?? ""), /^guild-composed-pg-[a-z0-9_]+$/);
assert.equal(fixture.session.role, "owner"); assert.ok(Date.parse(fixture.session.expiresAt) > Date.now(), "The frozen owner expired; do not change or replace it implicitly.");
assert.ok(!readdirSync(root).some(name => name.startsWith(".env") && name !== ".env.example"));
const buildId = readFileSync(resolve(root, ".next/BUILD_ID"), "utf8").trim(), freezeArgument = process.argv[3];
if (freezeArgument === "--qa-unfrozen") assert.ok(fixture.label.startsWith("http-"), "Only the separate destructive HTTP fixture can run before the final freeze.");
else {
  assert.ok(freezeArgument, "A native launch requires the exact final source/build/dependency freeze.");
  const freezeFile = resolve(freezeArgument), freeze = JSON.parse(readFileSync(freezeFile, "utf8"));
  assert.equal(freeze.version, "guild.web-composition-freeze.v1"); assert.equal(freeze.sourceRoot, root); assert.equal(freeze.buildId, buildId);
  assert.equal(process.version, freeze.node.version); assert.equal(createHash("sha256").update(readFileSync(process.execPath)).digest("hex"), freeze.node.sha256);
  for (const file of freeze.files) {
    assert.ok(!file.path.startsWith("/") && !file.path.split("/").includes(".."));
    assert.equal(createHash("sha256").update(readFileSync(resolve(root, file.path))).digest("hex"), file.sha256, "Frozen input changed: " + file.path);
    assert.equal(statSync(resolve(root, file.path)).mode & 0o777, file.mode, "Frozen input permissions changed: " + file.path);
  }
  for (const link of freeze.symlinks) assert.equal(readlinkSync(resolve(root, link.path)), link.target, "Frozen dependency link changed: " + link.path);
  const actualFiles = [], actualLinks = [];
  const excluded = path => freeze.excludedRuntimePaths.some(item => item.endsWith("/") ? path.startsWith(item) : path === item);
  function inventory(directory, scope) {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, item.name), local = absolute.slice(root.length + 1).replaceAll("\\", "/");
      if (excluded(local)) continue;
      if (scope === "source" && (freeze.excludedSourceDirectories.includes(item.name) && item.isDirectory() || item.name.endsWith(".log") || item.name.endsWith(".tsbuildinfo") || item.name === ".source-baseline.json")) continue;
      if (item.isSymbolicLink()) actualLinks.push(local);
      else if (item.isDirectory()) inventory(absolute, scope);
      else if (item.isFile()) actualFiles.push(local);
    }
  }
  inventory(root, "source"); inventory(resolve(root, "node_modules"), "dependency"); inventory(resolve(root, ".next"), "build");
  assert.deepEqual(actualFiles.sort(), freeze.files.map(file => file.path).sort(), "Unexpected or missing frozen source/dependency/build files.");
  assert.deepEqual(actualLinks.sort(), freeze.symlinks.map(link => link.path).sort(), "Unexpected or missing frozen runtime links.");
  const frozenFixture = freeze.fixtures.find(file => resolve(file.path) === fixtureFile); assert.ok(frozenFixture);
  assert.equal(createHash("sha256").update(readFileSync(fixtureFile)).digest("hex"), frozenFixture.sha256);
  for (const file of freeze.privateFiles) {
    assert.ok(!file.path.startsWith("/") && !file.path.split("/").includes(".."));
    assert.equal(createHash("sha256").update(readFileSync(resolve(dirname(freezeFile), file.path))).digest("hex"), file.sha256, "Frozen fixture input changed: " + file.path);
  }
}
await new Promise((accept, reject) => {
  const probe = net.createServer(); probe.once("error", reject); probe.listen(4550, "127.0.0.1", () => probe.close(accept));
});
const audit = resolve(dirname(fixtureFile), "server-transport.jsonl");
const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1",
  DATABASE_URL: fixture.databaseUrl, AUTH_SECRET: fixture.authSecret, JUDGE_SESSION_SECRET: fixture.sessionSecret, GUILD_SESSION_COOKIE: fixture.cookieName,
  BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_publicationfixture_synthetic-only", PUBLICATION_FIXTURE_FILE: fixtureFile, PUBLICATION_FIXTURE_AUDIT: audit,
  PORT: "4550", OPENAI_API_KEY: "", GEMINI_API_KEY: "", DEEPGRAM_API_KEY: "" };
const child = spawn(process.execPath, ["--import", resolve(root, "scripts/composed-fixture-preload.mjs"), resolve(root, "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", "4550"], { cwd: root, env, stdio: "inherit" });
console.log(JSON.stringify({ event: "synthetic_composed_web_server", label: fixture.label, sourceRoot: root, port: 4550, pid: child.pid, buildId, fixtureFile, audit, disclosure: fixture.disclosure }));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => { if (signal) console.log(JSON.stringify({ event: "synthetic_composed_web_server_exit", signal })); process.exitCode = code ?? 0; });
