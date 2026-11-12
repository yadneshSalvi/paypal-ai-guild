import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { MemoryMedia } from "./narration-fixture";
import { syntheticPublicationDisclosure } from "./web-publication-fixture";

const actor = z.object({ id: z.string().uuid(), tenantId: z.string().uuid(), role: z.enum(["owner", "judge", "operator", "provider"]), expiresAt: z.string().datetime() });
export const syntheticPublicationFixtureRecord = z.object({
  version: z.literal("guild.synthetic-publication-fixture.v1"), label: z.string().regex(/^(http|native)-[a-z0-9-]{1,40}$/),
  disclosure: z.literal(syntheticPublicationDisclosure), createdAt: z.string().datetime(), databaseUrl: z.string().url(),
  authSecret: z.string().min(32), sessionSecret: z.string().min(32), cookieName: z.literal("guild_publication_v1"), cookie: z.string().min(32),
  session: actor, originalSession: actor, commissionId: z.string().uuid(), artifactId: z.string().uuid(), selectedOrdinal: z.number().int().min(1).max(3),
  acceptedIds: z.array(z.string().uuid()).length(6), counts: z.object({ modelCreates: z.literal(1), modelReads: z.literal(1), auditCalls: z.literal(18), narrationTracks: z.literal(78), captionTracks: z.literal(78), imageCreates: z.number().int() }),
  media: z.array(z.object({ pathname: z.string().min(1), file: z.string().regex(/^[a-f0-9]{64}\.bin$/), mediaType: z.string().min(1), etag: z.string(), bytes: z.number().int().positive(), hash: z.string().regex(/^[a-f0-9]{64}$/) })),
}).strict();

/** A retained synthetic fixture is never selected implicitly and never points at
 * a normal application database. Native and destructive HTTP QA stay separate. */
export async function loadPublicationFixture(path: string, purpose: "http" | "native") {
  const record = syntheticPublicationFixtureRecord.parse(JSON.parse(await readFile(path, "utf8")));
  assert.ok(record.label.startsWith(purpose + "-"), "Use the independent fixture for this QA purpose.");
  const url = new URL(record.databaseUrl), options = url.searchParams.get("options") ?? "";
  assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.port, "55496"); assert.equal(url.username, "guild_web_fixture"); assert.equal(url.pathname, "/guild_web_tests");
  assert.match(options, /^-c search_path=guild_publication_fixture_[a-f0-9]{32}$/);
  assert.equal(record.session.role, "owner"); assert.equal(record.session.tenantId, record.originalSession.tenantId);
  const media = new MemoryMedia();
  for (const item of record.media) {
    assert.equal(item.file, createHash("sha256").update(item.pathname).digest("hex") + ".bin");
    const bytes = await readFile(resolve(dirname(path), "media", item.file));
    assert.equal(bytes.length, item.bytes); assert.equal(createHash("sha256").update(bytes).digest("hex"), item.hash);
    assert.ok(!media.files.has(item.pathname)); media.files.set(item.pathname, { pathname: item.pathname, bytes, mediaType: item.mediaType, etag: item.etag });
  }
  process.env.DATABASE_URL = record.databaseUrl; process.env.AUTH_SECRET = record.authSecret; process.env.JUDGE_SESSION_SECRET = record.sessionSecret; process.env.GUILD_SESSION_COOKIE = record.cookieName;
  process.env.OPENAI_API_KEY = ""; process.env.DEEPGRAM_API_KEY = ""; process.env.BLOB_READ_WRITE_TOKEN = "";
  return { ...record, fixturePath: resolve(path), media, owner: record.session };
}
