/** Actual mounted Next HTTP with fresh restricted data. No worker, model,
 * media provider or financial transport is enabled in this controlled suite. */
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { request as httpRequest } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { Client as McpClient, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createCommissionSchema, type ArtifactManifest, type Commission } from "../src/contracts/guild";
import { agentAccessCommandResultSchema, agentAccessCommandStatusSchema, agentAccessSnapshotSchema, providerClaimResultSchema,
  providerInvitationPreviewSchema, type AgentScope, type ControlledProviderSetupPlan } from "../src/contracts/provider-access";
import type { ProviderMarketSnapshot, ProviderPolicyInput } from "../src/contracts/provider-market";
import { planDigest } from "../src/domain/fixture";
import { canonical, digest } from "../src/domain/primitives";
import { createCommission, getCommission, saveCommission } from "../src/server/commissions";
import { getPool, transaction } from "../src/server/db";
import { SESSION_COOKIE, type Session } from "../src/server/session";
import { createProtocolClient } from "../src/server/provider-market/protocol-auth";
import { PROVIDER_SESSION_COOKIE } from "../src/server/provider-access/sessions";
import { providerRow } from "../src/server/provider-market/registry";
import { applyControlledProviderSetup, planControlledProviderSetup, providerSetupState, revokeProviderInvitation,
  type ProviderInvitationDelivery } from "../src/server/provider-access/setup";

const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."), evidence = process.env.GUILD_NEXT_EVIDENCE_DIR ?? "",
  origin = process.env.GUILD_NEXT_HTTP_ORIGIN ?? "", schema = process.env.GUILD_NEXT_TEST_SCHEMA ?? "";
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
interface Actor { session: Session; cookie: string }
interface Fixture { version: string; schema: string; origin: string; buyer: Actor; foreign: Actor; providers: Record<string, Actor>;
  negativeActors: Record<string, Actor>; commissions: { research: string; cancellation: string; native: string };
  setup: { plan: ControlledProviderSetupPlan; delivery: ProviderInvitationDelivery[] }; invitationExpiresAt: string; sessionCeilingAt: string }
interface Check { name: string; passed: boolean; error?: string }
interface Wire { method: string; path: string; requestHash: string; status: number; responseHash: string; transport?: "node:http"; host?: string }
export interface ProviderAccessReport { version: string; at: string; passed: boolean; actualNext: true; nativeBrowser: false;
  checks: Check[]; wire: Wire[]; failures: string[]; error?: string; reportPath?: string; sideEffects?: Record<string, number>; disclosures: string[] }
