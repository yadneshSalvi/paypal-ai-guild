import test from "node:test";
import assert from "node:assert/strict";
import { HostedTransportUncertain } from "@/server/web/hosted-transport";
import { VercelHostedSandboxDriver } from "@/server/web/hosted-session";
import { hostedVerifyCommand } from "@/server/web/hosted-commands";
import { hostedWebFixture } from "./support/hosted-web";
process.env.AUTH_SECRET = "synthetic-hosted-sdk-seal-only";
const name = "guild-web-" + "a".repeat(40), sessionId = "sbx_synthetic_original";
function wire(status = "running") {
  const at = Date.now();
  return { sandbox: { name, persistent: false, currentSessionId: sessionId, status, createdAt: at, updatedAt: at },
    session: { id: sessionId, status, vcpus: 2, memory: 4096, region: "iad1", timeout: 600000, requestedAt: at, createdAt: at, updatedAt: at, cwd: "/vercel/sandbox", sourceSnapshotId: "snap_synthetic", networkPolicy: { mode: "deny-all" } }, routes: [] };
}
const authenticate = async () => ({ token: "synthetic-opaque-token", teamId: "team_synthetic", projectId: "prj_synthetic" });

test("installed SDK create uses exact snapshot, bounded2CPU, denied network, no ports or injected credentials", async () => {
  const { configuration } = await hostedWebFixture(); let posts = 0;
  const driver = new VercelHostedSandboxDriver(async (input, init) => {
    assert.equal(new URL(String(input)).searchParams.get("teamId"), "team_synthetic"); assert.equal(init?.method, "POST"); posts++;
    const body = JSON.parse(String(init.body)); assert.equal(body.name, name); assert.equal(body.persistent, false); assert.deepEqual(body.resources, { vcpus: 2 });
    assert.deepEqual(body.source, { type: "snapshot", snapshotId: configuration.metadata.snapshot.id }); assert.deepEqual(body.networkPolicy, { mode: "deny-all" });
    assert.deepEqual(body.ports, []); assert.deepEqual(body.env, {}); assert.equal(body.timeout, 600000); assert.equal(body.region, "iad1");
    return Response.json(wire());
  }, authenticate);
  const session = await driver.create(name, configuration);
  assert.equal(posts, 1); assert.equal(session.identity.sessionId, sessionId); assert.equal(session.identity.networkPolicy, "deny-all");
});

test("installed SDK direct Session reads and command lookup never auto-resume a stopped original VM", async () => {
  const { configuration } = await hostedWebFixture(), paths: string[] = [];
  const driver = new VercelHostedSandboxDriver(async (input, init) => {
    const url = new URL(String(input)); paths.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname.endsWith("/" + name)) { assert.equal(url.searchParams.get("resume"), "false"); return Response.json(wire("stopped")); }
    assert.ok(url.pathname.includes("/sessions/" + sessionId + "/"));
    if (url.pathname.endsWith("/fs/read")) return new Response(null, { status: 404 });
    if (url.pathname.endsWith("/cmd/cmd_original")) return Response.json({ command: { id: "cmd_original", name: "/usr/bin/env", args: [], cwd: "/tmp/guild/tools/web-audit", sessionId, exitCode: 2, startedAt: 1 } });
    throw Error("Unexpected request; automatic resume or redelivery is forbidden in this synthetic SDK control");
  }, authenticate);
  const original = await driver.get(name, configuration);
  assert.equal(original.identity.status, "stopped"); assert.equal(await original.read("/tmp/original.json", 4096), null);
  assert.equal((await original.command("cmd_original")).id, "cmd_original");
  assert.equal(paths.length, 3); assert.ok(paths.every(path => !path.includes("resume")));
});

for (const loss of [429, 500, "network"] as const) test(`installed SDK sends one original Session command on ${loss}`, async () => {
  const { configuration } = await hostedWebFixture(); let commands = 0;
  const driver = new VercelHostedSandboxDriver(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/" + name)) return Response.json(wire());
    assert.ok(path.endsWith("/sessions/" + sessionId + "/cmd")); assert.equal(init?.method, "POST"); commands++;
    if (loss === "network") throw new TypeError("synthetic lost command response");
    return Response.json({ error: { message: "synthetic uncertain command" } }, { status: loss, headers: { "Retry-After": "0" } });
  }, authenticate);
  const original = await driver.get(name, configuration);
  await assert.rejects(original.run(hostedVerifyCommand(), async () => {}), error => error instanceof HostedTransportUncertain);
  assert.equal(commands, 1);
});

