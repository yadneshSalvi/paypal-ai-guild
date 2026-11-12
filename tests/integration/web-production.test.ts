import test, { after } from "node:test";
import assert from "node:assert/strict";
import { isolatedPostgres } from "../support/postgres";
const cleanup = await isolatedPostgres("guild_web_production_test"); after(cleanup);
const { fullWebFixture } = await import("../support/web-production-fixture");

test("complete five-family ancestry binds all 78 original recordings, captions and independent reports", async () => {
  const f = await fullWebFixture();
  assert.equal(f.source.ancestors.length, 5); assert.equal(f.source.inputBindings.length, 4);
  assert.equal(Object.values(f.source.labels).reduce((n, labels) => n + Object.keys(labels).length, 0), 78);
  assert.ok(Object.values(f.source.languageReviews).every(review => review.fluentHumanReviewed === false));
});
