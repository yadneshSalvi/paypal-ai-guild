/** Actual React component checks using explicit synthetic fetch responses.
 * jsdom is a pinned external harness; this makes no native-browser claim. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootPath = resolve(dirname(fileURLToPath(import.meta.url)), ".."), harness = resolve(process.argv[2] ?? "missing-harness"), mutant = process.argv[3] ?? null;
assert.ok(mutant === null || ["late-recovery", "response-identity"].includes(mutant));
const require = createRequire(resolve(rootPath, "package.json")), { JSDOM } = await import(pathToFileURL(resolve(harness, "node_modules/jsdom/lib/api.js")).href);
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost:4554", pretendToBeVisual: true });
for (const key of ["window", "document", "HTMLElement", "HTMLDetailsElement", "Event", "MouseEvent", "Node"]) globalThis[key] = key === "window" ? dom.window : key === "document" ? dom.window.document : dom.window[key];
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator }); globalThis.self = dom.window; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { build } = require("esbuild"); await mkdir(resolve(harness, "compiled"), { recursive: true });
const bundle = resolve(harness, `compiled/hosted-recovery${mutant ? "-" + mutant : ""}.mjs`);
await build({ stdin: { contents: 'export { WebHostedRecovery } from "./src/components/studio/web-hosted-recovery.tsx";', resolveDir: rootPath, sourcefile: "hosted-recovery-entry.tsx", loader: "tsx" },
  outfile: bundle, bundle: true, platform: "node", format: "esm", target: "node22", jsx: "automatic", tsconfig: resolve(rootPath, "tsconfig.json"),
  plugins: [{ name: "explicit-app-dependencies-and-mutation", setup(api) {
    api.onResolve({ filter: /^(react(?:\/.*)?|react-dom(?:\/.*)?|lucide-react)$/ }, args => ({ path: require.resolve(args.path), external: true }));
    if (mutant) api.onLoad({ filter: /web-hosted-recovery\.tsx$/ }, async args => {
      const source = await readFile(args.path, "utf8"), before = mutant === "late-recovery" ? "if (!isCurrent()) return;" : 'if (body.version !== "guild.web-hosted-recovery.v1" || body.caseId !== caseId || body.jobId !== jobId || body.receipt?.id !== caseId || body.state !== "received")';
      assert.equal(source.split(before).length, 2);
      return { contents: source.replace(before, mutant === "late-recovery" ? "/* compiled-input-only late-response mutant */" : "if (false)"), loader: "tsx", resolveDir: dirname(args.path) };
    });
  } }], logLevel: "silent" });
const React = require("react"), { act } = React, { createRoot } = require("react-dom/client"), { WebHostedRecovery } = await import(pathToFileURL(bundle).href);
const root = createRoot(document.getElementById("root")), originalFetch = globalThis.fetch, pending = [], requests = [];
globalThis.fetch = async (url, init = {}) => { requests.push({ url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null }); return new Promise(accept => pending.push({ url: String(url), init, accept })); };
const jobA = randomUUID(), jobB = randomUUID(), caseA = randomUUID(), caseB = randomUUID();
const register = (jobId, caseId) => ({ schemaVersion: "guild.web-job-evidence.v1", job: { id: jobId }, browserCases: [{ id: caseId, case_key: "SYNTHETIC original " + caseId, state: "indeterminate", failure_code: "SYNTHETIC_LOST_RESPONSE", original_failure_code: "SYNTHETIC_LOST_RESPONSE" }],
  hostedAttempts: [{ caseId, phase: "browser_started", originalDeadline: "2026-11-11T11:45:29.435Z", originalDispatchedAt: "2026-11-11T11:40:00.000Z", originalSessionId: "synthetic-original-session", originalCommandId: "synthetic-original-command", firstUnknownAt: "2026-11-11T11:41:00.000Z", evidenceRetained: true, observationSaved: false, errors: [{ code: "SYNTHETIC_LOST_RESPONSE", at: "2026-11-11T11:41:00.000Z" }] }] });