test("installed SDK saves original command ID through onStart before waiting for its stream result", async () => {
  const { configuration } = await hostedWebFixture(); let commands = 0, recorded = false;
  const spec = hostedVerifyCommand(), command = { id: "cmd_original_stream", name: spec.cmd, args: spec.args, cwd: spec.cwd, sessionId, exitCode: null as number | null, startedAt: Date.now() };
  let finish: (() => void) | undefined;
  const driver = new VercelHostedSandboxDriver(async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/" + name)) return Response.json(wire());
    assert.ok(path.endsWith("/cmd")); commands++;
    const encoder = new TextEncoder(), body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(encoder.encode(JSON.stringify({ command }) + "\n"));
      finish = () => { assert.ok(recorded); controller.enqueue(encoder.encode(JSON.stringify({ stream: "stdout", data: "synthetic original output" }) + "\n")); controller.enqueue(encoder.encode(JSON.stringify({ command: { ...command, exitCode: 0 } }) + "\n")); controller.close(); };
    } });
    return new Response(body, { headers: { "Content-Type": "application/x-ndjson" } });
  }, authenticate);
  const original = await driver.get(name, configuration);
  const output = await original.run(spec, async value => { assert.equal(value.id, command.id); assert.equal(value.startedAt, command.startedAt); recorded = true; finish!(); });
  assert.equal(output.id, command.id); assert.equal(output.stdout, "synthetic original output"); assert.equal(output.exitCode, 0); assert.equal(commands, 1);
});

test("installed SDK retains onStart identity when a command stream reports an uncertain original result", async () => {
  const { configuration } = await hostedWebFixture(); let commands = 0, commandId: string | undefined;
  const spec = hostedVerifyCommand(), command = { id: "cmd_lost_original", name: spec.cmd, args: spec.args, cwd: spec.cwd, sessionId, exitCode: null, startedAt: Date.now() };
  const driver = new VercelHostedSandboxDriver(async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/" + name)) return Response.json(wire());
    commands++; return new Response([JSON.stringify({ command }), JSON.stringify({ stream: "error", data: { code: "synthetic_stream_lost", message: "Synthetic original command outcome unknown" } }), ""].join("\n"), { headers: { "Content-Type": "application/x-ndjson" } });
  }, authenticate);
  const original = await driver.get(name, configuration);
  await assert.rejects(original.run(spec, async value => { commandId = value.id; })); assert.equal(commandId, command.id); assert.equal(commands, 1);
});

test("installed SDK upload/read transport loss sends one original filesystem request for each phase", async () => {
  const { configuration } = await hostedWebFixture(); const counts = { write: 0, read: 0 };
  const driver = new VercelHostedSandboxDriver(async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/" + name)) return Response.json(wire());
    if (path.endsWith("/fs/write")) counts.write++; else if (path.endsWith("/fs/read")) counts.read++; else throw new Error("Unexpected SDK request");
    throw new TypeError("synthetic filesystem response lost");
  }, authenticate);
  const original = await driver.get(name, configuration);
  await assert.rejects(original.upload([{ path: "/tmp/original.json", content: Buffer.from("{}"), mode: 0o600 }]), HostedTransportUncertain);
  await assert.rejects(original.read("/tmp/original.json", 4096), HostedTransportUncertain); assert.deepEqual(counts, { write: 1, read: 1 });
});

test("bounded direct Session file reads reject oversized original bytes", async () => {
  const { configuration } = await hostedWebFixture();
  const driver = new VercelHostedSandboxDriver(async input => new URL(String(input)).pathname.endsWith("/" + name) ? Response.json(wire()) : new Response(Buffer.alloc(8192), { headers: { "Content-Type": "application/octet-stream" } }), authenticate);
  const original = await driver.get(name, configuration); await assert.rejects(original.read("/tmp/original.json", 4096), /bounded evidence size/);
});
