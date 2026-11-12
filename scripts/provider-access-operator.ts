/** Explicit, private deployment setup. This script does not load .env, run a
 * migration, approve a provider policy, fetch an endpoint or start work. */
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { controlledProviderSetupPlanSchema } from "../src/contracts/provider-access";
import { digest, DomainError } from "../src/domain/primitives";

const options = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index]!, value = process.argv[index + 1];
  if (!key.startsWith("--") || !value || value.startsWith("--") || options.has(key)) throw new Error("Pass each named option once with an explicit value.");
  options.set(key, value);
}
const allowed = new Set(["--mode", "--database-url-file", "--browser-origin", "--service-origin", "--operation", "--issuer", "--synthetic-fixture",
  "--invitation-expires-at", "--session-ceiling-at", "--output-dir", "--plan", "--expect-digest", "--journal-dir", "--resume-original", "--invitation", "--reason-file"]);
for (const key of options.keys()) if (!allowed.has(key)) throw new Error(`Unknown operator option: ${key}`);
function required(key: string): string { const value = options.get(key); if (!value) throw new Error(`An explicit ${key} is required.`); return value; }
async function privateFile(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("Private input paths must be absolute.");
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size > 2_000_000) throw new Error("Private input must be a small regular file with mode0600.");
  return readFile(path, "utf8");
}
async function privateDirectory(path: string, create = false): Promise<void> {
  if (!isAbsolute(path)) throw new Error("Private output paths must be absolute.");
  if (create) await mkdir(path, { mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("Private output directory must have mode0700.");
}
async function save(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }
function reviewedPlan(value: string) {
  const plan = controlledProviderSetupPlanSchema.parse(JSON.parse(value)), { digest: expected, ...body } = plan;
  if (digest(body) !== expected || required("--expect-digest") !== expected) throw new Error("The supplied plan does not match its exact reviewed digest.");
  return plan;
}
let close: (() => Promise<void>) | undefined;
try {
  const databaseInput = (await privateFile(required("--database-url-file"))).trim();
  const databaseUrl = databaseInput.startsWith("{") ? (JSON.parse(databaseInput) as { databaseUrl?: string }).databaseUrl : databaseInput;
  if (!databaseUrl) throw new Error("The private configuration must contain databaseUrl.");
  const url = new URL(databaseUrl);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("An explicit PostgreSQL identity is required.");
  process.env.DATABASE_URL = databaseUrl;
  if (options.has("--browser-origin")) process.env.GUILD_MARKET_BROWSER_ORIGIN = required("--browser-origin");
  if (options.has("--service-origin")) process.env.GUILD_MARKET_APP_URL = required("--service-origin");
  const { getPool, transaction } = await import("../src/server/db"), setup = await import("../src/server/provider-access/setup");
  close = () => getPool().end();
  const mode = required("--mode");
  if (mode === "plan") {
    const output = required("--output-dir"); await privateDirectory(output, true);
    const fixture = required("--synthetic-fixture"); if (!["true", "false"].includes(fixture)) throw new Error("Choose synthetic-fixture true or false explicitly.");
    const result = await setup.planControlledProviderSetup({ operationId: z.string().uuid().parse(required("--operation")),
      browserOrigin: required("--browser-origin"), serviceOrigin: required("--service-origin"), issuerIdentity: required("--issuer"), syntheticFixture: fixture === "true",
      invitationExpiresAt: required("--invitation-expires-at"), sessionCeilingAt: required("--session-ceiling-at") });
    await save(resolve(output, "plan.json"), result.plan); await save(resolve(output, "delivery.private.json"), result.delivery);
    await save(resolve(output, "read-only-result.json"), { at: new Date().toISOString(), mode, digest: result.plan.digest,
      databaseIdentityDigest: digest(result.plan.databaseIdentity), deliveriesSha256: createHash("sha256").update(JSON.stringify(result.delivery)).digest("hex"), mutations: 0 });
    console.log(JSON.stringify({ mode, privatePlan: resolve(output, "plan.json"), digest: result.plan.digest, mutations: 0 }));
  } else if (mode === "inspect") {
    const output = required("--output-dir"); await privateDirectory(output, true);
    const result = await setup.inspectProviderSetupOperation(required("--operation"));
    await save(resolve(output, "retained-operation.json"), { at: new Date().toISOString(), result, mutations: 0 });
    console.log(JSON.stringify({ mode, resultVisible: !!result, privateResult: resolve(output, "retained-operation.json"), mutations: 0 }));
  } else if (mode === "apply" || mode === "revoke") {
    const plan = reviewedPlan(await privateFile(required("--plan"))), journal = required("--journal-dir");
    await privateDirectory(journal);
    // Even revocation checks the original database/catalog rather than trusting
    // a plausible UUID in an arbitrary connected environment.
    const state = await transaction(async db => { await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"); return setup.providerSetupState(db); });
    if (digest(state.databaseIdentity) !== digest(plan.databaseIdentity) || state.schemaFingerprint !== plan.schemaFingerprint) throw new Error("Original database identity or schema changed; no write was attempted.");
    const revocation = mode === "revoke" ? { operationId: z.string().uuid().parse(required("--operation")), invitationId: z.string().uuid().parse(required("--invitation")),
      expectedBindingDigest: (() => {
        const service = plan.services.find(item => item.invitationId === required("--invitation"));
        if (!service) throw new Error("Select an invitation retained in this original reviewed plan.");
        return digest({ id: service.id, ownerIdentity: service.ownerIdentity, endpoint: service.endpoint, cardUrl: service.cardUrl,
          kinds: service.kinds, provenance: service.provenance, syntheticFixture: plan.syntheticFixture });
      })(), issuerIdentity: required("--issuer"), reason: (await privateFile(required("--reason-file"))).trim() } : null;
    const operationId = revocation?.operationId ?? plan.operationId, intent = { mode, operationId, planDigest: plan.digest,
      databaseIdentityDigest: digest(plan.databaseIdentity), requestDigest: digest(revocation ?? plan) };
    const intentPath = resolve(journal, `${operationId}.intent.json`);
    try { await save(intentPath, intent); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (options.get("--resume-original") !== "true" || digest(JSON.parse(await privateFile(intentPath))) !== digest(intent)) {
        throw new Error("An original intent already exists. Inspect its retained result first; only explicit resume-original with the exact original plan may recover it.");
      }
    }
    const result = revocation ? await setup.revokeProviderInvitation(revocation) : await setup.applyControlledProviderSetup(plan, required("--expect-digest"));
    const output = resolve(journal, `${operationId}.${Date.now()}.receipt.json`); await save(output, { at: new Date().toISOString(), ...intent, result });
    console.log(JSON.stringify({ mode, privateReceipt: output, policyApprovals: 0, workStarted: 0, financialActions: 0 }));
  } else throw new Error("Choose mode plan, apply, inspect or revoke.");
} catch (error) {
  // Do not print database messages, query parameters, private delivery or stack.
  console.error(JSON.stringify({ ok: false, code: error instanceof DomainError ? error.code : "OPERATOR_REQUEST_NOT_CONFIRMED",
    message: error instanceof DomainError ? error.message : "The operator request was not confirmed. Retain the private original inputs and journal, inspect the original operation and correct its configuration before retrying." }));
  process.exitCode = 1;
} finally { if (close) await close(); }
