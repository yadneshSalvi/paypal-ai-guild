import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isolatedPostgres } from "../tests/support/postgres";

const url = new URL(process.env.DATABASE_URL ?? "http://invalid");
if (url.hostname !== "127.0.0.1" || url.port !== "55496" || url.pathname !== "/guild_web_tests" || url.username !== "guild_web_fixture") throw Error("This fixture requires the restricted independent PostgreSQL harness on loopback55496.");
const label = process.argv[2];
if (!label || !/^(native|http)-[a-z0-9-]{1,40}$/.test(label)) throw Error("Choose a separate native-* or http-* synthetic fixture name.");
const target = resolve("../web-publication-checks-v1", label);
await mkdir(target, { recursive: false, mode: 0o700 });
await isolatedPostgres("guild_publication_fixture"); // Deliberately retained for native/HTTP QA; cleanup is an explicit separate command.
process.env.AUTH_SECRET = randomBytes(32).toString("hex");
process.env.JUDGE_SESSION_SECRET = randomBytes(32).toString("hex");
const { publicationFixture } = await import("../tests/support/web-publication-fixture");
const f = await publicationFixture(label, message => console.log(new Date().toISOString(), message));
await mkdir(resolve(target, "media"), { mode: 0o700 });
const media = [];
for (const [pathname, file] of f.media.files) {
  const name = createHash("sha256").update(pathname).digest("hex") + ".bin";
  await writeFile(resolve(target, "media", name), file.bytes, { mode: 0o600 });
  media.push({ pathname, file: name, mediaType: file.mediaType, etag: file.etag, bytes: file.bytes.length, hash: createHash("sha256").update(file.bytes).digest("hex") });
}
const record = { version: "guild.synthetic-publication-fixture.v1", label, disclosure: f.disclosure, createdAt: new Date().toISOString(),
  databaseUrl: process.env.DATABASE_URL, authSecret: process.env.AUTH_SECRET, sessionSecret: process.env.JUDGE_SESSION_SECRET, cookieName: "guild_publication_v1", cookie: f.cookie,
  session: f.owner, originalSession: f.session, commissionId: f.commissionId, artifactId: f.artifactId, selectedOrdinal: f.selectedOrdinal, acceptedIds: f.acceptedIds, counts: f.counts, media };
await writeFile(resolve(target, "fixture.json"), JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ fixture: resolve(target, "fixture.json"), commissionId: f.commissionId, artifactId: f.artifactId, mediaFiles: media.length, counts: f.counts, disclosure: f.disclosure }));
const { getPool } = await import("../src/server/db"); await getPool().end();
