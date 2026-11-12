/** Actual marketplace/console React components in an independent jsdom harness.
 * All records below are explicit synthetic fixtures. No server, provider, media,
 * payment, browser, or database operation is performed or claimed. */
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootPath = resolve(dirname(fileURLToPath(import.meta.url)), "..");
assert.ok(process.argv[2], "Pass a separately copied jsdom harness directory.");
const harness = resolve(process.argv[2]), evidence = resolve(process.argv[3] ?? dirname(harness));
const require = createRequire(resolve(rootPath, "package.json"));
const { JSDOM } = await import(pathToFileURL(resolve(harness, "node_modules/jsdom/lib/api.js")).href);
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://guild-ui.test/market", pretendToBeVisual: true });
for (const key of ["window", "document", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLDialogElement", "HTMLButtonElement", "Event", "MouseEvent", "KeyboardEvent", "Node", "location", "history"]) globalThis[key] = key === "window" ? dom.window : key === "document" ? dom.window.document : dom.window[key];
globalThis.self = dom.window;
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no native dialog implementation. Only these platform methods are
// supplied; application dialog behavior, forms and command code run unchanged.
dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
let networkCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { networkCalls++; throw new Error("UI tests forbid network access"); };
await mkdir(resolve(harness, "compiled"), { recursive: true, mode: 0o700 });
await mkdir(evidence, { recursive: true, mode: 0o700 });
const bundle = resolve(harness, "compiled/provider-market-ui.mjs");
await require("esbuild").build({
  stdin: { contents: 'export { ProviderMarket } from "./src/components/provider-market/market.tsx"; export { ProviderConsole } from "./src/components/provider-market/provider-console.tsx"; export { providerMarketCommandSchema } from "./src/contracts/provider-market.ts";', resolveDir: rootPath, loader: "tsx", sourcefile: "provider-market-ui-entry.tsx" },
  outfile: bundle, bundle: true, platform: "node", format: "esm", target: "node22", jsx: "automatic", loader: { ".css": "empty" }, tsconfig: resolve(rootPath, "tsconfig.json"), logLevel: "silent",
  plugins: [{ name: "single-react-runtime", setup(api) { api.onResolve({ filter: /^(react(?:\/.*)?|react-dom(?:\/.*)?)$/ }, args => ({ path: require.resolve(args.path), external: true })); } }],
});
await chmod(bundle, 0o600);
const React = require("react"), { act } = React, { createRoot } = require("react-dom/client");
const { ProviderMarket, ProviderConsole, providerMarketCommandSchema } = await import(pathToFileURL(bundle).href);
const root = createRoot(document.getElementById("root"));
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const digest = c => c.repeat(64), clone = value => structuredClone(value);
const clock = "2030-05-13T10:00:00.000Z", expiry = "2030-05-14T10:00:00.000Z", ceiling = "2030-05-20T10:00:00.000Z";
function fixture(scope = "buyer", withThread = false, withTask = false) {
  const policy = { id: uuid(10), providerId: "formwork", revision: 2, digest: digest("b"), previousDigest: digest("a"), ownerId: "controlled-owner-1", createdAt: clock, disclosure: "Controlled policy fixture; no outside business claim.", minimumAwardMinor: 12000, askingAwardMinor: 14000, maximumConcurrentTasks: 2, workingHours: 8, calendarId: "museum-weekdays-v1", allowedKinds: ["web"], correctionAllowance: 1, counterofferLimit: 5, validUntil: ceiling, contentRules: "Only approved museum sources; no invented historical detail." };
  const provider = { id: "formwork", monogram: "Fw", color: "#d8c6ad", displayName: "Formwork", ownerDisplayName: "Controlled service owner", specialty: "Web exhibition design", description: "A controlled exhibition service with an explicit owner policy and source-bound work.", portfolioUrl: "https://example.test/controlled-portfolio", endpoint: "/controlled/formwork", cardUrl: "/controlled/formwork/card", kinds: ["web"], protocol: { specification: "1.0.1", version: "1.0", binding: "JSONRPC", cardDigest: digest("c"), observedAt: clock, streaming: false }, enrollment: { state: "ready", revision: 4, message: "Controlled provider discovery is ready.", requiredActions: [], lastFailure: null, canEdit: true }, policy, capacity: { active: 0, reserved: 0, maximum: 2 }, history: null, provenance: { kind: "guild_controlled_service", label: "Controlled service", syntheticFixture: true } };
  const work = { id: "web-work", title: "Controlled exhibition website", kind: "web", description: "Build a source-bound museum exhibition with the agreed controls and review pack.", contractVersion: 3, contractDigest: digest("d"), acceptancePackDigest: digest("e"), criteria: [{ id: "keyboard", label: "All exhibition controls work by keyboard", blocking: true, kind: "deterministic" }, { id: "curator", label: "Curator signs the visual review", blocking: true, kind: "human" }], sourceDigest: digest("f"), providerId: "formwork", providerAwardMinor: 12000, serviceFeeMinor: 1500, grossMinor: 13500, workAuthorityExpiresAt: ceiling, allowedProviderIds: ["formwork"], availableGrossMinor: 17500, state: "quoted", canRequestQuote: true, unavailableReason: null };
  const terms = { providerId: provider.id, packageId: work.id, kind: "web", contractVersion: work.contractVersion, contractDigest: work.contractDigest, acceptancePackDigest: work.acceptancePackDigest, sourceDigest: work.sourceDigest, providerPolicyRevision: policy.revision, providerPolicyDigest: policy.digest, providerAwardMinor: 12000, serviceFeeMinor: 1500, grossMinor: 13500, currency: "USD", workingHours: 8, calendarId: "museum-weekdays-v1", correctionAllowance: 1, expiresAt: expiry, workAuthorityExpiresAt: ceiling };
  const decision = (side, allowed) => ({ side, allowed, code: allowed ? "within_policy" : "below_provider_floor", reason: allowed ? `${side === "buyer" ? "Buyer" : "Provider"} policy allows these exact terms.` : "The $110.00 proposal is below the provider’s $120.00 owner floor.", policyId: side === "buyer" ? "controlled-child-mandate" : policy.id, policyRevision: side === "buyer" ? 6 : policy.revision, policyDigest: side === "buyer" ? digest("7") : policy.digest, checkedAt: clock });
  const message = (n, side, amount, allowed, kind) => ({ id: uuid(100 + n), commandId: uuid(200 + n), revision: n, parentDigest: n > 1 ? digest(String(n - 1)) : null, digest: digest(String(n)), kind, side, senderLabel: side === "buyer" ? "Controlled buyer" : "Formwork", createdAt: clock, terms: { ...terms, providerAwardMinor: amount, grossMinor: amount + terms.serviceFeeMinor }, termsDigest: digest(String(n + 3)), note: `Controlled ${side} ${kind} at ${amount / 100} USD.`, decisions: [decision("buyer", true), decision("provider", allowed)] });
  const thread = { id: uuid(30), revision: 3, commissionId: uuid(1), customerLabel: "Controlled museum", packageId: work.id, packageTitle: work.title, providerId: provider.id, state: "open", messages: [message(1, "provider", 14000, true, "offer.propose"), message(2, "buyer", 11000, false, "offer.counter"), message(3, "provider", 12000, true, "offer.counter")], latestTerms: terms, latestTermsDigest: digest("6"), selectedAt: null, approvalRequired: false, operations: [], permissions: { counter: true, select: true, decline: true, respond: true, delegate: false }, unavailableReason: null };
  const binding = { id: uuid(40), commissionId: uuid(1), packageId: work.id, providerId: provider.id, threadId: thread.id, offerRevision: thread.revision, offerDigest: thread.latestTermsDigest, contractVersion: work.contractVersion, contractDigest: work.contractDigest, acceptancePackDigest: work.acceptancePackDigest, sourceDigest: work.sourceDigest, approvedPlanDigest: digest("9"), mandateId: "controlled-child-mandate", mandateRevision: 6, mandateDigest: digest("7"), parentMandateId: "controlled-root-mandate", parentMandateRevision: 2, parentMandateDigest: digest("8"), providerPolicyRevision: policy.revision, providerPolicyDigest: policy.digest, providerAwardMinor: terms.providerAwardMinor, serviceFeeMinor: terms.serviceFeeMinor, grossMinor: terms.grossMinor, originalWorkCeiling: ceiling, taskId: uuid(50), createdAt: clock };
  const task = { id: uuid(50), contextId: uuid(51), revision: 2, state: "completed", providerId: provider.id, commissionId: uuid(1), customerLabel: "Controlled museum", packageId: work.id, packageTitle: work.title, binding, originalJobId: uuid(52), statusMessage: "Controlled work is submitted; curator acceptance is still required.", updatedAt: clock, artifacts: [{ id: uuid(53), title: "Controlled website artifact", contentHash: digest("a"), mediaType: "application/zip", downloadUrl: "/controlled/artifact.zip", submittedAt: clock, verification: { state: "passed", checks: [{ label: "Keyboard controls", status: "passed", evidence: "Controlled keyboard check retained against this content hash." }] } }], acceptance: { state: "awaiting_review", message: "The curator has not accepted this work." }, payment: { awardMinor: 12000, customerGrossMinor: 13500, captureState: "not_requested", payoutState: "not_started", disclosure: "Controlled payment projection. No funds have moved." }, canCancel: true, canReadOriginal: true, syntheticFixture: true };
  return { version: "guild.provider-market.v1", scope, serverTime: clock, revision: 11, viewer: { role: scope === "provider" ? "provider" : "owner", providerId: scope === "provider" ? provider.id : null, label: scope === "provider" ? "Controlled provider owner" : "Controlled curator", canManageProvider: scope === "provider" }, commission: { id: uuid(1), revision: 8, title: "Controlled museum commission", customerLabel: "Controlled museum", capMinor: 64000, availableMinor: 64000, approvedPlanDigest: null, originalWorkCeiling: ceiling, languages: ["en", "ar"], studioUrl: `/?commission=${uuid(1)}` }, providers: [provider], packages: [work], threads: withThread ? [thread] : [], tasks: withTask ? [task] : [], disclosure: "Synthetic UI qualification fixture; not external provider or financial evidence.", syntheticFixture: true, protocol: { a2a: { specification: "1.0.1", protocolVersion: "1.0", binding: "JSONRPC", sourceCommit: "3303592588e388e62e0f69f701af531d2f4e3991" }, interoperability: "pending", mcpTools: ["commission.create", "commission.status", "approval.link"], ap2Conformance: "pending" } };
}
const report = { version: "guild.provider-market-ui-dom.v1", at: new Date().toISOString(), passed: false, syntheticFixture: true, nativeBrowserClaimed: false, networkCalls: 0, checks: [], runtime: "Actual ProviderMarket and ProviderConsole; CSS excluded from jsdom; native dialog methods supplied by harness; no application boundary stubs." };
let serial = 0, currentComponent, currentProps;
const text = () => document.body.textContent;
const all = selector => [...document.querySelectorAll(selector)];
function buttonName(item) { if (item.getAttribute("aria-label")) return item.getAttribute("aria-label"); const copy = item.cloneNode(true); for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove(); return copy.textContent.trim(); }
function button(label, parent = document) { const found = [...parent.querySelectorAll("button")].find(item => buttonName(item) === label); assert.ok(found, `Missing button: ${label}`); return found; }
function startsButton(label, parent = document) { const found = [...parent.querySelectorAll("button")].find(item => buttonName(item).startsWith(label)); assert.ok(found, `Missing button starting: ${label}`); return found; }
const form = name => { const element = document.querySelector(`form[aria-label="${name}"]`); assert.ok(element, `Missing form ${name}`); return element; };
const field = (name, parent = document) => { const element = parent.querySelector(`[name="${name}"]`); assert.ok(element, `Missing field ${name}`); return element; };
async function click(element) { assert.ok(element); await act(async () => { element.click(); }); }
async function input(element, value) { await act(async () => { const prototype = element instanceof dom.window.HTMLTextAreaElement ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value); element.dispatchEvent(new dom.window.Event("input", { bubbles: true })); element.dispatchEvent(new dom.window.Event("change", { bubbles: true })); }); }
async function submit(element) { await act(async () => { element.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); }); }
async function mount(Component, snapshot, options = {}) {
  if (!options.keepStorage) dom.window.sessionStorage.clear();
  currentComponent = Component; currentProps = { snapshot, status: options.status ?? "ready", error: options.error ?? null, onRefresh: options.onRefresh ?? (async () => {}), onCommand: options.onCommand ?? (async command => ({ ok: true, commandId: command.commandId, message: "Controlled request completed.", snapshot })), key: ++serial };
  await act(async () => root.render(React.createElement(Component, currentProps)));
}
async function rerender(patch) { currentProps = { ...currentProps, ...patch }; await act(async () => root.render(React.createElement(currentComponent, currentProps))); }
const ok = (command, snapshot, extra = {}) => ({ ok: true, commandId: command.commandId, message: "Controlled request completed.", snapshot: clone(snapshot), ...extra });
async function check(name, work) { await work(); report.checks.push({ name, passed: true }); }

