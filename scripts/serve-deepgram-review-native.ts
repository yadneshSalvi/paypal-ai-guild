/** Loopback-only test harness around the actual Next application. Its one media
 * route uses the normal ownership/hash/range checks with retained fixture bytes.
 * It is never a deployed storage adapter or real qualification environment. */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { PrivateBlobGateway } from "../src/server/media/blob-store";

const folder = resolve(".local/native-caption-review");
const fixture = JSON.parse(await readFile(resolve(folder, "fixture.private.json"), "utf8")) as {
  schemaVersion: string; databaseUrl: string; authSecret: string; sessionSecret: string; cookie: string; commissionId: string;
  files: { pathname: string; filename: string; mediaType: string; etag: string; byteLength: number }[];
};
const database = new URL(fixture.databaseUrl);
if (fixture.schemaVersion !== "guild.synthetic-caption-native-fixture.v1" || !["127.0.0.1", "localhost"].includes(database.hostname) || database.pathname !== "/guild_deepgram_review_test" || !database.searchParams.get("options")?.includes("search_path=guild_caption_native_")) throw new Error("This server requires the separate loopback synthetic caption fixture.");
process.env.DATABASE_URL = fixture.databaseUrl; process.env.AUTH_SECRET = fixture.authSecret; process.env.JUDGE_SESSION_SECRET = fixture.sessionSecret;
process.env.APP_URL = "http://localhost:4547"; process.env.GUILD_ENABLE_DEEPGRAM_REVIEW = "false";
for (const key of ["OPENAI_API_KEY", "GEMINI_API_KEY", "DEEPGRAM_API_KEY", "BLOB_READ_WRITE_TOKEN", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"]) process.env[key] = "";
const fetchOriginal = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("External providers are disabled in the synthetic native harness.");
  return fetchOriginal(input, init);
};
const storage: PrivateBlobGateway = {
  async put() { throw new Error("This native fixture serves retained media only."); },
  async read(pathname, maximumBytes) {
    const item = fixture.files.find(file => file.pathname === pathname);
    if (!item) return null;
    if (!/^[a-f0-9]{64}\.(mp3|vtt)$/.test(item.filename) || item.byteLength > maximumBytes) throw new Error("Invalid fixture object identity or size.");
    const path = resolve(folder, "media", item.filename), info = await stat(path);
    if (info.size !== item.byteLength || info.size > maximumBytes) throw new Error("The original fixture object size changed.");
    return { pathname, bytes: await readFile(path), mediaType: item.mediaType, etag: item.etag };
  },
};
const { default: next } = await import("next");
// Prepare Next's Node runtime before importing server modules that use headers.
const app = next({ dev: false, hostname: "127.0.0.1", port: 4547 }); await app.prepare();
const { sessionFromToken } = await import("../src/server/session");
const { readOwnedMedia, privateMediaResponse } = await import("../src/server/media/objects");
const handler = app.getRequestHandler();
const server = createServer(async (request, response) => {
  if (!["localhost:4547", "127.0.0.1:4547"].includes(request.headers.host ?? "")) { response.writeHead(403).end(); return; }
  const url = new URL(request.url ?? "/", "http://localhost:4547");
  if (url.pathname === "/__caption_fixture") {
    response.writeHead(302, { "Location": `/?view=review&package=captions&commission=${fixture.commissionId}`, "Set-Cookie": `guild_session=${fixture.cookie}; Path=/; HttpOnly; SameSite=Strict`, "Cache-Control": "no-store", "X-Guild-Fixture": "Synthetic tones and controlled responses; no human review" }); response.end(); return;
  }
  const mediaId = /^\/api\/media\/([a-f0-9-]{36})$/.exec(url.pathname)?.[1];
  if (mediaId && request.method === "GET") {
    try {
      const cookie = request.headers.cookie?.split(";").map(item => item.trim()).find(item => item.startsWith("guild_session="))?.slice("guild_session=".length);
      const session = await sessionFromToken(cookie); if (!session) { response.writeHead(401).end(); return; }
      const file = await readOwnedMedia(session.tenantId, mediaId, storage);
      const headers = new Headers(); for (const [name, value] of Object.entries(request.headers)) if (value) headers.set(name, Array.isArray(value) ? value.join(",") : value);
      const result = privateMediaResponse(file.row, file.bytes, new Request(url, { headers }));
      response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(Buffer.from(await result.arrayBuffer())); return;
    } catch { response.writeHead(422, { "Cache-Control": "no-store" }).end("Original fixture media could not be verified."); return; }
  }
  await handler(request, response);
});
server.listen(4547, "127.0.0.1", () => console.log("Synthetic caption review fixture on http://localhost:4547/__caption_fixture · external providers disabled · no listening declarations pre-recorded"));
