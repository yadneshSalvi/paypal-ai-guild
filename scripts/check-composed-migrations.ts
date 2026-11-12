import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Pool } from "pg";

const target = resolve(process.argv[2] ?? "missing-evidence-directory"), baseUrl = new URL(process.env.DATABASE_URL!);
assert.equal(baseUrl.username, "guild_composed_app"); assert.equal(baseUrl.port, "55561");
assert.ok(isAbsolute(baseUrl.searchParams.get("host") ?? ""));
assert.match(basename(baseUrl.searchParams.get("host") ?? ""), /^guild-composed-pg-[a-z0-9_]+$/);
await mkdir(target, { recursive: false, mode: 0o700 });
const schema = "guild_composition_upgrade_" + randomUUID().replaceAll("-", ""), setup = new Pool({ connectionString: baseUrl.href, max: 1 });
await setup.query(`CREATE SCHEMA "${schema}"`);
baseUrl.searchParams.set("options", `-c search_path=${schema}`); process.env.DATABASE_URL = baseUrl.href;
const { getPool } = await import("../src/server/db"), pool = getPool();
const migrations = (await readdir(new URL("../migrations/", import.meta.url))).filter(name => name.endsWith(".sql")).sort();
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
async function snapshot(name: string) {
  const tables = (await pool.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename<>'guild_schema_migrations' ORDER BY tablename")).rows;
  const rows: Record<string, { count: number; sha256: string }> = {};
  for (const { tablename } of tables) {
    assert.match(tablename, /^guild_[a-z_]+$/);
    const hashes = (await pool.query<{ hash: string }>(`SELECT encode(sha256(convert_to(row_to_json(t)::text,'UTF8')),'hex') AS hash FROM "${tablename}" t ORDER BY hash`)).rows.map(row => row.hash);
    rows[tablename] = { count: hashes.length, sha256: sha(hashes.join("\n")) };
  }
  await writeFile(resolve(target, name + ".json"), JSON.stringify({ schema, tables: rows, sha256: sha(JSON.stringify(rows)), provenance: "Restricted independent synthetic migration fixture only." }, null, 2) + "\n", { mode: 0o600 });
  return rows;
}
async function apply(name: string) { await pool.query(await readFile(new URL("../migrations/" + name, import.meta.url), "utf8")); }
function retained(before: Awaited<ReturnType<typeof snapshot>>, after: Awaited<ReturnType<typeof snapshot>>) {
  for (const [table, record] of Object.entries(before)) assert.deepEqual(after[table], record, "Migration changed retained historical rows: " + table);
}
try {
  for (const name of migrations.filter(name => Number(name.slice(0, 3)) <= 16)) await apply(name);
  const role = (await pool.query("SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0];
  assert.deepEqual(role, { rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false });
  const { fresh, ready, queue, finish, MemoryMedia, SyntheticSpeech } = await import("../tests/support/narration-fixture");
  const f = await fresh(); await ready(f);
  const media = new MemoryMedia(), speech = new SyntheticSpeech("short");
  assert.equal((await finish(f, await queue(f), { media, speech }))?.state, "completed");
  const approval = (await pool.query("SELECT id,signature FROM guild_approval_receipts WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 1", [f.session.tenantId])).rows[0];
  assert.match(approval.signature, /^[a-f0-9]{64}$/);
  const paymentId = randomUUID(), resourceId = "SYNTHETIC_MIGRATION_UNDISPATCHED_" + randomUUID();
  await pool.query("INSERT INTO guild_payment_intents(id,tenant_id,commission_id,business_key,kind,approval_id,command,binding) VALUES($1,$2,$3,$4,'synthetic_migration_fixture',$5,$6,$7)",
    [paymentId, f.session.tenantId, f.commissionId, "synthetic-migration:" + paymentId, approval.id, { syntheticFixture: true, dispatched: false }, { syntheticFixture: true, amountMinor: 1234, originalApprovalSignature: approval.signature }]);
  await pool.query("INSERT INTO guild_payment_resources(kind,resource_id,tenant_id,commission_id,operation_id,resource,observed_at) VALUES('synthetic_undispatched',$1,$2,$3,$4,$5,now())", [resourceId, f.session.tenantId, f.commissionId, paymentId, { syntheticFixture: true, providerRequest: false, originalBytes: "Original synthetic payment-history bytes · لا دفع · 決済なし" }]);
  const baseline = await snapshot("baseline016");
  assert.ok(baseline.guild_artifacts!.count >= 3); assert.ok(baseline.guild_media_objects!.count > 0); assert.ok(baseline.guild_speech_runs!.count > 0); assert.ok(baseline.guild_approval_receipts!.count > 0);
  const dumpUrl = new URL(baseUrl); dumpUrl.searchParams.delete("options");
  const dump = spawnSync("/opt/homebrew/bin/pg_dump", ["--format=custom", "--schema", schema, "--file", resolve(target, "baseline016.dump"), dumpUrl.href], { encoding: "utf8", env: { PATH: "/opt/homebrew/bin:/usr/bin:/bin", NODE_ENV: "test" } });
  assert.equal(dump.status, 0, dump.stderr);
  const sequence = [];
  for (const version of [17, 18, 19]) {
    const name = migrations.find(name => Number(name.slice(0, 3)) === version)!; await apply(name);
    const current = await snapshot("after" + version); retained(baseline, current); sequence.push({ version, preservedPriorTables: Object.keys(baseline).length, tables: Object.keys(current).length });
  }
  const final = await snapshot("before-idempotent-reapply");
  for (const name of migrations) await apply(name);
  retained(final, await snapshot("after-idempotent-reapply"));
  assert.deepEqual((await pool.query("SELECT version FROM guild_schema_migrations ORDER BY version")).rows.map(row => row.version), Array.from({ length: 19 }, (_, index) => index + 1));
  const result = { version: "guild.web-composition-migration-check.v1", schema, restrictedRole: role, sequence, retainedDumpSha256: sha(await readFile(resolve(target, "baseline016.dump"))),
    historicalArtifactsPreserved: true, signedApprovalAndSpeechReceiptsPreserved: true, syntheticPaymentBytesPreserved: true, idempotentReapplicationPreserved: true,
    providerCalls: 0, financialDispatch: false, publicationByteUpgrade: "Separate required check: scripts/check-composed-publication-upgrade.ts against retained synthetic publications created through production policy." };
  await writeFile(resolve(target, "result.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(result));
} finally { await pool.end(); await setup.end(); }
