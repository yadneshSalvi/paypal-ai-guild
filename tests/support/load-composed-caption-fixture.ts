import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { MemoryMedia } from "./narration-fixture";
import { syntheticPublicationFixtureRecord } from "./load-publication-fixture";
import { syntheticCaptionReviewDisclosure } from "./synthetic-caption-review";

const uuid = z.string().uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/);
const captionReview = z.object({
  owner: syntheticPublicationFixtureRecord.shape.session, cookie: z.string().min(32), originalArtifactId: uuid, originalArtifactHash: hash,
  correctedArtifactId: uuid, correctedArtifactHash: hash, originalJob: uuid, originalVerificationJob: uuid, correctionJob: uuid, verificationJob: uuid,
  authorityExpiresAt: z.string().datetime(), earlierDraftIds: z.array(uuid).length(156),
  declarations: z.array(z.object({ id: uuid, digest: hash, locale: z.enum(["en","pt","es","fr","ja","ar"]), key: z.string().min(1) }).strict()).length(78),
  acceptedIds: z.array(uuid).length(5), counts: z.object({ recognitionCalls: z.literal(78), easyReadCalls: z.literal(6), correctionRecognitionCalls: z.literal(0), correctionModelCalls: z.literal(0),
    syntheticListeningStatements: z.literal(78), earlierDrafts: z.literal(156), originalAutomaticReady: z.number().int().nonnegative(), originalWithheld: z.number().int().nonnegative() }).strict(),
  disclosure: z.literal(syntheticCaptionReviewDisclosure), publicationDisclosure: syntheticPublicationFixtureRecord.shape.disclosure,
}).strict();
export const composedCaptionFixtureRecord = syntheticPublicationFixtureRecord.omit({ version:true,cookieName:true,counts:true,disclosure:true }).extend({
  version: z.literal("guild.synthetic-composed-caption-web-fixture.v1"), cookieName: z.literal("guild_composed_caption_web_v1"), disclosure: z.literal(syntheticCaptionReviewDisclosure), captionReview,
  producingJob: uuid, independentJob: uuid,
  counts: z.object({ modelCreates:z.literal(2),modelReads:z.literal(2),auditCalls:z.literal(54),producerReports:z.literal(36),independentReports:z.literal(18),narrationTracks:z.literal(78),captionTracks:z.literal(78),imageCreates:z.literal(12) }).strict(),
}).strict();

export async function loadComposedCaptionFixture(path: string, purpose: "http" | "native") {
  const fixture = composedCaptionFixtureRecord.parse(JSON.parse(await readFile(path,"utf8"))), url = new URL(fixture.databaseUrl);
  assert.ok(fixture.label.startsWith(purpose+"-")); assert.equal(url.hostname,"localhost"); assert.equal(url.port,"55562"); assert.equal(url.username,"guild_caption_web_app"); assert.equal(url.pathname,"/guild_caption_web_tests");
  assert.match(url.searchParams.get("options")??"",/^-c search_path=guild_caption_web_fixture_[a-f0-9]{32}$/);
  assert.ok(isAbsolute(url.searchParams.get("host")??"")); assert.match(basename(url.searchParams.get("host")??""),/^guild-caption-web-pg-[a-z0-9_]+$/);
  assert.equal(fixture.session.tenantId,fixture.originalSession.tenantId); assert.equal(fixture.session.role,"owner"); assert.equal(fixture.captionReview.owner.id,fixture.session.id);
  const media = new MemoryMedia();
  for (const item of fixture.media) {
    assert.equal(item.file,createHash("sha256").update(item.pathname).digest("hex")+".bin");
    const bytes = await readFile(resolve(dirname(path),"media",item.file)); assert.equal(bytes.length,item.bytes); assert.equal(createHash("sha256").update(bytes).digest("hex"),item.hash);
    assert.ok(!media.files.has(item.pathname)); media.files.set(item.pathname,{pathname:item.pathname,bytes,mediaType:item.mediaType,etag:item.etag});
  }
  process.env.DATABASE_URL=fixture.databaseUrl; process.env.AUTH_SECRET=fixture.authSecret; process.env.JUDGE_SESSION_SECRET=fixture.sessionSecret; process.env.GUILD_SESSION_COOKIE=fixture.cookieName;
  for (const key of ["OPENAI_API_KEY","GEMINI_API_KEY","DEEPGRAM_API_KEY","BLOB_READ_WRITE_TOKEN"]) process.env[key]="";
  process.env.GUILD_ENABLE_DEEPGRAM_REVIEW="false";
  return {...fixture,fixturePath:resolve(path),media,owner:fixture.session};
}
