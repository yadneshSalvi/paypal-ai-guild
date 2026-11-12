import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { MemoryMedia } from "./narration-fixture";
import { syntheticPublicationFixtureRecord } from "./load-publication-fixture";

const recordSchema = syntheticPublicationFixtureRecord.omit({ version: true, cookieName: true, counts: true }).extend({
  version: z.literal("guild.synthetic-composed-web-fixture.v1"), cookieName: z.literal("guild_composed_web_v1"), producingJob: z.string().uuid(), independentJob: z.string().uuid(),
  counts: z.object({ modelCreates: z.literal(2), modelReads: z.literal(2), auditCalls: z.literal(54), producerReports: z.literal(36), independentReports: z.literal(18), narrationTracks: z.literal(78), captionTracks: z.literal(78), imageCreates: z.literal(12) }),
}).strict();

export async function loadComposedFixture(path: string, purpose: "http" | "native") {
  const fixture = recordSchema.parse(JSON.parse(await readFile(path, "utf8"))), url = new URL(fixture.databaseUrl);
  assert.ok(fixture.label.startsWith(purpose + "-")); assert.equal(url.hostname, "localhost"); assert.equal(url.port, "55561");
  assert.equal(url.username, "guild_composed_app"); assert.equal(url.pathname, "/guild_composed_web_tests");
  assert.match(url.searchParams.get("options") ?? "", /^-c search_path=guild_composition_fixture_[a-f0-9]{32}$/);
  assert.ok(isAbsolute(url.searchParams.get("host") ?? "")); assert.match(basename(url.searchParams.get("host") ?? ""), /^guild-composed-pg-[a-z0-9_]+$/);
  assert.equal(fixture.session.tenantId, fixture.originalSession.tenantId); assert.equal(fixture.session.role, "owner");
  const media = new MemoryMedia();
  for (const item of fixture.media) {
    assert.equal(item.file, createHash("sha256").update(item.pathname).digest("hex") + ".bin");
    const bytes = await readFile(resolve(dirname(path), "media", item.file));
    assert.equal(bytes.length, item.bytes); assert.equal(createHash("sha256").update(bytes).digest("hex"), item.hash);
    assert.ok(!media.files.has(item.pathname)); media.files.set(item.pathname, { pathname: item.pathname, bytes, mediaType: item.mediaType, etag: item.etag });
  }
  process.env.DATABASE_URL = fixture.databaseUrl; process.env.AUTH_SECRET = fixture.authSecret; process.env.JUDGE_SESSION_SECRET = fixture.sessionSecret; process.env.GUILD_SESSION_COOKIE = fixture.cookieName;
  process.env.OPENAI_API_KEY = ""; process.env.GEMINI_API_KEY = ""; process.env.DEEPGRAM_API_KEY = ""; process.env.BLOB_READ_WRITE_TOKEN = "";
  return { ...fixture, fixturePath: resolve(path), media, owner: fixture.session };
}
