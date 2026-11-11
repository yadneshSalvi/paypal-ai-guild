import { createHmac, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import type { PaymentApproval, PaymentCommand, PaymentOperation, ProviderResource } from "@fracture/paypal-core";
import type { Commission } from "@/contracts/guild";
import type { EarnedWorkEvidence } from "@/domain/payments";
import { canonical, digest, DomainError } from "@/domain/primitives";
import { getPool } from "@/server/db";

export type Queryable = Pick<PoolClient, "query">;
export interface PaymentBinding {
  route: "authorization" | "package_checkout";
  merchantFingerprint: string;
  planDigest: string; actorId: string; approvalSignature: string;
  acceptance: EarnedWorkEvidence | null; contractDigest: string | null;
  parentIntentId: string | null; challengeId: string | null;
  finalCapture: boolean; purpose: "commission_hold" | "accepted_work" | "close_hold";
  switchToPackageCheckout?: boolean;
}
export interface PaymentIntent {
  id: string; tenant_id: string; commission_id: string; business_key: string;
  kind: PaymentCommand["action"]["kind"]; package_id: string | null; contract_version: number | null;
  approval_id: string; acceptance_id: string | null; command: PaymentCommand; binding: PaymentBinding;
  admission_state: "ready" | "cancelled"; blocked_reason: string | null; created_at: Date;
}
export interface ApprovalRow {
  id: string; actor_id: string; actor_role: string; plan_digest: string; payload: Record<string, unknown>; signature: string;
}

export const paymentScope = (c: Pick<Commission, "tenantId" | "id">) => ({ tenantId: c.tenantId, projectId: c.id });
export const contractDigest = (c: Commission, packageId: string): string => {
  const p = c.packages.find(pkg => pkg.id === packageId);
  if (!p) throw new DomainError("PACKAGE_NOT_FOUND", "That work package is not in this commission.", 404, false);
  return digest({ id: p.id, kind: p.kind, contractVersion: p.contractVersion, providerId: p.providerId, providerAwardMinor: p.providerAwardMinor, serviceFeeMinor: p.serviceFeeMinor, grossMinor: p.grossMinor, packDigest: p.acceptancePack.digest });
};

export async function approvalFor(db: Queryable, c: Commission): Promise<{ row: ApprovalRow; approval: PaymentApproval }> {
  const result = await db.query<ApprovalRow>("SELECT a.id,a.actor_id,s.role AS actor_role,a.plan_digest,a.payload,a.signature FROM guild_approval_receipts a JOIN guild_sessions s ON s.id=a.actor_id AND s.tenant_id=a.tenant_id WHERE a.tenant_id=$1 AND a.commission_id=$2 AND a.plan_digest=$3 ORDER BY a.created_at DESC LIMIT 1", [c.tenantId, c.id, c.approvedPlanDigest]);
  const row = result.rows[0];
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new DomainError("SIGNING_UNAVAILABLE", "Approval verification is temporarily unavailable.", 503);
  const expected = row ? createHmac("sha256", secret).update(canonical(row.payload)).digest("hex") : "";
  if (!row || !safeEqual(row.signature, expected) || row.payload.commission !== c.id || row.payload.digest !== c.approvedPlanDigest || row.payload.actor !== row.actor_id) throw new DomainError("APPROVAL_RECEIPT", "The current plan needs a valid approval receipt before payment.", 422, false);
  if (!["judge", "owner"].includes(row.actor_role)) throw new DomainError("APPROVAL_NOT_PAYABLE", "An operator qualification cannot grant commercial payment authority.", 422, false);
  const root = c.mandates.find(m => !m.parentId)!;
  return { row, approval: { id: row.id, version: root.revision, digest: row.plan_digest, expiresAt: root.expiresAt } };
}

export async function acceptanceFor(db: Queryable, c: Commission, packageId: string): Promise<EarnedWorkEvidence | null> {
  const pkg = c.packages.find(p => p.id === packageId);
  if (!pkg) return null;
  const result = await db.query<{ id: string; package_id: string; contract_version: number; artifact_id: string; artifact_hash: string; criteria_digest: string; actor_id: string; review_disclosures: EarnedWorkEvidence["review"] }>(
    "SELECT id,package_id,contract_version,artifact_id,artifact_hash,criteria_digest,actor_id,review_disclosures FROM guild_acceptance_decisions WHERE tenant_id=$1 AND commission_id=$2 AND package_id=$3 AND contract_version=$4 AND decision='accepted'",
    [c.tenantId, c.id, packageId, pkg.contractVersion],
  );
  const r = result.rows[0];
  return r ? { id: r.id, packageId: r.package_id, contractVersion: r.contract_version, artifactId: r.artifact_id, artifactHash: r.artifact_hash, criteriaDigest: r.criteria_digest, actorId: r.actor_id, review: r.review_disclosures } : null;
}

export async function listIntents(tenantId: string, commissionId: string, db: Queryable = getPool()): Promise<PaymentIntent[]> {
  return (await db.query<PaymentIntent>("SELECT * FROM guild_payment_intents WHERE tenant_id=$1 AND commission_id=$2 ORDER BY created_at,id", [tenantId, commissionId])).rows;
}

export async function ownedIntent(tenantId: string, commissionId: string, id: string, db: Queryable = getPool()): Promise<PaymentIntent> {
  const row = (await db.query<PaymentIntent>("SELECT * FROM guild_payment_intents WHERE tenant_id=$1 AND commission_id=$2 AND id=$3", [tenantId, commissionId, id])).rows[0];
  if (!row) throw new DomainError("PAYMENT_NOT_FOUND", "This payment is not in your commission.", 404, false);
  return row;
}

export async function openRecourse(c: Commission, db: Queryable = getPool()): Promise<boolean> {
  const r = await db.query("SELECT id FROM guild_recourse_holds WHERE tenant_id=$1 AND commission_id=$2 AND state='open' LIMIT 1", [c.tenantId, c.id]);
  return !!r.rowCount;
}

export async function rememberResource(db: Queryable, c: Commission, operationId: string, resource: ProviderResource): Promise<void> {
  const result = await db.query<{ tenant_id: string; commission_id: string }>(
    "INSERT INTO guild_payment_resources(kind,resource_id,tenant_id,commission_id,operation_id,resource,observed_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(kind,resource_id) DO UPDATE SET resource=EXCLUDED.resource,observed_at=EXCLUDED.observed_at WHERE guild_payment_resources.tenant_id=EXCLUDED.tenant_id AND guild_payment_resources.commission_id=EXCLUDED.commission_id AND guild_payment_resources.observed_at<=EXCLUDED.observed_at RETURNING tenant_id,commission_id",
    [resource.kind, resource.id, c.tenantId, c.id, operationId, resource, resource.observedAt],
  );
  if (!result.rowCount) {
    const existing = (await db.query<{ tenant_id: string; commission_id: string }>("SELECT tenant_id,commission_id FROM guild_payment_resources WHERE kind=$1 AND resource_id=$2", [resource.kind, resource.id])).rows[0];
    if (existing?.tenant_id !== c.tenantId || existing?.commission_id !== c.id) throw new DomainError("RESOURCE_OWNER_CONFLICT", "This provider resource is already bound to a different commission.", 409, false);
  }
}

export const safeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export function checkoutToken(challengeId: string, commissionId: string): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new DomainError("SIGNING_UNAVAILABLE", "Checkout is temporarily unavailable.", 503);
  return createHmac("sha256", secret).update(`guild.checkout.v1:${commissionId}:${challengeId}`).digest("base64url");
}

export function appOrigin(): string {
  if (process.env.VERCEL === "1" && !process.env.APP_URL) throw new DomainError("APP_ORIGIN", "Set the deployed studio's canonical APP_URL before arranging checkout.", 503);
  const url = new URL(process.env.APP_URL ?? "http://localhost:4101");
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) || url.username || url.password || url.hash || url.search || url.pathname !== "/") throw new DomainError("APP_ORIGIN", "The checkout return origin is not configured correctly.", 503);
  return url.origin;
}

export function merchantFingerprint(): string {
  return digest({ application: "guild", clientId: process.env.PAYPAL_CLIENT_ID ?? "", environment: "sandbox" });
}

export async function capabilityPassed(feature: string, db: Queryable = getPool()): Promise<boolean> {
  return (await db.query<{ passed: boolean }>("SELECT passed FROM guild_payment_capabilities WHERE merchant_fingerprint=$1 AND feature=$2", [merchantFingerprint(), feature])).rows[0]?.passed === true;
}

export function operationResource(operation: PaymentOperation, kind: ProviderResource["kind"]): ProviderResource | null {
  const matches = operation.receipt?.resources.filter(r => r.kind === kind) ?? [];
  return matches.length === 1 ? matches[0]! : null;
}