function validate(): void {
  const base = new URL(origin); assert.equal(base.protocol, "http:"); assert.equal(base.hostname, "127.0.0.1");
  assert.ok(Number(base.port) >= 1024 && Number(base.port) <= 65535); assert.equal(base.pathname, "/");
  assert.equal(base.username + base.password + base.search + base.hash, ""); assert.match(schema, /^guild_access_next_worker_[a-f0-9]{20}$/);
  assert.ok(evidence); const database = new URL(process.env.DATABASE_URL!);
  assert.equal(Number(database.searchParams.get("port") ?? database.port), 55568);
  assert.equal(database.searchParams.get("options"), `-c search_path=${schema}`);
  for (const key of ["OPENAI_API_KEY", "GEMINI_API_KEY", "DEEPGRAM_API_KEY", "BLOB_READ_WRITE_TOKEN", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"]) assert.equal(process.env[key] ?? "", "");
}
async function savePrivate(name: string, value: unknown): Promise<void> { await writeFile(resolve(evidence, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }
async function actor(role: Session["role"], expiresAt: string): Promise<Actor> {
  const id = randomUUID(), tenantId = randomUUID(), token = randomBytes(32).toString("base64url");
  await transaction(async db => {
    await db.query("INSERT INTO guild_tenants(id,expires_at,mode) VALUES($1,$2,'owner')", [tenantId, expiresAt]);
    await db.query("INSERT INTO guild_sessions(id,tenant_id,token_hash,role,expires_at) VALUES($1,$2,$3,$4,$5)", [id, tenantId, sha(token), role, expiresAt]);
  });
  return { session: { id, tenantId, role, expiresAt }, cookie: `${token}.${createHmac("sha256", process.env.JUDGE_SESSION_SECRET!).update(token).digest("hex")}` };
}
async function draft(owner: Actor, title: string): Promise<Commission> {
  const current = await createCommission(owner.session, createCommissionSchema.parse({ commandId: randomUUID(), title,
    museum: "Controlled provider entry qualification", objective: "Qualify fixed provider/customer roles and exact original credential recovery without real production or financial calls.", capMinor: 64000, languages: ["en"], sourceIds: [] }), []);
  current.mode = "sample"; await transaction(db => saveCommission(db, current)); return current;
}
export async function captureProviderAccessState(): Promise<unknown> {
  validate(); return transaction(async db => {
    await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const catalog = await providerSetupState(db), names = (await db.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename")).rows;
    const tables = [];
    for (const { tablename } of names) {
      assert.match(tablename, /^[a-zA-Z_][a-zA-Z0-9_]*$/);
      const rows = (await db.query<{ value: unknown }>(`SELECT to_jsonb(t) AS value FROM "${tablename}" t ORDER BY to_jsonb(t)::text`)).rows.map(item => item.value);
      tables.push({ table: tablename, count: rows.length, sha256: digest(rows), rows });
    }
    return { schema, databaseIdentity: catalog.databaseIdentity, catalog: catalog.schemaFingerprint, tables };
  });
}
export async function prepareProviderAccessNextFixture(): Promise<void> {
  validate(); const bootstrap = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try { assert.equal((await bootstrap.query("SELECT 1 FROM pg_namespace WHERE nspname=$1", [schema])).rowCount, 0); await bootstrap.query(`CREATE SCHEMA "${schema}"`); }
  finally { await bootstrap.end(); }
  const db = getPool();
  try {
    assert.equal((await db.query("SELECT current_schema() AS name")).rows[0].name, schema);
    for (const file of (await readdir(resolve(root, "migrations"))).filter(name => name.endsWith(".sql")).sort()) {
      const sql = await readFile(resolve(root, "migrations", file), "utf8"); assert.doesNotMatch(sql, /\bpublic\s*\./i); await db.query(sql);
    }
    const sessionCeilingAt = new Date(Date.now() + 14_400_000).toISOString(), invitationExpiresAt = new Date(Date.now() + 10_800_000).toISOString();
    const buyer = await actor("owner", sessionCeilingAt), foreign = await actor("owner", sessionCeilingAt);
    const negativeActors = { unbound: await actor("provider", sessionCeilingAt), operator: await actor("operator", sessionCeilingAt) };
    const before = await captureProviderAccessState();
    const setup = await planControlledProviderSetup({ operationId: randomUUID(), browserOrigin: origin, serviceOrigin: origin,
      issuerIdentity: "Controlled qualification operator; not an outside business", syntheticFixture: true, invitationExpiresAt, sessionCeilingAt });
    assert.deepEqual(await captureProviderAccessState(), before);
    await savePrivate("setup-plan.private.json", setup); await savePrivate("setup-apply-intent.json", { operationId: setup.plan.operationId, digest: setup.plan.digest });
    const result = await applyControlledProviderSetup(setup.plan, setup.plan.digest);
    assert.equal(result.retained, false); assert.equal(result.receipt.providersCreated, 7); assert.equal(result.receipt.providersPreserved, 0);
    await savePrivate("setup-apply-receipt.json", result);
    const research = await draft(buyer, "Controlled provider-agent research artifact"), cancellation = await draft(buyer, "Controlled provider-agent cancellation"), native = await draft(buyer, "Provider entry walkthrough");
    const fixture: Fixture = { version: "guild.provider-access-fixture.v1", schema, origin, buyer, foreign, providers: {}, negativeActors,
      commissions: { research: research.id, cancellation: cancellation.id, native: native.id }, setup, invitationExpiresAt, sessionCeilingAt };
    await savePrivate("fixture-private.json", fixture);
    console.log(JSON.stringify({ prepared: true, schema, providers: 7, invitations: 7, policyApprovals: 0, workers: 0 }));
  } finally { await db.end(); }
}

export async function runProviderAccessNextQualification(): Promise<ProviderAccessReport> {
  validate(); const fixture = JSON.parse(await readFile(resolve(evidence, "fixture-private.json"), "utf8")) as Fixture;
  assert.equal(fixture.schema, schema); assert.equal(fixture.origin, origin);
  const report: ProviderAccessReport = { version: "guild.provider-access-next-http.v1", at: new Date().toISOString(), passed: false, actualNext: true, nativeBrowser: false,
    checks: [], wire: [], failures: [], disclosures: ["Actual owned Next production HTTP and a fresh restricted socketPG55568 schema.",
      "Programmatically reviewed synthetic policies, approvals and artifacts are controlled qualification data, not human acceptance or live provider output.",
      "Credential/invitation actions start no model, media or financial operation. Two explicit controlled delegations exercise cancellation and artifact ownership; no worker executes.",
      "Independent UI DOM evidence is separate from this mounted HTTP suite and from pending root native acceptance."] };
  const sensitive = [process.env.DATABASE_URL!, process.env.AUTH_SECRET!, process.env.JUDGE_SESSION_SECRET!, fixture.buyer.cookie, fixture.foreign.cookie,
    ...Object.values(fixture.negativeActors).map(item => item.cookie), ...fixture.setup.delivery.map(item => item.challenge)];
  const scrub = (value: string) => sensitive.filter(Boolean).reduce((text, secret) => text.replaceAll(secret, "[private]"), value)
    .replace(/\b(?:gc|gp)_[A-Za-z0-9_-]+/g, "[private bearer]").replace(/\b[A-Za-z0-9_-]{43}\.[a-f0-9]{64}\b/g, "[private cookie]");
  const db = getPool(), clients: McpClient[] = [], originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input), origin); assert.equal(url.origin, origin);
    return originalFetch(input instanceof Request ? input : url, init);
  };
  const customerHeaders = (value = fixture.buyer, post = false): Record<string, string> => ({ Cookie: `${SESSION_COOKIE}=${value.cookie}`,
    ...(post ? { Origin: origin, "Content-Type": "application/json" } : {}) });
  const providerHeaders = (value: Actor, post = false): Record<string, string> => ({ Cookie: `${PROVIDER_SESSION_COOKIE}=${value.cookie}`,
    ...(post ? { Origin: origin, "Content-Type": "application/json" } : {}) });
  const bearerHeaders = (token: string, post = false): Record<string, string> => ({ Authorization: `Bearer ${token}`, ...(post ? { "Content-Type": "application/json" } : {}) });
  async function call(path: string, options: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) {
    const method = options.method ?? "GET", body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const response = await fetch(origin + path, { method, headers: options.headers, body, redirect: "error", signal: AbortSignal.timeout(30_000) });
    const text = await response.text(); let value: any = null; if (text) try { value = JSON.parse(text); } catch { /* HTML entry or a malformed negative. */ }
    if (typeof value?.token === "string") sensitive.push(value.token);
    const cookie = response.headers.get("set-cookie"); if (cookie) sensitive.push(cookie, cookie.split(";")[0]!.split("=").slice(1).join("="));
    report.wire.push({ method, path: new URL(origin + path).pathname, requestHash: sha(body ?? ""), status: response.status, responseHash: sha(text) });
    return { status: response.status, headers: response.headers, value, text };
  }
  async function rawHostClaim(path: string, host: string, value: unknown): Promise<{ status: number; value: any }> {
    const body = JSON.stringify(value);
    // Fetch may normalize Host to the destination. Exercise the actual wire
    // header while still connecting only to this explicitly owned origin.
    return new Promise((resolve, reject) => {
      const request = httpRequest(new URL(path, origin), { method: "POST", headers: {
        Origin: origin, Host: host, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body),
      } }, response => {
        const chunks: Buffer[] = [];
        response.on("data", chunk => chunks.push(Buffer.from(chunk)));
        response.on("error", reject);
        response.on("end", () => {
          const bytes = Buffer.concat(chunks), status = response.statusCode ?? 0;
          report.wire.push({ method: "POST", path, requestHash: sha(body), status, responseHash: sha(bytes), transport: "node:http", host });
          try { resolve({ status, value: JSON.parse(bytes.toString("utf8")) }); } catch (error) { reject(error); }
        });
      });
      assert.equal(request.getHeader("host"), host);
      request.on("error", reject);
      request.setTimeout(30_000, () => request.destroy(new Error("The original raw Host qualification request timed out.")));
      request.end(body);
    });
  }
  async function check(name: string, action: () => Promise<void>, required = true): Promise<void> {
    try { await action(); report.checks.push({ name, passed: true }); }
    catch (error) { const message = scrub(error instanceof Error ? error.message : String(error)); report.checks.push({ name, passed: false, error: message }); report.failures.push(name); if (required) throw new Error(message); }
  }
  const delivery = (id: string) => fixture.setup.delivery.find(item => item.providerId === id)!;
  const invitationPath = (id: string) => `/api/provider-access/invitations/${delivery(id).invitationId}`;
  const preview = (id: string, method = "GET") => call(invitationPath(id), { method, headers: { "X-Guild-Invitation-Challenge": delivery(id).challenge } });
  const claimIds = new Map<string, string>();
  async function claim(id: string, claimId = claimIds.get(id) ?? randomUUID()) {
    claimIds.set(id, claimId);
    return call(`${invitationPath(id)}/claim`, { method: "POST", headers: customerHeaders(fixture.buyer, true), body: { claimId, challenge: delivery(id).challenge } });
  }
  async function claimedActor(id: string, response: Awaited<ReturnType<typeof claim>>): Promise<Actor> {
    assert.equal(response.status, 200); const result = providerClaimResultSchema.parse(response.value); assert.equal(result.providerId, id);
    const header = response.headers.get("set-cookie")!; assert.match(header, new RegExp(`^${PROVIDER_SESSION_COOKIE}=`));
    assert.doesNotMatch(header, new RegExp(`(?:^|,\\s*)${SESSION_COOKIE}=`)); assert.match(header, /HttpOnly/); assert.match(header, /SameSite=Lax/);
    const cookie = decodeURIComponent(header.split(";")[0]!.slice(PROVIDER_SESSION_COOKIE.length + 1)); sensitive.push(cookie);
    const row = (await db.query("SELECT s.id,s.tenant_id,s.role,s.expires_at FROM guild_sessions s JOIN guild_provider_invitations i ON i.consumed_session_id=s.id WHERE i.id=$1", [delivery(id).invitationId])).rows[0];
    return { cookie, session: { id: row.id, tenantId: row.tenant_id, role: row.role, expiresAt: row.expires_at.toISOString() } };
  }
  async function accessCommand(scope: "customer" | "provider", value: Actor, command: Record<string, unknown>) {
    return call(scope === "provider" ? "/api/provider/agent-access/commands" : "/api/agent-access/commands", { method: "POST",
      headers: scope === "provider" ? providerHeaders(value, true) : customerHeaders(value, true), body: command });
  }
  async function issue(scope: "customer" | "provider", value: Actor, scopes: AgentScope[], label: string) {
    const command = { commandId: randomUUID(), type: "issue_credential", label, scopes, expiresAt: fixture.invitationExpiresAt };
    const response = await accessCommand(scope, value, command); assert.equal(response.status, 200);
    const result = agentAccessCommandResultSchema.parse(response.value); assert.equal(result.state, "issued_now");
    if (result.state !== "issued_now") throw new Error("The controlled credential was not issued.");
    return { command, result };
  }
  async function market(value: Actor, provider = false, commission?: string): Promise<ProviderMarketSnapshot> {
    const result = await call(provider ? "/api/provider/workspace" : `/api/provider-market${commission ? `?commission=${commission}` : ""}`,
      { headers: provider ? providerHeaders(value) : customerHeaders(value) }); assert.equal(result.status, 200); return result.value;
  }
  async function marketCommand(value: Actor, command: Record<string, unknown>, provider = false) {
    const response = await call(provider ? "/api/provider/workspace/commands" : "/api/provider-market/commands", { method: "POST",
      headers: provider ? providerHeaders(value, true) : customerHeaders(value, true), body: { commandId: randomUUID(), ...command } });
    assert.equal(response.value?.ok, true, response.value?.error?.code ?? response.value?.code); return response.value;
  }
  const owned: Record<string, Actor> = {}; let customerToken = "", providerToken = "", readToken = "", foreignProviderToken = "";
  let initialSessionRows: unknown, artifactTaskId = "", artifactId = "";
  try {
    await check("actual owned Next runtime and original restricted schema are available", async () => {
      const runtime = JSON.parse(await readFile(resolve(evidence, "runtime-owner.json"), "utf8")); assert.equal(runtime.origin, origin); assert.equal(runtime.cwd, root); process.kill(runtime.pid, 0);
      assert.equal((await call("/api/health")).value.status, "ready"); assert.equal((await db.query("SELECT current_schema() AS name")).rows[0].name, schema);
      initialSessionRows = (await db.query("SELECT to_jsonb(s) AS value FROM guild_sessions s ORDER BY id")).rows;
    });
    await check("operator exact apply replay preserves every row and both fixed deadlines", async () => {
      const before = await captureProviderAccessState(), retained = await applyControlledProviderSetup(fixture.setup.plan, fixture.setup.plan.digest);
      assert.equal(retained.retained, true); assert.deepEqual(await captureProviderAccessState(), before);
      await assert.rejects(applyControlledProviderSetup(fixture.setup.plan, "0".repeat(64)), /exact reviewed setup digest/);
      assert.deepEqual(await captureProviderAccessState(), before);
    });
    await check("invitation page GET HEAD previews are private and never consume or create sessions", async () => {
      const before = await captureProviderAccessState(), response = await preview("marlow"); assert.equal(response.status, 200);
      const value = providerInvitationPreviewSchema.parse(response.value); assert.equal(value.state, "available"); assert.equal(value.provider?.id, "marlow");
      assert.equal(value.sessionCeilingAt, fixture.sessionCeilingAt); assert.equal(response.headers.get("set-cookie"), null);
      assert.equal((await preview("marlow", "HEAD")).text, "");
      const page = await call(`/provider/invitations/${delivery("marlow").invitationId}`); assert.equal(page.status, 200);
      assert.equal(page.headers.get("referrer-policy"), "no-referrer"); assert.match(page.headers.get("cache-control") ?? "", /private.*no-store/); assert.equal(page.headers.get("x-frame-options"), "DENY");
      assert.ok(!page.text.includes(delivery("marlow").challenge)); assert.deepEqual(await captureProviderAccessState(), before);
    });
    await check("wrong challenge query duplicate and absent credentials reveal no provider identity", async () => {
      const before = await captureProviderAccessState();
      const cases: Record<string, string>[] = [{}, { "X-Guild-Invitation-Challenge": "x".repeat(43) }, { "X-Guild-Invitation-Challenge": `${delivery("marlow").challenge},${delivery("marlow").challenge}` }];
      for (const headers of cases) {
        const response = await call(`${invitationPath("marlow")}?challenge=fake-untrusted-query`, { headers }); const value = providerInvitationPreviewSchema.parse(response.value);
        assert.equal(value.state, "unavailable"); assert.equal(value.provider, null); assert.equal(value.sessionCeilingAt, null);
      }
      assert.deepEqual(await captureProviderAccessState(), before);
    });
    await check("cross-origin missing-origin cross-site and mismatched-host claim writes are refused", async () => {
      const before = await captureProviderAccessState(), body = { claimId: randomUUID(), challenge: delivery("marlow").challenge };
      const cases: Record<string, string>[] = [{}, { Origin: "https://untrusted.invalid" }, { Origin: origin, "Sec-Fetch-Site": "cross-site" }];
      for (const extra of cases) {
        const response = await call(`${invitationPath("marlow")}/claim`, { method: "POST", headers: { "Content-Type": "application/json", ...extra }, body }); assert.equal(response.status, 403);
      }
      const port = Number(new URL(origin).port);
      for (const host of ["untrusted.invalid", `localhost:${port}`, `127.0.0.1:${port === 65535 ? 65534 : port + 1}`]) {
        const response = await rawHostClaim(`${invitationPath("marlow")}/claim`, host, body);
        assert.equal(response.status, 403); assert.equal(response.value.error.code, "MCP_HOST_REFUSED");
      }
      assert.deepEqual(await captureProviderAccessState(), before);
    });
    await check("simultaneous exact claim creates one provider session and returns that same original cookie", async () => {
      const id = randomUUID(), replies = await Promise.all([claim("marlow", id), claim("marlow", id), claim("marlow", id)]);
      const actors = await Promise.all(replies.map(response => claimedActor("marlow", response))); owned.marlow = actors[0]!;
      assert.equal(new Set(actors.map(value => value.cookie)).size, 1); assert.equal(replies.filter(response => response.value.restoredOriginal === false).length, 1);
      assert.equal(actors[0]!.session.expiresAt, fixture.sessionCeilingAt); assert.equal((await db.query("SELECT 1 FROM guild_market_provider_sessions WHERE provider_id='marlow'")).rowCount, 1);
      const first = new Map((initialSessionRows as any[]).map(item => [item.value.id, item.value]));
      for (const row of (await db.query("SELECT to_jsonb(s) AS value FROM guild_sessions s WHERE id=ANY($1::uuid[]) ORDER BY id", [[...first.keys()]])).rows) assert.deepEqual(row.value, first.get(row.value.id));
    });
    await check("original claim recovers after a lost response and changed claim never mints replacement", async () => {
      const before = await captureProviderAccessState(), restored = await claim("marlow"); assert.equal(restored.value.restoredOriginal, true);
      assert.equal((await claimedActor("marlow", restored)).cookie, owned.marlow!.cookie);
      const originalId = claimIds.get("marlow")!; assert.equal((await claim("marlow", randomUUID())).status, 409); claimIds.set("marlow", originalId);
      assert.deepEqual(await captureProviderAccessState(), before);
    });
    await check("different concurrent claim identities produce one winner and one refusal", async () => {
      const ids = [randomUUID(), randomUUID()], replies = await Promise.all(ids.map(id => claim("tessellate", id)));
      assert.deepEqual(replies.map(reply => reply.status).sort(), [200, 409]); const winner = replies.findIndex(reply => reply.status === 200);
      claimIds.set("tessellate", ids[winner]!); owned.tessellate = await claimedActor("tessellate", replies[winner]!);
      assert.equal((await db.query("SELECT 1 FROM guild_market_provider_sessions WHERE provider_id='tessellate'")).rowCount, 1);
    });
    await check("fixed routes keep buyer and provider cookies separate when both are present", async () => {
      const headers = { Cookie: `${SESSION_COOKIE}=${fixture.buyer.cookie}; ${PROVIDER_SESSION_COOKIE}=${owned.marlow!.cookie}` };
      const customer = agentAccessSnapshotSchema.parse((await call("/api/agent-access", { headers })).value);
      const provider = agentAccessSnapshotSchema.parse((await call("/api/provider/agent-access", { headers })).value);
      assert.equal(customer.viewer.actorId, fixture.buyer.session.id); assert.equal(customer.viewer.providerBinding, null);
      assert.equal(provider.viewer.actorId, owned.marlow!.session.id); assert.equal(provider.viewer.providerBinding?.id, "marlow");
      assert.equal((await call("/api/provider/workspace", { headers: customerHeaders() })).status, 401);
      assert.equal((await call("/api/agent-access", { headers: providerHeaders(owned.marlow!) })).status, 401);
      assert.equal((await call("/api/provider-market", { headers: { Cookie: `${SESSION_COOKIE}=${owned.marlow!.cookie}` } })).status, 403);
    });
    await check("unbound operator duplicate-cookie and bearer management entries grant nothing", async () => {
      const before = await captureProviderAccessState();
      for (const value of Object.values(fixture.negativeActors)) {
        assert.equal((await call("/api/provider/agent-access", { headers: providerHeaders(value) })).status, 403);
        assert.equal((await call("/api/agent-access", { headers: customerHeaders(value) })).status, 403);
      }
      assert.equal((await call("/api/agent-access", { headers: { Cookie: `${SESSION_COOKIE}=${fixture.buyer.cookie}; ${SESSION_COOKIE}=${fixture.buyer.cookie}` } })).status, 401);
      assert.equal((await call("/api/agent-access", { headers: { ...customerHeaders(), Authorization: "Bearer fake" } })).status, 403);
      assert.deepEqual(await captureProviderAccessState(), before);
    });
    await check("customer credentials expose one token once while exact replay/status retain only summary", async () => {
      const result = await issue("customer", fixture.buyer, ["mcp", "a2a"], "Controlled customer agent"); customerToken = result.result.token;
      const count = (await db.query("SELECT count(*)::int AS n FROM guild_market_protocol_clients")).rows[0].n;
      const again = agentAccessCommandResultSchema.parse((await accessCommand("customer", fixture.buyer, result.command)).value); assert.equal(again.state, "retained"); assert.equal("token" in again, false);
      const status = agentAccessCommandStatusSchema.parse((await call(`/api/agent-access/commands/${result.command.commandId}`, { headers: customerHeaders() })).value);
      assert.equal(status.state, "completed"); assert.equal(status.credential?.id, result.result.credential.id); assert.equal("token" in status, false);
      assert.equal((await db.query("SELECT count(*)::int AS n FROM guild_market_protocol_clients")).rows[0].n, count);
      assert.equal((await accessCommand("customer", fixture.buyer, { ...result.command, label: "Changed original request" })).status, 409);
      assert.equal((await call(`/api/agent-access/commands/${result.command.commandId}`, { headers: customerHeaders(fixture.foreign) })).value.state, "not_found");
    });
    await check("unknown issuance response is recovered with a read then explicit original revocation", async () => {
      const command = { commandId: randomUUID(), type: "issue_credential", label: "Intentionally discarded controlled token", scopes: ["mcp"], expiresAt: fixture.invitationExpiresAt };
      const response = await accessCommand("customer", fixture.buyer, command); assert.equal(response.status, 200); response.value = null;
      const status = agentAccessCommandStatusSchema.parse((await call(`/api/agent-access/commands/${command.commandId}`, { headers: customerHeaders() })).value);
      assert.equal(status.tokenAvailability, "unavailable"); assert.ok(status.credential); assert.equal("token" in status, false);
      const originalCount = (await db.query("SELECT count(*)::int AS n FROM guild_market_protocol_clients WHERE actor_id=$1", [fixture.buyer.session.id])).rows[0].n;
      const revoke = { commandId: randomUUID(), type: "revoke_credential", clientId: status.credential!.id };
      assert.equal((await accessCommand("customer", fixture.buyer, revoke)).value.state, "revoked");
      const before = await captureProviderAccessState(); assert.equal((await accessCommand("customer", fixture.buyer, revoke)).value.state, "revoked"); assert.deepEqual(await captureProviderAccessState(), before);
      assert.equal((await db.query("SELECT count(*)::int AS n FROM guild_market_protocol_clients WHERE actor_id=$1", [fixture.buyer.session.id])).rows[0].n, originalCount);
    });
    await check("simultaneous credential issuance returns one new token with one retained command", async () => {
      const command = { commandId: randomUUID(), type: "issue_credential", label: "Concurrent controlled issue", scopes: ["mcp"], expiresAt: fixture.invitationExpiresAt };
      const replies = await Promise.all([accessCommand("customer", fixture.buyer, command), accessCommand("customer", fixture.buyer, command)]);
      assert.deepEqual(replies.map(reply => reply.value.state).sort(), ["issued_now", "retained"]);
      assert.equal(new Set(replies.map(reply => reply.value.credential.id)).size, 1);
      assert.equal((await db.query("SELECT 1 FROM guild_provider_access_commands WHERE command_id=$1", [command.commandId])).rowCount, 1);
    });
    await check("scope escalation mixed scopes and session-ceiling overflow never issue credentials", async () => {
      const before = (await db.query("SELECT count(*)::int AS n FROM guild_market_protocol_clients")).rows[0].n;
      const invalid = [{ scopes: ["provider:read"] }, { scopes: ["mcp", "provider:read"] }, { scopes: ["mcp", "mcp"] }, { scopes: ["mcp"], expiresAt: new Date(Date.parse(fixture.sessionCeilingAt) + 1).toISOString() }];
      for (const value of invalid) {
        const response = await accessCommand("customer", fixture.buyer, { commandId: randomUUID(), type: "issue_credential", label: "Refused controlled scope", expiresAt: fixture.invitationExpiresAt, ...value });
        assert.ok([400, 409].includes(response.status));
      }
      assert.equal((await db.query("SELECT count(*)::int AS n FROM guild_market_protocol_clients")).rows[0].n, before);
    });
    await check("legacy customer credentials retain their exact provider restriction and existing bytes", async () => {
      const legacy = await createProtocolClient(db, fixture.buyer.session, ["a2a"], "marlow", fixture.invitationExpiresAt); sensitive.push(legacy.token);
      const before = (await db.query("SELECT to_jsonb(c) AS value FROM guild_market_protocol_clients c WHERE id=$1", [legacy.id])).rows[0].value;
      const snapshot = agentAccessSnapshotSchema.parse((await call("/api/agent-access", { headers: customerHeaders() })).value), item = snapshot.credentials.find(value => value.id === legacy.id)!;
      assert.equal(item.providerId, "marlow"); assert.equal(item.prefix, "not-retained"); assert.equal(item.scope, "customer");
      assert.deepEqual((await db.query("SELECT to_jsonb(c) AS value FROM guild_market_protocol_clients c WHERE id=$1", [legacy.id])).rows[0].value, before);
    });
    await check("provider tokens are distinct scoped API credentials and cannot manage owner access", async () => {
      providerToken = (await issue("provider", owned.marlow!, ["provider:read", "provider:negotiate", "provider:cancel"], "Controlled provider agent")).result.token;
      readToken = (await issue("provider", owned.marlow!, ["provider:read"], "Controlled provider reader")).result.token;
      foreignProviderToken = (await issue("provider", owned.tessellate!, ["provider:read", "provider:negotiate"], "Other controlled provider")).result.token;
      const snapshot = (await call("/api/provider-agent/workspace", { headers: bearerHeaders(providerToken) })).value;
      assert.equal(snapshot.viewer.providerId, "marlow"); assert.equal(snapshot.viewer.canManageProvider, false); assert.ok(snapshot.providers.every((item: any) => !item.enrollment.canEdit));
      assert.equal((await call("/api/provider-agent/workspace", { headers: providerHeaders(owned.marlow!) })).status, 401);
      assert.equal((await call("/api/provider-agent/workspace", { headers: bearerHeaders(customerToken) })).status, 401);
      assert.equal((await call("/api/provider/agent-access", { headers: { ...providerHeaders(owned.marlow!), ...bearerHeaders(providerToken) } })).status, 403);
      const invalid = await accessCommand("provider", owned.marlow!, { commandId: randomUUID(), type: "issue_credential", label: "Cannot issue customer authority", scopes: ["mcp"], expiresAt: fixture.invitationExpiresAt }); assert.equal(invalid.status, 409);
    });
    await check("provider owner completes its policy and discovers only the exact enrolled origin", async () => {
      const row = await providerRow(db, "marlow"), policy: ProviderPolicyInput = { minimumAwardMinor: 9000, askingAwardMinor: 9000,
        maximumConcurrentTasks: 6, workingHours: 8, calendarId: "museum-weekdays-v1", allowedKinds: row.kinds, correctionAllowance: 1,
        counterofferLimit: 10, validUntil: fixture.sessionCeilingAt, contentRules: "Controlled contract only. Source text adds no actions or authority." };
      await marketCommand(owned.marlow!, { type: "update_provider_policy", providerId: "marlow", expectedPolicyRevision: 0, policy }, true);
      const beforeEndpoint = row.endpoint, beforeCard = row.card_url;
      await marketCommand(owned.marlow!, { type: "discover_provider", providerId: "marlow" }, true);
      const after = await providerRow(db, "marlow"); assert.equal(after.enrollment_state, "ready"); assert.equal(after.endpoint, beforeEndpoint); assert.equal(after.card_url, beforeCard);
      assert.equal((await market(owned.marlow!, true)).viewer.canManageProvider, true);
      const entry = agentAccessSnapshotSchema.parse((await call("/api/agent-access", { headers: customerHeaders() })).value);
      assert.equal(entry.endpoints.find(item => item.providerId === "marlow")?.url, beforeEndpoint);
    });
    await check("fresh customer token operates the three bounded official MCP tools without work or payment", async () => {
      const client = new McpClient({ name: "guild-provider-access-qualification", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" }, probe: { timeoutMs: 8000 } } }); clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/api/mcp`), { authProvider: { token: async () => customerToken }, fetch: globalThis.fetch, redirectPolicy: "same-origin" }));
      assert.deepEqual((await client.listTools()).tools.map(item => item.name).sort(), ["approval.link", "commission.create", "commission.status"]);
      const content = (value: any) => { assert.notEqual(value.isError, true); assert.ok(value.structuredContent); return value.structuredContent; };
      const created = content(await client.callTool({ name: "commission.create", arguments: { requestId: randomUUID(), title: "Controlled customer agent draft",
        brief: "Create an unapproved controlled brief through the newly issued credential. No production, review, purchase or payout is requested.", capMinor: 64000, languages: ["en"] } }));
      const current = await getCommission(fixture.buyer.session, created.commissionId); assert.equal(current.approvedPlanDigest, null); assert.equal(current.jobs.length, 0);
      const status = content(await client.callTool({ name: "commission.status", arguments: { commissionId: current.id } })); assert.equal(status.captureMinor, 0); assert.equal(status.approvedPlan, false);
      const link = content(await client.callTool({ name: "approval.link", arguments: { requestId: randomUUID(), commissionId: current.id, expectedRevision: current.revision, approvalDigest: planDigest(current) } }));
      assert.equal(new URL(link.url).origin, origin); sensitive.push(new URL(link.url).searchParams.get("challenge")!);
      assert.equal((await db.query("SELECT consumed_at FROM guild_market_approval_links WHERE commission_id=$1", [current.id])).rows[0].consumed_at, null);
      const denied = await call("/api/mcp", { method: "POST", headers: { ...bearerHeaders(providerToken, true), Accept: "application/json, text/event-stream" }, body: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "wrong-provider-role", version: "1" } } } }); assert.equal(denied.status, 401);
    });
    let researchThread = "";
    await check("provider agent replies only to its own actual mounted negotiation", async () => {
      const current = await getCommission(fixture.buyer.session, fixture.commissions.research);
      const quoted = await marketCommand(fixture.buyer, { type: "request_quote", commissionId: current.id, expectedCommissionRevision: current.revision, packageId: "research", providerId: "marlow" });
      researchThread = quoted.threadId; const snapshot = await market(owned.marlow!, true), thread = snapshot.threads.find(item => item.id === researchThread)!;
      const command = { commandId: randomUUID(), type: "provider_counter", threadId: thread.id, expectedThreadRevision: thread.revision, providerAwardMinor: 9000,
        note: "Controlled provider agent confirms these exact policy-bound terms; no buyer approval or work is implied." };
      const reader = await call("/api/provider-agent/workspace/commands", { method: "POST", headers: bearerHeaders(readToken, true), body: command }); assert.equal(reader.status, 403);
      assert.equal((await db.query("SELECT 1 FROM guild_market_commands WHERE command_id=$1", [command.commandId])).rowCount, 0);
      const foreign = await call("/api/provider-agent/workspace/commands", { method: "POST", headers: bearerHeaders(foreignProviderToken, true), body: { ...command, commandId: randomUUID() } }); assert.equal(foreign.value.ok, false);
      const reply = await call("/api/provider-agent/workspace/commands", { method: "POST", headers: bearerHeaders(providerToken, true), body: command }); assert.equal(reply.value.ok, true);
      const retained = reply.value.snapshot as ProviderMarketSnapshot; assert.equal(retained.viewer.canManageProvider, false);
      assert.ok(retained.threads.every(item => !item.permissions.select && !item.permissions.delegate));
      assert.equal(retained.threads.find(item => item.id === thread.id)!.revision, thread.revision + 1);
      const attribution = (await db.query("SELECT a.*,c.token_hash FROM guild_provider_agent_authorizations a JOIN guild_market_protocol_clients c ON c.id=a.client_id WHERE a.command_id=$1", [command.commandId])).rows;
      assert.equal(attribution.length, 1); assert.equal(attribution[0].token_hash, sha(providerToken)); assert.equal(attribution[0].permission, "provider:negotiate");
      assert.equal(attribution[0].decision_already_recorded, false); assert.equal(attribution[0].request_digest, digest(command));
    });
    await check("provider agent cannot edit profile discover select delegate or recover owner operations", async () => {
      const before = (await db.query("SELECT to_jsonb(t) AS value FROM guild_market_threads t WHERE id=$1", [researchThread])).rows[0].value;
      const commands = [
        { type: "discover_provider", providerId: "marlow" },
        { type: "select_offer", threadId: researchThread, expectedThreadRevision: 0, expectedCommissionRevision: 0, termsDigest: "0".repeat(64) },
        { type: "delegate_task", threadId: researchThread, expectedThreadRevision: 0, expectedCommissionRevision: 0, termsDigest: "0".repeat(64), approvedPlanDigest: "0".repeat(64) },
        { type: "recover_original", operationId: randomUUID() },
        { type: "request_quote", commissionId: fixture.commissions.native, expectedCommissionRevision: 0, packageId: "research", providerId: "marlow" },
        { type: "update_provider_profile", providerId: "marlow", expectedProfileRevision: 0, profile: { displayName: "Changed name", ownerDisplayName: "Changed owner", specialty: "Changed specialty", description: "This controlled negative must never change the provider profile.", portfolioUrl: null } },
      ];
      for (const command of commands) {
        const id = randomUUID(), result = await call("/api/provider-agent/workspace/commands", { method: "POST", headers: bearerHeaders(providerToken, true), body: { commandId: id, ...command } });
        assert.equal(result.status, 403); assert.equal(result.value.code, "PROVIDER_AGENT_ACTION");
        assert.equal((await db.query("SELECT 1 FROM guild_market_commands WHERE command_id=$1", [id])).rowCount, 0);
      }
      assert.deepEqual((await db.query("SELECT to_jsonb(t) AS value FROM guild_market_threads t WHERE id=$1", [researchThread])).rows[0].value, before);
    });
    await check("credential revocation racing after preauthentication refuses the original market write", async () => {
      const issued = await issue("provider", owned.marlow!, ["provider:read", "provider:negotiate"], "Controlled revocation race");
      const thread = (await market(owned.marlow!, true)).threads.find(item => item.id === researchThread)!, commandId = randomUUID();
      const locker = await db.connect(); let pending: Promise<Awaited<ReturnType<typeof call>>> | undefined;
      try {
        await locker.query("BEGIN"); await locker.query("SELECT id FROM guild_sessions WHERE id=$1 FOR UPDATE", [owned.marlow!.session.id]);
        pending = call("/api/provider-agent/workspace/commands", { method: "POST", headers: bearerHeaders(issued.result.token, true), body: { commandId, type: "provider_counter", threadId: thread.id,
          expectedThreadRevision: thread.revision, providerAwardMinor: 9000, note: "This preauthenticated command must be refused after the original credential is revoked." } });
        let waiting = false; const end = Date.now() + 5000;
        while (Date.now() < end) {
          waiting = (await db.query("SELECT 1 FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND usename=current_user AND wait_event_type='Lock' AND query LIKE '%guild_sessions%' AND query LIKE '%FOR SHARE%' LIMIT 1")).rowCount === 1;
          if (waiting) break; await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert.equal(waiting, true, "The actual command reached its in-transaction session lock after bearer preauthentication.");
        await locker.query("UPDATE guild_market_protocol_clients SET revoked_at=clock_timestamp() WHERE id=$1", [issued.result.credential.id]); await locker.query("COMMIT");
        const result = await pending; assert.equal(result.value.ok, false); assert.equal(result.value.error.code, "PROVIDER_AGENT_AUTHORITY");
        assert.equal((await db.query("SELECT revision FROM guild_market_threads WHERE id=$1", [thread.id])).rows[0].revision, thread.revision);
        assert.equal((await db.query("SELECT 1 FROM guild_market_commands WHERE command_id=$1", [commandId])).rowCount, 0);
      } finally { await locker.query("ROLLBACK").catch(() => undefined); locker.release(); if (pending) await pending.catch(() => undefined); }
    });
    async function controlledDelegation(commissionId: string, threadId?: string): Promise<string> {
      let current = await getCommission(fixture.buyer.session, commissionId);
      if (!threadId) threadId = (await marketCommand(fixture.buyer, { type: "request_quote", commissionId, expectedCommissionRevision: current.revision, packageId: "research", providerId: "marlow" })).threadId;
      let thread = (await market(fixture.buyer, false, commissionId)).threads.find(item => item.id === threadId)!;
      await marketCommand(fixture.buyer, { type: "select_offer", threadId, expectedThreadRevision: thread.revision, expectedCommissionRevision: current.revision, termsDigest: thread.latestTermsDigest });
      current = await getCommission(fixture.buyer.session, commissionId); assert.equal(current.approvedPlanDigest, null);
      const approved = await call(`/api/commissions/${commissionId}/commands`, { method: "POST", headers: customerHeaders(fixture.buyer, true), body: {
        type: "approve_plan", commandId: randomUUID(), expectedRevision: current.revision, planDigest: planDigest(current),
      } }); assert.equal(approved.value.ok, true);
      current = await getCommission(fixture.buyer.session, commissionId); thread = (await market(fixture.buyer, false, commissionId)).threads.find(item => item.id === threadId)!;
      const result = await marketCommand(fixture.buyer, { type: "delegate_task", threadId, expectedThreadRevision: thread.revision,
        expectedCommissionRevision: current.revision, termsDigest: thread.latestTermsDigest, approvedPlanDigest: current.approvedPlanDigest });
      return result.taskId;
    }
    await check("provider cancellation scope cancels only an eligible original unstarted controlled job", async () => {
      const taskId = await controlledDelegation(fixture.commissions.cancellation), task = (await market(owned.marlow!, true)).tasks.find(item => item.id === taskId)!;
      assert.equal(task.canCancel, true); const command = { commandId: randomUUID(), type: "cancel_task", taskId, expectedTaskRevision: task.revision,
        note: "Controlled provider-agent cancellation before any worker or external dispatch." };
      assert.equal((await call("/api/provider-agent/workspace/commands", { method: "POST", headers: bearerHeaders(readToken, true), body: command })).status, 403);
      const response = await call("/api/provider-agent/workspace/commands", { method: "POST", headers: bearerHeaders(providerToken, true), body: command }); assert.equal(response.value.ok, true);
      const cancelled = (response.value.snapshot as ProviderMarketSnapshot).tasks.find(item => item.id === taskId)!; assert.equal(cancelled.state, "cancelled"); assert.equal(cancelled.canCancel, false);
      const job = (await db.query("SELECT state,attempts FROM guild_jobs WHERE id=$1", [task.originalJobId])).rows[0]; assert.equal(job.state, "failed"); assert.equal(job.attempts, 0);
      assert.equal((await db.query("SELECT permission FROM guild_provider_agent_authorizations WHERE command_id=$1", [command.commandId])).rows[0].permission, "provider:cancel");
    });
    await check("controlled completion updates both durable job and studio projection without invented review", async () => {
      artifactTaskId = await controlledDelegation(fixture.commissions.research, researchThread);
      const current = await getCommission(fixture.buyer.session, fixture.commissions.research), pkg = current.packages.find(item => item.id === "research")!;
      const task = (await db.query("SELECT original_job_id FROM guild_market_tasks WHERE id=$1", [artifactTaskId])).rows[0];
      const body = { controlled: true, text: "Synthetic provider-access artifact for route ownership; no model, human review or acceptance." }, createdAt = new Date().toISOString();
      const artifact: ArtifactManifest = { id: randomUUID(), packageId: "research", title: "Controlled provider entry research output", mediaType: "application/json", contentHash: digest(body),
        downloadUrl: "/controlled/no-transport", previewUrl: null, sourceIds: [], createdAt,
        provenance: { mode: "sample", label: "Controlled provider-access projection", sourceId: "access-worker", observedAt: createdAt, sandbox: false }, reviewStatus: "Not accepted", content: body };
      artifactId = artifact.id; current.artifacts.push(artifact); pkg.artifactIds.push(artifact.id); pkg.state = "awaiting_acceptance";
      const projection = current.jobs.find(item => item.id === task.original_job_id); assert.ok(projection);
      Object.assign(projection, { state: "completed", step: "Controlled fixture completion; no model call", error: null, blocksNewProduction: false, updatedAt: createdAt });
      await transaction(async client => { await saveCommission(client, current); await client.query("UPDATE guild_jobs SET state='completed',output=$2,updated_at=$3 WHERE id=$1 AND state='queued' AND attempts=0", [task.original_job_id, { artifactId }, createdAt]); });
      const snapshot = await market(owned.marlow!, true), view = snapshot.tasks.find(item => item.id === artifactTaskId)!;
      assert.equal(view.state, "completed"); assert.equal(view.acceptance.state, "awaiting_review"); assert.equal(view.payment.payoutState, "not_started");
      assert.equal((await getCommission(fixture.buyer.session, current.id)).jobs.filter(item => ["queued", "running"].includes(item.state)).length, 0);
      assert.equal(view.artifacts[0]!.downloadUrl, `/api/provider/workspace/tasks/${artifactTaskId}/artifacts/${artifactId}`);
    });
    await check("fixed provider human and agent artifact routes return exact bytes with no buyer-cookie fallback", async () => {
      const before = await captureProviderAccessState(), providerPath = `/api/provider/workspace/tasks/${artifactTaskId}/artifacts/${artifactId}`,
        agentPath = `/api/provider-agent/workspace/tasks/${artifactTaskId}/artifacts/${artifactId}`;
      const human = await call(providerPath, { headers: providerHeaders(owned.marlow!) }), agent = await call(agentPath, { headers: bearerHeaders(readToken) });
      assert.equal(human.status, 200); assert.equal(agent.status, 200); assert.equal(human.text, agent.text);
      assert.equal(agent.value.artifact.id, artifactId); assert.equal(agent.value.acceptance.state, "awaiting_review");
      const head = await call(agentPath, { method: "HEAD", headers: bearerHeaders(readToken) }); assert.equal(head.status, 200); assert.equal(head.text, ""); assert.equal(head.headers.get("content-length"), agent.headers.get("content-length"));
      assert.equal((await call(providerPath, { headers: customerHeaders() })).status, 401);
      assert.equal((await call(agentPath, { headers: providerHeaders(owned.marlow!) })).status, 401);
      const foreign = await call(agentPath, { headers: bearerHeaders(foreignProviderToken) }), missing = await call(`/api/provider-agent/workspace/tasks/${randomUUID()}/artifacts/${artifactId}`, { headers: bearerHeaders(foreignProviderToken) });
      assert.equal(foreign.status, 404); assert.equal(foreign.text, missing.text);
      assert.equal((await call(`/api/provider-market/tasks/${artifactTaskId}/artifacts/${artifactId}`, { headers: providerHeaders(owned.marlow!) })).status, 401);
      assert.deepEqual(await captureProviderAccessState(), before);
    });
    await check("expired first-claim invitation refuses admission without any new session", async () => {
      await db.query("UPDATE guild_provider_invitations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [delivery("halide").invitationId]);
      const before = await captureProviderAccessState(); assert.equal((await preview("halide")).value.state, "expired"); assert.equal((await claim("halide")).status, 410);
      assert.deepEqual(await captureProviderAccessState(), before);
    });
    await check("expired first-claim window can recover only the already claimed original live session", async () => {
      await db.query("UPDATE guild_provider_invitations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [delivery("marlow").invitationId]);
      const before = await captureProviderAccessState(), response = await preview("marlow"); assert.equal(response.value.state, "claimed");
      const original = await claimedActor("marlow", await claim("marlow")); assert.equal(original.cookie, owned.marlow!.cookie); assert.equal(original.session.expiresAt, fixture.sessionCeilingAt);
      assert.deepEqual(await captureProviderAccessState(), before);
    });
    await check("expired original provider session and credential cannot be renewed through recovery", async () => {
      owned.quill = await claimedActor("quill", await claim("quill"));
      const credential = await issue("provider", owned.quill!, ["provider:read"], "Controlled expiry negative");
      await db.query("UPDATE guild_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [owned.quill!.session.id]);
      const before = await captureProviderAccessState(); assert.equal((await claim("quill")).status, 410);
      assert.equal((await call("/api/provider/agent-access", { headers: providerHeaders(owned.quill!) })).status, 401);
      assert.equal((await call("/api/provider-agent/workspace", { headers: bearerHeaders(credential.result.token) })).status, 401);
      assert.deepEqual(await captureProviderAccessState(), before);
    });
    await check("changed original provider ownership redacts preview and refuses claim atomically", async () => {
      await db.query("UPDATE guild_market_providers SET owner_identity=$2 WHERE id=$1", ["ostrava", randomUUID()]);
      const before = await captureProviderAccessState(), response = await preview("ostrava"); assert.equal(response.value.state, "unavailable"); assert.equal(response.value.provider, null);
      assert.equal((await claim("ostrava")).status, 409); assert.deepEqual(await captureProviderAccessState(), before);
    });
    await check("explicit invitation revocation terminates only its original provider session and clients", async () => {
      owned.formwork = await claimedActor("formwork", await claim("formwork"));
      const credential = await issue("provider", owned.formwork!, ["provider:read"], "Controlled invitation revocation");
      const allBefore = (await db.query("SELECT to_jsonb(s) AS value FROM guild_sessions s WHERE id<>$1 ORDER BY id", [owned.formwork!.session.id])).rows;
      const row = (await db.query("SELECT provider_binding_digest FROM guild_provider_invitations WHERE id=$1", [delivery("formwork").invitationId])).rows[0];
      const input = { operationId: randomUUID(), invitationId: delivery("formwork").invitationId, expectedBindingDigest: row.provider_binding_digest,
        issuerIdentity: "Controlled qualification operator", reason: "Explicitly revoke this controlled invitation and its original provider access only." };
      const result = await revokeProviderInvitation(input); await savePrivate("invitation-revocation.private.json", { input, result });
      const before = await captureProviderAccessState(); assert.deepEqual(await revokeProviderInvitation(input), result); assert.deepEqual(await captureProviderAccessState(), before);
      assert.equal((await preview("formwork")).value.state, "revoked"); assert.equal((await claim("formwork")).status, 410);
      assert.equal((await call("/api/provider-agent/workspace", { headers: bearerHeaders(credential.result.token) })).status, 403);
      assert.deepEqual((await db.query("SELECT to_jsonb(s) AS value FROM guild_sessions s WHERE id<>$1 ORDER BY id", [owned.formwork!.session.id])).rows, allBefore);
      assert.equal((await db.query("SELECT revoked_at FROM guild_market_protocol_clients WHERE id=$1", [credential.result.credential.id])).rows[0].revoked_at instanceof Date, true);
    });
    await check("foreign customer and provider cannot revoke another original credential", async () => {
      const client = (await db.query("SELECT id,revoked_at FROM guild_market_protocol_clients WHERE token_hash=$1", [sha(providerToken)])).rows[0];
      for (const [scope, owner] of [["customer", fixture.foreign], ["provider", owned.tessellate!]] as const) {
        const response = await accessCommand(scope, owner, { commandId: randomUUID(), type: "revoke_credential", clientId: client.id });
        assert.equal(response.status, 409); assert.equal(response.value.error.code, "CLIENT_NOT_FOUND");
      }
      assert.equal((await db.query("SELECT revoked_at FROM guild_market_protocol_clients WHERE id=$1", [client.id])).rows[0].revoked_at, null);
    });
    await check("operator dry plan is read-only and actual registry drift refuses its later apply", async () => {
      const before = await captureProviderAccessState();
      const stale = await planControlledProviderSetup({ operationId: randomUUID(), browserOrigin: origin, serviceOrigin: origin,
        issuerIdentity: "Controlled stale-plan negative", syntheticFixture: true, invitationExpiresAt: fixture.invitationExpiresAt, sessionCeilingAt: fixture.sessionCeilingAt });
      sensitive.push(...stale.delivery.map(item => item.challenge)); assert.deepEqual(await captureProviderAccessState(), before); await savePrivate("stale-setup-plan.private.json", stale);
      const row = await providerRow(db, "marlow"); await marketCommand(owned.marlow!, { type: "update_provider_profile", providerId: "marlow", expectedProfileRevision: row.profile_revision,
        profile: { ...row.profile, description: `${row.profile.description} Controlled explicit owner profile revision for setup-drift qualification.` } }, true);
      const changed = await captureProviderAccessState(); await assert.rejects(applyControlledProviderSetup(stale.plan, stale.plan.digest), /registry changed/);
      assert.deepEqual(await captureProviderAccessState(), changed);
    });
    let nativeInvitation: ProviderInvitationDelivery | undefined;
    await check("explicit additional invitations preserve every enrolled service and all original rows", async () => {
      const before = await captureProviderAccessState() as any;
      const operationId = randomUUID(), directory = resolve(evidence, "operator-additional-plan"), journal = resolve(evidence, "operator-journal"); await mkdir(journal, { mode: 0o700 });
      await savePrivate("operator-database.private.json", { databaseUrl: process.env.DATABASE_URL });
      const run = async (name: string, args: string[]) => {
        const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/provider-access-operator.ts", "--database-url-file", resolve(evidence, "operator-database.private.json"), ...args],
          { cwd: root, env: process.env, timeout: 30_000, maxBuffer: 1_000_000 });
        await writeFile(resolve(evidence, `operator-${name}.log`), result.stdout + result.stderr, { flag: "wx", mode: 0o600 });
        assert.equal(result.stderr, ""); return JSON.parse(result.stdout.trim());
      };
      await run("plan", ["--mode", "plan", "--operation", operationId, "--browser-origin", origin, "--service-origin", origin,
        "--issuer", "Controlled explicit additional-invitation preservation check", "--synthetic-fixture", "true",
        "--invitation-expires-at", fixture.invitationExpiresAt, "--session-ceiling-at", fixture.sessionCeilingAt, "--output-dir", directory]);
      assert.deepEqual(await captureProviderAccessState(), before);
      const additional = { plan: JSON.parse(await readFile(resolve(directory, "plan.json"), "utf8")) as ControlledProviderSetupPlan,
        delivery: JSON.parse(await readFile(resolve(directory, "delivery.private.json"), "utf8")) as ProviderInvitationDelivery[] };
      sensitive.push(...additional.delivery.map(item => item.challenge));
      const applyArgs = ["--mode", "apply", "--plan", resolve(directory, "plan.json"), "--expect-digest", additional.plan.digest,
        "--browser-origin", origin, "--service-origin", origin, "--journal-dir", journal];
      const output = await run("apply", applyArgs), result = JSON.parse(await readFile(output.privateReceipt, "utf8")).result;
      assert.equal(result.receipt.providersCreated, 0); assert.equal(result.receipt.providersPreserved, 7); assert.equal(result.receipt.invitations.length, 7);
      const after = await captureProviderAccessState() as any; assert.equal(after.catalog, before.catalog);
      for (const table of before.tables) {
        const next = after.tables.find((item: any) => item.table === table.table);
        if (!["guild_provider_setup_operations", "guild_provider_invitations"].includes(table.table)) assert.deepEqual(next, table);
        else for (const row of table.rows) assert.deepEqual(next.rows.find((item: any) => item.id === row.id), row);
      }
      await run("inspect", ["--mode", "inspect", "--operation", operationId, "--output-dir", resolve(evidence, "operator-retained-inspection")]);
      const retained = await run("recover", [...applyArgs, "--resume-original", "true"]);
      assert.equal(JSON.parse(await readFile(retained.privateReceipt, "utf8")).result.retained, true); assert.deepEqual(await captureProviderAccessState(), after);
      nativeInvitation = additional.delivery.find(item => item.providerId === "northlight")!;
    });
    await check("unavailable changed service origin cannot silently retarget the original setup", async () => {
      const before = await captureProviderAccessState();
      const changed = { ...fixture.setup.plan, browserOrigin: "https://untrusted.invalid", operationId: randomUUID() }, { digest: ignored, ...body } = changed;
      const value = { ...body, digest: digest(body) }; await assert.rejects(applyControlledProviderSetup(value, value.digest), /origins must match/);
      assert.deepEqual(await captureProviderAccessState(), before);
    });
    await check("raw tokens challenges and cookies are absent from persisted rows read APIs HTML and server log", async () => {
      const state = canonical(await captureProviderAccessState());
      const reads = await Promise.all([call("/api/agent-access", { headers: customerHeaders() }), call("/api/provider/agent-access", { headers: providerHeaders(owned.marlow!) }),
        call("/connections"), call("/provider/connections"), call(`/provider/invitations/${nativeInvitation!.invitationId}`)]);
      const runtime = JSON.parse(await readFile(resolve(evidence, "runtime-owner.json"), "utf8")), log = await readFile(runtime.log, "utf8");
      for (const secret of sensitive.filter(Boolean)) { assert.equal(state.includes(secret), false); assert.equal(log.includes(secret), false); for (const response of reads) assert.equal(response.text.includes(secret), false); }
      for (const response of reads.slice(2)) { assert.equal(response.status, 200); assert.equal(response.headers.get("referrer-policy"), "no-referrer"); assert.match(response.headers.get("cache-control") ?? "", /private.*no-store/); }
    });
    await check("GET HEAD credential status provider workspaces and artifacts leave every row unchanged", async () => {
      const before = await captureProviderAccessState();
      for (const method of ["GET", "HEAD"]) {
        for (const [path, headers] of [["/api/agent-access", customerHeaders()], ["/api/provider/agent-access", providerHeaders(owned.marlow!)],
          ["/api/provider/workspace", providerHeaders(owned.marlow!)], ["/api/provider-agent/workspace", bearerHeaders(readToken)],
          [`/api/agent-access/commands/${randomUUID()}`, customerHeaders()]] as const) {
          const response = await call(path, { method, headers }); assert.equal(response.status, 200); if (method === "HEAD") assert.equal(response.text, ""); assert.equal(response.headers.get("set-cookie"), null);
        }
      }
      assert.deepEqual(await captureProviderAccessState(), before);
    });
    await check("native handoff keeps original ceilings no running jobs and a complete before-row baseline", async () => {
      const effects: Record<string, number> = {};
      for (const name of ["guild_acceptance_decisions", "guild_model_runs", "guild_payment_intents"]) { effects[name] = Number((await db.query(`SELECT count(*) AS n FROM ${name}`)).rows[0].n); assert.equal(effects[name], 0); }
      assert.equal((await db.query("SELECT 1 FROM guild_jobs WHERE state IN ('queued','running') OR attempts<>0")).rowCount, 0);
      for (const row of (await db.query<{ snapshot: Commission }>("SELECT snapshot FROM guild_commissions")).rows) {
        assert.equal(row.snapshot.payments.capturedMinor, 0); assert.equal(row.snapshot.payments.providerPaidMinor, 0); assert.equal(row.snapshot.payments.operations.length, 0);
      }
      for (const value of [fixture.buyer, fixture.foreign, ...Object.values(fixture.negativeActors)]) {
        const current = (await db.query("SELECT expires_at,revoked_at FROM guild_sessions WHERE id=$1", [value.session.id])).rows[0];
        assert.equal(current.expires_at.toISOString(), value.session.expiresAt); assert.equal(current.revoked_at, null);
      }
      assert.equal((await db.query("SELECT consumed_at FROM guild_provider_invitations WHERE id=$1", [nativeInvitation!.invitationId])).rows[0].consumed_at, null);
      report.sideEffects = effects;
      await savePrivate("native-before.private.json", { at: new Date().toISOString(), state: await captureProviderAccessState() });
      await savePrivate("native-entry-packet.private.json", { version: "guild.provider-access-native-entry.v1", origin, schema, nativeAcceptance: "pending",
        buyer: { cookieName: SESSION_COOKIE, cookieValue: fixture.buyer.cookie, expiresAt: fixture.buyer.session.expiresAt, url: `${origin}/connections`, marketUrl: `${origin}/market?commission=${fixture.commissions.native}` },
        invitation: { ...nativeInvitation, invitationExpiresAt: fixture.invitationExpiresAt, originalSessionCeilingAt: fixture.sessionCeilingAt },
        existingProvider: { cookieName: PROVIDER_SESSION_COOKIE, cookieValue: owned.marlow!.cookie, expiresAt: owned.marlow!.session.expiresAt, url: `${origin}/provider`, connectionsUrl: `${origin}/provider/connections` },
        controlledArtifact: { taskId: artifactTaskId, artifactId },
        allowedNativeActions: ["Review invitation dialog focus/Escape and one explicit Northlight claim; buyer cookie must remain exact.", "Inspect own provider console and fixed connections scope.", "Optionally issue one read-only provider credential, inspect its one-time disclosure without capturing raw token in screenshots, then explicitly revoke that same credential.", "Inspect buyer connections without issuing a credential; existing buyer cookie/expiry remains exact.", "Check390/360 keyboard, focus and errors. No policy/plan approval, delegation, worker, model, media, financial or publication action."],
        caution: "Private original credentials/fragment. Do not print or capture raw values. Fixed expiries are never renewed; preserve original browser cookies and restore them after the review." });
    });
  } catch (error) { report.error = scrub(error instanceof Error ? error.message : String(error)); }
  finally {
    for (const client of clients) await client.close().catch(() => undefined);
    globalThis.fetch = originalFetch;
    report.passed = report.failures.length === 0 && !report.error;
    report.reportPath = resolve(evidence, `provider-access-next-http-${Date.now()}.json`);
    await writeFile(report.reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await db.end();
  }
  return report;
}
if (process.argv[1]?.endsWith("check-provider-access-next-http.ts")) {
  if (process.argv[2] === "prepare") await prepareProviderAccessNextFixture();
  else { const report = await runProviderAccessNextQualification(); console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, http: report.wire.length, failures: report.failures, reportPath: report.reportPath })); if (!report.passed) process.exitCode = 1; }
}
