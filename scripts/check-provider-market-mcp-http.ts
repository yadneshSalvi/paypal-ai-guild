/** Controlled MCP qualification: fresh restricted schema + owned real loopback.
 * No original data, provider/model/media, financial transport or browser calls. */
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Pool } from "pg";
import { Client, StreamableHTTPClientTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { createCommissionSchema, type Commission } from "../src/contracts/guild";
import { planDigest } from "../src/domain/fixture";
import { DomainError } from "../src/domain/primitives";
import { createCommission, getCommission } from "../src/server/commissions";
import { getPool, transaction } from "../src/server/db";
import { SESSION_COOKIE, type Session } from "../src/server/session";
import { consumeApprovalLink, issueApprovalLink, previewApprovalLink } from "../src/server/provider-market/approval-links";
import { handleGuildMcpHttp, MCP_MAX_REQUEST_BYTES } from "../src/server/provider-market/mcp";
import { approvalBrowserSession, handleApprovalLinkConsume, privateMcpResponse, requireConfiguredOrigin } from "../src/server/provider-market/mcp-http";
import { mcpDraftResultSchema, mcpLinkResultSchema, mcpStatusResultSchema } from "../src/server/provider-market/mcp-results";
import { createProtocolClient } from "../src/server/provider-market/protocol-auth";

interface BrowserOwner { session: Session; cookie: string }
interface Check { name: string; passed: boolean }
interface Wire { method: string; path: string; mcpMethod: string | null; tool: string | null; requestBytes: number; requestHash: string; responseStatus?: number; responseHash?: string; droppedAfterResult?: boolean }
export interface McpQualificationReport { version: string; at: string; schema: string; passed: boolean; nativeBrowserClaimed: false; actualNextClaimed: false; checks: Check[]; wire: Wire[]; error?: { message: string; stack?: string }; reportPath?: string; sideEffects?: Record<string, number>; negotiatedProtocol?: string; fixture: string; migrations?: number[] }
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function runProviderMarketMcpQualification(): Promise<McpQualificationReport> {
  const schema = process.env.GUILD_MCP_TEST_SCHEMA ?? "", evidence = process.env.GUILD_MCP_EVIDENCE_DIR;
  assert.match(schema, /^guild_market_mcp_[a-f0-9]{20}$/); assert.ok(evidence, "A private evidence directory is required.");
  assert.ok(process.env.DATABASE_URL && process.env.AUTH_SECRET && process.env.JUDGE_SESSION_SECRET, "Private restricted configuration is required.");
  const configured = new URL(process.env.DATABASE_URL), configuredPort = Number((configured.searchParams.get("port") ?? configured.port) || "5432");
  assert.equal(configuredPort, 55568, "Only the restricted MCP database is allowed.");
  assert.equal(configured.searchParams.get("options"), `-c search_path=${schema}`);
  for (const key of ["OPENAI_API_KEY", "GEMINI_API_KEY", "DEEPGRAM_API_KEY", "BLOB_READ_WRITE_TOKEN", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"]) assert.equal(process.env[key] ?? "", "", `${key} must be empty`);
  const sensitive = new Set([process.env.DATABASE_URL, process.env.AUTH_SECRET, process.env.JUDGE_SESSION_SECRET]);
  const scrub = (value: string) => {
    let clean = value; for (const secret of sensitive) if (secret) clean = clean.replaceAll(secret, "[redacted]");
    return clean.replace(/challenge=[^&\s"'<>]+/g, "challenge=[redacted]").replace(/\bgc_[A-Za-z0-9_-]+\b/g, "[client-token]").replace(/\b[A-Za-z0-9_-]{43}\b/g, "[challenge]");
  };
  const report: McpQualificationReport = { version: "guild.provider-market-mcp-http.v1", at: new Date().toISOString(), schema, passed: false, nativeBrowserClaimed: false, actualNextClaimed: false, checks: [], wire: [], fixture: "Fresh controlled schema. Recorded payment projections used only as synthetic status vectors; no provider or financial transport evidence is claimed." };
  let server: ReturnType<typeof createServer> | null = null, db: Pool | null = null;
  const clients: Client[] = [];
  let origin = "", dropLinkResponse = false;
  async function check(name: string, work: () => Promise<void>) { await work(); report.checks.push({ name, passed: true }); }
  async function owner(role: Session["role"] = "owner", tenantId: string = randomUUID(), expiresIn = 3_600_000): Promise<BrowserOwner> {
    assert.ok(db); const token = randomBytes(32).toString("base64url"), id = randomUUID(), expiresAt = new Date(Date.now() + expiresIn).toISOString(); sensitive.add(token);
    await db.query("INSERT INTO guild_tenants(id,expires_at,mode) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING", [tenantId, expiresAt, role === "judge" ? "judge" : "owner"]);
    await db.query("INSERT INTO guild_sessions(id,tenant_id,token_hash,role,expires_at) VALUES($1,$2,$3,$4,$5)", [id, tenantId, sha(token), role, expiresAt]);
    const cookie = `${token}.${createHmac("sha256", process.env.JUDGE_SESSION_SECRET!).update(token).digest("hex")}`; sensitive.add(cookie);
    return { session: { id, tenantId, role, expiresAt }, cookie };
  }
  async function protocolClient(actor: BrowserOwner, scopes: ("a2a" | "mcp")[] = ["mcp"]) {
    assert.ok(db); const credentials = await createProtocolClient(db, actor.session, scopes, null, new Date(Date.now() + 20 * 60_000).toISOString()); sensitive.add(credentials.token);
    const client = new Client({ name: "guild-independent-mcp-qualification", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" }, probe: { timeoutMs: 5_000 } } }); clients.push(client);
    const transport = new StreamableHTTPClientTransport(new URL("/api/mcp", origin), { authProvider: { token: async () => credentials.token }, fetch: globalThis.fetch, redirectPolicy: "same-origin" });
    await client.connect(transport); return { client, token: credentials.token, id: credentials.id };
  }
  function createInput(capMinor = 64000) { return { requestId: randomUUID(), title: "Controlled MCP commission", brief: "Prepare a controlled source-free museum exhibition draft for protocol qualification only.", capMinor, languages: ["en", "ar"] }; }
  async function draft(actor: BrowserOwner, capMinor = 64000): Promise<Commission> {
    const input = createInput(capMinor); return createCommission(actor.session, createCommissionSchema.parse({ commandId: input.requestId, title: input.title, museum: "Controlled MCP qualification", objective: input.brief, capMinor: input.capMinor, languages: input.languages, sourceIds: [] }), []);
  }
  async function setCommission(commission: Commission): Promise<void> { assert.ok(db); await db.query("UPDATE guild_commissions SET snapshot=$1,revision=$2,state=$3 WHERE id=$4 AND tenant_id=$5", [commission, commission.revision, commission.state, commission.id, commission.tenantId]); }
  async function requestLink(actor: BrowserOwner, commission: Commission) { return issueApprovalLink(actor.session, { requestId: randomUUID(), commissionId: commission.id, expectedRevision: commission.revision, approvalDigest: planDigest(commission) }); }
  function linkParts(link: { url: string }) { const url = new URL(link.url), challenge = url.searchParams.get("challenge")!; sensitive.add(challenge); return { id: url.pathname.split("/").at(-1)!, challenge, url }; }
  function content(result: CallToolResult): Record<string, unknown> { assert.notEqual(result.isError, true); assert.ok(result.structuredContent && typeof result.structuredContent === "object"); return result.structuredContent as Record<string, unknown>; }
  function refusal(result: CallToolResult, code?: string) { assert.equal(result.isError, true); const output = result.structuredContent as { ok: false; error: { code: string }; paymentAuthorized: false }; assert.equal(output.ok, false); assert.equal(output.paymentAuthorized, false); if (code) assert.equal(output.error.code, code); return output; }
  async function postConsume(actor: BrowserOwner, link: { url: string }, overrides: { origin?: string | null; challenge?: string; cookie?: string | null; site?: string } = {}) {
    const parts = linkParts(link), headers: Record<string, string> = { "Content-Type": "application/json" };
    if (overrides.cookie !== null) headers.cookie = `${SESSION_COOKIE}=${overrides.cookie ?? actor.cookie}`;
    if (overrides.origin !== null) headers.origin = overrides.origin ?? origin;
    if (overrides.site) headers["Sec-Fetch-Site"] = overrides.site;
    return fetch(`${origin}/api/provider-market/approval-links/${parts.id}/consume`, { method: "POST", headers, body: JSON.stringify({ challenge: overrides.challenge ?? parts.challenge }) });
  }
  function privateHeaders(response: Response) { assert.match(response.headers.get("cache-control") ?? "", /private.*no-store/); assert.equal(response.headers.get("referrer-policy"), "no-referrer"); }
  async function publicPreview(request: Request, id: string): Promise<Response> {
    try { requireConfiguredOrigin(request); const actor = await approvalBrowserSession(request), challenge = new URL(request.url).searchParams.get("challenge"); return privateMcpResponse(Response.json(await previewApprovalLink(actor, id, challenge))); }
    catch (error) { const status = error instanceof DomainError ? error.status : 400; return privateMcpResponse(Response.json({ ok: false, code: error instanceof DomainError ? error.code : "INVALID_INPUT", message: error instanceof DomainError ? error.message : "Invalid link" }, { status })); }
  }
  async function bridge(incoming: IncomingMessage, outgoing: ServerResponse) {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of incoming) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 128_000) { outgoing.writeHead(413); outgoing.end(); return; } chunks.push(bytes); }
    const body = Buffer.concat(chunks), headers = new Headers(); for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    const url = new URL(incoming.url ?? "/", origin), method = incoming.method ?? "GET";
    let payload: { method?: string; params?: { name?: string } } = {}; try { payload = JSON.parse(body.toString("utf8")); } catch { /* Negative HTTP cases intentionally include non-JSON bytes. */ }
    const wire: Wire = { method, path: url.pathname, mcpMethod: payload?.method ?? null, tool: payload?.params?.name ?? null, requestBytes: body.length, requestHash: sha(body) }; report.wire.push(wire);
    const request = new Request(url, { method, headers, ...(method === "GET" || method === "HEAD" ? {} : { body, duplex: "half" }) } as RequestInit);
    let response: Response;
    if (url.pathname === "/api/mcp") response = await handleGuildMcpHttp(request);
    else if (/^\/approval\/[a-f0-9-]+$/.test(url.pathname) && ["GET", "HEAD"].includes(method)) response = await publicPreview(request, url.pathname.split("/").at(-1)!);
    else if (/^\/api\/provider-market\/approval-links\/[a-f0-9-]+\/consume$/.test(url.pathname) && method === "POST") response = await handleApprovalLinkConsume(request, url.pathname.split("/").at(-2)!);
    else response = new Response("Controlled route unavailable", { status: 404 });
    const bytes = Buffer.from(await response.arrayBuffer()); wire.responseStatus = response.status; wire.responseHash = sha(bytes);
    if (dropLinkResponse && wire.tool === "approval.link") { dropLinkResponse = false; wire.droppedAfterResult = true; outgoing.destroy(); return; }
    outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(method === "HEAD" ? undefined : bytes);
  }
  try {
    const bootstrap = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    try { const exists = await bootstrap.query("SELECT 1 FROM pg_namespace WHERE nspname=$1", [schema]); assert.equal(exists.rowCount, 0, "Never reuse another schema or prior fixture."); await bootstrap.query(`CREATE SCHEMA "${schema}"`); } finally { await bootstrap.end(); }
    db = getPool(); assert.equal((await db.query<{ name: string }>("SELECT current_schema() AS name")).rows[0]?.name, schema);
    for (const file of (await readdir(resolve(root, "migrations"))).filter(name => name.endsWith(".sql")).sort()) { const sql = await readFile(resolve(root, "migrations", file), "utf8"); assert.doesNotMatch(sql, /\bpublic\s*\./i); await db.query(sql); }
    report.migrations = (await db.query<{ version: number }>("SELECT version FROM guild_schema_migrations ORDER BY version")).rows.map(row => row.version);
    server = createServer((request, response) => { void bridge(request, response).catch(() => { if (!response.headersSent) response.writeHead(500); response.end("Controlled HTTP bridge failed"); }); });
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert.ok(address && typeof address === "object"); origin = `http://127.0.0.1:${address.port}`; process.env.GUILD_MCP_HTTP_ORIGIN = origin; process.env.GUILD_MARKET_APP_URL = origin;
    const alice = await owner(), bob = await owner(), sameTenant = await owner("owner", alice.session.tenantId), judge = await owner("judge");
    const external = await protocolClient(alice), foreign = await protocolClient(bob), judgeClient = await protocolClient(judge);
    let commission!: Commission, link!: { url: string; expiresAt: string; commissionId: string; expectedRevision: number }, originalInput!: ReturnType<typeof createInput>, originalLinkInput!: { requestId: string; commissionId: string; expectedRevision: number; approvalDigest: string };
    await check("official SDK2.4 current discovery and listTools expose exactly the three bounded tools", async () => {
      const tools = await external.client.listTools(); assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ["approval.link", "commission.create", "commission.status"]); for (const tool of tools.tools) { assert.ok(tool.inputSchema); assert.ok(tool.outputSchema); assert.equal(tool.annotations?.openWorldHint, false); }
      assert.ok(report.wire.some(wire => wire.mcpMethod === "server/discover"), "The independent current client must exercise official discovery."); report.negotiatedProtocol = "current SDK discovery observed";
    });
    await check("commission.create saves an actual owned draft with empty sources and no production or approval", async () => {
      originalInput = createInput(); const result = mcpDraftResultSchema.parse(content(await external.client.callTool({ name: "commission.create", arguments: originalInput }))); commission = await getCommission(alice.session, result.commissionId); assert.equal(commission.state, "draft"); assert.equal(commission.approvedPlanDigest, null); assert.deepEqual(commission.sourceAssets, []); assert.deepEqual(commission.jobs, []); assert.equal(result.paymentAuthorized, false); assert.equal(new URL(result.statusUri).origin, origin);
    });
    await check("exact create retry recovers the original commission while changed payload reuse refuses", async () => {
      const retry = mcpDraftResultSchema.parse(content(await external.client.callTool({ name: "commission.create", arguments: originalInput }))); assert.equal(retry.commissionId, commission.id); refusal(await external.client.callTool({ name: "commission.create", arguments: { ...originalInput, title: "Changed controlled brief" } }), "COMMAND_CHANGED"); const rows = await db!.query("SELECT id FROM guild_commissions WHERE tenant_id=$1", [alice.session.tenantId]); assert.equal(rows.rowCount, 1);
    });
    await check("service cap lower and upper boundaries are preserved without coercion", async () => {
      for (const cap of [0, 99, 64001, 10000000]) refusal(await external.client.callTool({ name: "commission.create", arguments: createInput(cap) }), "MCP_COMMISSION_SERVICE_RANGE");
      for (const cap of [100, 64000]) { const result = mcpDraftResultSchema.parse(content(await external.client.callTool({ name: "commission.create", arguments: createInput(cap) }))); assert.equal((await getCommission(alice.session, result.commissionId)).capMinor, cap); }
    });
    await check("strict MCP input rejects source IDs and arbitrary execution or financial fields", async () => {
      const before = Number((await db!.query("SELECT count(*) AS count FROM guild_commissions")).rows[0].count); const result = await external.client.callTool({ name: "commission.create", arguments: { ...createInput(), sourceIds: [randomUUID()], approve: true, execute: "capture" } }); assert.equal(result.isError, true); assert.equal(Number((await db!.query("SELECT count(*) AS count FROM guild_commissions")).rows[0].count), before);
    });
    await check("owner status is redacted and foreign tenants cannot read the commission", async () => {
      const result = mcpStatusResultSchema.parse(content(await external.client.callTool({ name: "commission.status", arguments: { commissionId: commission.id } }))); assert.equal(result.approvedPlan, false); assert.equal(result.captureMinor, 0); assert.equal(result.payoutMinor, 0); assert.deepEqual(result.packages.map(work => work.state), commission.packages.map(work => work.state)); const serialized = JSON.stringify(result); assert.doesNotMatch(serialized, /tenantId|token|cookie|trace|payee|clientSecret/); for (const secret of sensitive) if (secret) assert.equal(serialized.includes(secret), false); refusal(await foreign.client.callTool({ name: "commission.status", arguments: { commissionId: commission.id } }), "NOT_FOUND");
    });
    await check("status reports separate recorded totals from a labeled synthetic projection instead of fixed zeros", async () => {
      const controlled = structuredClone(commission); controlled.payments.capturedMinor = 1234; controlled.payments.providerPaidMinor = 567; await setCommission(controlled); const result = mcpStatusResultSchema.parse(content(await external.client.callTool({ name: "commission.status", arguments: { commissionId: commission.id } }))); assert.equal(result.captureMinor, 1234); assert.equal(result.payoutMinor, 567); await setCommission(commission);
    });
    await check("judge-scoped clients create only their own review-required drafts", async () => {
      const result = mcpDraftResultSchema.parse(content(await judgeClient.client.callTool({ name: "commission.create", arguments: createInput() }))); assert.equal((await getCommission(judge.session, result.commissionId)).tenantId, judge.session.tenantId); assert.equal(result.approvalRequired, true); assert.equal(result.paymentAuthorized, false);
    });
    await check("approval.link exact retry after a deliberately dropped real HTTP response retains URL and expiry", async () => {
      const input = { requestId: randomUUID(), commissionId: commission.id, expectedRevision: commission.revision, approvalDigest: planDigest(commission) }; originalLinkInput = input; dropLinkResponse = true;
      await assert.rejects(external.client.callTool({ name: "approval.link", arguments: input })); const rows = await db!.query<{ id: string; expires_at: Date; challenge_hash: string }>("SELECT id,expires_at,challenge_hash FROM guild_market_approval_links WHERE owner_session_id=$1 AND request_id=$2", [alice.session.id, input.requestId]); assert.equal(rows.rowCount, 1);
      link = mcpLinkResultSchema.parse(content(await external.client.callTool({ name: "approval.link", arguments: input }))); const exact = await issueApprovalLink(alice.session, input); assert.equal(link.url, exact.url); assert.equal(link.expiresAt, exact.expiresAt); assert.equal(new URL(link.url).pathname, `/approval/${rows.rows[0]!.id}`); assert.equal(link.expiresAt, rows.rows[0]!.expires_at.toISOString()); const parts = linkParts(link); assert.equal(sha(parts.challenge), rows.rows[0]!.challenge_hash); assert.notEqual(parts.challenge, rows.rows[0]!.challenge_hash); assert.ok(Date.parse(link.expiresAt) <= Date.now() + 10 * 60_000); assert.equal(link.expectedRevision, commission.revision);
      refusal(await external.client.callTool({ name: "approval.link", arguments: { ...input, approvalDigest: "0".repeat(64) } }), "APPROVAL_REQUEST_CHANGED");
    });
    await check("approval.link refuses stale revision and stale exact plan digest before storing a link", async () => {
      const before = Number((await db!.query("SELECT count(*) AS count FROM guild_market_approval_links")).rows[0].count); for (const input of [{ requestId: randomUUID(), commissionId: commission.id, expectedRevision: commission.revision + 1, approvalDigest: planDigest(commission) }, { requestId: randomUUID(), commissionId: commission.id, expectedRevision: commission.revision, approvalDigest: "0".repeat(64) }]) refusal(await external.client.callTool({ name: "approval.link", arguments: input }), "APPROVAL_PLAN_CHANGED"); assert.equal(Number((await db!.query("SELECT count(*) AS count FROM guild_market_approval_links")).rows[0].count), before);
    });
    await check("repeated authenticated GET and prefetch are read-only and carry private headers", async () => {
      for (const purpose of ["navigate", "prefetch"]) { const response = await fetch(link.url, { headers: { cookie: `${SESSION_COOKIE}=${alice.cookie}`, "Sec-Purpose": purpose } }); privateHeaders(response); assert.equal(response.status, 200); const preview = await response.json() as { title: string; paymentAuthorized: boolean }; assert.equal(preview.title, commission.title); assert.equal(preview.paymentAuthorized, false); }
      assert.equal((await db!.query("SELECT consumed_at FROM guild_market_approval_links WHERE id=$1", [linkParts(link).id])).rows[0].consumed_at, null);
    });
    await check("a bearer alone cannot impersonate the original owner browser session", async () => { const response = await fetch(link.url, { headers: { authorization: `Bearer ${external.token}` } }); assert.equal(response.status, 401); privateHeaders(response); });
    await check("same-tenant different owner and foreign-tenant browsers cannot read or consume the link", async () => {
      for (const actor of [sameTenant, bob]) { assert.equal((await fetch(link.url, { headers: { cookie: `${SESSION_COOKIE}=${actor.cookie}` } })).status, 404); assert.equal((await postConsume(actor, link)).status, 404); } assert.equal((await db!.query("SELECT consumed_at FROM guild_market_approval_links WHERE id=$1", [linkParts(link).id])).rows[0].consumed_at, null);
    });
    await check("same-origin POST enforcement refuses missing Origin, foreign Origin and cross-site fetch", async () => {
      for (const overrides of [{ origin: null }, { origin: "https://unrelated.invalid" }, { site: "cross-site" }]) assert.equal((await postConsume(alice, link, overrides)).status, 403);
    });
    await check("wrong challenge is refused without consuming or revealing the original", async () => { const response = await postConsume(alice, link, { challenge: "x".repeat(43) }); assert.equal(response.status, 404); assert.equal((await db!.query("SELECT consumed_at FROM guild_market_approval_links WHERE id=$1", [linkParts(link).id])).rows[0].consumed_at, null); });
    await check("concurrent consumption succeeds once and leaves commission approval, work and money unchanged", async () => {
      const before = await getCommission(alice.session, commission.id), responses = await Promise.all([postConsume(alice, link), postConsume(alice, link)]); assert.deepEqual(responses.map(response => response.status).sort(), [200, 410]); for (const response of responses) privateHeaders(response); const result = await responses.find(response => response.status === 200)!.json() as { continueUrl: string; approvalRequired: boolean; paymentAuthorized: boolean }; assert.equal(result.continueUrl, `/?view=passport&commission=${commission.id}`); assert.equal(result.approvalRequired, true); assert.equal(result.paymentAuthorized, false); assert.deepEqual(await getCommission(alice.session, commission.id), before); assert.ok((await db!.query("SELECT consumed_at FROM guild_market_approval_links WHERE id=$1", [linkParts(link).id])).rows[0].consumed_at);
    });
    await check("consumed GET and POST replay fail while exact issuance replay keeps the original identity", async () => {
      assert.equal((await fetch(link.url, { headers: { cookie: `${SESSION_COOKIE}=${alice.cookie}` } })).status, 410); assert.equal((await postConsume(alice, link)).status, 410); const replay = await issueApprovalLink(alice.session, originalLinkInput); assert.equal(replay.url, link.url); assert.equal(replay.expiresAt, link.expiresAt);
    });
    await check("a revision change invalidates an issued link without consuming it", async () => {
      const retained = await requestLink(alice, commission), changed = structuredClone(commission); changed.revision++; await setCommission(changed); assert.equal((await fetch(retained.url, { headers: { cookie: `${SESSION_COOKIE}=${alice.cookie}` } })).status, 409); assert.equal((await postConsume(alice, retained)).status, 409); await setCommission(commission);
    });
    await check("a digest change invalidates an issued link even if a row revision was left unchanged", async () => {
      const retained = await requestLink(alice, commission), changed = structuredClone(commission); changed.objective += " Controlled changed purpose."; await setCommission(changed); assert.equal((await postConsume(alice, retained)).status, 409); await setCommission(commission);
    });
    await check("revoked mandate fails even without relying on a digest or commission revision change", async () => {
      const retained = await requestLink(alice, commission), changed = structuredClone(commission); changed.mandates[0]!.status = "revoked"; await setCommission(changed); assert.equal((await postConsume(alice, retained)).status, 422); await setCommission(commission);
    });
    await check("retained market work and mandate ceilings bound expiry without extension", async () => {
      const limited = await draft(alice), ceiling = new Date(Date.now() + 45_000).toISOString(); limited.mandates[0]!.expiresAt = new Date(Date.now() + 90_000).toISOString(); limited.packages[0]!.marketOffer = { threadId: randomUUID(), offerRevision: 1, offerDigest: "a".repeat(64), providerPolicyRevision: 1, providerPolicyDigest: "b".repeat(64), sourceDigest: "c".repeat(64), originalWorkCeiling: ceiling }; await setCommission(limited); const retained = await requestLink(alice, limited); assert.ok(Date.parse(retained.expiresAt) <= Date.parse(ceiling));
    });
    await check("real link authority expiry fails GET and POST while the original owner stays active", async () => {
      const limited = await draft(alice), ceiling = new Date(Date.now() + 1_500).toISOString(); limited.mandates[0]!.expiresAt = ceiling; await setCommission(limited); const input = { requestId: randomUUID(), commissionId: limited.id, expectedRevision: limited.revision, approvalDigest: planDigest(limited) }, retained = await issueApprovalLink(alice.session, input); await new Promise(resolve => setTimeout(resolve, 1_650)); assert.equal((await fetch(retained.url, { headers: { cookie: `${SESSION_COOKIE}=${alice.cookie}` } })).status, 410); assert.equal((await postConsume(alice, retained)).status, 410); const replay = await issueApprovalLink(alice.session, input); assert.equal(replay.url, retained.url); assert.equal(replay.expiresAt, retained.expiresAt);
    });
    await check("original owner session revocation fails continuation without consuming its retained link", async () => {
      const revoked = await owner(), ownCommission = await draft(revoked), retained = await requestLink(revoked, ownCommission); await db!.query("UPDATE guild_sessions SET revoked_at=clock_timestamp() WHERE id=$1", [revoked.session.id]); assert.equal((await fetch(retained.url, { headers: { cookie: `${SESSION_COOKIE}=${revoked.cookie}` } })).status, 401); assert.equal((await postConsume(revoked, retained)).status, 401); assert.equal((await db!.query("SELECT consumed_at FROM guild_market_approval_links WHERE id=$1", [linkParts(retained).id])).rows[0].consumed_at, null);
    });
    await check("original owner session expiry caps a new link and cannot be extended by a request retry", async () => {
      const short = await owner("owner", randomUUID(), 1_500), ownCommission = await draft(short), input = { requestId: randomUUID(), commissionId: ownCommission.id, expectedRevision: ownCommission.revision, approvalDigest: planDigest(ownCommission) }, retained = await issueApprovalLink(short.session, input); assert.ok(Date.parse(retained.expiresAt) <= Date.parse(short.session.expiresAt)); await new Promise(resolve => setTimeout(resolve, 1_650)); assert.equal((await postConsume(short, retained)).status, 401); await assert.rejects(issueApprovalLink(short.session, input), error => error instanceof DomainError && error.code === "SESSION_EXPIRED");
    });
    await check("caller-owned transaction seams never acquire a second pool client", async () => {
      const input = { requestId: randomUUID(), commissionId: commission.id, expectedRevision: commission.revision, approvalDigest: planDigest(commission) };
      await transaction(async client => { const connect = db!.connect; db!.connect = (() => { throw new Error("Nested pool acquisition is forbidden"); }) as Pool["connect"]; try { const retained = await issueApprovalLink(alice.session, input, client), parts = linkParts(retained); const preview = await previewApprovalLink(alice.session, parts.id, parts.challenge, client); assert.equal(preview.commissionId, commission.id); await consumeApprovalLink(alice.session, parts.id, parts.challenge, client); } finally { db!.connect = connect; } });
    });
    await check("MCP requires scoped bearer auth and rejects ambient browser cookies and internal A2A credentials", async () => {
      const cases: Record<string, string>[] = [{ cookie: `${SESSION_COOKIE}=${alice.cookie}` }, { authorization: "Bearer g1.controlled.invalid" }];
      for (const headers of cases) { const response = await fetch(`${origin}/api/mcp`, { method: "POST", headers: { ...headers, "Content-Type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "controlled-negative", version: "1" } } }) }); assert.ok([401, 403].includes(response.status)); privateHeaders(response); }
    });
    await check("MCP-scoped client revocation is rechecked on each real HTTP request", async () => {
      const disposable = await protocolClient(alice); await db!.query("UPDATE guild_market_protocol_clients SET revoked_at=clock_timestamp() WHERE id=$1", [disposable.id]); await assert.rejects(disposable.client.callTool({ name: "commission.status", arguments: { commissionId: commission.id } }));
    });
    await check("an otherwise valid private A2A-only client cannot call MCP commission tools", async () => {
      const scoped = await createProtocolClient(db!, alice.session, ["a2a"], null, new Date(Date.now() + 60_000).toISOString()); sensitive.add(scoped.token); const response = await fetch(`${origin}/api/mcp`, { method: "POST", headers: { authorization: `Bearer ${scoped.token}`, "Content-Type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" }); assert.equal(response.status, 401); privateHeaders(response);
    });
    await check("the official stateless legacy initialization remains supported without application session IDs", async () => {
      const response = await fetch(`${origin}/api/mcp`, { method: "POST", headers: { authorization: `Bearer ${external.token}`, "Content-Type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 72, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "controlled-legacy-probe", version: "1" } } }) }); assert.equal(response.status, 200); assert.equal(response.headers.get("mcp-session-id"), null); assert.match(await response.text(), /protocolVersion/); privateHeaders(response);
    });
    await check("HTTP body limits and configured Host/Origin checks run before tool dispatch", async () => {
      const headers = { authorization: `Bearer ${external.token}`, "Content-Type": "application/json", accept: "application/json, text/event-stream" }; const huge = await fetch(`${origin}/api/mcp`, { method: "POST", headers, body: JSON.stringify({ data: "x".repeat(MCP_MAX_REQUEST_BYTES + 1) }) }); assert.equal(huge.status, 413); const wrongOrigin = await fetch(`${origin}/api/mcp`, { method: "POST", headers: { ...headers, origin: "https://foreign.invalid" }, body: "{}" }); assert.equal(wrongOrigin.status, 403);
      const wrongHostStatus = await new Promise<number>((resolve, reject) => { const request = httpRequest(new URL("/api/mcp", origin), { method: "POST", headers: { ...headers, host: "foreign.invalid" } }, response => { response.resume(); response.on("end", () => resolve(response.statusCode!)); }); request.on("error", reject); request.end("{}"); }); assert.equal(wrongHostStatus, 403);
    });
    await check("database retains only challenge hashes and all source/approval/job/financial effects remain absent", async () => {
      const columns = (await db!.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='guild_market_approval_links'", [schema])).rows.map(row => row.column_name); assert.ok(columns.includes("challenge_hash")); assert.equal(columns.some(name => /^(challenge|token|url)$/.test(name)), false);
      const effects: Record<string, number> = {}; for (const table of ["guild_jobs", "guild_model_runs", "guild_approval_receipts", "guild_approval_challenges", "guild_budget_reservations", "guild_acceptance_decisions", "guild_market_tasks"]) { effects[table] = Number((await db!.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count); assert.equal(effects[table], 0, `${table} must remain empty`); }
      const snapshots = (await db!.query<{ snapshot: Commission }>("SELECT snapshot FROM guild_commissions")).rows; for (const { snapshot } of snapshots) { assert.equal(snapshot.approvedPlanDigest, null); assert.equal(snapshot.jobs.length, 0); assert.equal(snapshot.sourceAssets.length, 0); assert.equal(snapshot.payments.operations.length, 0); assert.equal(snapshot.payments.payouts.length, 0); assert.equal(snapshot.payments.capturedMinor, 0); assert.equal(snapshot.payments.providerPaidMinor, 0); } report.sideEffects = effects;
    });
    report.passed = true;
  } catch (error) { report.error = { message: scrub(error instanceof Error ? error.message : String(error)), stack: error instanceof Error ? scrub(error.stack ?? "") : undefined }; }
  finally {
    for (const client of clients) try { await client.close(); } catch { /* Deliberately revoked clients cannot complete a disconnect exchange. */ }
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
    if (db) await db.end();
    await mkdir(evidence, { recursive: true, mode: 0o700 }); const path = resolve(evidence, `provider-market-mcp-${Date.now()}.json`); report.reportPath = path; await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  }
  return report;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const report = await runProviderMarketMcpQualification(); console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, schema: report.schema, reportPath: report.reportPath, error: report.error?.message, nativeBrowserClaimed: false, actualNextClaimed: false })); if (!report.passed) process.exitCode = 1;
}
