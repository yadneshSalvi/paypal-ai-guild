import type { Commission, Mandate, PaymentOperationView, PaymentSummary, WorkPackage } from "@/contracts/guild";
import { assertEarnedCapture } from "./acceptance";
import { checkAuthority } from "./authority";
import { planDigest } from "./fixture";
import { assertMinor, digest, DomainError } from "./primitives";

export interface EarnedWorkEvidence {
  id: string; packageId: string; contractVersion: number; artifactId: string;
  artifactHash: string; criteriaDigest: string; actorId: string;
  review: { humanReviewed?: boolean; actorKind?: string; mode?: string };
}

export function normalizePayments(c: Commission): PaymentSummary {
  c.payments.operations ??= [];
  c.payments.checkout ??= null;
  c.payments.authorization ??= null;
  c.payments.toolEvidence ??= [];
  c.payments.toolRuns ??= [];
  c.payments.payouts ??= [];
  c.payments.serviceFeeMinor = c.packages.filter(pkg => pkg.paymentState === "paid").reduce((sum, pkg) => sum + pkg.serviceFeeMinor, 0);
  return c.payments;
}

export function paymentMandate(c: Commission, pkg?: WorkPackage): Mandate {
  const mandate = (pkg && c.mandates.find(m => m.parentId && m.allowedKinds.includes(pkg.kind))) || c.mandates.find(m => !m.parentId);
  if (!mandate) throw new DomainError("PASSPORT_MISSING", "Approve a Passport before arranging payment.", 422);
  return mandate;
}

export function assertFinancialPlan(c: Commission, now = new Date().toISOString()): Mandate {
  if (c.mode !== "live") throw new DomainError("SAMPLE_NOT_PAYABLE", "A sample commission cannot reserve or charge PayPal funds. Start a live commission first.", 422, false);
  if (!c.approvedPlanDigest) throw new DomainError("APPROVAL_REQUIRED", "Review and approve the current Passport before opening checkout.", 422);
  if (c.approvedPlanDigest !== planDigest(c)) throw new DomainError("PLAN_CHANGED", "The approved plan no longer matches its sources, commercial terms, or authority. Review the current plan first.");
  const root = paymentMandate(c);
  if (root.status !== "active" || !Number.isFinite(Date.parse(root.expiresAt)) || Date.parse(root.expiresAt) <= Date.parse(now)) throw new DomainError("PASSPORT_INACTIVE", "The root Passport is revoked or expired. A new approval is required.", 422);
  if (!["producing", "reviewing", "delivered", "settling", "completed", "paused"].includes(c.state)) throw new DomainError("COMMISSION_NOT_PAYABLE", "This commission is not ready for commercial execution.", 422);
  assertMinor(c.capMinor);
  if (c.capMinor < 1 || c.capMinor > 64000 || c.capMinor > root.capMinor) throw new DomainError("CAP_NOT_APPROVED", "The charge ceiling must fit the approved Passport and this sandbox workspace.", 422);
  if (new Set(c.packages.map(p => p.id)).size !== c.packages.length) throw new DomainError("PACKAGE_IDENTITY", "The commercial plan contains duplicate package identities.", 422, false);
  const gross = c.packages.filter(p => !["rejected", "withdrawn"].includes(p.state)).reduce((sum, p) => {
    assertMinor(p.providerAwardMinor); assertMinor(p.serviceFeeMinor); assertMinor(p.grossMinor);
    if (p.grossMinor !== p.providerAwardMinor + p.serviceFeeMinor) throw new DomainError("ALLOCATION_MISMATCH", "The provider award and disclosed service fee must equal the buyer charge.", 422, false);
    return sum + p.grossMinor;
  }, 0);
  if (gross > c.capMinor) throw new DomainError("PLAN_OVER_CAP", "The current commercial plan exceeds the approved cap.", 422);
  return root;
}

export function assertAcceptedPayment(c: Commission, pkg: WorkPackage, acceptance: EarnedWorkEvidence | null, now = new Date().toISOString()): void {
  assertFinancialPlan(c, now);
  assertEarnedCapture(pkg, pkg.grossMinor);
  if (!acceptance || acceptance.packageId !== pkg.id || acceptance.contractVersion !== pkg.contractVersion || acceptance.actorId !== pkg.acceptedBy || acceptance.criteriaDigest !== pkg.acceptancePack.digest) throw new DomainError("ACCEPTANCE_BINDING", "Payment needs the acceptance record for this exact contract.", 422, false);
  const artifact = c.artifacts.find(a => a.id === acceptance.artifactId && a.packageId === pkg.id);
  if (!artifact || artifact.contentHash !== acceptance.artifactHash || artifact.contentHash !== digest(artifact.content) || artifact.provenance.mode !== "live") throw new DomainError("ARTIFACT_BINDING", "The accepted artifact and its content fingerprint must match before payment.", 422, false);
  if (!acceptance.review.humanReviewed || !["owner", "judge"].includes(acceptance.review.actorKind ?? "") || acceptance.review.mode !== "live") throw new DomainError("ACCEPTANCE_NOT_PAYABLE", "A system qualification or sample acknowledgment cannot grant payment authority.", 422, false);
  if (pkg.acceptancePack.criteria.some(x => x.blocking && (x.kind === "deterministic" || x.kind === "human") && x.status !== "passed")) throw new DomainError("ACCEPTANCE_CHECKS", "The agreed checks and curator acceptance must remain attached to this work.", 422);
  const page = paymentMandate(c, pkg);
  const authority = checkAuthority(c.mandates, { mandateId: page.id, amountMinor: 0, kind: pkg.kind, providerId: pkg.providerId, purpose: page.purpose, now });
  if (!authority.allowed) throw new DomainError(authority.ruleId, authority.reason, 422);
}

export function finalCaptureEligible(c: Commission, packageId: string, operations: PaymentOperationView[], recourseOpen: boolean): boolean {
  if (recourseOpen || c.packages.some(p => p.state !== "accepted")) return false;
  if (operations.some(o => ["capture_authorization", "capture_order"].includes(o.kind) && ["queued", "claimed", "dispatching", "pending_reconciliation"].includes(o.state))) return false;
  return c.packages.every(p => p.id === packageId || p.paymentState === "paid");
}

export function assertClosable(c: Commission, operations: PaymentOperationView[], recourseOpen: boolean, switchToPackageCheckout = false): void {
  if (recourseOpen) throw new DomainError("RECOURSE_OPEN", "Resolve the open recourse review before closing this authorization.", 422);
  if (!switchToPackageCheckout && c.packages.some(p => p.state === "accepted" && p.paymentState !== "not_eligible" && p.paymentState !== "paid")) throw new DomainError("ACCEPTED_WORK_UNPAID", "Pay the accepted work before closing its authorization, or explicitly switch to package checkout.", 422);
  if (operations.some(o => ["capture_authorization", "capture_order"].includes(o.kind) && ["queued", "claimed", "dispatching", "pending_reconciliation"].includes(o.state))) throw new DomainError("CAPTURE_UNCERTAIN", "Reconcile every pending capture before closing the authorization.", 422);
  if (!switchToPackageCheckout && (c.jobs.some(j => j.state === "running" || j.state === "queued") || c.packages.some(p => !["accepted", "rejected", "withdrawn"].includes(p.state)))) throw new DomainError("PRODUCTION_OPEN", "Finish the outstanding work before closing the authorization, or explicitly switch its billing route.", 422);
}

export const resourceLabel = (id: string): string => `•••• ${id.slice(-6)}`;
