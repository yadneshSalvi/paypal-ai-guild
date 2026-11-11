import { readFile, readdir } from "node:fs/promises";
import { PostgresDatabase, SqlPaymentStore } from "@fracture/paypal-core";
import { getPool } from "../src/server/db";
try { process.loadEnvFile(".env"); } catch { /* Hosting supplies environment directly. */ }
const db = getPool();
for (const name of (await readdir(new URL("../migrations/", import.meta.url))).filter(n=>n.endsWith(".sql")).sort()) {
  await db.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
}
const coreDb = new PostgresDatabase(process.env.DATABASE_URL!);
await new SqlPaymentStore(coreDb).initialize();
await coreDb.close();
await db.end();
console.log("Guild schema and payment operation tables migrated.");
