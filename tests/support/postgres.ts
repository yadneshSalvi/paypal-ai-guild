import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";

export async function isolatedPostgres(prefix: string): Promise<() => Promise<void>> {
  try { process.loadEnvFile(".env"); } catch { /* CI supplies its own isolated database. */ }
  const originalUrl = process.env.DATABASE_URL;
  if (!originalUrl) throw new Error("A dedicated PostgreSQL database is required for integration tests.");
  if (!/^[a-z_]+$/.test(prefix)) throw new Error("Invalid integration-test schema prefix.");
  const schema = `${prefix}_${randomUUID().replaceAll("-", "")}`, admin = new Pool({ connectionString: originalUrl, max: 1 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(originalUrl); url.searchParams.set("options", `${url.searchParams.get("options") ?? ""} -c search_path=${schema}`.trim());
  process.env.DATABASE_URL = url.toString();
  process.env.AUTH_SECRET = "fixture-approval-secret-only-in-disposable-schema";
  process.env.JUDGE_SESSION_SECRET = "fixture-session-secret-only-in-disposable-schema";
  process.env.OPENAI_API_KEY = "";
  const { getPool } = await import("../../src/server/db");
  for (const file of (await readdir(new URL("../../migrations/", import.meta.url))).filter(name => name.endsWith(".sql")).sort()) await getPool().query(await readFile(new URL(`../../migrations/${file}`, import.meta.url), "utf8"));
  return async () => { await getPool().end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); };
}
