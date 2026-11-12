import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import type { ContractDetailTab } from "../src/components/studio/contract-detail-tabs";

test("contract detail tabs move focus and selection together while preserving the unsaved-review guard", async () => {
  const require = createRequire(new URL("../package.json", import.meta.url));
  const { JSDOM } = require("jsdom");
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://guild-tabs.test/", pretendToBeVisual: true });
  const directory = await mkdtemp(resolve(tmpdir(), "guild-contract-tabs-"));
  const original = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, KeyboardEvent: dom.window.KeyboardEvent, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const bundle = resolve(directory, "tabs.mjs");
  await build({ stdin: { contents: 'export { ContractDetailTabs } from "./src/components/studio/contract-detail-tabs.tsx";', resolveDir: process.cwd(), loader: "tsx" }, outfile: bundle, bundle: true, platform: "node", format: "esm", jsx: "automatic", tsconfig: resolve("tsconfig.json"), logLevel: "silent", plugins: [{ name: "one-react", setup(api) { api.onResolve({ filter: /^(react(?:\/.*)?|react-dom(?:\/.*)?)$/ }, args => ({ path: require.resolve(args.path), external: true })); } }] });
  const React = require("react") as typeof import("react"), { act } = React;
  const { createRoot } = require("react-dom/client") as typeof import("react-dom/client");
  const { ContractDetailTabs } = await import(pathToFileURL(bundle).href);
  const root = createRoot(document.getElementById("root")!);
  let mayLeave = true, refused = 0;
  function Harness() {
    const [value, setValue] = React.useState<ContractDetailTab>("artifact");
    return React.createElement(React.Fragment, null,
      React.createElement(ContractDetailTabs, { id: "details", value, passed: 2, total: 4, onSelect: (next: ContractDetailTab) => { if (!mayLeave) { refused++; return false; } setValue(next); return true; } }),
      React.createElement("div", { id: "details-panel", role: "tabpanel", "aria-labelledby": `details-${value}` }, value));
  }
  const tabs = () => [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const selected = () => tabs().find(tab => tab.getAttribute("aria-selected") === "true")!;
  async function key(value: string) { await act(async () => { selected().dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })); }); }
  function expectSelection(index: number) {
    assert.equal(selected(), tabs()[index]);
    assert.equal(document.activeElement, tabs()[index]);
    assert.deepEqual(tabs().map(tab => tab.tabIndex), tabs().map((_, i) => i === index ? 0 : -1));
    assert.equal(document.querySelector('[role="tabpanel"]')?.getAttribute("aria-labelledby"), selected().id);
    assert.ok(tabs().every(tab => tab.getAttribute("aria-controls") === "details-panel"));
  }
  try {
    await act(async () => root.render(React.createElement(Harness)));
    tabs()[0]!.focus(); expectSelection(0);
    await key("ArrowRight"); expectSelection(1);
    await key("End"); expectSelection(2);
    await key("ArrowRight"); expectSelection(0);
    await key("ArrowLeft"); expectSelection(2);
    await key("Home"); expectSelection(0);
    mayLeave = false;
    await key("ArrowRight"); expectSelection(0); assert.equal(refused, 1);
    await act(async () => tabs()[1]!.click()); expectSelection(0); assert.equal(refused, 2);
    mayLeave = true;
    await key("ArrowRight"); expectSelection(1);
    await key("ArrowDown"); expectSelection(1);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of original) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    await rm(directory, { recursive: true });
  }
});
