/** The actual Studio, Next Link and shared navigation event. Unrelated screen
 * contents are component-boundary stubs; no layout or native claim is made. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootPath = resolve(dirname(fileURLToPath(import.meta.url)), ".."), harness = resolve(process.argv[2] ?? "missing-harness"), mutant = process.argv[3] ?? null;
assert.ok(mutant === null || mutant === "missing-home-guard");
const require = createRequire(resolve(rootPath, "package.json")), { JSDOM } = await import(pathToFileURL(resolve(harness, "node_modules/jsdom/lib/api.js")).href);
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost:4554/?view=commission", pretendToBeVisual: true });
for (const key of ["window", "document", "HTMLElement", "HTMLDialogElement", "HTMLButtonElement", "Event", "MouseEvent", "KeyboardEvent", "PopStateEvent", "Node", "location", "history"]) globalThis[key] = key === "window" ? dom.window : key === "document" ? dom.window.document : dom.window[key];
globalThis.self = dom.window; Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
globalThis.addEventListener = dom.window.addEventListener.bind(dom.window); globalThis.removeEventListener = dom.window.removeEventListener.bind(dom.window);
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window); globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window); globalThis.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} }); dom.window.scrollTo = () => {};
dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; }; dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
const { build } = require("esbuild"); await mkdir(resolve(harness, "compiled"), { recursive: true });
const bundle = resolve(harness, `compiled/studio-caption-navigation${mutant ? "-" + mutant : ""}.mjs`);
await build({ stdin: { contents: 'export { Studio } from "./src/components/studio/studio.tsx"; export { createSampleCommission } from "./src/domain/fixture.ts"; export { CONTRACT_VERSION } from "./src/contracts/guild.ts";', resolveDir: rootPath, loader: "tsx", sourcefile: "studio-navigation-entry.tsx" },
  outfile: bundle, bundle: true, platform: "node", format: "esm", target: "node22", jsx: "automatic", loader: { ".css": "empty" }, tsconfig: resolve(rootPath, "tsconfig.json"), logLevel: "silent",
  plugins: [{ name: "actual-studio-navigation-with-screen-boundaries", setup(api) {
    api.onResolve({ filter: /^(react(?:\/.*)?|react-dom(?:\/.*)?|next\/link|lucide-react)$/ }, args => ({ path: require.resolve(args.path), external: true }));
    api.onLoad({ filter: /\/studio\/views\.tsx$/ }, () => ({ contents: ["Overview", "Market", "Passport", "Review", "Collection", "Activity"].map(name => `export function ${name}(){return <h1 data-view="${name}">${name} boundary</h1>}`).join("\n"), loader: "tsx" }));
    api.onLoad({ filter: /\/studio\/(production-floor|settlement)\.tsx$/ }, args => ({ contents: `export function ${args.path.endsWith("settlement.tsx") ? "Settlement" : "ProductionFloor"}(){return <h1>Unrelated screen boundary</h1>}`, loader: "tsx" }));
    if (mutant) api.onLoad({ filter: /\/studio\/studio\.tsx$/ }, async args => {
      const source = await readFile(args.path, "utf8"), before = " onNavigate={event=>{if(!mayLeaveCaptionReview())event.preventDefault();}}";
      assert.equal(source.split(before).length, 2); return { contents: source.replace(before, ""), loader: "tsx", resolveDir: dirname(args.path) };
    });
  } }] });
const React = require("react"), { act } = React, { createRoot } = require("react-dom/client"), { RouterContext } = require("next/dist/shared/lib/router-context.shared-runtime.js");
const { Studio, createSampleCommission, CONTRACT_VERSION } = await import(pathToFileURL(bundle).href), commission = createSampleCommission("synthetic-navigation-tenant");
const snapshot = { schemaVersion: CONTRACT_VERSION, commission, session: { id: "synthetic-navigation-actor", role: "owner", expiresAt: new Date(Date.now() + 28_800_000).toISOString() }, serverTime: new Date().toISOString(), approvalDigest: "f".repeat(64) };
let navigations = 0, reads = 0, rejectNavigation = true, guardEvents = 0;
const router = { pathname: "/", route: "/", query: {}, asPath: "/?view=commission", isFallback: false, isReady: true, prefetch: async () => {}, push: async () => { navigations++; return true; }, replace: async () => { navigations++; return true; } };
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => { assert.match(String(url), /^\/api\/workspace(?:\?|$)/); assert.ok(!options.method || options.method === "GET"); reads++; return Response.json(snapshot); };
const guard = event => { guardEvents++; if (rejectNavigation) event.preventDefault(); }; window.addEventListener("guild:caption-review-leave", guard);
const report = { version: "guild.caption-studio-navigation-dom.v1", at: new Date().toISOString(), mutant, passed: false, nativeBrowserClaimed: false, applicationFilesMutated: false,
  runtime: "Actual React Studio + Next Link + shared event; unrelated screen contents stubbed at component boundaries", checks: [] };
const root = createRoot(document.getElementById("root")), frames = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 45)); }); };
async function click(element) { assert.ok(element); const event = new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }); await act(async () => { element.dispatchEvent(event); }); await frames(); return event; }
try {
  await act(async () => { root.render(React.createElement(RouterContext.Provider, { value: router }, React.createElement(Studio))); }); await frames();
  assert.ok(reads > 0); assert.ok(document.querySelector('[data-view="Overview"]'));
  const home = document.querySelector('a[aria-label="Guild home"]'), event = await click(home);
  assert.equal(navigations, 0, "An unsaved or pending caption editor must prevent the real Home Link navigation."); assert.equal(event.defaultPrevented, true); assert.equal(guardEvents, 1);
  report.checks.push({ name: "the real Home Link obeys the caption editor's cancellable navigation contract", passed: true });
  await click([...document.querySelectorAll("button.nav-item")].find(button => button.textContent.startsWith("Review room")));
  assert.ok(document.querySelector('[data-view="Overview"]')); const originalUrl = location.href;
  await act(async () => { history.pushState({}, "", "/?view=collection"); window.dispatchEvent(new dom.window.PopStateEvent("popstate")); });
  assert.equal(location.href, originalUrl); assert.ok(document.querySelector('[data-view="Overview"]'));
  report.checks.push({ name: "sidebar and browser history retain the same guarded view and URL", passed: true });
  rejectNavigation = false; await click(home); assert.equal(navigations, 1, "Saving or discarding must leave the normal Home Link usable.");
  report.checks.push({ name: "the clean editor permits the normal Next Link route action", passed: true }); report.passed = true;
} catch (error) { report.error = { message: error.message, stack: error.stack }; throw error; }
finally {
  window.removeEventListener("guild:caption-review-leave", guard); await act(async () => { root.unmount(); }); globalThis.fetch = originalFetch; dom.window.close();
  const path = resolve(harness, `studio-navigation-${mutant ?? "qualified"}-${new Date().toISOString().replaceAll(":", "-")}.json`);
  await writeFile(path, JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "wx" }); console.log(JSON.stringify({ reportPath: path, passed: report.passed, mutant, checks: report.checks.length }));
}
