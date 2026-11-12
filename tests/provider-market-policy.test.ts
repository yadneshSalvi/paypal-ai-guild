import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createSampleCommission } from "../src/domain/fixture";
import { digest } from "../src/domain/primitives";
import { assertQuotedContract, buyerOfferDecision, marketSourceDigest, marketWorkCeiling, providerOfferDecision, quoteTerms } from "../src/domain/provider-market";
import { providerPolicyInputSchema, type ProviderPolicy } from "../src/contracts/provider-market";

const now = "2026-11-12T05:00:00.000Z", expiry = "2026-11-12T08:00:00.000Z";
function fixture() {
  const c = createSampleCommission(randomUUID()); for (const page of c.mandates) page.expiresAt = expiry;
  const pkg = c.packages.find(item => item.kind === "web")!;
  const value = { id: randomUUID(), providerId: "formwork", revision: 1, ownerId: randomUUID(), previousDigest: null,
    minimumAwardMinor: 12000, askingAwardMinor: 14000, maximumConcurrentTasks: 2, workingHours: 16, calendarId: "museum-weekdays-v1" as const,
    allowedKinds: ["web" as const], correctionAllowance: 1, counterofferLimit: 4, validUntil: expiry,
    contentRules: "Use the exact accepted source register and agreed acceptance pack.", createdAt: now, disclosure: "Controlled test owner policy." };
  const policy: ProviderPolicy = { ...value, digest: digest(value) };
  return { c, pkg, policy };
}

test("bilateral 140→110→120 negotiation preserves fee and records each side's independent floor/cap result", () => {
  const { c, pkg, policy } = fixture();
  const asking = quoteTerms(c, pkg, policy, 14000, expiry, now), low = quoteTerms(c, pkg, policy, 11000, expiry, now), final = quoteTerms(c, pkg, policy, 12000, expiry, now);
  assert.equal(asking.grossMinor, 15500); assert.equal(low.grossMinor, 12500); assert.equal(final.grossMinor, 13500);
  assert.equal(buyerOfferDecision(c, pkg, low, now).allowed, true);
  assert.equal(providerOfferDecision(policy, low, 0, now).code, "PROVIDER.FLOOR");
  assert.equal(providerOfferDecision(policy, final, 0, now).allowed, true);
  assert.equal(buyerOfferDecision(c, pkg, final, now).allowed, true);
  assert.equal(asking.serviceFeeMinor, final.serviceFeeMinor);
  c.mandates.find(item => item.id === "passport-design")!.capMinor = 13000;
  assert.equal(buyerOfferDecision(c, pkg, final, now).code, "PASSPORT.CAP");
});

test("a draft may constrain a quote but cannot authorize production; revocation is never relaxed", () => {
  const { c, pkg, policy } = fixture(), terms = quoteTerms(c, pkg, policy, 12000, expiry, now);
  assert.equal(buyerOfferDecision(c, pkg, terms, now, false).allowed, true);
  assert.equal(buyerOfferDecision(c, pkg, terms, now, true).code, "PASSPORT.INACTIVE");
  c.mandates[0]!.status = "revoked";
  assert.equal(buyerOfferDecision(c, pkg, terms, now, false).code, "PASSPORT.INACTIVE");
});

test("current provider revision, expiry, capacity, scope and service limits must still permit retained terms", () => {
  const { c, pkg, policy } = fixture(), terms = quoteTerms(c, pkg, policy, 12000, expiry, now);
  assert.equal(providerOfferDecision({ ...policy, revision: 2 }, terms, 0, now).code, "PROVIDER.POLICY_CHANGED");
  assert.equal(providerOfferDecision(policy, terms, 2, now).code, "PROVIDER.CAPACITY");
  assert.equal(providerOfferDecision(policy, terms, 0, expiry).code, "PROVIDER.POLICY_EXPIRED");
  assert.equal(providerOfferDecision({ ...policy, allowedKinds: ["research"] }, terms, 0, now).code, "PROVIDER.SCOPE");
  assert.equal(providerOfferDecision(policy, { ...terms, correctionAllowance: 2 }, 0, now).code, "PROVIDER.SERVICE_CHANGED");
});

test("source versions, acceptance criteria, contract price and service fee cannot be substituted under an old quote", () => {
  const { c, pkg, policy } = fixture(), terms = quoteTerms(c, pkg, policy, 12000, expiry, now);
  assert.doesNotThrow(() => assertQuotedContract(c, pkg, terms));
  const changed = structuredClone(c); changed.packages.find(item => item.id === "research")!.contractVersion++;
  assert.notEqual(marketSourceDigest(c, pkg), marketSourceDigest(changed, pkg));
  assert.throws(() => assertQuotedContract(changed, pkg, terms), { code: "MARKET_CONTRACT_CHANGED" });
  assert.throws(() => assertQuotedContract(c, { ...pkg, serviceFeeMinor: 0 }, terms), { code: "MARKET_CONTRACT_CHANGED" });
  assert.throws(() => assertQuotedContract(c, { ...pkg, acceptancePack: { ...pkg.acceptancePack, digest: "f".repeat(64) } }, terms), { code: "MARKET_CONTRACT_CHANGED" });
});

test("session or policy renewal cannot extend the original caption/web work ceiling", () => {
  const { c, pkg, policy } = fixture();
  pkg.acceptancePack.parameters = { authority: { expiresAt: "2026-11-12T05:20:00.000Z" } };
  assert.equal(marketWorkCeiling(c, "2026-11-20T00:00:00.000Z"), "2026-11-12T05:20:00.000Z");
  const terms = quoteTerms(c, pkg, policy, 12000, marketWorkCeiling(c, expiry), now);
  assert.equal(terms.expiresAt, "2026-11-12T05:20:00.000Z");
  assert.throws(() => quoteTerms(c, pkg, policy, 12000, terms.workAuthorityExpiresAt, "2026-11-12T05:21:00.000Z"), { code: "MARKET_AUTHORITY_EXPIRED" });
});

test("policy rejects duplicate work types, below-floor asking award and undeclared fields", () => {
  const { policy } = fixture(); const { id: _id, providerId: _provider, revision: _rev, ownerId: _owner, previousDigest: _prior, digest: _digest, createdAt: _at, disclosure: _disclosure, ...input } = policy;
  assert.equal(providerPolicyInputSchema.safeParse(input).success, true);
  assert.equal(providerPolicyInputSchema.safeParse({ ...input, askingAwardMinor: 11999 }).success, false);
  assert.equal(providerPolicyInputSchema.safeParse({ ...input, allowedKinds: ["web", "web"] }).success, false);
  assert.equal(providerPolicyInputSchema.safeParse({ ...input, bypassBuyerApproval: true }).success, false);
});
