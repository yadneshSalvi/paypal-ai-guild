/** Focus/state regressions in a separate pinned jsdom harness. Native dialog
 * geometry, keyboard trapping and actual browser behavior remain root QA. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { loadComposedCaptionFixture } from "../tests/support/load-composed-caption-fixture.ts";

const rootPath = resolve(dirname(fileURLToPath(import.meta.url)), ".."), f = await loadComposedCaptionFixture(process.argv[2] ?? "missing-fixture", "http");
const harness = resolve(process.argv[3] ?? "missing-dom-harness"), require = createRequire(resolve(rootPath, "package.json"));
const mutant = process.argv[4] ?? null;
assert.ok(mutant === null || ["missing-prepare-focus", "native-busy-cancel"].includes(mutant), "Unknown DOM regression mutant.");
const { getPool } = await import("../src/server/db.ts"), { publicationWorkspace } = await import("../src/server/web/publications.ts");
const original = await publicationWorkspace(f.owner, f.commissionId);
const saved = (await getPool().query("SELECT proposal FROM guild_web_publication_proposals WHERE tenant_id=$1 AND commission_id=$2 ORDER BY created_at DESC LIMIT 1", [f.owner.tenantId, f.commissionId])).rows[0].proposal;
await getPool().end();
const { JSDOM } = await import(pathToFileURL(resolve(harness, "node_modules/jsdom/lib/api.js")).href);
const dom = new JSDOM('<!doctype html><html><body tabindex="-1"><div id="root"></div></body></html>', { url: "http://localhost:4554", pretendToBeVisual: true });
for (const key of ["window", "document", "HTMLElement", "HTMLDialogElement", "HTMLButtonElement", "HTMLTextAreaElement", "Event", "MouseEvent", "KeyboardEvent", "Node"]) globalThis[key] = key === "window" ? dom.window : key === "document" ? dom.window.document : dom.window[key];
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
globalThis.self = dom.window;
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window); globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window); globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no modal presentation engine. Model only native show/close and the
// cancel event's default close so React's prevention/state logic can be tested.
dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; this.querySelector("button,input,select,textarea,[tabindex]")?.focus(); };
dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
const { build } = require("esbuild"); await mkdir(resolve(harness, "compiled"), { recursive: true });
const bundlePath = resolve(harness, `compiled/publication-dom${mutant ? `-${mutant}` : ""}.mjs`);
await build({ stdin: { contents: 'export { WebPublication } from "./src/components/studio/web-publication.tsx"; export { Modal } from "./src/components/studio/ui.tsx";', resolveDir: rootPath, sourcefile: "publication-dom-entry.tsx", loader: "tsx" }, outfile: bundlePath,
  bundle: true, platform: "node", format: "esm", target: "node22", jsx: "automatic", loader: { ".css": "empty" }, tsconfig: resolve(rootPath, "tsconfig.json"),
  plugins: [{ name: "independent-app-dependencies", setup(api) {
    api.onResolve({ filter: /^(react(?:\/.*)?|react-dom(?:\/.*)?|next\/link|lucide-react)$/ }, args => ({ path: require.resolve(args.path), external: true }));
    if (mutant) api.onLoad({ filter: mutant === "missing-prepare-focus" ? /web-publication\.tsx$/ : /\/ui\.tsx$/ }, async args => {
      const source = await readFile(args.path, "utf8");
      const before = mutant === "missing-prepare-focus" ? " returnFocus={returnToPreparation}" : "onCancel={event=>{event.preventDefault();onClose();}}";
      const after = mutant === "missing-prepare-focus" ? "" : "onCancel={onClose}";
      assert.equal(source.split(before).length, 2, "The mutation must change one exact compiled input without editing application files.");
      return { contents: source.replace(before, after), loader: "tsx", resolveDir: dirname(args.path) };
    });
  } }], logLevel: "silent" });
const React = require("react"), { act } = React, { createRoot } = require("react-dom/client"), { WebPublication, Modal } = await import(pathToFileURL(bundlePath).href);
let current = { ...original, revision: 0, currentEditionId: null, editions: [], history: [] };
const requests = [], pending = { prepare: [], publish: [], withdraw: [] };
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const kind = String(url).split("/").at(-1);
  if (init.method === "GET") return Response.json(current);
  assert.ok(["prepare", "publish", "withdraw"].includes(kind)); const body = JSON.parse(init.body); requests.push({ kind, body });
  return new Promise(resolve => pending[kind].push({ resolve, body }));
};
const report = { version: "guild.composed-publication-dom-regressions.v1", at: new Date().toISOString(), fixture: f.label, disclosure: f.disclosure,
  runtime: "jsdom@26.1.0 + actual React19.3.1 components; dialog presentation/default-cancel shim", mutant, nativeBrowserClaimed: false, checks: [], passed: false };
const root = createRoot(document.getElementById("root"));
const frames = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 45)); }); };
async function click(element) { assert.ok(element); await act(async () => { element.click(); }); }
function button(text) { return [...document.querySelectorAll("button")].find(element => element.textContent.trim() === text); }
async function settle(kind, status, data) { const item = pending[kind].shift(); assert.ok(item); await act(async () => { item.resolve(Response.json(data, { status })); }); await frames(); return item.body; }
async function escape(dialog) {
  const event = new dom.window.Event("cancel", { cancelable: true });
  await act(async () => { if (dialog.dispatchEvent(event)) dialog.open = false; }); await frames(); return event;
}
async function openProposal() {
  const trigger = document.querySelector(".publication-prepare-button"); assert.ok(!trigger.disabled); trigger.focus(); await click(trigger);
  assert.equal(pending.prepare.length, 1); assert.equal(trigger.disabled, true);
  document.body.focus(); assert.equal(document.activeElement, document.body, "Reproduce async focus loss before the proposal arrives.");
  const proposal = { ...saved, id: randomUUID(), expectedRevision: current.revision, editionVersion: 1, olderActiveIds: [], olderEditions: "keep" };
  await settle("prepare", 200, { ok: true, kind: "prepared", revision: current.revision, proposal });
  const dialog = document.querySelector("dialog"); assert.ok(dialog?.open); return { trigger, dialog, proposal };
}
async function reason(value) {
  const field = document.querySelector("dialog textarea"); assert.ok(field);
  await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set.call(field, value); field.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
}
try {
  await act(async () => { root.render(React.createElement(WebPublication, { initial: current, commissionId: f.commissionId })); });
  const first = await openProposal(); await escape(first.dialog);
  assert.equal(document.querySelector("dialog"), null); assert.ok(document.activeElement === first.trigger, "Closing the asynchronous proposal must focus its captured Prepare trigger.");
  report.checks.push({ name: "async BODY focus returns to the synchronously captured Prepare trigger", passed: true });
  const second = await openProposal();
  assert.notEqual(requests.filter(item => item.kind === "prepare")[0].body.commandId, requests.filter(item => item.kind === "prepare")[1].body.commandId, "A confirmed closed preparation gets a fresh command.");
  await click(second.dialog.querySelector('input[type="checkbox"]')); await click(button("Publish edition 1"));
  assert.equal(pending.publish.length, 1); assert.match(second.dialog.textContent, /Publishing this edition/);
  assert.equal((await escape(second.dialog)).defaultPrevented, true); assert.ok(second.dialog.open); assert.ok(document.contains(second.dialog));
  const unknown = await settle("publish", 503, { ok: false, message: "The confirmation was interrupted; retry this same decision." });
  assert.ok(second.dialog.open); await click(button("Publish edition 1")); assert.deepEqual(pending.publish[0].body, unknown);
  assert.equal((await escape(second.dialog)).defaultPrevented, true); assert.ok(second.dialog.open);
  const edition = { id: randomUUID(), publicId: "a".repeat(48), version: 1, revision: 1, publishedAt: new Date().toISOString(), actorRole: "owner", publicUrl: "/published/" + "a".repeat(48) + "/index.html", downloadUrl: "/published/" + "a".repeat(48) + "/exhibition.zip", manifestUrl: "/published/" + "a".repeat(48) + "/bundle-manifest.json", proposalDigest: second.proposal.digest, editionNote: "Synthetic DOM-state fixture", state: "current", withdrawnAt: null, withdrawalReason: null, withdrawnByRole: null, binding: second.proposal.binding, downloadResponses: 0 };
  current = { ...current, revision: 1, currentEditionId: edition.id, editions: [edition] };
  await settle("publish", 200, { ok: true, kind: "published", editionId: edition.id, version: 1, revision: 1 });
  assert.equal(document.querySelector("dialog"), null); assert.equal(document.activeElement.id, "prepare-title", "Disabled Prepare has a visible enabled heading fallback after publishing.");
  report.checks.push({ name: "busy Escape preserves the dialog; an unknown outcome reuses the exact command; confirmed close uses the visible fallback", passed: true });

  const withdrawTrigger = button("Withdraw edition 1"); withdrawTrigger.focus(); await click(withdrawTrigger);
  await reason("Synthetic focused DOM withdrawal test."); await click(document.querySelector('dialog input[type="checkbox"]')); await click(document.querySelector("dialog .publication-danger"));
  assert.equal(pending.withdraw.length, 1); current = { ...current, revision: 2 };
  const stale = await settle("withdraw", 409, { ok: false, message: "Publication history changed while you were reviewing." });
  assert.match(document.querySelector('[role="alert"]').textContent, /Close this dialog, review the refreshed edition history, then open withdrawal again/);
  await click(document.querySelector("dialog .publication-danger")); assert.deepEqual(pending.withdraw[0].body, stale, "Refresh does not silently change the retained decision.");
  await settle("withdraw", 409, { ok: false, message: "Publication history changed while you were reviewing." });
  await escape(document.querySelector("dialog")); assert.equal(document.activeElement.id, "history-title");
  await click(button("Withdraw edition 1")); await reason("Synthetic focused DOM withdrawal test."); await click(document.querySelector('dialog input[type="checkbox"]')); await click(document.querySelector("dialog .publication-danger"));
  assert.equal(pending.withdraw[0].body.expectedRevision, 2); assert.notEqual(pending.withdraw[0].body.commandId, stale.commandId);
  const withdrawalDialog = document.querySelector("dialog"); assert.equal((await escape(withdrawalDialog)).defaultPrevented, true); assert.ok(withdrawalDialog.open);
  await settle("withdraw", 503, { ok: false, message: "A temporary transport pause." });
  await escape(withdrawalDialog); assert.equal(document.querySelector("dialog"), null); assert.equal(document.activeElement.id, "history-title");
  report.checks.push({ name: "withdrawal conflict requires explicit close/review/reopen; busy Escape and later normal Escape preserve state and focus", passed: true });

  function ExistingModal() { const [opened, setOpened] = React.useState(false); return React.createElement(React.Fragment, null, React.createElement("button", { id: "existing-trigger", onClick: () => setOpened(true) }, "Existing dialog"), opened && React.createElement(Modal, { title: "Existing dialog", onClose: () => setOpened(false) }, React.createElement("p", null, "Existing callers retain ordinary focus restoration."))); }
  await act(async () => { root.render(React.createElement(ExistingModal)); });
  const existing = document.getElementById("existing-trigger"); existing.focus(); await click(existing); await escape(document.querySelector("dialog"));
  assert.equal(document.querySelector("dialog"), null); assert.equal(document.activeElement, existing);
  report.checks.push({ name: "shared Modal retains ordinary Escape/state/focus behavior for callers without returnFocus", passed: true });
  report.passed = true;
} catch (error) { report.error = { message: error.message, stack: error.stack }; throw error; }
finally {
  await act(async () => { root.unmount(); }); await frames(); globalThis.fetch = originalFetch; dom.window.close();
  const path = resolve(harness, `dom-${new Date().toISOString().replaceAll(":", "-")}.json`); await writeFile(path, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ reportPath: path, passed: report.passed, checks: report.checks.length, nativeBrowserClaimed: false }));
}
