import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { Pool } from "pg";

const label = process.argv[2] ?? "", target = resolve(process.argv[3] ?? "missing-private-fixture-directory"), url = new URL(process.env.DATABASE_URL!);
assert.match(label, /^(native|http)-[a-z0-9-]{1,40}$/); assert.equal(url.username, "guild_composed_app"); assert.equal(url.port, "55561");
assert.equal(url.pathname, "/guild_composed_web_tests"); assert.ok(isAbsolute(url.searchParams.get("host") ?? "")); assert.match(basename(url.searchParams.get("host") ?? ""), /^guild-composed-pg-[a-z0-9_]+$/);
assert.ok(!url.searchParams.has("options"));
await mkdir(target, { recursive: false, mode: 0o700 });
const schema = "guild_composition_fixture_" + randomUUID().replaceAll("-", ""), setup = new Pool({ connectionString: url.href, max: 1 });
await setup.query(`CREATE SCHEMA "${schema}"`); url.searchParams.set("options", `-c search_path=${schema}`); process.env.DATABASE_URL = url.href;
const { getPool } = await import("../src/server/db"), pool = getPool();
try {
  for (const file of (await readdir(new URL("../migrations/", import.meta.url))).filter(name => name.endsWith(".sql")).sort()) await pool.query(await readFile(new URL("../migrations/" + file, import.meta.url), "utf8"));
  const { composedWebFixture } = await import("../tests/support/composed-web-fixture"), f = await composedWebFixture(label, message => console.log(new Date().toISOString(), message));
  await mkdir(resolve(target, "media"), { mode: 0o700 }); const media = [];
  for (const [pathname, file] of f.media.files) {
    const name = createHash("sha256").update(pathname).digest("hex") + ".bin";
    await writeFile(resolve(target, "media", name), file.bytes, { mode: 0o600 });
    media.push({ pathname, file: name, mediaType: file.mediaType, etag: file.etag, bytes: file.bytes.length, hash: createHash("sha256").update(file.bytes).digest("hex") });
  }
  const { syntheticPublicationActor } = await import("../tests/support/web-publication-fixture");
  const actors = { operator: await syntheticPublicationActor(f.owner.tenantId, "operator"), provider: await syntheticPublicationActor(f.owner.tenantId, "provider"),
    judge: await syntheticPublicationActor(f.owner.tenantId, "judge"), revoked: await syntheticPublicationActor(f.owner.tenantId), expired: await syntheticPublicationActor(f.owner.tenantId) };
  await pool.query("UPDATE guild_sessions SET revoked_at=now() WHERE id=$1", [actors.revoked.session.id]);
  await pool.query("UPDATE guild_sessions SET expires_at=now()-interval '1 second' WHERE id=$1", [actors.expired.session.id]);
  const foreignTenant = randomUUID(); await pool.query("INSERT INTO guild_tenants(id,expires_at,mode) VALUES($1,now()+interval '8 hours','judge')", [foreignTenant]);
  const foreign = await syntheticPublicationActor(foreignTenant);
  const record = { version: "guild.synthetic-composed-web-fixture.v1", label, disclosure: f.disclosure, createdAt: new Date().toISOString(), databaseUrl: process.env.DATABASE_URL,
    authSecret: process.env.AUTH_SECRET, sessionSecret: process.env.JUDGE_SESSION_SECRET, cookieName: "guild_composed_web_v1", cookie: f.cookie,
    session: f.owner, originalSession: f.originalSession, commissionId: f.commissionId, artifactId: f.artifactId, selectedOrdinal: f.selectedOrdinal, acceptedIds: f.acceptedIds,
    producingJob: f.producingJob, independentJob: f.independentJob, counts: f.counts, media };
  await writeFile(resolve(target, "fixture.json"), JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  await writeFile(resolve(target, "qa-actors.json"), JSON.stringify({ version: "guild.synthetic-composed-web-actors.v1", disclosure: f.disclosure, cookieName: record.cookieName, actors: { ...actors, foreign } }, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ fixture: resolve(target, "fixture.json"), schema, commissionId: f.commissionId, artifactId: f.artifactId, mediaFiles: media.length, counts: f.counts, disclosure: f.disclosure }));
} finally { await pool.end(); await setup.end(); }
