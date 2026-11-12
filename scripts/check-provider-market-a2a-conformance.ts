/** Bounded A2A 1.0.1 JSON-RPC profile qualification using the pinned official
 * client over real loopback HTTP. This is not a full-protocol conformance claim.
 * Every row is new controlled data; no job, model, media or payment runs. */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Pool } from "pg";
import { SendMessageRequest, SubscribeToTaskRequest, Task, TaskState, type StreamResponse } from "@a2a-js/sdk";
import { ClientFactory, JsonRpcTransportFactory, ServiceParameters, withA2AExtensions } from "@a2a-js/sdk/client";
import { isJsonRpcError } from "@a2a-js/sdk/errors";
import { createCommissionSchema, type Commission, type PackageKind } from "../src/contracts/guild";
import { MARKET_EXTENSION, type ProviderMarketCommand } from "../src/contracts/provider-market";
import { marketContractDigest, marketSourceDigest, marketWorkCeiling } from "../src/domain/provider-market";
import { createCommission, saveCommission } from "../src/server/commissions";
import { getPool, transaction } from "../src/server/db";
import type { Session } from "../src/server/session";
import { marketAgentCardResponse, marketA2AResponse } from "../src/server/provider-market/a2a-http";
import { executeProviderMarketCommand } from "../src/server/provider-market/commands";
import { createProtocolClient } from "../src/server/provider-market/protocol-auth";
import { configureControlledProviders, providerRow } from "../src/server/provider-market/registry";

