import assert from "node:assert/strict";
import { chmod, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

test("approval continuation component preserves a deliberate one-use human handoff", { skip: !process.env.GUILD_MCP_DOM_HARNESS || !process.env.GUILD_MCP_EVIDENCE_DIR }, async () => {
  const require = createRequire(new URL("../package.json", import.meta.url));
  const { JSDOM } = await import(pathToFileURL(resolve(process.env.GUILD_MCP_DOM_HARNESS!, "node_modules/jsdom/lib/api.js")).href);
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://guild-approval-ui.test/approval/00000000-0000-4000-8000-000000000001", pretendToBeVisual: true });
  for (const key of ["window", "document", "HTMLElement", "Event", "MouseEvent", "Node"]) Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : key === "document" ? dom.window.document : dom.window[key] });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  const bundle = resolve(process.env.GUILD_MCP_EVIDENCE_DIR!, "approval-link-ui.bundle.mjs");
  await build({ stdin: { contents: 'export { ApprovalLink } from "./src/components/provider-market/approval-link.tsx";', resolveDir: process.cwd(), loader: "tsx" }, outfile: bundle, bundle: true, platform: "node", format: "esm", jsx: "automatic", loader: { ".css": "empty" }, tsconfig: resolve("tsconfig.json"), logLevel: "silent", plugins: [{ name: "one-react", setup(api) { api.onResolve({ filter: /^(react(?:\/.*)?|react-dom(?:\/.*)?)$/ }, args => ({ path: require.resolve(args.path), external: true })); } }] });
  await chmod(bundle, 0o600);
  const React = require("react") as typeof import("react"), { act } = React;
  const { createRoot } = require("react-dom/client") as typeof import("react-dom/client");
  const { ApprovalLink } = await import(pathToFileURL(bundle).href);
  const root = createRoot(document.getElementById("root")!), originalFetch = globalThis.fetch;
  const report: { passed: boolean; checks: string[]; nativeBrowserClaimed: false; networkCalls: number; error?: string } = { passed: false, checks: [], nativeBrowserClaimed: false, networkCalls: 0 };
  const preview = { id: "00000000-0000-4000-8000-000000000001", commissionId: "00000000-0000-4000-8000-000000000002", title: "Controlled approval handoff", expectedRevision: 3, capMinor: 64000, packageCount: 6, expiresAt: "2030-01-01T10:00:00.000Z", passportUrl: "/?view=passport&commission=00000000-0000-4000-8000-000000000002", approvalRequired: true, paymentAuthorized: false };
  const challenge = "x".repeat(43); let serial = 0;
  const button = (label: string) => { const found = [...document.querySelectorAll("button")].find(item => item.textContent?.trim().startsWith(label)); assert.ok(found); return found; };
  async function mount(value: typeof preview | null, error: string | null = null) { await act(async () => root.render(React.createElement(ApprovalLink, { key: ++serial, preview: value, challenge: value ? challenge : null, error }))); }
  try {
    let calls: { url: string; options: RequestInit }[] = [], finish!: (response: Response) => void;
    globalThis.fetch = (async (url: RequestInfo | URL, options: RequestInit = {}) => { calls.push({ url: String(url), options }); return new Promise<Response>(resolve => { finish = resolve; }); }) as typeof fetch;
    await mount(preview); assert.equal(calls.length, 0); assert.match(document.body.textContent ?? "", /still review and approve the plan/); assert.match(document.body.textContent ?? "", /\$640.00/);
    const opener = button("Continue to Passport"); await act(async () => { opener.click(); opener.click(); }); assert.equal(calls.length, 1); assert.equal(calls[0]!.options.credentials, "same-origin"); assert.equal(calls[0]!.options.cache, "no-store"); assert.equal(calls[0]!.options.referrerPolicy, "no-referrer"); assert.equal(JSON.parse(String(calls[0]!.options.body)).challenge, challenge);
    await act(async () => finish(Response.json({ ok: true, commissionId: preview.commissionId, continueUrl: preview.passportUrl, approvalRequired: true, paymentAuthorized: false }))); assert.ok(document.querySelector(`.al-success a[href="${preview.passportUrl}"]`)); assert.match(document.querySelector(".al-success")!.textContent!, /No plan or payment was approved/); report.checks.push("render is read-only, same-turn submission is guarded, and verified continuation only opens Passport");

    calls = []; globalThis.fetch = (async (url: RequestInfo | URL, options: RequestInit = {}) => { calls.push({ url: String(url), options }); if (calls.length === 1) throw new Error("Controlled lost response"); return Response.json({ ok: false, message: "This one-use link has already been continued." }, { status: 410 }); }) as typeof fetch;
    await mount(preview); await act(async () => button("Continue to Passport").click()); assert.match(document.body.textContent ?? "", /response was lost/); await act(async () => button("Retry same continuation").click()); assert.equal(calls.length, 2); assert.equal(calls[0]!.url, calls[1]!.url); assert.equal(calls[0]!.options.body, calls[1]!.options.body); assert.equal(document.querySelector(".al-success"), null); assert.match(document.body.textContent ?? "", /already been continued/); report.checks.push("unknown continuation retries the exact URL and challenge and a replay refusal never becomes approval");

    globalThis.fetch = (async () => Response.json({ ok: true, continueUrl: "https://foreign.invalid/approval" })) as typeof fetch; await mount(preview); await act(async () => button("Continue to Passport").click()); assert.equal(document.querySelector('a[href^="https://foreign.invalid"]'), null); assert.equal(document.querySelector(".al-success"), null); assert.match(document.body.textContent ?? "", /could not be verified/); report.checks.push("unbound or foreign success destinations are refused");

    await mount(null, "This link has expired."); assert.equal(document.querySelector("button"), null); assert.match(document.body.textContent ?? "", /This link has expired/); assert.ok(document.querySelector('a.al-button[href="/"]')); report.checks.push("unavailable links keep the original workspace recovery path without a consume action"); report.passed = true;
  } catch (error) { report.error = (error instanceof Error ? error.message : String(error)).replaceAll(challenge, "[controlled challenge]"); }
  finally { await act(async () => root.unmount()); dom.window.close(); globalThis.fetch = originalFetch; await writeFile(resolve(process.env.GUILD_MCP_EVIDENCE_DIR!, `provider-market-approval-ui-${Date.now()}.json`), JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "wx" }); }
  assert.equal(report.passed, true, report.error);
  assert.equal(report.checks.length, 4);
});
