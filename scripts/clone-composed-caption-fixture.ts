import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import { loadComposedCaptionFixture } from "../tests/support/load-composed-caption-fixture";

// Copy a completed fixture, never regenerate its sources or replace its fixed
// identities/deadlines. Destructive HTTP qualification uses this independent
// schema and independent media files; native review retains its original schema.
const sourceFile = resolve(process.argv[2] ?? "missing-native-fixture"), target = resolve(process.argv[3] ?? "missing-new-http-directory"), label = process.argv[4] ?? "";
assert.match(label, /^http-[a-z0-9-]{1,40}$/);
const f = await loadComposedCaptionFixture(sourceFile, "native"), sourceUrl = new URL(f.databaseUrl), sourceSchema = sourceUrl.searchParams.get("options")!.replace("-c search_path=", "");
const sourceReadonly = new URL(sourceUrl); sourceReadonly.searchParams.set("options", `-c search_path=${sourceSchema} -c default_transaction_read_only=on`);
const base = new URL(sourceUrl); base.searchParams.delete("options");
const copiedSchema = "guild_caption_web_fixture_" + randomUUID().replaceAll("-", ""), copiedUrl = new URL(base); copiedUrl.searchParams.set("options", `-c search_path=${copiedSchema}`);
const source = new Pool({ connectionString: sourceReadonly.href, max: 1 }); let copy: Pool | undefined, original: PoolClient | undefined;
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
type TableSnapshot = { table: string; rows: number; sha256: string }[];
async function snapshot(db: Pool | PoolClient, schema: string): Promise<TableSnapshot> {
  assert.match(schema, /^guild_caption_web_fixture_[a-f0-9]{32}$/);
  const names = (await db.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename", [schema])).rows, result = [];
  for (const { tablename } of names) {
    assert.match(tablename, /^[a-z][a-z_0-9]+$/);
    const rows = (await db.query<{ hash: string }>(`SELECT encode(sha256(convert_to(row_to_json(t)::text,'UTF8')),'hex') AS hash FROM "${schema}"."${tablename}" t ORDER BY hash`)).rows;
    result.push({ table: tablename, rows: rows.length, sha256: sha(rows.map(row => row.hash).join("\n")) });
  }
  return result;
}
const privateWrite = (name: string, value: string | Buffer) => writeFile(resolve(target, name), value, { mode: 0o600, flag: "wx" });
await mkdir(target, { mode: 0o700, recursive: false });
await privateWrite("attempt.json", JSON.stringify({ version: "guild.synthetic-caption-fixture-clone-attempt.v1", label, sourceSchema, copiedSchema, startedAt: new Date().toISOString(), providerCalls: 0, sourceWrites: 0 }) + "\n");
try {
  original = await source.connect(); await original.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.equal((await original.query("SHOW transaction_read_only")).rows[0].transaction_read_only, "on");
  const before = await snapshot(original, sourceSchema); assert.equal(before.length, 60);
  const token = (await original.query<{ snapshot: string }>("SELECT pg_export_snapshot() AS snapshot")).rows[0]!.snapshot;
  const dump = spawnSync("/opt/homebrew/bin/pg_dump", ["--format=plain", "--no-owner", "--no-privileges", "--schema", sourceSchema, "--snapshot", token, "--dbname", base.href],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { PATH: "/opt/homebrew/bin:/usr/bin:/bin", NODE_ENV: "test", PGOPTIONS: "-c default_transaction_read_only=on" } });
  assert.equal(dump.status, 0, dump.stderr); await privateWrite("original-native.sql", dump.stdout);
  await original.query("COMMIT"); original.release(); original = undefined;
  const sql = dump.stdout.replaceAll(sourceSchema, copiedSchema); await privateWrite("copied-http.sql", sql);
  const restored = spawnSync("/opt/homebrew/bin/psql", ["--no-psqlrc", "--set", "ON_ERROR_STOP=1", "--dbname", base.href],
    { input: sql, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env: { PATH: "/opt/homebrew/bin:/usr/bin:/bin", NODE_ENV: "test" } });
  await privateWrite("restore.log", restored.stdout + restored.stderr); assert.equal(restored.status, 0, "Inspect the retained independent HTTP restore failure.");
  copy = new Pool({ connectionString: copiedUrl.href, max: 1 });
  assert.deepEqual((await copy.query("SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0], { rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false });
  const after = await snapshot(copy, copiedSchema); assert.deepEqual(after, before);
  await mkdir(resolve(target, "media"), { mode: 0o700 });
  const originalRecord = JSON.parse(await readFile(sourceFile, "utf8")), record = { ...originalRecord, label, databaseUrl: copiedUrl.href };
  for (const item of record.media) {
    const bytes = await readFile(resolve(dirname(sourceFile), "media", item.file)); assert.equal(sha(bytes), item.hash);
    await privateWrite("media/" + item.file, bytes);
  }
  await privateWrite("qa-actors.json", await readFile(resolve(dirname(sourceFile), "qa-actors.json")));
  await privateWrite("fixture.json", JSON.stringify(record, null, 2) + "\n");
  const sourceAfter = await snapshot(source, sourceSchema); assert.deepEqual(sourceAfter, before);
  await privateWrite("native-before-and-after.json", JSON.stringify({ schema: sourceSchema, tables: before, sha256: sha(JSON.stringify(before)), unchanged: true }, null, 2) + "\n");
  await privateWrite("http-clone-baseline.json", JSON.stringify({ schema: copiedSchema, tables: after, sha256: sha(JSON.stringify(after)) }, null, 2) + "\n");
  const result = { version: "guild.synthetic-caption-fixture-clone.v1", sourceSchema, copiedSchema, tables: before.length, identicalTableHash: sha(JSON.stringify(before)),
    sourceFixtureSha256: sha(await readFile(sourceFile)), copiedFixtureSha256: sha(await readFile(resolve(target, "fixture.json"))), originalDumpSha256: sha(dump.stdout), copiedDumpSha256: sha(sql),
    originalIdentitiesAndDeadlinesPreserved: true, sourceWrites: 0, providerCalls: 0, newDeclarations: 0, independentMediaFiles: record.media.length, disclosure: f.disclosure };
  await privateWrite("result.json", JSON.stringify(result, null, 2) + "\n"); console.log(JSON.stringify(result));
} finally { if (original) { await original.query("ROLLBACK"); original.release(); } await source.end(); await copy?.end(); }
