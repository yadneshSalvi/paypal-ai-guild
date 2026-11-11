import type { Mandate, PackageKind, ProviderCard } from "@/contracts/guild";
import { assertMinor, DomainError } from "./primitives";

export interface AuthorityRequest { mandateId: string; amountMinor: number; kind: PackageKind | "premium_voice"; providerId: string; purpose: string; now: string }
export interface AuthorityResult { allowed: boolean; ruleId: string; reason: string; ancestorIds: string[] }
export function checkAuthority(mandates: readonly Mandate[], request: AuthorityRequest): AuthorityResult {
  assertMinor(request.amountMinor);
  const ancestorIds: string[] = [];
  let current = mandates.find(m => m.id === request.mandateId);
  const deny = (ruleId: string, reason: string): AuthorityResult => ({ allowed: false, ruleId, reason, ancestorIds });
  if (!current) return deny("PASSPORT.NOT_FOUND", "This authority page does not belong to this commission.");
  if (!Number.isFinite(Date.parse(request.now))) return deny("PASSPORT.INVALID_TIME", "The authority clock could not be verified.");
  while (current) {
    if (ancestorIds.includes(current.id)) return deny("PASSPORT.CYCLE", "The authority chain is invalid.");
    ancestorIds.push(current.id);
    if (current.status !== "active") return deny("PASSPORT.INACTIVE", `${current.title} is ${current.status}. New commitments are blocked.`);
    if (!Number.isFinite(Date.parse(current.expiresAt)) || Date.parse(current.expiresAt) <= Date.parse(request.now)) return deny("PASSPORT.EXPIRED", `${current.title} has expired or has no valid expiry. The curator must renew it.`);
    if (current.purpose !== request.purpose) return deny("PASSPORT.PURPOSE", "This proposal changes the approved purpose.");
    if (!current.allowedKinds.includes(request.kind as PackageKind)) return deny("PASSPORT.CATEGORY", `${current.title} permits ${current.allowedKinds.join(", ")}. Premium voices are outside that scope.`);
    if (!current.allowedProviders.includes(request.providerId)) return deny("PASSPORT.PROVIDER", "The proposed provider is outside the approved provider list.");
    if (current.reservedMinor + current.committedMinor + request.amountMinor > current.capMinor) return deny("PASSPORT.CAP", `This proposal exceeds ${current.title}'s available allowance.`);
    if (!current.parentId) break;
    const parent = mandates.find(m => m.id === current!.parentId);
    if (!parent) return deny("PASSPORT.PARENT_MISSING", "An ancestor approval is missing.");
    if (parent.revision !== current.parentRevision) return deny("PASSPORT.STALE_PARENT", "The parent authority changed. This page must be approved again.");
    current = parent;
  }
  return { allowed: true, ruleId: "PASSPORT.WITHIN_SCOPE", reason: "The proposal fits every active authority page.", ancestorIds };
}

export function validateChild(parent: Mandate, child: Mandate): void {
  assertMinor(parent.capMinor);assertMinor(child.capMinor);
  if (child.parentId !== parent.id || child.parentRevision !== parent.revision || child.capMinor > parent.capMinor || !Number.isFinite(Date.parse(child.expiresAt)) || !Number.isFinite(Date.parse(parent.expiresAt)) || Date.parse(child.expiresAt) > Date.parse(parent.expiresAt) || child.purpose !== parent.purpose || child.allowedKinds.some(k => !parent.allowedKinds.includes(k)) || child.allowedProviders.some(p => !parent.allowedProviders.includes(p))) {
    throw new DomainError("CHILD_BROADENS_AUTHORITY", "A child Passport can only narrow its parent's cap, scope, providers, purpose and expiry.", 422, false);
  }
}

export function negotiateOffer(provider: ProviderCard, amountMinor: number, buyerAllowance: number): { accepted: boolean; counterMinor: number | null; reason: string } {
  assertMinor(amountMinor); assertMinor(buyerAllowance);
  if (amountMinor > buyerAllowance) return { accepted: false, counterMinor: null, reason: "The offer exceeds the buyer's child allowance." };
  if (amountMinor < provider.priceFloorMinor) return { accepted: false, counterMinor: provider.priceFloorMinor <= buyerAllowance ? provider.priceFloorMinor : null, reason: `The provider's owner mandate sets a ${provider.priceFloorMinor}-cent floor.` };
  return { accepted: true, counterMinor: null, reason: "Both owner mandates permit this price." };
}

export function reserveInSnapshot(mandates: Mandate[], request: AuthorityRequest): string[] {
  const result = checkAuthority(mandates, request);
  if (!result.allowed) throw new DomainError(result.ruleId, result.reason, 422);
  for (const id of result.ancestorIds) mandates.find(m => m.id === id)!.reservedMinor += request.amountMinor;
  return result.ancestorIds;
}
