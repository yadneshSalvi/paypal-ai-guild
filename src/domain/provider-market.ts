import type { Commission, Mandate, WorkPackage } from "@/contracts/guild";
import { offerTermsSchema, type MarketPolicyDecision, type OfferTerms, type ProviderPolicy } from "@/contracts/provider-market";
import { checkAuthority } from "./authority";
import { digest, DomainError } from "./primitives";
import { schedulingContractDigest } from "@/scheduling/source";

export const marketContractDigest = (pkg: WorkPackage) => digest({ contract: schedulingContractDigest(pkg), marketOffer: pkg.marketOffer ?? null });

/** Exact source versions, including accepted/draft lineage, are part of a quote. */
export function marketSourceDigest(commission: Commission, pkg: WorkPackage): string {
  return digest({ sources: commission.sourceAssets.map(source => ({ id: source.id, hash: source.contentHash })),
    dependencies: pkg.dependsOn.map(id => {
      const input = commission.packages.find(item => item.id === id);
      return { id, version: input?.contractVersion ?? null, state: input?.state ?? null,
        artifacts: (input?.artifactIds ?? []).map(artifactId => ({ id: artifactId, hash: commission.artifacts.find(item => item.id === artifactId)?.contentHash ?? null })) };
    }), inputPolicy: pkg.inputPolicy ?? "accepted" });
}

export function marketMandate(commission: Commission, pkg: WorkPackage): Mandate {
  const mandate = commission.mandates.find(item => item.parentId && item.allowedKinds.includes(pkg.kind)) ?? commission.mandates.find(item => !item.parentId);
  if (!mandate) throw new DomainError("MARKET_MANDATE_MISSING", "This work has no current Passport page.", 422, false);
  return mandate;
}

export function marketWorkCeiling(commission: Commission, sessionExpiresAt: string): string {
  const limits = [sessionExpiresAt, ...commission.mandates.map(item => item.expiresAt)];
  for (const pkg of commission.packages) {
    const parameters = pkg.acceptancePack.parameters as Record<string, unknown> | undefined;
    for (const name of ["authority", "authorityCeiling"]) {
      const value = parameters?.[name] as { expiresAt?: unknown } | undefined;
      if (typeof value?.expiresAt === "string") limits.push(value.expiresAt);
    }
    const correction = pkg.narrationFollowupCorrection ?? pkg.narrationTargetedCorrection ?? pkg.narrationCorrection;
    if (correction) limits.push(correction.proposal.providerOffer.expiresAt);
  }
  const times = limits.map(Date.parse);
  if (!times.length || times.some(value => !Number.isFinite(value))) throw new DomainError("MARKET_AUTHORITY_INVALID", "The original work expiry could not be verified.", 422, false);
  return new Date(Math.min(...times)).toISOString();
}

export function quoteTerms(commission: Commission, pkg: WorkPackage, policy: ProviderPolicy, providerAwardMinor: number, ceiling: string, now = new Date().toISOString()): OfferTerms {
  const expiresAt = new Date(Math.min(Date.parse(now) + 30 * 60_000, Date.parse(ceiling), Date.parse(policy.validUntil))).toISOString();
  if (Date.parse(expiresAt) <= Date.parse(now)) throw new DomainError("MARKET_AUTHORITY_EXPIRED", "This offer's original authority or provider policy has expired.", 422, false);
  return offerTermsSchema.parse({ providerId: policy.providerId, packageId: pkg.id, kind: pkg.kind,
    contractVersion: pkg.contractVersion, contractDigest: marketContractDigest(pkg), acceptancePackDigest: pkg.acceptancePack.digest,
    sourceDigest: marketSourceDigest(commission, pkg), providerPolicyRevision: policy.revision, providerPolicyDigest: policy.digest,
    providerAwardMinor, serviceFeeMinor: pkg.serviceFeeMinor, grossMinor: providerAwardMinor + pkg.serviceFeeMinor, currency: "USD",
    workingHours: policy.workingHours, calendarId: policy.calendarId, correctionAllowance: pkg.acceptancePack.correctionAllowance,
    expiresAt, workAuthorityExpiresAt: ceiling });
}