try {
  await check("loading state names the work without enabling mutations", async () => {
    await mount(ProviderMarket, null, { status: "loading" }); assert.match(text(), /Loading the provider workspace/); assert.equal(startsButton("Refresh state").matches(":disabled"), true); assert.equal(all(".pm-provider-card").length, 0);
  });
  await check("initial error and failed refresh preserve an actionable recovery state", async () => {
    let reads = 0; await mount(ProviderMarket, null, { status: "error", error: "Controlled connection failure", onRefresh: async () => { reads++; throw new Error("controlled"); } }); await click(button("Try again")); assert.equal(reads, 1); assert.match(text(), /Controlled connection failure/); assert.match(text(), /Your draft and original request are still here/);
  });
  await check("empty marketplace and absent commission remain usable without invented providers", async () => {
    const data = fixture(); data.providers = []; data.packages = []; data.commission = null; let mutations = 0; await mount(ProviderMarket, data, { onCommand: async () => { mutations++; } }); assert.match(text(), /No work packages yet/); assert.match(text(), /The registry is empty/); assert.match(text(), /No delegated work yet/); assert.equal(mutations, 0);
  });
  await check("a failed refresh shows retained state while all writes are disabled", async () => {
    await mount(ProviderMarket, fixture(), { status: "error", error: "Offline fixture" }); assert.match(text(), /Showing the last confirmed state/); assert.equal(startsButton("Request quote").matches(":disabled"), true); assert.ok(document.querySelector(".pm-contract"));
  });
  await check("request quote carries the selected contract identity and guards two same-turn clicks", async () => {
    const data = fixture(), calls = []; let finish;
    await mount(ProviderMarket, data, { onCommand: command => { calls.push(clone(command)); return new Promise(resolve => { finish = resolve; }); } });
    const request = startsButton("Request quote"); await act(async () => { request.click(); request.click(); }); assert.equal(calls.length, 1); const command = calls[0]; providerMarketCommandSchema.parse(command);
    assert.equal(command.type, "request_quote"); assert.equal(command.commissionId, data.commission.id); assert.equal(command.expectedCommissionRevision, 8); assert.equal(command.packageId, "web-work"); assert.equal(command.providerId, "formwork"); assert.ok(command.commandId); await act(async () => finish(ok(command, data)));
  });
  await check("unknown result retains exact payload and identity across remount and retries once", async () => {
    const data = fixture(), calls = []; let lost = true;
    const onCommand = async command => { calls.push(clone(command)); if (lost) { lost = false; throw new Error("Controlled lost response"); } return ok(command, data); };
    await mount(ProviderMarket, data, { onCommand }); await click(startsButton("Request quote")); assert.match(text(), /Original request retained/); const first = calls[0]; assert.equal(dom.window.sessionStorage.length, 1); assert.equal(startsButton("Request quote").matches(":disabled"), true);
    await mount(ProviderMarket, data, { onCommand, keepStorage: true }); assert.match(text(), /Original request retained/); await click(button("Recover same request")); assert.equal(calls.length, 2); assert.deepEqual(calls[1], first); assert.equal(dom.window.sessionStorage.length, 0); assert.equal(document.querySelector(".pm-retained"), null);
  });
  await check("a response for a different command is treated as unknown, never as confirmation", async () => {
    const data = fixture(); let sent; await mount(ProviderMarket, data, { onCommand: async command => { sent = command; return ok({ ...command, commandId: uuid(999) }, data); } }); await click(startsButton("Request quote")); assert.match(text(), /The result needs to be recovered/); assert.match(document.querySelector(".pm-retained").textContent, new RegExp(sent.commandId));
  });
  await check("unknown server operations remain recoverable and a lost recovery keeps both exact identities", async () => {
    const data = fixture(), calls = []; let unknown, original;
    const onCommand = async command => {
      calls.push(clone(command));
      if (calls.length === 1) {
        original = clone(command); unknown = fixture("buyer", true); unknown.threads[0].state = "needs_review";
        unknown.threads[0].operations = [{ id: uuid(94), commandId: command.commandId, kind: "request_quote", state: "needs_review", requestDigest: digest("8"), originalMessageId: uuid(95), failureCode: "controlled_unknown", canRecoverOriginal: true, createdAt: clock }];
        return { ok: false, commandId: command.commandId, error: { code: "provider_response_unknown", message: "Controlled original response is unknown", retryable: true, unknownOutcome: true }, snapshot: unknown };
      }
      if (calls.length === 2) throw new Error("Controlled recovery response lost");
      const recovered = clone(unknown); recovered.threads[0].operations[0].state = "completed"; recovered.threads[0].operations[0].canRecoverOriginal = false;
      return ok(command, recovered);
    };
    await mount(ProviderMarket, data, { onCommand }); await click(startsButton("Request quote")); const recovery = button("Recover original provider result"); assert.equal(recovery.matches(":disabled"), false); await click(recovery); assert.equal(calls.length, 2); assert.equal(calls[1].type, "recover_original"); assert.equal(calls[1].operationId, uuid(94)); const retained = JSON.parse(dom.window.sessionStorage.getItem(dom.window.sessionStorage.key(0))); assert.deepEqual(retained.original.command, original); assert.deepEqual(retained.command, calls[1]);
    await mount(ProviderMarket, unknown, { onCommand, keepStorage: true }); await click(button("Recover same request")); assert.equal(calls.length, 3); assert.deepEqual(calls[2], calls[1]); assert.equal(dom.window.sessionStorage.length, 0); assert.equal(document.querySelector(".pm-retained"), null);
  });
  await check("enrollment, capacity, policy expiry, allowlist and authority each explain unavailable quotes", async () => {
    for (const [mutate, expected] of [
      [data => { data.providers[0].enrollment.state = "discovery_required"; data.providers[0].enrollment.message = "Controlled discovery pending"; }, /Controlled discovery pending/],
      [data => { data.providers[0].capacity.active = 2; }, /All current provider capacity is in use/],
      [data => { data.providers[0].policy.validUntil = "2029-01-01T00:00:00.000Z"; }, /current policy has expired/],
      [data => { data.packages[0].allowedProviderIds = []; }, /outside the package’s current allowlist/],
      [data => { data.packages[0].workAuthorityExpiresAt = "2029-01-01T00:00:00.000Z"; }, /work authority has expired/],
    ]) { const data = fixture(); mutate(data); await mount(ProviderMarket, data); assert.equal(startsButton("Request quote").matches(":disabled"), true); assert.match(text(), expected); }
  });
  await check("the full 140→110→120 offer history displays both policy decisions and separate fee/gross", async () => {
    await mount(ProviderMarket, fixture("buyer", true)); const messages = all(".pm-offer-history>li"); assert.equal(messages.length, 3);
    for (const [index, award, gross] of [[0, "$140.00", "$155.00"], [1, "$110.00", "$125.00"], [2, "$120.00", "$135.00"]]) { const row = messages[index]; const price = row.querySelector(".pm-money"); assert.match(price.textContent, new RegExp(award.replaceAll("$", "\\$"))); assert.match(price.textContent, /Service fee\$15\.00/); assert.ok(price.textContent.includes(gross)); assert.equal(row.querySelectorAll(".pm-decision-side").length, 2); }
    assert.match(messages[1].textContent, /Refused/); assert.match(messages[1].textContent, /\$120.00 owner floor/); assert.match(text(), /Sample · controlled fixture/); assert.match(text(), /No verified history recorded/);
  });
  await check("buyer counter sends exact integer cents and the visible thread revision even below provider floor", async () => {
    const data = fixture("buyer", true), calls = []; await mount(ProviderMarket, data, { onCommand: async command => { calls.push(command); return ok(command, data); } }); await click(button("Counter this offer")); const response = form("Counteroffer response"); await input(response.querySelector("input"), "110.00"); await input(response.querySelector("textarea"), "Controlled buyer counter within the child allowance."); await submit(response); assert.equal(calls.length, 1); assert.equal(calls[0].type, "counter_offer"); assert.equal(calls[0].providerAwardMinor, 11000); assert.equal(calls[0].expectedThreadRevision, 3); providerMarketCommandSchema.parse(calls[0]);
  });
  await check("stale buyer counter preserves its amount and note until the current thread revision is reviewed", async () => {
    const data = fixture("buyer", true), fresh = clone(data), calls = []; fresh.threads[0].revision = 4; fresh.threads[0].latestTerms.providerAwardMinor = 12500; fresh.threads[0].latestTerms.grossMinor = 14000;
    await mount(ProviderMarket, data, { onCommand: async command => { calls.push(clone(command)); return calls.length === 1 ? { ok: false, commandId: command.commandId, error: { code: "stale_thread_revision", message: "Controlled newer offer", retryable: false, unknownOutcome: false, currentRevision: 4 }, snapshot: fresh } : ok(command, fresh); } }); await click(button("Counter this offer")); const response = form("Counteroffer response"); await input(response.querySelector("input"), "110.00"); await input(response.querySelector("textarea"), "Keep this controlled buyer draft."); await submit(response); assert.equal(response.querySelector("input").value, "110.00"); assert.equal(response.querySelector("textarea").value, "Keep this controlled buyer draft."); assert.equal(button("Send counteroffer").matches(":disabled"), true); await click(button("Use my response with revision 4")); await submit(response); assert.equal(calls.length, 2); assert.equal(calls[1].expectedThreadRevision, 4); assert.equal(calls[1].providerAwardMinor, 11000);
  });
  await check("offer dialog supports Escape, focus return, and explicit selection of the reviewed digest", async () => {
    const data = fixture("buyer", true), calls = []; const selected = clone(data); selected.threads[0].state = "selected"; selected.threads[0].revision++; selected.threads[0].approvalRequired = true; selected.threads[0].selectedAt = clock; selected.threads[0].permissions.select = false;
    await mount(ProviderMarket, data, { onCommand: async command => { calls.push(command); return ok(command, selected, { threadId: data.threads[0].id, approvalUrl: `/?view=passport&commission=${uuid(1)}` }); } }); const opener = startsButton("Review offer"); opener.focus(); await click(opener); let dialog = document.querySelector("dialog[open]"); assert.ok(dialog); assert.equal(calls.length, 0); assert.equal(button("Select these terms", dialog).matches(":disabled"), true); assert.ok(dialog.contains(document.activeElement)); await act(async () => dialog.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }))); assert.equal(document.querySelector("dialog"), null); assert.equal(document.activeElement, opener);
    await click(opener); dialog = document.querySelector("dialog[open]"); await click(dialog.querySelector("input[type=checkbox]")); await click(button("Select these terms", dialog)); assert.equal(calls.length, 1); assert.equal(calls[0].type, "select_offer"); assert.equal(calls[0].termsDigest, data.threads[0].latestTermsDigest); assert.equal(calls[0].expectedThreadRevision, 3); assert.equal(calls[0].expectedCommissionRevision, 8); assert.ok(document.querySelector('a[href^="/?view=passport&commission="]')); assert.equal(startsButton("Review delegation").matches(":disabled"), true); assert.match(text(), /Artifact acceptance, customer payment, and provider payout are separate/);
  });
  await check("delegation requires current approval and sends its exact approved-plan and offer digests", async () => {
    const data = fixture("buyer", true), calls = []; data.threads[0].state = "selected"; data.threads[0].permissions.delegate = true; data.commission.approvedPlanDigest = digest("9");
    await mount(ProviderMarket, data, { onCommand: async command => { calls.push(command); return ok(command, data); } }); await click(startsButton("Review delegation")); const dialog = document.querySelector("dialog[open]"); assert.equal(calls.length, 0); await click(dialog.querySelector("input[type=checkbox]")); await click(button("Delegate this work", dialog)); assert.equal(calls.length, 1); assert.equal(calls[0].type, "delegate_task"); assert.equal(calls[0].approvedPlanDigest, digest("9")); assert.equal(calls[0].termsDigest, data.threads[0].latestTermsDigest); assert.equal(calls[0].expectedCommissionRevision, 8);
  });
  await check("an offer or commission change during review disables the frozen decision", async () => {
    const data = fixture("buyer", true); let calls = 0; await mount(ProviderMarket, data, { onCommand: async () => { calls++; } }); await click(startsButton("Review offer")); let dialog = document.querySelector("dialog[open]"); await click(dialog.querySelector("input[type=checkbox]")); const next = clone(data); next.threads[0].revision++; next.threads[0].latestTermsDigest = digest("a"); await rerender({ snapshot: next }); dialog = document.querySelector("dialog[open]"); assert.match(dialog.textContent, /changed while you were reviewing/); assert.equal(button("Select these terms", dialog).matches(":disabled"), true); await click(button("Select these terms", dialog)); assert.equal(calls, 0);
  });
  await check("an expired quote cannot be selected or countered despite stale optimistic permission flags", async () => {
    const data = fixture("buyer", true); data.threads[0].latestTerms.expiresAt = "2029-01-01T00:00:00.000Z"; await mount(ProviderMarket, data); assert.equal(startsButton("Review offer").matches(":disabled"), true); assert.equal(button("Counter this offer").matches(":disabled"), true); assert.match(text(), /quote has expired/); assert.equal(startsButton("Request quote").matches(":disabled"), false, "An expired open thread must not block a server-permitted fresh quote.");
  });
  await check("customer market retains commission scope even if a snapshot contains another commission's records", async () => {
    const data = fixture("buyer", true, true); data.threads[0].commissionId = uuid(700); data.threads[0].packageTitle = "FOREIGN COMMISSION OFFER"; data.tasks[0].commissionId = uuid(700); data.tasks[0].packageTitle = "FOREIGN COMMISSION TASK"; await mount(ProviderMarket, data); assert.doesNotMatch(text(), /FOREIGN COMMISSION/); assert.equal(all(".pm-thread,.pm-task").length, 0); assert.equal(startsButton("Request quote").matches(":disabled"), false);
  });
  await check("the console requires an explicit provider binding instead of trusting a generic role", async () => {
    const data = fixture("provider", true, true); data.viewer.providerId = null; await mount(ProviderConsole, data); assert.match(text(), /A provider owner session is required/); assert.equal(all(".pm-thread,.pm-task,.pm-settings-panel").length, 0);
  });
  await check("provider console filters offers and tasks to the bound provider", async () => {
    const data = fixture("provider", true, true), other = clone(data.providers[0]); other.id = "other-service"; other.displayName = "FOREIGN PRIVATE PROVIDER"; data.providers.push(other); const thread = clone(data.threads[0]); thread.id = uuid(600); thread.providerId = other.id; thread.packageTitle = "FOREIGN PRIVATE OFFER"; data.threads.push(thread); const task = clone(data.tasks[0]); task.id = uuid(601); task.providerId = other.id; task.packageTitle = "FOREIGN PRIVATE TASK"; data.tasks.push(task); await mount(ProviderConsole, data); assert.doesNotMatch(text(), /FOREIGN PRIVATE/); assert.equal(all(".pm-thread").length, 1); assert.equal(all(".pm-task").length, 1); assert.match(text(), /All exhibition controls work by keyboard/);
  });
  await check("same-ID contracts from two customers resolve only by the thread's exact contract and source digests", async () => {
    const data = fixture("provider", true), first = clone(data.packages[0]), other = clone(first), otherThread = clone(data.threads[0]);
    other.title = "Second controlled customer's website"; other.contractDigest = digest("a"); other.sourceDigest = digest("c"); other.criteria = [{ id: "other-contract-rule", label: "Only the second customer's exact collection may be used", blocking: true, kind: "human" }];
    otherThread.id = uuid(710); otherThread.commissionId = uuid(711); otherThread.customerLabel = "Second controlled customer"; otherThread.packageTitle = other.title; otherThread.latestTerms.contractDigest = other.contractDigest; otherThread.latestTerms.sourceDigest = other.sourceDigest; otherThread.latestTermsDigest = digest("8");
    for (const message of otherThread.messages) { message.id = uuid(Number(message.revision) + 720); message.terms.contractDigest = other.contractDigest; message.terms.sourceDigest = other.sourceDigest; }
    data.packages = [other, first]; data.threads.push(otherThread); await mount(ProviderConsole, data); const contracts = all(".pm-thread .pm-requested-contract"); assert.equal(contracts.length, 2); assert.match(contracts[0].textContent, /All exhibition controls work by keyboard/); assert.doesNotMatch(contracts[0].textContent, /second customer's exact collection/); assert.match(contracts[1].textContent, /second customer's exact collection/); assert.doesNotMatch(contracts[1].textContent, /All exhibition controls work by keyboard/);
  });
  await check("a missing exact source contract blocks provider responses instead of falling back to another customer", async () => {
    const data = fixture("provider", true); data.packages[0].sourceDigest = digest("c"); data.packages[0].criteria[0].label = "OTHER CUSTOMER CRITERION"; await mount(ProviderConsole, data); assert.equal(all(".pm-requested-contract").length, 0); assert.doesNotMatch(document.querySelector(".pm-thread").textContent, /OTHER CUSTOMER CRITERION/); assert.equal(button("Make a counteroffer").matches(":disabled"), true); assert.equal(button("Decline offer").matches(":disabled"), true); assert.match(text(), /exact requested work contract is missing or ambiguous/);
  });
  await check("ambiguous exact contract matches block provider writes and expose an actionable refresh reason", async () => {
    const data = fixture("provider", true); data.packages.push(clone(data.packages[0])); await mount(ProviderConsole, data); assert.equal(all(".pm-requested-contract").length, 0); assert.equal(button("Make a counteroffer").matches(":disabled"), true); assert.equal(button("Decline offer").matches(":disabled"), true); assert.match(text(), /Refresh before responding/);
  });
  await check("read-only owner permissions disable profile, policy, discovery and commercial responses", async () => {
    const data = fixture("provider", true); data.viewer.canManageProvider = false; let calls = 0; await mount(ProviderConsole, data, { onCommand: async () => { calls++; } }); assert.match(text(), /Read-only provider access/); assert.equal(button("Save profile").matches(":disabled"), true); assert.equal(button("Publish new policy revision").matches(":disabled"), true); assert.equal(button("Refresh discovery").matches(":disabled"), true); assert.equal(button("Make a counteroffer").matches(":disabled"), true); await submit(form("Provider profile")); assert.equal(calls, 0);
  });
  await check("profile validation rejects incomplete descriptions and executable portfolio URLs", async () => {
    let calls = 0; await mount(ProviderConsole, fixture("provider"), { onCommand: async () => { calls++; } }); const profile = form("Provider profile"); await input(field("description", profile), "Short"); await input(field("portfolioUrl", profile), "javascript:alert(1)"); await submit(profile); assert.equal(calls, 0); assert.equal(field("description", profile).getAttribute("aria-invalid"), "true"); assert.match(profile.textContent, /Use a complete https/); assert.equal(profile.querySelectorAll(".pm-validation li").length, 2);
  });
  await check("stale profile keeps the draft, shows current saved state and requires explicit rebase", async () => {
    const data = fixture("provider"), calls = [], fresh = clone(data); fresh.providers[0].displayName = "Saved by another tab"; fresh.providers[0].enrollment.revision = 5;
    await mount(ProviderConsole, data, { onCommand: async command => { calls.push(clone(command)); if (calls.length === 1) return { ok: false, commandId: command.commandId, error: { code: "stale_profile_revision", message: "Controlled profile conflict", retryable: false, unknownOutcome: false, currentRevision: 5 }, snapshot: fresh }; const next = clone(fresh); next.providers[0] = { ...next.providers[0], ...command.profile, enrollment: { ...next.providers[0].enrollment, revision: 6 } }; return ok(command, next); } });
    await input(field("displayName", form("Provider profile")), "My preserved draft"); await submit(form("Provider profile")); assert.equal(field("displayName", form("Provider profile")).value, "My preserved draft"); assert.match(form("Provider profile").textContent, /Saved by another tab/); assert.equal(button("Save profile").matches(":disabled"), true); await click(button("Keep my draft on revision 5")); await submit(form("Provider profile")); assert.equal(calls.length, 2); assert.equal(calls[0].expectedProfileRevision, 4); assert.equal(calls[1].expectedProfileRevision, 5); assert.equal(calls[1].profile.displayName, "My preserved draft"); assert.notEqual(calls[0].commandId, calls[1].commandId);
  });
  await check("all policy constraints reject invalid edits without emitting a command", async () => {
    let calls = 0; await mount(ProviderConsole, fixture("provider"), { onCommand: async () => { calls++; } }); const policy = form("Provider owner policy");
    for (const [name, value] of [["minimumAward", "120.00"], ["askingAward", "110.00"], ["maximumConcurrentTasks", "0"], ["workingHours", "241"], ["correctionAllowance", "4"], ["counterofferLimit", "21"], ["validUntil", "2029-01-01T10:00"], ["contentRules", ""]]) await input(field(name, policy), value);
    for (const checkbox of [...policy.querySelectorAll('input[name="allowedKinds"]')].filter(item => item.checked)) await click(checkbox);
    await submit(policy); assert.equal(calls, 0); assert.equal(policy.querySelectorAll(".pm-validation li").length, 8); assert.match(policy.textContent, /asking award must meet your minimum/); assert.match(policy.textContent, /Choose at least one allowed work type/);
  });
  await check("complete policy editor sends every schema field with integer money and explicit UTC expiry", async () => {
    const data = fixture("provider"), calls = []; await mount(ProviderConsole, data, { onCommand: async command => { calls.push(clone(command)); const next = clone(data); next.providers[0].policy = { ...next.providers[0].policy, ...command.policy, revision: 3 }; return ok(command, next); } }); const policy = form("Provider owner policy");
    for (const [name, value] of [["minimumAward", "125.25"], ["askingAward", "150.50"], ["maximumConcurrentTasks", "3"], ["workingHours", "16"], ["correctionAllowance", "2"], ["counterofferLimit", "7"], ["validUntil", "2032-03-04T12:30"], ["contentRules", "Controlled owner rules for museum material only."]]) await input(field(name, policy), value);
    await submit(policy); assert.equal(calls.length, 1); const command = calls[0]; providerMarketCommandSchema.parse(command); assert.equal(command.type, "update_provider_policy"); assert.equal(command.expectedPolicyRevision, 2); assert.deepEqual(command.policy, { minimumAwardMinor: 12525, askingAwardMinor: 15050, maximumConcurrentTasks: 3, workingHours: 16, calendarId: "museum-weekdays-v1", allowedKinds: ["web"], correctionAllowance: 2, counterofferLimit: 7, validUntil: "2032-03-04T12:30:00.000Z", contentRules: "Controlled owner rules for museum material only." });
  });
  await check("editing another policy field preserves the exact existing UTC seconds and milliseconds", async () => {
    const data = fixture("provider"), calls = []; data.providers[0].policy.validUntil = "2030-05-20T10:00:37.123Z"; await mount(ProviderConsole, data, { onCommand: async command => { calls.push(command); return ok(command, data); } }); const policy = form("Provider owner policy"); await input(field("contentRules", policy), "Controlled updated rules with an unchanged exact expiry."); await submit(policy); assert.equal(calls.length, 1); assert.equal(calls[0].policy.validUntil, data.providers[0].policy.validUntil);
  });
  await check("stale policy retains the complete owner draft beside the newly saved revision", async () => {
    const data = fixture("provider"), fresh = clone(data); fresh.providers[0].policy.revision = 3; fresh.providers[0].policy.minimumAwardMinor = 13000;
    await mount(ProviderConsole, data, { onCommand: async command => ({ ok: false, commandId: command.commandId, error: { code: "stale_policy_revision", message: "Controlled policy conflict", retryable: false, unknownOutcome: false, currentRevision: 3 }, snapshot: fresh }) }); const policy = form("Provider owner policy"); await input(field("contentRules", policy), "My unsaved owner content rules."); await input(field("askingAward", policy), "160.00"); await submit(policy); assert.equal(field("contentRules", policy).value, "My unsaved owner content rules."); assert.equal(field("askingAward", policy).value, "160.00"); assert.match(policy.textContent, /\$130.00/); assert.equal(button("Publish new policy revision").matches(":disabled"), true); await click(button("Keep my draft on revision 3")); assert.equal(button("Publish new policy revision").matches(":disabled"), false);
  });
  await check("provider counter enforces its current owner floor before sending the exact response", async () => {
    const data = fixture("provider", true), calls = []; await mount(ProviderConsole, data, { onCommand: async command => { calls.push(command); return ok(command, data); } }); await click(button("Make a counteroffer")); let response = form("Counteroffer response"); await input(response.querySelector("input"), "110.00"); await input(response.querySelector("textarea"), "Controlled provider response."); await submit(response); assert.equal(calls.length, 0); assert.match(response.textContent, /requires at least \$120.00/); await input(response.querySelector("input"), "120.00"); await submit(response); assert.equal(calls.length, 1); assert.equal(calls[0].type, "provider_counter"); assert.equal(calls[0].providerAwardMinor, 12000); assert.equal(calls[0].expectedThreadRevision, 3);
  });
  await check("provider decline retains a deliberate reason and original thread revision", async () => {
    const data = fixture("provider", true), calls = []; await mount(ProviderConsole, data, { onCommand: async command => { calls.push(command); return ok(command, data); } }); await click(button("Decline offer")); const response = form("Decline response"); await input(response.querySelector("textarea"), "The controlled source scope is outside our current owner rules."); await submit(response); assert.equal(calls.length, 1); assert.equal(calls[0].type, "provider_decline"); assert.equal(calls[0].expectedThreadRevision, 3); assert.match(calls[0].note, /outside our current owner rules/);
  });
  await check("task completion, artifact checks, acceptance, customer capture and provider payout are independent", async () => {
    await mount(ProviderConsole, fixture("provider", true, true)); const task = document.querySelector(".pm-task"), states = [...task.querySelectorAll(".pm-task-states>section")]; assert.equal(states.length, 4); assert.match(states[0].textContent, /completed/); assert.match(states[1].textContent, /awaiting review/); assert.match(states[2].textContent, /not requested/); assert.match(states[3].textContent, /not started/); assert.match(task.textContent, /Checks passed/); assert.match(task.textContent, /Provider award\$120.00Service fee\$15.00Customer gross\$135.00/); assert.match(task.textContent, /No funds have moved/); assert.equal(task.querySelector('a[href="/controlled/artifact.zip"]').textContent.includes("Open submitted artifact"), true); assert.equal([...task.querySelectorAll("button")].some(item => /accept artifact|capture payment|approve payment/i.test(item.textContent)), false);
  });
  await check("task cancellation preserves its reason across a stale task and requires reviewed revision", async () => {
    const data = fixture("provider", true, true), fresh = clone(data), calls = []; fresh.tasks[0].revision = 3; fresh.tasks[0].statusMessage = "Controlled updated original task status.";
    await mount(ProviderConsole, data, { onCommand: async command => { calls.push(command); return calls.length === 1 ? { ok: false, commandId: command.commandId, error: { code: "stale_task_revision", message: "Task changed", retryable: false, unknownOutcome: false, currentRevision: 3 }, snapshot: fresh } : ok(command, fresh); } }); await click(button("Cancel task")); const response = form("Cancel delegated task"); await input(response.querySelector("textarea"), "Controlled cancellation reason."); await submit(response); assert.equal(response.querySelector("textarea").value, "Controlled cancellation reason."); assert.equal(button("Confirm task cancellation").matches(":disabled"), true); await click(button("Use my reason with revision 3")); await submit(response); assert.equal(calls.length, 2); assert.equal(calls[1].type, "cancel_task"); assert.equal(calls[1].expectedTaskRevision, 3); assert.equal(calls[1].taskId, data.tasks[0].id);
  });
  await check("original-result recovery addresses the recorded operation without creating replacement work", async () => {
    const data = fixture("provider", true, true), calls = []; data.threads[0].operations = [{ id: uuid(89), commandId: uuid(88), kind: "request_quote", state: "needs_review", requestDigest: digest("7"), originalMessageId: uuid(87), failureCode: "controlled_old_quote", canRecoverOriginal: true, createdAt: clock }, { id: uuid(90), commandId: uuid(91), kind: "delegate_task", state: "needs_review", requestDigest: digest("8"), originalMessageId: uuid(92), failureCode: "controlled_response_lost", canRecoverOriginal: true, createdAt: clock }]; await mount(ProviderConsole, data, { onCommand: async command => { calls.push(command); return ok(command, data); } }); await click(button("Recover original result", document.querySelector(".pm-task"))); assert.equal(calls.length, 1); assert.equal(calls[0].type, "recover_original"); assert.equal(calls[0].operationId, uuid(90)); assert.match(document.querySelector(".pm-task").textContent, new RegExp(data.tasks[0].originalJobId));
  });
  await check("discovery retry uses only the bound provider and onboarding identifies the next step", async () => {
    const data = fixture("provider"), calls = []; data.providers[0].enrollment.state = "discovery_required"; data.providers[0].enrollment.lastFailure = "Controlled transport unavailable"; data.providers[0].enrollment.requiredActions = ["Retry service discovery."]; await mount(ProviderConsole, data, { onCommand: async command => { calls.push(command); return ok(command, data); } }); await click(button("Retry discovery")); assert.equal(calls.length, 1); assert.equal(calls[0].type, "discover_provider"); assert.equal(calls[0].providerId, "formwork"); const next = fixture("provider"); next.providers[0].enrollment.state = "profile_required"; await mount(ProviderConsole, next); assert.ok(document.querySelector('a[href="#provider-profile"]')); assert.equal(button("Refresh discovery").matches(":disabled"), true);
  });
  await check("unsafe links and bid markup stay inert while locale content retains its own direction", async () => {
    const data = fixture("provider", true, true); data.providers[0].portfolioUrl = "javascript:alert(1)"; data.providers[0].cardUrl = "data:text/html,unsafe"; data.tasks[0].artifacts[0].downloadUrl = "//untrusted.test/private"; data.threads[0].messages[0].note = 'العربية <img src=x onerror="alert(1)">'; await mount(ProviderConsole, data); assert.equal(all("a").some(a => /^(javascript:|data:|\/\/)/.test(a.getAttribute("href"))), false); assert.equal(all("img").length, 0); const note = document.querySelector(".pm-message-note"); assert.equal(note.getAttribute("dir"), "auto"); assert.ok(note.textContent.includes("<img")); assert.match(text(), /A safe artifact link is not available/);
  });
  await check("all editable fields have programmatic labels and dialog focus wraps to a visible control", async () => {
    await mount(ProviderConsole, fixture("provider", true)); for (const input of all("input,textarea,select")) assert.ok(input.labels?.length > 0, `Unlabeled ${input.name || input.id}`);
    await mount(ProviderMarket, fixture("buyer", true)); await click(startsButton("Review offer")); const dialog = document.querySelector("dialog[open]"), last = button("Select these terms", dialog); await click(dialog.querySelector("input[type=checkbox]")); last.focus(); await act(async () => last.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }))); assert.equal(document.activeElement, dialog.querySelector("button"));
  });
  await check("refresh is guarded synchronously and component UI makes no network requests", async () => {
    let reads = 0, finish; await mount(ProviderMarket, fixture(), { onRefresh: () => { reads++; return new Promise(resolve => { finish = resolve; }); } }); const refresh = button("Refresh state"); await act(async () => { refresh.click(); refresh.click(); }); assert.equal(reads, 1); await act(async () => finish()); assert.equal(networkCalls, 0);
  });
  await check("scoped CSS contains phone/tablet, reduced-motion and forced-colour paths (not layout verification)", async () => {
    const css = await readFile(resolve(rootPath, "src/components/provider-market/provider-market.css"), "utf8"); assert.match(css, /@media\(max-width:420px\)/); assert.match(css, /@media\(max-width:650px\)/); assert.match(css, /@media\(max-width:900px\)/); assert.match(css, /prefers-reduced-motion:reduce/); assert.match(css, /forced-colors:active/); assert.doesNotMatch(css, /@import|https?:\/\//);
  });
  report.passed = true;
} catch (error) {
  report.error = { message: error.message, stack: error.stack }; process.exitCode = 1;
} finally {
  report.networkCalls = networkCalls;
  await act(async () => root.unmount()); dom.window.close(); globalThis.fetch = originalFetch;
  const path = resolve(evidence, `provider-market-ui-${new Date().toISOString().replaceAll(":", "-")}.json`);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ reportPath: path, passed: report.passed, checks: report.checks.length, networkCalls, nativeBrowserClaimed: false, error: report.error?.message }));
}