const report = { version: "guild.composed-hosted-dom.v1", at: new Date().toISOString(), mutant, runtime: "jsdom@26.1.0 + actual React component", nativeBrowserClaimed: false, checks: [], passed: false };
const frames = async () => { await act(async () => { await new Promise(accept => setTimeout(accept, 35)); }); };
async function render(jobId) { await act(async () => { root.render(React.createElement(WebHostedRecovery, { jobId, updatedAt: "synthetic-original-update" })); }); await frames(); }
async function open() { const details = document.querySelector("details"); assert.ok(details); await act(async () => { details.open = true; details.dispatchEvent(new dom.window.Event("toggle")); }); await frames(); }
function take(method, jobId) { const index = pending.findIndex(item => (item.init.method ?? "GET") === method && item.url.includes(jobId)); assert.ok(index >= 0, method + " " + jobId); return pending.splice(index, 1)[0]; }
async function respond(item, body, status = 200) { await act(async () => { item.accept(Response.json(body, { status })); }); await frames(); }
async function clickRead() { const button = [...document.querySelectorAll("button")].find(item => item.textContent.trim() === "Read this original result"); assert.ok(button); await act(async () => { button.click(); button.click(); }); await frames(); }
try {
  await render(jobA); assert.equal(requests.length, 0); await open();
  await respond(take("GET", jobA), register(jobB, caseB));
  assert.match(document.querySelector('[role="alert"]').textContent, /different original job/); assert.ok(!document.body.textContent.includes(caseB));
  report.checks.push({ name: "register reads are deliberate and reject a foreign job response", passed: true });
  const refresh = [...document.querySelectorAll("button")].find(item => item.textContent.includes("Read the saved register again")); await act(async () => refresh.click());
  await respond(take("GET", jobA), register(jobA, caseA)); await clickRead();
  const successful = take("POST", jobA); assert.deepEqual(JSON.parse(successful.init.body), { caseId: caseA });
  assert.equal(document.querySelector("article button").disabled, true);
  await respond(successful, { version: "guild.web-hosted-recovery.v1", caseId: caseA, jobId: jobA, receipt: { id: caseA }, state: "received" });
  assert.match(document.body.textContent, /The original report is saved/); await respond(take("GET", jobA), register(jobA, caseA));
  assert.equal(document.activeElement, document.querySelector("article"), "The refreshed original record retains a useful focus target after its action changes.");
  assert.equal(requests.filter(item => item.method === "POST").length, 1);
  report.checks.push({ name: "one deliberate original read binds its exact request, confirms identity and refreshes the saved register", passed: true });
  await clickRead(); const wrong = take("POST", jobA);
  await respond(wrong, { version: "guild.web-hosted-recovery.v1", caseId: caseB, jobId: jobB, receipt: { id: caseB }, state: "received" });
  const identityError = document.querySelector('[role="alert"]'); assert.ok(identityError, "A foreign original recovery must retain an explicit current-case error.");
  assert.match(identityError.textContent, /differs from this exact original case/);
  assert.ok(!document.body.textContent.includes("The original report is saved"));
  report.checks.push({ name: "foreign original recovery cannot become a successful current-case notice", passed: true });
  await clickRead(); const late = take("POST", jobA); await render(jobB);
  assert.equal(late.init.signal.aborted, true); assert.ok(!document.body.textContent.includes(caseA)); await open(); await respond(take("GET", jobB), register(jobB, caseB));
  await respond(late, { version: "guild.web-hosted-recovery.v1", caseId: caseA, jobId: jobA, receipt: { id: caseA }, state: "received" });
  assert.ok(document.body.textContent.includes(caseB)); assert.ok(!document.body.textContent.includes(caseA)); assert.ok(!document.body.textContent.includes("The original report is saved"));
  report.checks.push({ name: "a completed late original response is ignored after the visible job changes", passed: true });
  await clickRead(); const unmounted = take("POST", jobB); await act(async () => root.unmount()); assert.equal(unmounted.init.signal.aborted, true);
  await respond(unmounted, { version: "guild.web-hosted-recovery.v1", caseId: caseB, jobId: jobB, receipt: { id: caseB }, state: "received" });
  report.checks.push({ name: "leaving the view aborts the client read while retaining the same server original identity", passed: true });
  report.passed = true;
} catch (error) { report.error = { message: error.message, stack: error.stack }; throw error; }
finally {
  try { await act(async () => root.unmount()); } catch {} globalThis.fetch = originalFetch; dom.window.close();
  const path = resolve(harness, `hosted-dom-${new Date().toISOString().replaceAll(":", "-")}.json`); await writeFile(path, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ reportPath: path, passed: report.passed, checks: report.checks.length, mutant, nativeBrowserClaimed: false }));
}
