import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadComposedFixture } from "../tests/support/load-composed-fixture";
import { composedFixtureSnapshot } from "../tests/support/composed-snapshot";

const purpose = process.argv[3]; assert.ok(purpose === "native" || purpose === "http");
await loadComposedFixture(process.argv[2] ?? "missing-fixture", purpose);
const target = resolve(process.argv[4] ?? "missing-snapshot-output"), { getPool } = await import("../src/server/db");
try {
  const snapshot = await composedFixtureSnapshot(); await writeFile(target, JSON.stringify(snapshot, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ target, tables: snapshot.tables.length, sha256: snapshot.sha256 }));
} finally { await getPool().end(); }