export function buyerOfferDecision(commission: Commission, pkg: WorkPackage, terms: OfferTerms, now = new Date().toISOString(), requireActive = false): MarketPolicyDecision {
  const page = marketMandate(commission, pkg);
  // Draft pages may bound a proposal. Only actual approval can activate dispatch.
  const pages = requireActive ? commission.mandates : commission.mandates.map(item => ({ ...item, status: item.status === "draft" ? "active" as const : item.status }));
  const authority = checkAuthority(pages, { mandateId: page.id, amountMinor: terms.grossMinor, kind: pkg.kind,
    providerId: terms.providerId, purpose: page.purpose, now });
  let allowed = authority.allowed, code = authority.ruleId, reason = authority.reason;
  if (commission.packages.reduce((sum, item) => sum + (item.id === pkg.id ? terms.grossMinor : item.grossMinor), 0) > commission.capMinor) {
    allowed = false; code = "MARKET.PLAN_CAP"; reason = "This offer would put the complete commission above its approved spending cap.";
  }
  if (Date.parse(terms.expiresAt) <= Date.parse(now) || Date.parse(terms.workAuthorityExpiresAt) <= Date.parse(now)) {
    allowed = false; code = "MARKET.OFFER_EXPIRED"; reason = "The offer or its original work authority has expired.";
  }
  return { side: "buyer", allowed, code, reason, policyId: page.id, policyRevision: page.revision, policyDigest: page.digest, checkedAt: now };
}

export function providerOfferDecision(policy: ProviderPolicy, terms: OfferTerms, activeTasks: number, now = new Date().toISOString()): MarketPolicyDecision {
  let code = "PROVIDER.WITHIN_POLICY", reason = "The work fits the provider owner's current floor, scope, capacity and time limits.";
  if (policy.providerId !== terms.providerId || policy.digest !== terms.providerPolicyDigest || policy.revision !== terms.providerPolicyRevision) {
    code = "PROVIDER.POLICY_CHANGED"; reason = "The provider policy changed after this offer. Request terms under the current policy.";
  } else if (Date.parse(policy.validUntil) <= Date.parse(now) || Date.parse(terms.expiresAt) <= Date.parse(now)) {
    code = "PROVIDER.POLICY_EXPIRED"; reason = "The provider policy or offer has expired.";
  } else if (!policy.allowedKinds.includes(terms.kind)) {
    code = "PROVIDER.SCOPE"; reason = "This work type is outside the provider owner's policy.";
  } else if (terms.providerAwardMinor < policy.minimumAwardMinor) {
    code = "PROVIDER.FLOOR"; reason = `The provider cannot accept an award below ${policy.minimumAwardMinor} USD cents.`;
  } else if (terms.correctionAllowance > policy.correctionAllowance || terms.workingHours !== policy.workingHours || terms.calendarId !== policy.calendarId) {
    code = "PROVIDER.SERVICE_CHANGED"; reason = "The correction, duration or calendar differs from the provider policy.";
  } else if (activeTasks >= policy.maximumConcurrentTasks) {
    code = "PROVIDER.CAPACITY"; reason = "The provider has no available task capacity.";
  }
  return { side: "provider", allowed: code === "PROVIDER.WITHIN_POLICY", code, reason,
    policyId: policy.id, policyRevision: policy.revision, policyDigest: policy.digest, checkedAt: now };
}

export function assertQuotedContract(commission: Commission, pkg: WorkPackage, terms: OfferTerms): void {
  if (terms.packageId !== pkg.id || terms.kind !== pkg.kind || terms.contractVersion !== pkg.contractVersion || terms.contractDigest !== marketContractDigest(pkg)
      || terms.acceptancePackDigest !== pkg.acceptancePack.digest || terms.sourceDigest !== marketSourceDigest(commission, pkg)
      || terms.serviceFeeMinor !== pkg.serviceFeeMinor) {
    throw new DomainError("MARKET_CONTRACT_CHANGED", "The work, sources, criteria or disclosed service fee changed. Review a new offer for the current contract.", 409, false);
  }
}
