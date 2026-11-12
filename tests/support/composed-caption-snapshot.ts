import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { getPool } from "@/server/db";

export async function composedCaptionFixtureSnapshot() {
  const db = await getPool().connect();
  try {
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const schema = (await db.query<{ schema: string }>("SELECT current_schema() AS schema")).rows[0]!.schema;
    assert.match(schema, /^guild_caption_web_fixture_[a-f0-9]{32}$/);
    const tables = (await db.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename")).rows, records = [];
    for (const { tablename } of tables) {
      assert.match(tablename, /^[a-z][a-z_0-9]+$/);
      const rows = (await db.query<{ hash: string }>(`SELECT encode(sha256(convert_to(row_to_json(t)::text,'UTF8')),'hex') AS hash FROM "${schema}"."${tablename}" t ORDER BY hash`)).rows;
      records.push({ table: tablename, rows: rows.length, sha256: createHash("sha256").update(rows.map(row => row.hash).join("\n")).digest("hex") });
    }
    await db.query("COMMIT");
    return { version: "guild.synthetic-caption-web-database-snapshot.v1", at: new Date().toISOString(), schema, tables: records,
      sha256: createHash("sha256").update(JSON.stringify(records)).digest("hex"), disclosure: "Only this restricted synthetic composition fixture; row hashes expose no credentials or original row contents." };
  } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
}
