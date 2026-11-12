import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { getPool } from "@/server/db";

/** Hashes only the caller's explicit restricted fixture schema. Secret values,
 * bytea evidence and original row contents never leave the database. */
export async function publicationFixtureSnapshot() {
  const db = await getPool().connect();
  try {
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const schema = (await db.query<{ schema: string }>("SELECT current_schema() AS schema")).rows[0]!.schema;
    assert.match(schema, /^guild_publication_fixture_[a-f0-9]{32}$/);
    const tables = (await db.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename")).rows, records = [];
    for (const { tablename } of tables) {
      assert.match(tablename, /^guild_[a-z_]+$/);
      const rows = (await db.query<{ hash: string }>(`SELECT encode(sha256(convert_to(row_to_json(t)::text,'UTF8')),'hex') AS hash FROM "${schema}"."${tablename}" t ORDER BY hash`)).rows;
      records.push({ table: tablename, rows: rows.length, sha256: createHash("sha256").update(rows.map(row => row.hash).join("\n")).digest("hex") });
    }
    await db.query("COMMIT");
    return { version: "guild.synthetic-publication-database-snapshot.v1", at: new Date().toISOString(), schema, tables: records,
      sha256: createHash("sha256").update(JSON.stringify(records)).digest("hex"), disclosure: "Only a separate synthetic publication fixture schema; row hashes are observations, not actual human review or production authority." };
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
}
