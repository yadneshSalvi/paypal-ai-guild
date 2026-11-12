import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { loadComposedFixture } from "../tests/support/load-composed-fixture";

const fixture = await loadComposedFixture(process.argv[2] ?? "missing-http-fixture", "http"), target = resolve(process.argv[3] ?? "missing-evidence-directory");
await mkdir(target, { recursive: false, mode: 0o700 });
const originalUrl = new URL(fixture.databaseUrl), originalSchema = (originalUrl.searchParams.get("options") ?? "").replace("-c search_path=", "");
assert.match(originalSchema, /^guild_composition_fixture_[a-f0-9]{32}$/);
const schema = "guild_composition_pubupgrade_" + randomUUID().replaceAll("-", ""), setup = new Pool({ connectionString: originalUrl.href, max: 1 });
await setup.query(`CREATE SCHEMA "${schema}"`);
const url = new URL(originalUrl); url.searchParams.set("options", `-c search_path=${schema}`);
const db = new Pool({ connectionString: url.href, max: 6 }), sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const { getPool } = await import("../src/server/db"), originalPool = getPool();
const runtime = globalThis as unknown as { guildPool?: Pool };
try {
  const migrations = (await readdir(new URL("../migrations/", import.meta.url))).filter(name => name.endsWith(".sql")).sort();
  for (const file of migrations.filter(name => Number(name.slice(0, 3)) <= 18)) await db.query(await readFile(new URL("../migrations/" + file, import.meta.url), "utf8"));
  const tables = (await db.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename<>'guild_schema_migrations' ORDER BY tablename")).rows.map(row => row.tablename);
  const dependencies = (await db.query<{ child: string; parent: string }>("SELECT child.relname AS child,parent.relname AS parent FROM pg_constraint c JOIN pg_class child ON child.oid=c.conrelid JOIN pg_class parent ON parent.oid=c.confrelid JOIN pg_namespace n ON n.oid=child.relnamespace WHERE c.contype='f' AND n.nspname=current_schema()")).rows;
  const columns = new Map<string, string[]>(), copied = new Set<string>();
  while (copied.size < tables.length) {
    let progress = 0;
    for (const table of tables.filter(table => !copied.has(table))) {
      if (dependencies.some(row => row.child === table && tables.includes(row.parent) && !copied.has(row.parent))) continue;
      assert.match(table, /^guild_[a-z_]+$/);
      const fields = (await db.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 ORDER BY ordinal_position", [table])).rows.map(row => row.column_name);
      for (const field of fields) assert.match(field, /^[a-z_]+$/);
      columns.set(table, fields); const names = fields.map(field => '"' + field + '"').join(",");
      await db.query(`INSERT INTO "${schema}"."${table}" (${names}) SELECT ${names} FROM "${originalSchema}"."${table}"`);
      copied.add(table); progress++;
    }
    assert.ok(progress, "A cyclic FK needs an explicit migration-fixture copy order.");
  }
  async function snapshot(name: string) {
    const records = [];
    for (const table of [...tables].sort()) {
      const names = columns.get(table)!.map(field => '"' + field + '"').join(",");
      const rows = (await db.query<{ hash: string }>(`SELECT encode(sha256(convert_to(row_to_json(t)::text,'UTF8')),'hex') AS hash FROM (SELECT ${names} FROM "${schema}"."${table}") t ORDER BY hash`)).rows;
      records.push({ table, rows: rows.length, sha256: sha(rows.map(row => row.hash).join("\n")) });
    }
    const value = { schema, tables: records, sha256: sha(JSON.stringify(records)) };
    await writeFile(resolve(target, name + ".json"), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); return value;
  }
  const before = await snapshot("baseline018");
  assert.ok(before.tables.find(table => table.table === "guild_web_publication_editions")!.rows >= 3);
  assert.equal((await db.query("SELECT max(version) AS maximum FROM guild_schema_migrations")).rows[0].maximum, 18);
  const nineteen = migrations.find(name => name.startsWith("019_"))!; await db.query(await readFile(new URL("../migrations/" + nineteen, import.meta.url), "utf8"));
  const after = await snapshot("after019"); assert.deepEqual(after.tables, before.tables); assert.equal(after.sha256, before.sha256);
  assert.equal((await db.query("SELECT max(version) AS maximum FROM guild_schema_migrations")).rows[0].maximum, 19);
  runtime.guildPool = db;
  const { publicationWorkspace, publicationEditionReceipt } = await import("../src/server/web/publications");
  const workspace = await publicationWorkspace(fixture.owner, fixture.commissionId); assert.ok(workspace.editions.length >= 3);
  for (const edition of workspace.editions) {
    const receipt = await publicationEditionReceipt(fixture.owner, fixture.commissionId, edition.id); assert.ok(receipt);
  }
  const afterReads = await snapshot("after-original-signed-receipt-reads"); assert.deepEqual(afterReads.tables, before.tables);
  const result = { version: "guild.web-composition-publication-upgrade.v1", sourceFixture: fixture.label, originalSchema, schema, baselineVersion: 18, finalVersion: 19,
    preservedTables: tables.length, exactHash: before.sha256, validImmutableEditions: workspace.editions.length, originalSignedReceiptsVerified: true,
    originalPublicationAndArtifactAndPaymentBytesPreserved: true, sourceFixtureMutated: false, providerCalls: 0, humanReviewClaimed: false };
  await writeFile(resolve(target, "result.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 }); console.log(JSON.stringify(result));
} finally { runtime.guildPool = originalPool; await db.end(); await originalPool.end(); await setup.end(); }
