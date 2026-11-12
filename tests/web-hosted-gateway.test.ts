import test from "node:test";
import assert from "node:assert/strict";
import { digest, DomainError } from "@/domain/primitives";
import { webCaseOutcomes, type WebAuditReceipt } from "@/domain/web-audits";
import { HostedWebAuditGateway, validateHostedCollectedEvidence } from "@/server/web/hosted-gateway";
import { hostedCasePaths } from "@/server/web/hosted-commands";
import { hostedWebFixture, MemoryHostedStore, SyntheticHostedDriver, type FakeHostedOptions } from "./support/hosted-web";

process.env.AUTH_SECRET = "synthetic-hosted-unit-seal-only";
async function setup(options: FakeHostedOptions = {}) {
  const fixture = await hostedWebFixture(), store = new MemoryHostedStore(fixture.row), driver = new SyntheticHostedDriver(fixture, options);
  const gateway = new HostedWebAuditGateway({ runtime: fixture.runtime, store, driver });
  return { fixture, store, driver, gateway };
}
const code = (value: string) => (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === value;

test("hosted execution checks authority after exact verification/uploads and retains original evidence before stopping", async () => {
  const { fixture: f, store, driver } = await setup();
  let receipt: WebAuditReceipt | undefined;
  const gateway = new HostedWebAuditGateway({ runtime: f.runtime, store, driver, async confirmObservation() { assert.ok(receipt, "No cleanup before a durable observation"); return receipt; } });
  f.input.beforeBrowser = async () => {
    assert.equal(driver.counts.create, 1); assert.equal(driver.counts.verify, 1); assert.equal(driver.counts.upload, 1); assert.equal(driver.counts.uploadVerify, 1);
    assert.equal(driver.counts.browser, 0); driver.events.push("current_authority");
  };
  const measured = await gateway.run(f.input);
  assert.equal(driver.counts.create, 1); assert.equal(driver.counts.browser, 1); assert.equal(driver.counts.stop, 0);
  assert.ok(driver.events.indexOf("current_authority") > driver.events.indexOf("uploadVerify"));
  assert.ok(driver.events.indexOf("current_authority") < driver.events.indexOf("browser"));
  assert.equal(store.record!.phase, "evidence_retained"); assert.ok(store.record!.commands.browser?.id); assert.equal(store.record!.binding.workerId, f.workerId);
  assert.equal(store.record!.binding.originalDeadline, f.originalDeadline); assert.equal(store.record!.binding.originalDispatchedAt, f.row.dispatched_at!.toISOString());
  assert.ok(store.retained.has("dispatch.json")); assert.ok(store.retained.has("result.json")); assert.ok(store.retained.has("hosted-runtime-verification.json"));
  assert.equal(digest(measured.result.files), store.record!.evidence!.nativeFilesDigest);
  const uploaded = [...driver.remote].filter(([path]) => path.includes("/bundle/") || path.endsWith("/request.json"));
  assert.equal(uploaded.length, f.input.manifest.files.length + 1);
  assert.ok(!JSON.stringify(uploaded.map(([path]) => path)).includes(".env"));
  await measured.afterSave?.(); assert.equal(driver.counts.stop, 0);
  assert.equal(store.record!.errors.at(-1)?.code, "WEB_HOSTED_CLEANUP_UNKNOWN");
  receipt = { id: f.row.id, requestDigest: digest(f.request), resultHash: digest(measured.result), result: measured.result };
  await measured.afterSave?.(); assert.equal(driver.counts.stop, 1); assert.equal(store.record!.phase, "cleaned");
  assert.ok(store.record!.firstUnknownAt, "The earlier cleanup hold remains in history");
});

test("revoked or expired authority after provisioning cannot launch the browser or borrow a new claim", async () => {
  const { fixture: f, store, driver, gateway } = await setup();
  f.input.beforeBrowser = async () => { throw new DomainError("WEB_AUTHORITY_EXPIRED", "Synthetic expired original authority", 422, false); };
  await assert.rejects(gateway.run(f.input), code("WEB_AUTHORITY_EXPIRED"));
  assert.equal(driver.counts.create, 1); assert.equal(driver.counts.uploadVerify, 1); assert.equal(driver.counts.browser, 0);
  assert.equal(store.record!.phase, "browser_intent"); assert.equal(store.record!.binding.originalDeadline, f.originalDeadline);
  await assert.rejects(gateway.recover(f.row), code("WEB_HOSTED_COMMAND_UNKNOWN"));
  await assert.rejects(gateway.run(f.input), code("WEB_AUDIT_OUTCOME_UNKNOWN"));
  assert.equal(driver.counts.create, 1); assert.equal(driver.counts.browser, 0);
});

test("two competing callers cause one original creation and one browser command", async () => {
  const { fixture: f, driver, gateway } = await setup();
  const results = await Promise.allSettled([gateway.run(f.input), gateway.run(f.input)]);
  assert.equal(results.filter(item => item.status === "fulfilled").length, 1);
  assert.equal(results.filter(item => item.status === "rejected").length, 1);
  assert.equal(driver.counts.create, 1); assert.equal(driver.counts.browser, 1); assert.equal(f.browserChecks(), 1);
});

test("lost create response recovers its original deterministic name/session and cannot start missing browser work", async () => {
  const { fixture: f, store, driver, gateway } = await setup({ lostCreate: true });
  await assert.rejects(gateway.run(f.input), code("WEB_HOSTED_OUTCOME_UNKNOWN"));
  const name = store.record!.binding.remoteName;
  assert.equal(store.record!.phase, "create_intent"); assert.equal(store.record!.session, null);
  f.runtime.read = f.runtime.verify = async () => { throw new Error("Current runtime is deliberately unavailable during historical recovery"); };
  await assert.rejects(gateway.recover(f.row), code("WEB_HOSTED_COMMAND_UNKNOWN"));
  assert.equal(store.record!.binding.remoteName, name); assert.equal(store.record!.session!.id, driver.sessionId);
  assert.equal(driver.counts.create, 1); assert.equal(driver.counts.browser, 0); assert.equal(driver.counts.verify, 0);
});

test("lost upload result retains its exact phase and never uploads or launches again", async () => {
  const { fixture: f, store, driver, gateway } = await setup({ lostUpload: true });
  await assert.rejects(gateway.run(f.input), code("WEB_HOSTED_OUTCOME_UNKNOWN"));
  assert.equal(store.record!.phase, "upload_intent"); assert.equal(driver.counts.upload, 1); assert.equal(driver.counts.browser, 0);
  await assert.rejects(gateway.recover(f.row), code("WEB_HOSTED_COMMAND_UNKNOWN"));
  assert.equal(driver.counts.upload, 1); assert.equal(driver.counts.browser, 0);
});

test("lost command response after onStart recovers original native bytes without current authority or another browser", async () => {
  const { fixture: f, store, driver, gateway } = await setup({ lostBrowserAfterStart: true });
  await assert.rejects(gateway.run(f.input), code("WEB_HOSTED_OUTCOME_UNKNOWN"));
  const originalSession = store.record!.session!.id, originalCommand = store.record!.commands.browser!.id, dispatched = f.row.dispatched_at!.toISOString();
  assert.equal(store.record!.phase, "browser_started"); assert.ok(store.record!.firstUnknownAt);
  f.runtime.read = f.runtime.verify = async () => { throw new Error("Historical recovery must not require a current configured renderer/runtime"); };
  f.input.beforeBrowser = async () => { throw new Error("Historical recovery must not renew authority"); };
  const recovered = await gateway.recover({ ...f.row, state: "indeterminate" });
  assert.equal(recovered.recovery.sessionId, originalSession); assert.equal(recovered.recovery.commandId, originalCommand); assert.equal(recovered.recovery.originalDispatchedAt, dispatched);
  assert.equal(recovered.result.requestDigest, f.row.request_hash); assert.equal(driver.counts.browser, 1); assert.equal(driver.counts.upload, 1); assert.equal(driver.counts.create, 1);
  assert.ok(store.record!.errors.length); assert.equal(store.record!.phase, "evidence_retained");
  const previousReads = driver.counts.read;
  driver.status = "stopped";
  const replayed = await gateway.recover({ ...f.row, state: "indeterminate" });
  assert.equal(digest(replayed.result), digest(recovered.result)); assert.equal(driver.counts.read, previousReads, "Complete immutable DB evidence needs no resumed VM");
});

test("a browser dispatch without a durably observed original command ID stays unknown even when files exist", async () => {
  const { fixture: f, store, driver, gateway } = await setup({ lostBrowserBeforeStart: true });
  await assert.rejects(gateway.run(f.input), code("WEB_HOSTED_OUTCOME_UNKNOWN"));
  assert.equal(store.record!.commands.browser, null); assert.equal(driver.counts.browser, 1);
  assert.ok(store.retained.has("axe-default.json")); assert.ok(store.retained.has("result.json"));
  await assert.rejects(gateway.recover(f.row), code("WEB_HOSTED_COMMAND_UNKNOWN"));
  assert.equal(driver.counts.browser, 1); assert.equal(store.record!.evidence, null);
});

test("lost original file read retains partial bytes and resumes only exact read-only collection", async () => {
  const { fixture: f, store, driver, gateway } = await setup({ failReadPath: "lighthouse.json" });
  await assert.rejects(gateway.run(f.input), code("WEB_HOSTED_OUTCOME_UNKNOWN"));
  assert.ok(store.retained.has("axe-default.json")); const before = Buffer.from(store.retained.get("axe-default.json")!);
  const recovered = await gateway.recover({ ...f.row, state: "indeterminate" });
  assert.ok(recovered.result.complete); assert.ok(store.retained.get("axe-default.json")!.equals(before)); assert.equal(driver.counts.browser, 1); assert.equal(driver.counts.create, 1);
});

test("a stopped original session never resumes or relaunches to replace uncollected evidence", async () => {
  const { fixture: f, store, driver, gateway } = await setup({ lostBrowserAfterStart: true });
  await assert.rejects(gateway.run(f.input)); driver.status = "stopped";
  await assert.rejects(gateway.recover(f.row), code("WEB_HOSTED_READ_UNKNOWN"));
  assert.equal(driver.counts.browser, 1); assert.equal(driver.counts.create, 1); assert.equal(driver.counts.readonly, 0); assert.equal(store.record!.evidence, null);
});

test("a later or foreign session cannot replace the original retained session", async () => {
  const { fixture: f, store, driver, gateway } = await setup({ lostBrowserAfterStart: true });
  await assert.rejects(gateway.run(f.input)); const original = store.record!.session!.id; driver.sessionId = "synthetic-substituted-session";
  await assert.rejects(gateway.recover(f.row), code("WEB_HOSTED_IDENTITY_CHANGED"));
  assert.equal(store.record!.session!.id, original); assert.equal(driver.counts.browser, 1); assert.equal(driver.counts.create, 1);
});

test("changed original command metadata and changed raw native bytes both fail closed", async () => {
  const { fixture: f, store, driver, gateway } = await setup({ lostBrowserAfterStart: true });
  await assert.rejects(gateway.run(f.input));
  const id = store.record!.commands.browser!.id, command = driver.commands.get(id)!;
  command.startedAt++; await assert.rejects(gateway.recover(f.row), code("WEB_HOSTED_COMMAND_CHANGED")); command.startedAt--;
  const paths = hostedCasePaths(store.record!); driver.remote.set(paths.evidence + "/axe-default.json", Buffer.from('{"altered":true}'));
  await assert.rejects(gateway.recover(f.row), code("WEB_HOSTED_EVIDENCE_CHANGED")); assert.equal(driver.counts.browser, 1);
});

test("known failing and incomplete original native results are retained without inferred passes", async () => {
  for (const options of [{ failing: true }, { incomplete: true }]) {
    const { fixture: f, store, driver, gateway } = await setup(options);
    const measured = await gateway.run(f.input);
    assert.equal(store.record!.phase, "evidence_retained"); assert.equal(webCaseOutcomes(measured.result).axe, false); assert.equal(driver.counts.browser, 1);
  }
});

test("missing result remains partial and a SIGKILL-style missing index permits only a bounded original-directory read", async () => {
  const missing = await setup({ missingResult: true });
  await assert.rejects(missing.gateway.run(missing.fixture.input), code("WEB_HOSTED_OUTCOME_UNKNOWN"));
  assert.ok(missing.store.retained.has("axe-default.json")); assert.equal(missing.store.record!.evidence, null); assert.equal(missing.driver.counts.browser, 1);
  const killed = await setup({ missingIndex: true });
  const measured = await killed.gateway.run(killed.fixture.input);
  assert.ok(measured.result.complete); assert.equal(killed.driver.counts.browser, 1); assert.equal(killed.driver.counts.readonly, 1);
  assert.equal(killed.store.record!.recoveryReads.length, 1);
  assert.equal(JSON.parse(killed.store.retained.get("hosted-output-index.json")!.toString()).source, "readonly_original_result_read");
});

test("changed snapshot ownership and changed full remote verification stop before browser work", async () => {
  const snapshot = await setup({ changedSnapshot: true });
  await assert.rejects(snapshot.gateway.run(snapshot.fixture.input), code("WEB_HOSTED_SNAPSHOT_CHANGED")); assert.equal(snapshot.driver.counts.create, 0);
  const engine = await setup({ changedRuntime: true });
  await assert.rejects(engine.gateway.run(engine.fixture.input), code("WEB_HOSTED_RUNTIME_CHANGED")); assert.equal(engine.driver.counts.upload, 0); assert.equal(engine.driver.counts.browser, 0);
});

test("original proof/dispatch tampering cannot validate a collected result", async () => {
  const { fixture: f, store, gateway } = await setup();
  await gateway.run(f.input);
  const all = await store.files(store.record!), changed = JSON.parse(all.get("dispatch.json")!.toString()); changed.pid++;
  all.set("dispatch.json", Buffer.from(JSON.stringify(changed)));
  assert.throws(() => validateHostedCollectedEvidence(store.record!, f.request, all), code("WEB_HOSTED_EVIDENCE_CHANGED"));
});
