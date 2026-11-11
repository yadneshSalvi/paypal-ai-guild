import { Pool, type PoolClient } from "pg";

const runtime = globalThis as unknown as { guildPool?: Pool };
export function getPool(): Pool {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required. Run npm run db:migrate after configuring the environment.");
  return runtime.guildPool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 6, idleTimeoutMillis: 10000, connectionTimeoutMillis: 5000 });
}
export async function transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try { await client.query("BEGIN"); const result = await run(client); await client.query("COMMIT"); return result; }
  catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
