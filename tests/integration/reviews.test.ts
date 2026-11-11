import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isolatedPostgres } from "../support/postgres";

const cleanup = await isolatedPostgres("guild_review_test"); after(cleanup);
const { createSession } = await import("../../src/server/session");
const { seedCommission, executeCommand, getCommission } = await import("../../src/server/commissions");
const { getPool } = await import("../../src/server/db");
const { digest, DomainError } = await import("../../src/domain/primitives");
const { commissionCommandSchema } = await import("../../src/contracts/guild");
const { assertEarnedCapture } = await import("../../src/domain/acceptance");
const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;

async function ready() {
  const { session } = await createSession(); let c = await seedCommission(session);
  await executeCommand(session, c.id, { type: "verify_artifact", commandId: randomUUID(), expectedRevision: c.revision, packageId: "research", artifactId: c.artifacts[0]!.id });
  c = await getCommission(session, c.id);
  const artifact = c.artifacts[0]!, pkg = c.packages.find(pkg => pkg.id === "research")!;
  return { session, c, artifact, pkg, command: { type: "record_automated_review" as const, commandId: randomUUID(), expectedRevision: c.revision, packageId: pkg.id, artifactId: artifact.id, artifactHash: artifact.contentHash, contractVersion: pkg.contractVersion, findings: "Synthetic automated review fixture. The source text was compared; no human review or independent archive inspection is claimed.", acknowledgeLimitations: true as const } };
}

test("an automated review is durable and visible while acceptance, checks and payment authority stay separate", async () => {
  const f = await ready(), packHash = digest(f.pkg.acceptancePack);
  assert.equal(f.pkg.state, "awaiting_acceptance");
  const first = await executeCommand(f.session, f.c.id, f.command), duplicate = await executeCommand(f.session, f.c.id, f.command);
  assert.deepEqual(duplicate, first);
  const c = await getCommission(f.session, f.c.id), pkg = c.packages.find(pkg => pkg.id === "research")!, review = c.artifactReviews![0]!;
  assert.equal(c.artifactReviews!.length, 1); assert.equal(review.kind, "automated"); assert.equal(review.humanReviewed, false); assert.equal(review.accepted, false);
  assert.equal(review.artifactHash, f.artifact.contentHash); assert.equal(review.criteriaDigest, packHash);
  assert.equal(pkg.state, "awaiting_acceptance"); assert.equal(pkg.acceptedAt, null); assert.equal(pkg.paymentState, "not_eligible");
  assert.equal(digest(pkg.acceptancePack), packHash, "a review note cannot overwrite the verifier's evidence");
  assert.throws(() => assertEarnedCapture(pkg, pkg.grossMinor), code("WORK_NOT_ACCEPTED"));
  const records = (await getPool().query("SELECT * FROM guild_artifact_reviews WHERE commission_id=$1", [c.id])).rows;
  assert.equal(records.length, 1); assert.equal(records[0].disclosures.humanReviewed, false);
  const acceptance = await getPool().query("SELECT count(*)::int AS count FROM guild_acceptance_decisions WHERE commission_id=$1", [c.id]); assert.equal(acceptance.rows[0].count, 0);
});

test("automated review cannot change its artifact, contract, tenant or claim human verification", async () => {
  const f = await ready(), other = await createSession();
  await assert.rejects(executeCommand(other.session, f.c.id, f.command), code("NOT_FOUND"));
  await assert.rejects(executeCommand(f.session, f.c.id, { ...f.command, artifactHash: "f".repeat(64) }), code("REVIEW_BINDING_CHANGED"));
  await assert.rejects(executeCommand(f.session, f.c.id, { ...f.command, contractVersion: f.pkg.contractVersion + 1 }), code("REVIEW_BINDING_CHANGED"));
  assert.equal(commissionCommandSchema.safeParse({ ...f.command, humanReviewed: true }).success, false);
  assert.equal(commissionCommandSchema.safeParse({ ...f.command, acknowledgeLimitations: false }).success, false);
  const rows = await getPool().query("SELECT count(*)::int AS count FROM guild_artifact_reviews WHERE commission_id=$1", [f.c.id]); assert.equal(rows.rows[0].count, 0);
});
