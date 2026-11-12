import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { DomainError } from "@/domain/primitives";
import { preparePublicationSchema, publishExhibitionSchema, withdrawPublicationSchema } from "@/domain/web-publication";
import { publicationBytesResponse, publicExhibitionFailure, publicExhibitionResponse, publicNoStore } from "@/server/web/publication-http";
import { publicationSha } from "@/server/web/publications";

const bytes = Buffer.from("0123456789"), file = { path: "assets/audio/original.mp3", mediaType: "audio/mpeg", contentHash: publicationSha(bytes), byteLength: bytes.length };
const request = (headers: Record<string, string> = {}, method = "GET") => new Request("http://localhost/published/" + "a".repeat(48) + "/" + file.path, { method, headers });

test("publication commands require the exact proposal and deliberate disclosure acknowledgments", () => {
  const prepare = { commandId: randomUUID(), expectedRevision: 0, artifactId: randomUUID(), selectedOrdinal: 1, olderEditions: "keep" };
  assert.equal(preparePublicationSchema.parse(prepare).editionNote, "");
  for (const extra of [{ tenantId: randomUUID() }, { syntheticFixture: true }, { acceptSources: true }, { selectedOrdinal: 4 }, { expectedRevision: -1 }])
    assert.equal(preparePublicationSchema.safeParse({ ...prepare, ...extra }).success, false);
  const publish = { commandId: randomUUID(), proposalId: randomUUID(), proposalDigest: "a".repeat(64), expectedRevision: 0, acknowledgePublicFiles: true };
  assert.ok(publishExhibitionSchema.safeParse(publish).success);
  for (const change of [{ acknowledgePublicFiles: false }, { acknowledgePublicFiles: undefined }, { proposalDigest: "a".repeat(63) }, { artifactId: randomUUID() }])
    assert.equal(publishExhibitionSchema.safeParse({ ...publish, ...change }).success, false);
  const withdraw = { commandId: randomUUID(), editionId: randomUUID(), expectedRevision: 1, reason: "The curator closed this edition.", acknowledgeCopiesRemain: true };
  assert.ok(withdrawPublicationSchema.safeParse(withdraw).success);
  for (const change of [{ acknowledgeCopiesRemain: false }, { reason: "short" }, { reason: "        " }, { publicId: "a".repeat(48) }])
    assert.equal(withdrawPublicationSchema.safeParse({ ...withdraw, ...change }).success, false);
});

test("original-byte responses implement single ranges, validators, HEAD and no-store at every outcome", async () => {
  const cases = [
    { headers: {}, status: 200, body: "0123456789" },
    { headers: { range: "bytes=2-4" }, status: 206, body: "234", range: "bytes 2-4/10" },
    { headers: { range: "BYTES=2-4" }, status: 206, body: "234", range: "bytes 2-4/10" },
    { headers: { range: "items=2-4" }, status: 200, body: "0123456789" },
    { headers: { range: "bytes=7-" }, status: 206, body: "789", range: "bytes 7-9/10" },
    { headers: { range: "bytes=-3" }, status: 206, body: "789", range: "bytes 7-9/10" },
    { headers: { range: "bytes=-30" }, status: 206, body: "0123456789", range: "bytes 0-9/10" },
    { headers: { range: "bytes=7-300" }, status: 206, body: "789", range: "bytes 7-9/10" },
    { headers: { range: "bytes=2-4", "if-range": '"outdated"' }, status: 200, body: "0123456789" },
    { headers: { range: "bytes=2-4", "if-range": `"sha256-${file.contentHash}"` }, status: 206, body: "234", range: "bytes 2-4/10" },
    { headers: { "if-none-match": `"older", W/"sha256-${file.contentHash}"` }, status: 304, body: "" },
    { headers: { "if-none-match": "*" }, status: 304, body: "" },
    { headers: { "if-match": '"older"' }, status: 412, body: "" },
    { headers: { "if-match": `W/"sha256-${file.contentHash}"` }, status: 412, body: "" },
    { headers: { "if-match": "*" }, status: 200, body: "0123456789" },
  ];
  for (const item of cases) {
    const result = publicationBytesResponse(file, bytes, request(item.headers as Record<string, string>));
    assert.equal(result.status, item.status); assert.equal(await result.text(), item.body);
    if (item.range) assert.equal(result.headers.get("content-range"), item.range);
    for (const [header, value] of Object.entries(publicNoStore)) assert.equal(result.headers.get(header), value);
    assert.equal(result.headers.get("etag"), `"sha256-${file.contentHash}"`);
    assert.equal(result.headers.get("content-type"), "audio/mpeg");
  }
  for (const range of ["bytes=10-", "bytes=-0", "bytes=-", "bytes=3-2", "bytes=0-2,5-8", "bytes=a-b", "bytes=9007199254740992-"]) {
    const result = publicationBytesResponse(file, bytes, request({ range }));
    assert.equal(result.status, 416, range); assert.equal(result.headers.get("content-range"), "bytes */10"); assert.equal(await result.text(), "");
    assert.equal(result.headers.get("cache-control"), publicNoStore["Cache-Control"]);
  }
  for (const headers of [{}, { range: "bytes=2-4" }]) {
    const result = publicationBytesResponse(file, bytes, request(headers as Record<string, string>, "HEAD"));
    assert.equal(result.status, 200); assert.equal(await result.text(), ""); assert.equal(result.headers.get("content-length"), "10"); assert.equal(result.headers.get("content-range"), null);
  }
  assert.throws(() => publicationBytesResponse(file, Buffer.from("012345678x"), request()), /immutable fingerprint/);
});

test("selectors and traversal are rejected before opening a public database transaction", async () => {
  for (const query of ["?tenantId=elsewhere", "?artifactId=other", "?ordinal=2", "?file=secret", "?lang=ar&lang=en", "?lang=xx"]) {
    await assert.rejects(publicExhibitionResponse("a".repeat(48), ["index.html"], new Request("http://localhost/published/x/index.html" + query)), (error: unknown) => error instanceof DomainError && error.status === 404);
  }
  for (const path of [["..", ".env"], ["assets", "..", "reader.js"], ["assets/audio/x.mp3"], ["assets\\audio"], [".env"], ["%2e%2e", "file"]])
    await assert.rejects(publicExhibitionResponse("a".repeat(48), path, new Request("http://localhost/published/x/index.html")), (error: unknown) => error instanceof DomainError && error.status === 404);
});

test("withdrawn and unavailable responses disclose no tenant, source, credential or internal failure", async () => {
  const internal = "private-tenant-and-secret-not-for-a-public-reader";
  for (const status of [404, 410, 422, 503]) {
    const result = publicExhibitionFailure(new DomainError("PRIVATE_INTERNAL", internal, status, false), new Request("http://localhost/published/x/index.html", { headers: { accept: "text/html" } }));
    const html = await result.text(); assert.equal(result.status, status); assert.ok(!html.includes(internal)); assert.ok(!html.includes("PRIVATE_INTERNAL"));
    assert.equal(result.headers.get("cache-control"), publicNoStore["Cache-Control"]);
    if (status === 410) { assert.match(html, /withdrawn/); assert.match(html, /Previously downloaded copies cannot be recalled/); assert.match(html, /new edition and link/); }
  }
  assert.equal(await publicExhibitionFailure(Error(internal), request({}, "HEAD")).text(), "");
});