type SdkClient = Awaited<ReturnType<ClientFactory["createFromAgentCard"]>>;
type Actor = Session & { token?: string };
interface Check { id: string; provider: string; requirement: string; passed: boolean; observed?: unknown; error?: string }
interface Wire { method: string; path: string; rpcMethod?: string; requestHash: string; status?: number; contentType?: string; responseHash?: string; chunks?: number }
export interface A2AConformanceReport {
  version: string; schema: string; at: string; origin: string; completed: boolean; passed: boolean;
  conformance: "not-qualified"; sourceSpecification: "1.0.1"; sdkSpecification: "1.0.0"; wireVersion: "1.0";
  checks: Check[]; failures: string[]; wire: Wire[]; sourceHashes: Record<string, string>; sourceHashesEnd: Record<string, string>;
  changedSources: string[]; bridgeErrors: string[]; sideEffects: Record<string, number>; reportPath?: string; error?: string; disclosures: string[];
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const providerIds = ["marlow", "tessellate", "quill", "halide", "ostrava", "formwork", "northlight"];
const options = () => ({ serviceParameters: ServiceParameters.create(withA2AExtensions(MARKET_EXTENSION)), signal: AbortSignal.timeout(8_000) });
function jsonRpcFailure(error: unknown) {
  // SDK 1.3.0's SSE parser wraps the semantic JSON-RPC error in Error.cause;
  // ordinary JSON responses throw that semantic error directly.
  const semantic = isJsonRpcError(error) ? error : error instanceof Error ? error.cause : undefined;
  assert.ok(isJsonRpcError(semantic)); return semantic;
}

export async function runProviderMarketA2AConformanceQualification(): Promise<A2AConformanceReport> {
  const schema = process.env.GUILD_A2A_CONFORMANCE_SCHEMA ?? "", evidence = process.env.GUILD_A2A_CONFORMANCE_EVIDENCE_DIR;
  assert.match(schema, /^guild_market_a2a_conformance_[a-f0-9]{20}$/); assert.ok(evidence);
  assert.ok(process.env.DATABASE_URL && process.env.AUTH_SECRET && process.env.JUDGE_SESSION_SECRET);
  const uri = new URL(process.env.DATABASE_URL);
  assert.equal(Number(uri.searchParams.get("port") ?? uri.port), 55568);
  assert.equal(uri.searchParams.get("options"), `-c search_path=${schema}`);
  for (const key of ["OPENAI_API_KEY", "GEMINI_API_KEY", "DEEPGRAM_API_KEY", "BLOB_READ_WRITE_TOKEN", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"]) assert.equal(process.env[key] ?? "", "");
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  const sensitive = new Set([process.env.DATABASE_URL, process.env.AUTH_SECRET, process.env.JUDGE_SESSION_SECRET]);
  const scrub = (value: string) => [...sensitive].reduce((text, secret) => secret ? text.replaceAll(secret, "[private]") : text, value).replace(/\b(?:gc_|g1\.)[A-Za-z0-9_.-]+/g, "[credential]");
  const report: A2AConformanceReport = { version: "guild.a2a-profile-conformance-qualification.v1", schema, at: new Date().toISOString(), origin: "", completed: false, passed: false,
    conformance: "not-qualified", sourceSpecification: "1.0.1", sdkSpecification: "1.0.0", wireVersion: "1.0", checks: [], failures: [], wire: [],
    sourceHashes: {}, sourceHashesEnd: {}, changedSources: [], bridgeErrors: [], sideEffects: {}, disclosures: [
      "Seven addressed Guild-controlled services, not seven independent outside businesses.",
      "Only the specified JSON-RPC profile and bounded edge cases are qualified. Full A2A 1.0.1 conformance is not established.",
      "The SDK package is 1.3.0 and its README declares specification 1.0.0. Specification patch revision 1.0.1 selects wire version 1.0.",
      "Programmatic fixture authority and controlled receipt-status changes are qualification data, not human approval or real provider production.",
      "No existing runtime, schema, fixture or job is reused; no worker/model/media/financial transport runs.",
    ] };
  for (const file of ["scripts/check-provider-market-a2a-conformance.ts", "tests/provider-market-a2a-conformance.test.ts", "src/server/provider-market/a2a-http.ts",
    "src/server/provider-market/a2a-service.ts", "src/server/provider-market/a2a-wire.ts", "src/server/provider-market/a2a-validation.ts", "src/server/provider-market/a2a-pagination.ts",
    "src/server/provider-market/registry.ts", "src/server/provider-market/protocol-auth.ts", "src/contracts/provider-market.ts", "node_modules/@a2a-js/sdk/package.json",
    "node_modules/@a2a-js/sdk/dist/server/index.js", "node_modules/@a2a-js/sdk/dist/client/index.js", "node_modules/@a2a-js/sdk/README.md"]) report.sourceHashes[file] = sha(await readFile(resolve(root, file)));
  let db: Pool | undefined, server: ReturnType<typeof createServer> | undefined, origin = "", buyer: Actor;
  let currentObserved: unknown;
  const clients: Record<string, SdkClient> = {}, quotes: Record<string, { task: Task; kind: PackageKind; commission: Commission }> = {};
  async function check(id: string, provider: string, requirement: string, work: () => Promise<unknown>): Promise<void> {
    try { report.checks.push({ id, provider, requirement, passed: true, observed: await work() }); }
    catch (error) { report.checks.push({ id, provider, requirement, passed: false, error: scrub(error instanceof Error ? error.message : String(error)), observed: currentObserved }); report.failures.push(`${provider}:${id}`); }
    currentObserved = undefined;
  }
  async function actor(role: Session["role"] = "owner", sameTenant?: Actor): Promise<Actor> {
    const id = randomUUID(), tenantId = sameTenant?.tenantId ?? randomUUID(), token = randomBytes(32).toString("base64url"), expiresAt = sameTenant?.expiresAt ?? new Date(Date.now() + 7_200_000).toISOString();
    sensitive.add(token);
    if (!sameTenant) await db!.query("INSERT INTO guild_tenants(id,expires_at,mode) VALUES($1,$2,'owner')", [tenantId, expiresAt]);
    await db!.query("INSERT INTO guild_sessions(id,tenant_id,token_hash,role,expires_at) VALUES($1,$2,$3,$4,$5)", [id, tenantId, sha(token), role, expiresAt]);
    return { id, tenantId, role, expiresAt };
  }
  async function protocolActor(value: Actor): Promise<Actor> {
    const credential = await createProtocolClient(db!, value, ["a2a"], null, value.expiresAt); sensitive.add(credential.token); return { ...value, token: credential.token };
  }
  async function commission(title = "Controlled conformance vector"): Promise<Commission> {
    const value = await createCommission(buyer, createCommissionSchema.parse({ commandId: randomUUID(), title, museum: "Controlled conformance test", objective: "Audit the exact controlled Guild profile using no sources, workers or payments.", capMinor: 64000, languages: ["en"], sourceIds: [] }), []);
    value.mode = "sample"; await transaction(client => saveCommission(client, value)); return value;
  }
  function quote(value: Commission, kind: PackageKind, patch: Record<string, unknown> = {}): SendMessageRequest {
    const pkg = value.packages.find(item => item.kind === kind)!;
    return SendMessageRequest.fromJSON({ tenant: buyer.tenantId, configuration: { returnImmediately: true, historyLength: 2, acceptedOutputModes: ["application/json"] }, message: { messageId: randomUUID(), role: "ROLE_USER", extensions: [MARKET_EXTENSION],
      parts: [{ data: { type: "quote.request", requestId: randomUUID(), commissionId: value.id, packageId: pkg.id, kind, contractVersion: pkg.contractVersion, contractDigest: marketContractDigest(pkg), acceptancePackDigest: pkg.acceptancePack.digest, sourceDigest: marketSourceDigest(value, pkg), workAuthorityExpiresAt: marketWorkCeiling(value, buyer.expiresAt) } }], metadata: { guild: { commissionRevision: value.revision } }, ...patch } });
  }
  async function raw(provider: string, method: string, params: unknown = {}, extra: { id?: number | string; headers?: Record<string, string>; principal?: Actor } = {}): Promise<any> {
    const headers = { Authorization: `Bearer ${(extra.principal ?? buyer).token}`, "Content-Type": "application/json", "A2A-Version": "1.0", "A2A-Extensions": MARKET_EXTENSION, ...extra.headers };
    const response = await fetch(`${origin}/api/providers/${provider}/a2a`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: extra.id ?? randomUUID(), method, params }) });
    const contentType = response.headers.get("content-type") ?? "", selectedVersion = response.headers.get("a2a-version");
    return contentType.includes("text/event-stream") ? { status: response.status, contentType, selectedVersion, text: await response.text() } : { status: response.status, contentType, selectedVersion, ...await response.json() };
  }
  async function code(promise: Promise<any>, expected: number): Promise<unknown> {
    const result = await promise; currentObserved = result; assert.equal(result.error?.code, expected);
    assert.ok(Array.isArray(result.error.data)); assert.ok(result.error.data.every((item: Record<string, unknown>) => typeof item["@type"] === "string"));
    return { status: result.status, code: result.error.code };
  }
  async function list(params: Record<string, unknown> = {}, extra: { principal?: Actor } = {}): Promise<any> {
    const result = await raw("marlow", "ListTasks", { tenant: extra.principal?.tenantId ?? buyer.tenantId, ...params }, extra);
    currentObserved = result; assert.ok(result.result, result.error?.message); return result.result;
  }
  async function protocolRows(): Promise<Record<string, number>> {
    const value: Record<string, number> = {};
    for (const table of ["guild_market_threads", "guild_market_messages", "guild_market_protocol_receipts", "guild_market_operations", "guild_jobs"]) value[table] = Number((await db!.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
    return value;
  }
  async function withoutProtocolWrites(work: () => Promise<unknown>): Promise<unknown> { const before = await protocolRows(), result = await work(); assert.deepEqual(await protocolRows(), before); return result; }
  async function updateReceipt(id: string, patch: Record<string, unknown>): Promise<void> {
    const task = (await db!.query("SELECT task FROM guild_market_protocol_receipts WHERE task_id=$1", [id])).rows[0].task;
    Object.assign(task.status, patch); await db!.query("UPDATE guild_market_protocol_receipts SET task=$2 WHERE task_id=$1", [id, task]);
  }
  async function newQuote(title: string): Promise<Task> { const value = await clients.marlow!.sendMessage(quote(await commission(title), "research"), options()); assert.ok("id" in value); return value; }
  async function bridge(incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []; for await (const data of incoming) chunks.push(Buffer.from(data));
    const body = Buffer.concat(chunks), url = new URL(incoming.url ?? "/", origin), headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    const row: Wire = { method: incoming.method ?? "GET", path: url.pathname, requestHash: sha(body) };
    try { row.rpcMethod = JSON.parse(body.toString()).method; } catch { /* Discovery has no body. */ }
    report.wire.push(row);
    const abort = new AbortController(); outgoing.once("close", () => { if (!outgoing.writableEnded) abort.abort(); });
    const request = new Request(url, { method: row.method, headers, signal: abort.signal, ...(["GET", "HEAD"].includes(row.method) ? {} : { body, duplex: "half" }) } as RequestInit);
    const provider = url.pathname.split("/")[3]!, response = url.pathname.endsWith("/.well-known/agent-card.json") ? await marketAgentCardResponse(provider)
      : url.pathname.endsWith("/a2a") && row.method === "POST" ? await marketA2AResponse(request, provider) : new Response("Unavailable", { status: 405 });
    row.status = response.status; row.contentType = response.headers.get("content-type") ?? "";
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (row.contentType.includes("text/event-stream")) {
      const reader = response.body!.getReader(), hash = createHash("sha256"); let count = 0;
      try { for (;;) { const part = await reader.read(); if (part.done) break; count++; hash.update(part.value); if (outgoing.destroyed) { await reader.cancel(); break; } outgoing.write(part.value); } }
      finally { reader.releaseLock(); }
      row.chunks = count; row.responseHash = hash.digest("hex");
    } else { const bytes = Buffer.from(await response.arrayBuffer()); row.responseHash = sha(bytes); outgoing.write(bytes); }
    if (!outgoing.destroyed) outgoing.end();
  }
  try {
    const bootstrap = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    try { assert.equal((await bootstrap.query("SELECT 1 FROM pg_namespace WHERE nspname=$1", [schema])).rowCount, 0); await bootstrap.query(`CREATE SCHEMA "${schema}"`); }
    finally { await bootstrap.end(); }
    db = getPool(); assert.equal((await db.query("SELECT current_schema() AS name")).rows[0].name, schema);
    for (const file of (await readdir(resolve(root, "migrations"))).filter(name => name.endsWith(".sql")).sort()) {
      const sql = await readFile(resolve(root, "migrations", file), "utf8"); assert.doesNotMatch(sql, /\bpublic\s*\./i); await db.query(sql);
    }
    server = createServer((req, res) => void bridge(req, res).catch(error => { report.bridgeErrors.push(scrub(error instanceof Error ? error.message : String(error))); if (!res.headersSent) res.writeHead(500); res.end("Owned bridge failed"); }));
    await new Promise<void>(done => server!.listen(0, "127.0.0.1", done)); const address = server.address(); assert.ok(address && typeof address === "object");
    assert.ok(![4572, 4554, 4582].includes(address.port)); origin = `http://127.0.0.1:${address.port}`; report.origin = origin;
    process.env.GUILD_A2A_CONFORMANCE_HTTP_ORIGIN = origin; process.env.GUILD_MARKET_APP_URL = origin;
    buyer = await protocolActor(await actor()); await transaction(client => configureControlledProviders(client, true));
    for (const provider of providerIds) {
      const owner = await actor("provider"), row = await providerRow(db, provider);
      await db.query("INSERT INTO guild_market_provider_sessions(session_id,provider_id,owner_identity) VALUES($1,$2,$3)", [owner.id, provider, row.owner_identity]);
      const minimum = ({ formwork: 12000, marlow: 9000, tessellate: 12000, quill: 8000, halide: 4500, ostrava: 16000, northlight: 3500 } as Record<string, number>)[provider]!;
      for (const input of [{ type: "update_provider_policy", providerId: provider, expectedPolicyRevision: 0, policy: { minimumAwardMinor: minimum, askingAwardMinor: provider === "formwork" ? 14000 : minimum, maximumConcurrentTasks: 6, workingHours: 8, calendarId: "museum-weekdays-v1", allowedKinds: row.kinds, correctionAllowance: 1, counterofferLimit: 10, validUntil: owner.expiresAt, contentRules: "Typed controlled conformance work only." } }, { type: "discover_provider", providerId: provider }]) {
        const result = await executeProviderMarketCommand(owner, { ...input, commandId: randomUUID() } as ProviderMarketCommand, { fetch }); assert.equal(result.ok, true, result.ok ? result.message : result.error.code);
      }
      const authenticated: typeof fetch = (input, init = {}) => { const headers = new Headers(init.headers); headers.set("Authorization", `Bearer ${buyer.token}`); return fetch(input, { ...init, headers }); };
      clients[provider] = await new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl: authenticated })], preferredTransports: ["JSONRPC"], clientConfig: { polling: true, acceptedOutputModes: ["application/json"] } }).createFromUrl(`${origin}/api/providers/${provider}/.well-known/agent-card.json`, "");
      await check("card-and-quote", provider, "8.3 / 3.1.1", async () => {
        const value = await commission(), kind = row.kinds[0]!, result = await clients[provider]!.sendMessage(quote(value, kind), options()); assert.ok("id" in result);
        assert.equal(result.status?.state, TaskState.TASK_STATE_COMPLETED); quotes[provider] = { task: result, kind, commission: value };
        const card = await (await fetch(`${origin}/api/providers/${provider}/.well-known/agent-card.json`)).json();
        assert.equal(card.supportedInterfaces[0].protocolVersion, "1.0"); assert.equal(card.capabilities.streaming, true);
        return { taskId: result.id, state: "TASK_STATE_COMPLETED", wire: "1.0", push: card.capabilities.pushNotifications ?? false, extended: card.capabilities.extendedAgentCard ?? false };
      });
      await check("terminal-subscribe", provider, "3.1.6", async () => {
        const events: StreamResponse[] = [];
        await assert.rejects(async () => { for await (const event of clients[provider]!.resubscribeTask(SubscribeToTaskRequest.fromJSON({ id: quotes[provider]!.task.id, tenant: buyer.tenantId }), options())) events.push(event); }, error => {
          const semantic = jsonRpcFailure(error);
          currentObserved = { code: semantic.envelopeCode, events: events.map(event => event.payload?.$case) };
          assert.equal(semantic.envelopeCode, -32004); assert.equal(events.length, 0); return true;
        });
        const wireId = `terminal-subscribe-wire-${provider}`, wire = await raw(provider, "SubscribeToTask", { id: quotes[provider]!.task.id, tenant: buyer.tenantId }, { id: wireId });
        assert.ok(wire.contentType.includes("text/event-stream"));
        const envelopes = [...wire.text.matchAll(/^data:\s*(.+)$/gm)].map(match => JSON.parse(match[1]!));
        assert.equal(envelopes.length, 1); assert.equal(envelopes[0].id, wireId); assert.equal(envelopes[0].error.code, -32004); assert.equal(envelopes[0].result, undefined);
        assert.ok(envelopes[0].error.data.every((item: any) => typeof item["@type"] === "string"));
        return { code: -32004, taskEvents: 0, correlatedWireError: true };
      });
      await check("extended-card-capability-error", provider, "3.3.4 / 5.4", () => code(raw(provider, "GetExtendedAgentCard", { tenant: buyer.tenantId }), -32004));
      await check("push-capability-errors", provider, "3.3.4 / 5.4", async () => {
        for (const method of ["CreateTaskPushNotificationConfig", "GetTaskPushNotificationConfig", "ListTaskPushNotificationConfigs", "DeleteTaskPushNotificationConfig"]) await code(raw(provider, method, { tenant: buyer.tenantId, taskId: quotes[provider]!.task.id, id: randomUUID(), url: "https://untrusted.invalid/never-contacted" }), -32003);
        return { operations: 4, code: -32003 };
      });
      await check("unknown-message-task-reference", provider, "3.4.2", async () => { const value = await commission(); return withoutProtocolWrites(() => code(raw(provider, "SendMessage", SendMessageRequest.toJSON(quote(value, row.kinds[0]!, { taskId: randomUUID() }))), -32001)); });
      await check("terminal-message-task-reference", provider, "3.1.1", async () => { const value = await commission(); return withoutProtocolWrites(() => code(raw(provider, "SendMessage", SendMessageRequest.toJSON(quote(value, row.kinds[0]!, { taskId: quotes[provider]!.task.id }))), -32004)); });
    }
    await check("raw-list-presence", "marlow", "3.1.4 / 5.7", async () => { const value = await list({ pageSize: 100, historyLength: 0 }); assert.equal(value.nextPageToken, ""); assert.ok(Object.hasOwn(value, "nextPageToken")); assert.ok(value.tasks.every((task: object) => !Object.hasOwn(task, "artifacts") && !Object.hasOwn(task, "history"))); return { tasks: value.tasks.length, omittedArtifacts: true, omittedHistory: true }; });
    await check("raw-input-types", "marlow", "3.3.2 / 5.6", () => code(raw("marlow", "ListTasks", { tenant: buyer.tenantId, includeArtifacts: "false" }), -32602));
    await check("invalid-status-timestamp", "marlow", "3.3.2 / 5.6.1", () => code(raw("marlow", "ListTasks", { tenant: buyer.tenantId, statusTimestampAfter: "not-a-timestamp" }), -32602));
    await check("invalid-status-enum", "marlow", "3.3.2 / 5.6", () => code(raw("marlow", "ListTasks", { tenant: buyer.tenantId, status: "NOT_A_TASK_STATE" }), -32602));
    await check("request-response-correlation", "marlow", "9.3", async () => { for (const id of [0, "", "independent-string-id"]) { const value = await raw("marlow", "GetTask", { tenant: buyer.tenantId, id: quotes.marlow!.task.id }, { id }); assert.equal(value.id, id); assert.equal(value.result.status.state, "TASK_STATE_COMPLETED"); } return { ids: 3 }; });
    await check("required-extension-and-output-mode", "marlow", "3.3.4 / 5.4", async () => {
      await code(raw("marlow", "GetTask", { tenant: buyer.tenantId, id: quotes.marlow!.task.id }, { headers: { "A2A-Extensions": "" } }), -32008);
      const input = SendMessageRequest.toJSON(quote(await commission(), "research")) as any; input.configuration.acceptedOutputModes = ["application/pdf"];
      await code(raw("marlow", "SendMessage", input), -32005); return { extension: -32008, outputMode: -32005 };
    });
    await check("patch-version-negotiation", "marlow", "3.6", async () => { const value = await raw("marlow", "GetTask", { tenant: buyer.tenantId, id: quotes.marlow!.task.id }, { headers: { "A2A-Version": "1.0.1" } }); currentObserved = value; assert.ok(value.result, "Patch suffix changed version compatibility"); assert.equal(value.selectedVersion, "1.0"); return { request: "1.0.1", selected: "1.0" }; });
    await check("context-rejection-no-new-context", "marlow", "3.4.1", async () => {
      const value = await commission(), requested = randomUUID();
      return withoutProtocolWrites(async () => { const result = await raw("marlow", "SendMessage", SendMessageRequest.toJSON(quote(value, "research", { contextId: requested }))); currentObserved = { error: result.error, requestedContext: requested, returnedContext: result.result?.task?.contextId }; assert.equal(result.error?.code, -32602); assert.equal(result.result, undefined); return { code: result.error.code, noTaskAllocated: true }; });
    });
    const ordering = await newQuote("Controlled ordering vector");
    await check("status-time-order", "marlow", "3.1.4", async () => { const id = quotes.marlow!.task.id, later = new Date(Math.max(Date.now(), Date.parse(ordering.status!.timestamp!) + 1)).toISOString(); await updateReceipt(id, { timestamp: later, state: "TASK_STATE_WORKING" }); const value = await list({ pageSize: 100 }); currentObserved = { expectedFirst: id, observedIds: value.tasks.map((task: any) => task.id) }; assert.equal(value.tasks[0].id, id); return { first: id, strictlyLaterTimestamp: later }; });
    await check("cursor-page-stability", "marlow", "3.1.4", async () => {
      const first = await list({ pageSize: 1 }); assert.ok(first.nextPageToken); await newQuote("Controlled insertion between pages"); const next = await list({ pageSize: 1, pageToken: first.nextPageToken });
      currentObserved = { cursorHash: sha(first.nextPageToken), first: first.tasks[0]?.id, next: next.tasks[0]?.id }; assert.notEqual(next.tasks[0]?.id, first.tasks[0]?.id, "Page repeats a delivered task after insertion"); assert.equal(next.tasks.length, 1); return currentObserved;
    });

    // Additional negatives cross the original actor/provider/filter boundary,
    // rather than merely proving that a cursor can be encoded and decoded.
    const sameOwner = await protocolActor(await actor("owner", buyer)), foreignOwner = await protocolActor(await actor());
    const firstPage = await list({ pageSize: 1 }), cursor = firstPage.nextPageToken; assert.ok(cursor);
    for (const [id, principal] of [["same-tenant-other-owner", sameOwner], ["other-tenant-owner", foreignOwner]] as const) {
      await check(`cursor-${id}`, "marlow", "3.1.4 / 13.1", () => withoutProtocolWrites(() => code(raw("marlow", "ListTasks", { tenant: principal.tenantId, pageSize: 1, pageToken: cursor }, { principal }), -32602)));
    }
    await check("cursor-other-provider", "quill", "3.1.4 / 13.1", () => withoutProtocolWrites(() => code(raw("quill", "ListTasks", { tenant: buyer.tenantId, pageSize: 1, pageToken: cursor }), -32602)));
    for (const [name, filter] of [["context", { contextId: quotes.marlow!.task.contextId }], ["status", { status: "TASK_STATE_WORKING" }], ["timestamp", { statusTimestampAfter: "2000-01-01T00:00:00Z" }]] as const) {
      await check(`cursor-changed-${name}-filter`, "marlow", "3.1.4 / 13.1", () => withoutProtocolWrites(() => code(raw("marlow", "ListTasks", { tenant: buyer.tenantId, pageToken: cursor, ...filter }), -32602)));
    }
    await check("cursor-tamper-and-offset-refusal", "marlow", "3.1.4 / 3.3.2", async () => {
      const tampered = `${cursor[0] === "e" ? "f" : "e"}${cursor.slice(1)}`;
      for (const token of ["1", "-1", "1e3", " ", "x".repeat(2049), tampered, `${cursor}.extra`]) await withoutProtocolWrites(() => code(raw("marlow", "ListTasks", { tenant: buyer.tenantId, pageToken: token }), -32602));
      return { refused: 7 };
    });
    await check("cursor-output-options-can-change", "marlow", "3.1.4 / 3.2.4", async () => { const next = await list({ pageToken: cursor, pageSize: 2, historyLength: 0, includeArtifacts: true }); assert.ok(next.tasks.length); assert.ok(next.tasks.every((task: any) => Array.isArray(task.artifacts) && !Object.hasOwn(task, "history"))); assert.notEqual(next.tasks[0].id, firstPage.tasks[0].id); return { returned: next.tasks.length }; });
    await check("raw-list-noncoercion-and-bounds", "marlow", "3.3.2 / 5.6", async () => {
      const cases = [{ pageSize: "1" }, { pageSize: false }, { pageSize: 1.1 }, { pageSize: 0 }, { pageSize: 101 }, { historyLength: "0" }, { historyLength: -1 }, { historyLength: 2_147_483_648 }, { includeArtifacts: 1 }, { includeArtifacts: [] }, { pageToken: 1 }, { contextId: {} }, { tenant: false }, { status: -1 }, { status: 1 }, { status: "UNRECOGNIZED" }];
      for (const patch of cases) await withoutProtocolWrites(() => code(raw("marlow", "ListTasks", { tenant: buyer.tenantId, ...patch }), -32602)); return { refused: cases.length };
    });
    await check("utc-calendar-and-precision-validation", "marlow", "5.6.1", async () => {
      const invalid = ["", "2026-02-29T12:00:00Z", "2024-02-30T12:00:00Z", "2026-13-01T00:00:00Z", "2026-01-01T24:00:00Z", "2026-01-01T00:60:00Z", "2026-01-01T00:00:60Z", "2026-01-01", "2026-01-01T00:00:00+00:00", "2026-01-01T00:00:00.1234567890Z", "0000-01-01T00:00:00Z"];
      for (const timestamp of invalid) await code(raw("marlow", "ListTasks", { tenant: buyer.tenantId, statusTimestampAfter: timestamp }), -32602);
      for (const timestamp of ["0001-01-01T00:00:00Z", "2024-02-29T12:00:00.1Z", "2026-01-01T00:00:00.123456789Z", "9999-12-31T23:59:59.999999999Z"]) await list({ statusTimestampAfter: timestamp }); return { invalid: invalid.length, valid: 4 };
    });
    await check("optional-null-and-forward-fields", "marlow", "5.7", async () => { const value = await list({ pageSize: null, pageToken: null, historyLength: null, includeArtifacts: null, statusTimestampAfter: null, futureA2AField: { ignored: true } }); assert.equal(value.pageSize, 50); assert.ok(value.tasks.every((task: any) => !Object.hasOwn(task, "artifacts"))); return { defaultPageSize: 50, optionalNullIsUnset: true }; });
    await check("raw-message-and-task-noncoercion", "marlow", "3.3.2 / 5.5", async () => {
      const input = SendMessageRequest.toJSON(quote(await commission(), "research")) as any;
      const cases = [{ message: { ...input.message, taskId: 42 } }, { message: { ...input.message, contextId: [] } }, { message: { ...input.message, role: 1 } }, { message: { ...input.message, extensions: MARKET_EXTENSION } }, { configuration: { ...input.configuration, returnImmediately: "false" } }, { configuration: { ...input.configuration, historyLength: "2" } }, { message: { ...input.message, parts: [{ data: input.message.parts[0].data, text: "extra action" }] } }];
      for (const patch of cases) await withoutProtocolWrites(() => code(raw("marlow", "SendMessage", { ...input, ...patch }), -32602));
      for (const id of [null, 4, true, [], {}]) await code(raw("marlow", "GetTask", { tenant: buyer.tenantId, id }), -32602);
      return { messagesRefused: cases.length, taskIdentifiersRefused: 5 };
    });
    await check("version-patch-and-unsupported-minor", "marlow", "3.6", async () => {
      for (const version of ["1.0.0", "1.0.999"]) { const value = await raw("marlow", "GetTask", { tenant: buyer.tenantId, id: quotes.marlow!.task.id }, { headers: { "A2A-Version": version } }); assert.ok(value.result); assert.equal(value.selectedVersion, "1.0"); }
      for (const version of ["1.1", "2.0.1", "1.0.1-extra", "1.0.1.2", "", "0.3"]) await code(raw("marlow", "GetTask", { tenant: buyer.tenantId, id: quotes.marlow!.task.id }, { headers: { "A2A-Version": version } }), -32009);
      return { compatiblePatchInputs: 2, refused: 6, selected: "1.0" };
    });
    await check("foreign-owner-task-and-context-refusal", "marlow", "3.4.1 / 3.4.2 / 13.1", async () => {
      const value = await commission();
      for (const principal of [sameOwner, foreignOwner]) {
        const taskInput = SendMessageRequest.toJSON(quote(value, "research", { taskId: quotes.marlow!.task.id })) as any; taskInput.tenant = principal.tenantId;
        await withoutProtocolWrites(() => code(raw("marlow", "SendMessage", taskInput, { principal }), -32001));
        const contextInput = SendMessageRequest.toJSON(quote(value, "research", { contextId: quotes.marlow!.task.contextId })) as any; contextInput.tenant = principal.tenantId;
        await withoutProtocolWrites(() => code(raw("marlow", "SendMessage", contextInput, { principal }), -32602));
      } return { foreignTasks: 2, foreignContexts: 2 };
    });
    await check("other-provider-task-and-mismatched-context", "marlow", "3.4.3 / 13.1", async () => {
      const value = await commission();
      await withoutProtocolWrites(() => code(raw("marlow", "SendMessage", SendMessageRequest.toJSON(quote(value, "research", { taskId: quotes.quill!.task.id }))), -32001));
      await withoutProtocolWrites(() => code(raw("marlow", "SendMessage", SendMessageRequest.toJSON(quote(value, "research", { taskId: quotes.marlow!.task.id, contextId: randomUUID() }))), -32602));
      return { otherProvider: -32001, mismatchedContext: -32602 };
    });
    await check("known-nonterminal-task-explicitly-unsupported", "marlow", "3.3.3 / 3.4.3", async () => {
      const value = await commission(); return withoutProtocolWrites(() => code(raw("marlow", "SendMessage", SendMessageRequest.toJSON(quote(value, "research", { taskId: quotes.marlow!.task.id }))), -32004));
    });
    await check("accepted-context-business-refusal-preserves-context", "marlow", "3.4.1", async () => {
      const original = quotes.marlow!, input = SendMessageRequest.toJSON(quote(original.commission, "research", { contextId: original.task.contextId }));
      const result = await raw("marlow", "SendMessage", input); currentObserved = result;
      assert.equal(result.error, undefined); assert.equal(result.result.task.status.state, "TASK_STATE_REJECTED"); assert.equal(result.result.task.contextId, original.task.contextId);
      const replay = await raw("marlow", "SendMessage", input); assert.deepEqual(replay.result, result.result); return { retainedContext: original.task.contextId, replaySameTask: true };
    });
    await check("completed-send-stream-is-still-legal", "marlow", "3.1.2", async () => { const events: StreamResponse[] = []; for await (const event of clients.marlow!.sendMessageStream(quote(await commission(), "research"), options())) events.push(event); assert.equal(events.length, 1); assert.equal(events[0]?.payload?.$case, "task"); if (events[0]?.payload?.$case === "task") assert.equal(events[0].payload.value.status?.state, TaskState.TASK_STATE_COMPLETED); return { initialTaskEvents: 1, closed: true }; });
    await check("all-terminal-subscriptions-refuse-before-task", "marlow", "3.1.6", async () => {
      const retained = await newQuote("Controlled terminal-state subscriptions");
      for (const state of ["TASK_STATE_COMPLETED", "TASK_STATE_FAILED", "TASK_STATE_CANCELED", "TASK_STATE_REJECTED"]) {
        await updateReceipt(retained.id, { state }); let count = 0;
        await assert.rejects(async () => { for await (const _event of clients.marlow!.resubscribeTask(SubscribeToTaskRequest.fromJSON({ id: retained.id, tenant: buyer.tenantId }), options())) count++; }, error => jsonRpcFailure(error).envelopeCode === -32004); assert.equal(count, 0);
      } return { states: 4, taskEvents: 0 };
    });
    await check("nanosecond-order-and-inclusive-timestamp-filter", "marlow", "3.1.4 / 5.6.1", async () => {
      const a = await newQuote("Controlled nanosecond lower"), b = await newQuote("Controlled nanosecond upper");
      await updateReceipt(a.id, { timestamp: "2090-01-01T00:00:00.000000001Z" }); await updateReceipt(b.id, { timestamp: "2090-01-01T00:00:00.000000002Z" });
      const both = await list({ statusTimestampAfter: "2090-01-01T00:00:00.000000001Z" }); assert.deepEqual(both.tasks.map((task: any) => task.id), [b.id, a.id]);
      const only = await list({ statusTimestampAfter: "2090-01-01T00:00:00.000000002Z" }); assert.deepEqual(only.tasks.map((task: any) => task.id), [b.id]); return { exactNanosecondOrdering: true, lowerBoundInclusive: true };
    });
    await check("cursor-tied-timestamps-exhaust-once", "marlow", "3.1.4", async () => {
      const ids: string[] = []; for (let index = 0; index < 3; index++) { const task = await newQuote(`Controlled timestamp tie ${index}`); ids.push(task.id); await updateReceipt(task.id, { timestamp: "2091-01-01T00:00:00Z" }); }
      const seen: string[] = []; let token = "", pages = 0;
      do { const page = await list({ pageSize: 1, statusTimestampAfter: "2091-01-01T00:00:00Z", pageToken: token }); seen.push(...page.tasks.map((task: any) => task.id)); assert.equal(page.totalSize, 3); token = page.nextPageToken; assert.ok(++pages <= 3); } while (token);
      assert.deepEqual(seen, ids.sort().reverse()); assert.equal(new Set(seen).size, 3); return { pages, distinctTasks: seen.length, finalNextPageToken: token };
    });
    await check("get-positive-history-above-100", "marlow", "3.2.4 / SendMessageConfiguration.history_length int32", async () => {
      for (const length of [101, 1000, 2_147_483_647]) {
        const value = await raw("marlow", "GetTask", { tenant: buyer.tenantId, id: quotes.marlow!.task.id, historyLength: length }); currentObserved = value;
        assert.ok(value.result, value.error?.message); assert.ok(value.result.history.length <= length);
      } return { accepted: [101, 1000, 2_147_483_647], serverMayReturnLess: true };
    });
    await check("list-positive-history-above-100-empty", "marlow", "3.2.4", async () => {
      const value = await raw("marlow", "ListTasks", { tenant: foreignOwner.tenantId, historyLength: 101 }, { principal: foreignOwner }); currentObserved = value;
      assert.ok(value.result, value.error?.message); assert.deepEqual(value.result.tasks, []); return { historyLength: 101, tasks: 0 };
    });
    await check("send-positive-history-above-100", "marlow", "3.2.4", async () => {
      const input = quote(await commission(), "research"); input.configuration!.historyLength = 101;
      const value = await raw("marlow", "SendMessage", SendMessageRequest.toJSON(input)); currentObserved = value;
      assert.ok(value.result?.task, value.error?.message); assert.ok(value.result.task.history.length <= 101); return { requested: 101, returned: value.result.task.history.length };
    });
    await check("history-server-lower-limit-keeps-most-recent-messages", "marlow", "3.2.4", async () => {
      const id = quotes.marlow!.task.id, original = (await db!.query("SELECT task FROM guild_market_protocol_receipts WHERE task_id=$1", [id])).rows[0].task;
      const history = Array.from({ length: 150 }, () => ({ ...original.history[original.history.length - 1], messageId: randomUUID() }));
      await db!.query("UPDATE guild_market_protocol_receipts SET task=$2 WHERE task_id=$1", [id, { ...original, history }]);
      try {
        const answer = await raw("marlow", "GetTask", { tenant: buyer.tenantId, id, historyLength: 1000 }); currentObserved = answer;
        assert.ok(answer.result, answer.error?.message); assert.equal(answer.result.history.length, 50); assert.deepEqual(answer.result.history.map((message: any) => message.messageId), history.slice(-50).map(message => message.messageId));
        const small = await raw("marlow", "GetTask", { tenant: buyer.tenantId, id, historyLength: 3 }); assert.deepEqual(small.result.history.map((message: any) => message.messageId), history.slice(-3).map(message => message.messageId));
      } finally { await db!.query("UPDATE guild_market_protocol_receipts SET task=$2 WHERE task_id=$1", [id, original]); }
      return { retainedFixtureMessages: 150, requested: 1000, returnedRecent: 50, smallRequest: 3 };
    });

    // Seed a large retained *quote receipt* history, never work jobs. These rows
    // are explicitly controlled fixture data. HTTP still exercises the real
    // authorization, filtering, timestamp ordering and cursor implementation.
    const narrow = await newQuote("Controlled large-history narrow context"), largeIds: string[] = [], retainedRows: Record<string, unknown>[] = [];
    for (let index = 0; index < 1005; index++) {
      const id = randomUUID(), messageId = randomUUID(), base = quotes.marlow!.task; largeIds.push(id);
      const fixture = Task.toJSON({ ...base, id, status: { ...base.status!, state: TaskState.TASK_STATE_AUTH_REQUIRED, timestamp: `2092-01-01T00:00:00.${String(index).padStart(9, "0")}Z` },
        history: base.history.map(message => ({ ...message, messageId: randomUUID(), taskId: id })), metadata: { ...base.metadata, originalMessageId: messageId, controlledRetainedQuoteFixture: true } });
      retainedRows.push({ message_id: messageId, task_id: id, request_hash: sha(JSON.stringify(fixture)), task: fixture });
    }
    await db.query("INSERT INTO guild_market_protocol_receipts(provider_id,tenant_id,actor_id,message_id,request_hash,task_id,task,created_at) SELECT 'marlow',$1,$2,x.message_id,x.request_hash,x.task_id,x.task,'2000-01-01T00:00:00Z'::timestamptz FROM jsonb_to_recordset($3::jsonb) AS x(message_id uuid,task_id uuid,request_hash text,task jsonb)", [buyer.tenantId, buyer.id, JSON.stringify(retainedRows)]);
    await check("large-history-narrow-context-remains-readable", "marlow", "3.1.4 / 13.1", async () => {
      const value = await list({ contextId: narrow.contextId, pageSize: 1, historyLength: 0 }); assert.equal(value.totalSize, 1); assert.deepEqual(value.tasks.map((task: any) => task.id), [narrow.id]); assert.equal(value.nextPageToken, ""); return { retainedFixtureRows: 1005, narrowResults: 1 };
    });
    await check("large-history-cursor-exhausts-without-lifetime-cutoff", "marlow", "3.1.4", async () => {
      const seen: string[] = []; let token = "", pages = 0;
      do {
        const page = await list({ pageSize: 100, historyLength: 0, status: "TASK_STATE_AUTH_REQUIRED", statusTimestampAfter: "2092-01-01T00:00:00Z", pageToken: token });
        assert.equal(page.totalSize, 1005); seen.push(...page.tasks.map((task: any) => task.id)); token = page.nextPageToken; assert.ok(++pages <= 11);
      } while (token);
      assert.deepEqual(seen, [...largeIds].reverse()); assert.equal(new Set(seen).size, 1005); return { pages, distinctTasks: seen.length, nextPageToken: token };
    });
    await check("large-history-six-concurrent-narrow-reads", "marlow", "3.1.4 / original max-six pool", async () => {
      const pages = await Promise.all(Array.from({ length: 6 }, () => list({ contextId: narrow.contextId, pageSize: 1 })));
      assert.ok(pages.every(page => page.tasks[0]?.id === narrow.id)); return { concurrentReads: 6, eachNarrowResults: 1 };
    });
    await check("blocking-default-waits-past-25-seconds", "marlow", "3.2.2", async () => {
      const input = quote(await commission("Controlled retained blocking receipt"), "research"); input.configuration!.returnImmediately = false;
      const params = SendMessageRequest.toJSON(input), initial = await raw("marlow", "SendMessage", params); assert.ok(initial.result?.task);
      const id = initial.result.task.id; await updateReceipt(id, { state: "TASK_STATE_WORKING", timestamp: new Date().toISOString() });
      const started = Date.now();
      const completion = new Promise<void>((resolve, reject) => setTimeout(() => { void updateReceipt(id, { state: "TASK_STATE_COMPLETED", timestamp: new Date().toISOString() }).then(resolve, reject); }, 28_000));
      try {
        const answer = await raw("marlow", "SendMessage", params); currentObserved = { elapsedMs: Date.now() - started, code: answer.error?.code, state: answer.result?.task?.status?.state, taskId: id };
        assert.equal(answer.error, undefined, "Elapsed time alone must not return UnsupportedOperationError"); assert.equal(answer.result.task.id, id); assert.equal(answer.result.task.status.state, "TASK_STATE_COMPLETED"); assert.ok(Date.now() - started >= 27_000);
      } finally { await completion; }
      return { elapsedMs: Date.now() - started, originalTaskCompleted: true, jobsCreated: 0 };
    });
    for (const table of ["guild_jobs", "guild_model_runs", "guild_acceptance_decisions", "guild_payment_intents", "guild_budget_reservations", "guild_payment_tool_runs", "guild_payout_operations", "guild_payout_attempts"]) { const count: number = Number((await db.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n); report.sideEffects[table] = count; assert.equal(count, 0); }
    assert.deepEqual(report.bridgeErrors, []); report.completed = true;
  } catch (error) { report.error = scrub(error instanceof Error ? error.message : String(error)); }
  finally {
    if (server) { server.closeAllConnections(); await new Promise<void>(done => server!.close(() => done())); }
    if (db) await db.end();
    for (const file of Object.keys(report.sourceHashes)) { report.sourceHashesEnd[file] = sha(await readFile(resolve(root, file))); if (report.sourceHashesEnd[file] !== report.sourceHashes[file]) report.changedSources.push(file); }
    report.passed = report.completed && report.failures.length === 0 && report.changedSources.length === 0;
    report.reportPath = resolve(evidence, `provider-market-a2a-conformance-${Date.now()}.json`);
    await writeFile(report.reportPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  }
  return report;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const report = await runProviderMarketA2AConformanceQualification();
  console.log(JSON.stringify({ passed: report.passed, completed: report.completed, checks: report.checks.length, failures: report.failures, error: report.error, reportPath: report.reportPath, conformance: report.conformance }));
  if (!report.passed) process.exitCode = 1;
}
