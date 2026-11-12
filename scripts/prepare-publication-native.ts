import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadPublicationFixture } from "../tests/support/load-publication-fixture";
import { syntheticPublicationActor } from "../tests/support/web-publication-fixture";
import { publicationFixtureSnapshot } from "../tests/support/publication-snapshot";

const f = await loadPublicationFixture(process.argv[2] ?? "missing-fixture", "native"), directory = dirname(f.fixturePath), actorsPath = resolve(directory, "qa-actors.json");
await assert.rejects(access(actorsPath), "The private native actors already exist; reuse them without extending expiry.");
const { getPool } = await import("../src/server/db"), pool = getPool();
try {
  const actors = { operator: await syntheticPublicationActor(f.owner.tenantId, "operator"), provider: await syntheticPublicationActor(f.owner.tenantId, "provider"),
    judge: await syntheticPublicationActor(f.owner.tenantId, "judge"), revoked: await syntheticPublicationActor(f.owner.tenantId, "owner"), expired: await syntheticPublicationActor(f.owner.tenantId, "owner") };
  await pool.query("UPDATE guild_sessions SET revoked_at=now() WHERE id=$1", [actors.revoked.session.id]);
  await pool.query("UPDATE guild_sessions SET expires_at=now()-interval '1 second' WHERE id=$1", [actors.expired.session.id]);
  const foreignTenant = randomUUID(); await pool.query("INSERT INTO guild_tenants(id,expires_at,mode) VALUES($1,now()+interval '2 hours','judge')", [foreignTenant]);
  const foreign = await syntheticPublicationActor(foreignTenant);
  await writeFile(actorsPath, JSON.stringify({ version: "guild.synthetic-publication-native-identities.v1", disclosure: f.disclosure, cookieName: f.cookieName, createdAt: new Date().toISOString(), actors: { ...actors, foreign } }, null, 2) + "\n", { mode: 0o600 });
  const snapshot = await publicationFixtureSnapshot(), snapshotPath = resolve(directory, "database-before-native.json");
  await writeFile(snapshotPath, JSON.stringify(snapshot, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ actorsPath, snapshotPath, snapshotHash: snapshot.sha256, publicationEditions: snapshot.tables.find(table => table.table === "guild_web_publication_editions")!.rows, acceptanceDecisions: snapshot.tables.find(table => table.table === "guild_acceptance_decisions")!.rows, disclosure: f.disclosure }));
} finally { await pool.end(); }
