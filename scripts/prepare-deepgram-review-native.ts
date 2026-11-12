/** Local, synthetic native-UI fixture. No actual provider calls, human review,
 * acceptance or payment. Refuses non-loopback or unnamed fixture databases. */
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";

const supplied = process.env.GUILD_NATIVE_FIXTURE_DATABASE_URL;
if (!supplied) throw new Error("Explicit GUILD_NATIVE_FIXTURE_DATABASE_URL for the separate local fixture database is required.");
const database = new URL(supplied);
if (!["127.0.0.1", "localhost"].includes(database.hostname) || database.pathname !== "/guild_deepgram_review_test") throw new Error("Use only the independently created loopback guild_deepgram_review_test database.");
process.env.DATABASE_URL = supplied;
for (const key of ["OPENAI_API_KEY", "GEMINI_API_KEY", "DEEPGRAM_API_KEY", "BLOB_READ_WRITE_TOKEN", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"]) process.env[key] = "";
globalThis.fetch = async () => { throw new Error("External network is disabled in the synthetic native fixture."); };
const { isolatedPostgres } = await import("../tests/support/postgres");
await isolatedPostgres("guild_caption_native"); // Retained for root's explicit native QA; cleanup is recorded in the private manifest.
const { captionFixture, queueCaptions, syntheticEasyReadModel } = await import("../tests/support/caption-fixture");
const { amendDeepgramCaptions, ControlledDeepgram, finishDeepgram, syntheticMeasuredDraft } = await import("../tests/support/deepgram-caption-fixture");
const { getPool, transaction } = await import("../src/server/db");
const { getCommission, saveCommission } = await import("../src/server/commissions");
const { deepgramCaptionArtifactSchema } = await import("../src/domain/deepgram-captions");
const { captionReviewWorkspace, saveCaptionReview } = await import("../src/server/captions/review");
const { digest } = await import("../src/domain/primitives");
const count = process.env.GUILD_NATIVE_FIXTURE_RECORDINGS === "12" ? 1 : 12;
console.log(`Preparing ${count === 12 ? 78 : 12} synthetic recordings in a new disposable schema. No provider endpoint is reachable.`);
const f = await captionFixture(count), model = syntheticEasyReadModel(), gateway = new ControlledDeepgram("disagreements");
process.env.GUILD_ENABLE_DEEPGRAM_REVIEW = "true"; process.env.DEEPGRAM_API_KEY = "controlled-native-fixture-not-a-provider-key";
await amendDeepgramCaptions(f);
const job = await queueCaptions(f);
assert.equal((await finishDeepgram(f, job, gateway))?.state, "completed");
console.log("Synthetic original observations retained. Rechecking original file and VTT bytes.");
assert.equal((await finishDeepgram(f, await queueCaptions(f, "verify_artifact"), gateway))?.state, "completed");
const c = await getCommission(f.session, f.commissionId), pkg = c.packages.find(item => item.kind === "captions")!, artifact = c.artifacts.find(item => item.id === pkg.artifactIds.at(-1))!, content = deepgramCaptionArtifactSchema.parse(artifact.content);
const operator = { ...f.session, id: randomUUID(), role: "operator" as const };
await getPool().query("INSERT INTO guild_sessions(id,tenant_id,token_hash,role,expires_at) VALUES($1,$2,$3,'operator',$4)", [operator.id, operator.tenantId, digest(operator.id), operator.expiresAt]);
const first = content.sources.tracks.find(item => item.locale === "en")!, workspace = await captionReviewWorkspace(operator, artifact.id, first.locale, first.key);
await saveCaptionReview(operator, artifact.id, { action: "save", requestId: randomUUID(), parentRevisionId: null, artifactHash: artifact.contentHash, locale: first.locale, key: first.key, draft: syntheticMeasuredDraft(first, workspace.initialUnits) });
const current = await getCommission(f.session, f.commissionId);
current.title = "Synthetic offline caption review — no real speech or human review";
const disclosure = "SYNTHETIC NATIVE UI FIXTURE. The recordings are generated tones, recognition and model responses are controlled test data, and measured draft timings are synthetic. No listening declaration, human or fluent review, actual provider output, acceptance, or payment is represented.";
await transaction(async db => { current.revision++; await saveCommission(db, current); });
// A separate fixture UI session leaves the original approval actor unchanged.
const token = randomBytes(32).toString("base64url"), uiSession = randomUUID();
await getPool().query("INSERT INTO guild_sessions(id,tenant_id,token_hash,role,expires_at) VALUES($1,$2,$3,'judge',$4)", [uiSession, f.session.tenantId, createHash("sha256").update(token).digest("hex"), f.session.expiresAt]);
const cookie = `${token}.${createHmac("sha256", process.env.JUDGE_SESSION_SECRET!).update(token).digest("hex")}`;
const folder = resolve(".local/native-caption-review"), mediaFolder = resolve(folder, "media");
await mkdir(mediaFolder, { recursive: true, mode: 0o700 });
const files = [];
for (const [pathname, value] of f.media.files) {
  const filename = createHash("sha256").update(pathname).digest("hex") + (value.mediaType === "text/vtt" ? ".vtt" : ".mp3");
  await writeFile(resolve(mediaFolder, filename), value.bytes, { mode: 0o600 });
  files.push({ pathname, filename, mediaType: value.mediaType, etag: value.etag, byteLength: value.bytes.length });
}
const counts = { sourceRecordings: content.sources.tracks.length, controlledDeepgramRequests: gateway.calls, controlledEasyReadResponses: model.count(), reviewDrafts: 1, listeningDeclarations: 0, realProviderRequests: 0 };
await writeFile(resolve(folder, "fixture.private.json"), JSON.stringify({ schemaVersion: "guild.synthetic-caption-native-fixture.v1", disclosure, databaseUrl: process.env.DATABASE_URL,
  authSecret: process.env.AUTH_SECRET, sessionSecret: process.env.JUDGE_SESSION_SECRET, cookie, commissionId: f.commissionId, tenantId: f.session.tenantId, artifactId: artifact.id,
  artifactHash: artifact.contentHash, sourceDigest: content.sourceDigest, expiresAt: f.session.expiresAt, files, counts,
  cleanup: "Stop the loopback native server, then drop only the guild_caption_native_* schema named in this manifest’s DATABASE_URL search_path. Keep this candidate's isolated cluster separate from every other database." }, null, 2), { mode: 0o600 });
await writeFile(resolve(folder, "summary.json"), JSON.stringify({ disclosure, artifactId: artifact.id, artifactHash: artifact.contentHash, counts, launchPath: "http://localhost:4547/__caption_fixture", createdAt: new Date().toISOString() }, null, 2));
model.restore(); process.env.GUILD_ENABLE_DEEPGRAM_REVIEW = "false"; process.env.DEEPGRAM_API_KEY = "";
await getPool().end();
console.log(JSON.stringify({ fixture: ".local/native-caption-review/fixture.private.json", counts, listeningWarning: "Open and inspect the declaration dialog only. Do not submit a claim of actual listening to synthetic tone recordings." }));
