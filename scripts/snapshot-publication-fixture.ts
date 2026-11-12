import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadPublicationFixture } from "../tests/support/load-publication-fixture";
import { publicationFixtureSnapshot } from "../tests/support/publication-snapshot";

const purpose = process.argv[3]; assert.ok(purpose === "native" || purpose === "http");
const label = process.argv[4]; assert.ok(label && /^[a-z0-9-]{1,60}$/.test(label));
const f = await loadPublicationFixture(process.argv[2] ?? "missing-fixture", purpose), { getPool } = await import("../src/server/db");
try {
  const snapshot = await publicationFixtureSnapshot(), path = resolve(dirname(f.fixturePath), `database-${label}.json`);
  await writeFile(path, JSON.stringify(snapshot, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ path, sha256: snapshot.sha256, tables: snapshot.tables.length, disclosure: f.disclosure }));
} finally { await getPool().end(); }
