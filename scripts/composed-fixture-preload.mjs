/** Test-process transport only. This module is never imported by the app or its
 * bundle. Real HTTP uses the unmodified production Vercel Blob gateway and SDK,
 * with its exact original synthetic objects supplied by an Undici MockAgent. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { MockAgent, setGlobalDispatcher } from "undici";

const file = process.env.PUBLICATION_FIXTURE_FILE;
assert.ok(file, "An explicit retained publication fixture is required.");
const fixture = JSON.parse(readFileSync(file, "utf8"));
assert.equal(fixture.version, "guild.synthetic-composed-web-fixture.v1");
assert.match(fixture.disclosure, /^SYNTHETIC PUBLICATION FIXTURE\./);
const origin = "https://publicationfixture.private.blob.vercel-storage.com";
const auditFile = process.env.PUBLICATION_FIXTURE_AUDIT;
const audit = value => { if (auditFile) appendFileSync(auditFile, JSON.stringify({ at: new Date().toISOString(), ...value }) + "\n", { mode: 0o600 }); };
class FixtureAgent extends MockAgent {
  dispatch(options, handler) {
    if (String(options.origin) !== origin) {
      audit({ event: "network_denied", method: options.method, origin: String(options.origin) });
    }
    return super.dispatch(options, handler);
  }
}
const agent = new FixtureAgent(); agent.disableNetConnect();
const store = agent.get(origin);
for (const item of fixture.media) {
  assert.match(item.file, /^[a-f0-9]{64}\.bin$/);
  assert.equal(item.file, createHash("sha256").update(item.pathname).digest("hex") + ".bin");
  const bytes = readFileSync(resolve(dirname(file), "media", item.file));
  assert.equal(bytes.length, item.bytes); assert.equal(createHash("sha256").update(bytes).digest("hex"), item.hash);
  store.intercept({ method: "GET", path: "/" + item.pathname + "?cache=0" }).reply(() => {
    audit({ event: "original_synthetic_blob_read", pathnameHash: createHash("sha256").update(item.pathname).digest("hex"), contentHash: item.hash, bytes: item.bytes });
    return { statusCode: 200, data: bytes, responseOptions: { headers: { "content-type": item.mediaType, "content-length": String(bytes.length), etag: item.etag,
      "cache-control": "no-store", "last-modified": new Date(fixture.createdAt).toUTCString() } } };
  }).persist();
}
setGlobalDispatcher(agent);
audit({ event: "synthetic_transport_started", label: fixture.label, mediaFiles: fixture.media.length, disclosure: fixture.disclosure, realNetworkAllowed: false });
