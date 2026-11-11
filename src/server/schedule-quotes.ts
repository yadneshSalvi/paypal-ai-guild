import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { AuthorityDeadline, Commission, WorkPackage } from "@/contracts/guild";
import { planDigest } from "@/domain/fixture";
import { canonical, digest, DomainError } from "@/domain/primitives";
import { captionAuthorityCeilingSchema } from "@/domain/captions";
import { controlledScheduleQuoteSchema, type ControlledScheduleQuote } from "@/scheduling/persisted";
import { museumWorkingCalendar, schedulingContractDigest } from "@/scheduling/source";
import type { Session } from "./session";

type Db = Pool | PoolClient;
interface QuoteRow { terms: ControlledScheduleQuote; digest: string; state: string; prepared_at: Date | null; approval_id: string | null; approved_at: Date | null }
function fail(code: string, message: string): never { throw new DomainError(code, message, 422, false); }
export const controlledRecoveryServices = {
  economy: { providerId: "formwork", priceMinor: 13000, workingHours: 24 },
  accessible: { providerId: "ostrava", priceMinor: 16000, workingHours: 8 },
} as const;
function servicePolicy(c: Commission, providerId: string) {
  const provider = c.providers.find(item => item.id === providerId);
  if (!provider || !provider.kinds.includes("web")) fail("QUOTE_PROVIDER", "This provider does not offer the requested work.");
  return { version: "guild.controlled-recovery-service.v1", providerId, ownerPolicyDigest: provider.policyDigest,
    priceFloorMinor: provider.priceFloorMinor, capacityUnits: provider.capacity * 100,
    calendar: { ...museumWorkingCalendar, id: `provider-${provider.id}`, name: `${provider.name} · Monday–Friday, 9–5` },
    timeZone: "America/New_York" as const, services: controlledRecoveryServices,
  };
}
function signature(terms: Omit<ControlledScheduleQuote, "signature">) {
  if (!process.env.AUTH_SECRET) throw new Error("AUTH_SECRET required");
  return createHmac("sha256", process.env.AUTH_SECRET).update(canonical({ kind: "guild.controlled-schedule-quote-receipt.v1", terms })).digest("hex");
}
export function quoteDigest(quote: Omit<ControlledScheduleQuote, "signature" | "digest"> | ControlledScheduleQuote) {
  const { signature: _signature, digest: _digest, ...terms } = quote as ControlledScheduleQuote;
  return digest(terms);
}

/** The signed original ceiling survives every proposal, renewal and workspace continuation. */
export function requireScheduleWindow(c: Commission, quotes: ControlledScheduleQuote[] = []) {
  if (!c.mandates.length || c.mandates.some(page => !["active", "draft"].includes(page.status))) fail("SCHEDULE_AUTHORITY_INACTIVE", "The original Passport was suspended or revoked. Its schedule cannot authorize new work.");
  const limits = [...c.mandates.map(page => Date.parse(page.expiresAt)), ...quotes.map(quote => Date.parse(quote.authorityExpiresAt))];
  if (limits.some(value => !Number.isFinite(value) || value <= Date.now())) fail("SCHEDULE_AUTHORITY_EXPIRED", "The original authority deadline has expired. A quote or workspace renewal cannot extend it.");
}

async function preparedContract(db: Db, c: Commission, quote: ControlledScheduleQuote, pkg: WorkPackage) {
  const original = (await db.query<{ previous_contract: WorkPackage; proposed_contract: WorkPackage }>("SELECT previous_contract,proposed_contract FROM guild_contract_amendments WHERE tenant_id=$1 AND commission_id=$2 AND package_id=$3 AND from_version=$4 AND to_version=$5", [c.tenantId, c.id, pkg.id, quote.contractVersion, quote.contractVersion + 1])).rows[0];
  if (!original || schedulingContractDigest(original.previous_contract) !== quote.contractDigest || schedulingContractDigest(original.proposed_contract) !== schedulingContractDigest(pkg) || pkg.contractVersion !== quote.contractVersion + 1 || pkg.providerId !== quote.providerId || pkg.providerAwardMinor !== quote.providerAwardMinor || pkg.serviceFeeMinor !== quote.serviceFeeMinor || pkg.grossMinor !== quote.grossMinor || pkg.workingHours !== quote.workingHours || pkg.acceptancePack.digest !== quote.acceptancePackDigest) fail("QUOTE_CONTRACT_CHANGED", "The prepared contract differs from the accepted offer.");
}

/** Historical signatures are checked against their original terms, never today's policy. */
async function readQuoteChain(db: Db, c: Commission, input: ControlledScheduleQuote, seen = new Set<string>()): Promise<{ quote: ControlledScheduleQuote; row: QuoteRow }> {
  const quote = controlledScheduleQuoteSchema.parse(input), { signature: supplied, ...terms } = quote;
  if (seen.has(quote.id) || seen.size >= 24) fail("QUOTE_LINEAGE", "The renewal history is incomplete or cyclic.");
  seen.add(quote.id);
  const row = (await db.query<QuoteRow>("SELECT terms,digest,state,prepared_at,approval_id,approved_at FROM guild_schedule_quotes WHERE id=$1 AND tenant_id=$2 AND commission_id=$3", [quote.id, c.tenantId, c.id])).rows[0];
  if (!row || quote.tenantId !== c.tenantId || quote.commissionId !== c.id || row.digest !== quote.digest || digest(row.terms) !== digest(quote) || quote.digest !== quoteDigest(quote) || !timingSafeEqual(Buffer.from(signature(terms)), Buffer.from(supplied))) fail("QUOTE_CHANGED", "The signed offer no longer matches its retained original terms.");
  const report = (await db.query<{ artifact_id: string; artifact_hash: string; criteria_digest: string; result: WorkPackage["acceptancePack"]; content_hash: string }>("SELECT v.artifact_id,v.artifact_hash,v.criteria_digest,v.result,a.content_hash FROM guild_verifications v JOIN guild_artifacts a ON a.id=v.artifact_id AND a.tenant_id=v.tenant_id AND a.commission_id=v.commission_id WHERE v.id=$1 AND v.tenant_id=$2 AND v.commission_id=$3 AND v.package_id=$4", [quote.failedSubmission.verificationId, c.tenantId, c.id, quote.packageId])).rows[0];
  if (!report || report.artifact_id !== quote.failedSubmission.artifactId || report.artifact_hash !== quote.failedSubmission.artifactHash || report.content_hash !== report.artifact_hash || report.criteria_digest !== quote.failedSubmission.criteriaDigest || digest(report.result) !== report.criteria_digest || !report.result.criteria.some(item => item.kind === "deterministic" && item.blocking && item.status === "failed")) fail("QUOTE_REPORT_CHANGED", "The retained failed submission or its independent report no longer matches this offer.");
  if (quote.renewal) {
    const prior = (await db.query<{ terms: ControlledScheduleQuote }>("SELECT terms FROM guild_schedule_quotes WHERE id=$1 AND tenant_id=$2 AND commission_id=$3", [quote.renewal.quoteId, c.tenantId, c.id])).rows[0]?.terms;
    if (!prior || prior.digest !== quote.renewal.quoteDigest || prior.packageId !== quote.packageId || prior.providerId !== quote.providerId || prior.contractVersion + 1 !== quote.contractVersion || digest(prior.failedSubmission) !== digest(quote.failedSubmission) || Date.parse(quote.authorityExpiresAt) > Date.parse(prior.authorityExpiresAt)) fail("QUOTE_LINEAGE", "The renewed offer does not preserve its original contract, report and authority ceiling.");
    const previous = await readQuoteChain(db, c, prior, seen);
    if (previous.row.state !== "accepted" || !previous.row.prepared_at) fail("QUOTE_LINEAGE", "A renewal requires the retained prepared agreement.");
  }
  return { quote, row };
}

export async function issueRecoveryQuote(db: PoolClient, session: Session, c: Commission, pkg: WorkPackage, requestId: string, offer: keyof typeof controlledRecoveryServices, renewal?: ControlledScheduleQuote) {
  const service = controlledRecoveryServices[offer], policy = servicePolicy(c, service.providerId);
  requireScheduleWindow(c, renewal ? [renewal] : []);
  if (pkg.kind !== "web" || pkg.acceptedAt || pkg.paymentState !== "not_eligible") fail("QUOTE_REVIEW_REQUIRED", "Recovery offers need an unaccepted exhibition contract with no payment commitment.");
  let failedSubmission: ControlledScheduleQuote["failedSubmission"];
  if (renewal) {
    const prior = await readQuoteChain(db, c, renewal);
    if (!c.schedule?.quoteIds.includes(renewal.id) || prior.row.state !== "accepted" || service.providerId !== renewal.providerId) fail("QUOTE_RENEWAL_CHANGED", "Renew the exact prepared offer shown in the current schedule.");
    await preparedContract(db, c, renewal, pkg);
    failedSubmission = renewal.failedSubmission;
  } else {
    if (!["correction_requested", "rejected"].includes(pkg.state)) fail("QUOTE_REVIEW_REQUIRED", "Recovery offers need the failed web contract and its retained review.");
    const failed = (await db.query<{ id: string; artifact_id: string; artifact_hash: string; criteria_digest: string; result: WorkPackage["acceptancePack"] }>("SELECT id,artifact_id,artifact_hash,criteria_digest,result FROM guild_verifications WHERE tenant_id=$1 AND commission_id=$2 AND package_id=$3 AND contract_version=$4 AND artifact_id=ANY($5::uuid[]) ORDER BY created_at DESC LIMIT 1", [c.tenantId, c.id, pkg.id, pkg.contractVersion, pkg.artifactIds])).rows[0];
    if (!failed || digest(failed.result) !== failed.criteria_digest || !failed.result.criteria.some(item => item.kind === "deterministic" && item.blocking && item.status === "failed")) fail("QUOTE_FAILED_REPORT_REQUIRED", "Retain the current independent failed report before requesting recovery offers.");
    failedSubmission = { artifactId: failed.artifact_id, artifactHash: failed.artifact_hash, verificationId: failed.id, criteriaDigest: failed.criteria_digest };
  }
  if (c.timezone !== policy.timeZone || service.priceMinor < policy.priceFloorMinor || policy.capacityUnits < 100) fail("QUOTE_PROVIDER_POLICY", "The provider's current floor, calendar or capacity cannot support this offer.");
  const issuedAt = new Date().toISOString();
  const authorityExpiresAt = new Date(Math.min(Date.parse(session.expiresAt), ...c.mandates.map(item => Date.parse(item.expiresAt)), ...(renewal ? [Date.parse(renewal.authorityExpiresAt)] : []))).toISOString();
  const expiresAt = new Date(Math.min(Date.now() + 20 * 60_000, Date.parse(authorityExpiresAt))).toISOString();
  if (Date.parse(expiresAt) <= Date.now()) fail("QUOTE_AUTHORITY_EXPIRED", "The real authority deadline has expired. Scenario dates cannot renew it.");
  const terms = {
    schemaVersion: "guild.controlled-schedule-quote.v1" as const, id: randomUUID(), revision: 1 as const,
    tenantId: c.tenantId, commissionId: c.id, packageId: pkg.id, contractVersion: pkg.contractVersion,
    contractDigest: schedulingContractDigest(pkg), acceptancePackDigest: pkg.acceptancePack.digest, failedSubmission,
    providerId: service.providerId, providerPolicyDigest: policy.ownerPolicyDigest, servicePolicyDigest: digest(policy),
    offer, providerAwardMinor: service.priceMinor, serviceFeeMinor: pkg.serviceFeeMinor, grossMinor: service.priceMinor + pkg.serviceFeeMinor,
    workingHours: service.workingHours, capacityUnits: policy.capacityUnits, calendar: policy.calendar,
    timeZone: policy.timeZone, notBefore: new Date(Date.parse(c.openingAt) - 3 * 86_400_000 + 5 * 3_600_000).toISOString(),
    issuedAt, expiresAt, authorityExpiresAt, renewal: renewal ? { quoteId: renewal.id, quoteDigest: renewal.digest } : null,
    clock: "accelerated_scenario" as const,
    provenance: { kind: "controlled_provider_offer" as const, environment: c.mode, issuer: "Guild team-operated provider service" as const,
      disclosure: "An issued offer from Guild's controlled service, with its own identity, policy and real expiry. Business dates use the disclosed opening-week scenario. This is not an unaffiliated provider, observed completion, A2A negotiation or payment approval." },
  };
  const signed = { ...terms, digest: quoteDigest(terms) };
  const quote = controlledScheduleQuoteSchema.parse({ ...signed, signature: signature(signed) });
  await db.query("INSERT INTO guild_schedule_quotes(id,tenant_id,commission_id,package_id,provider_id,request_id,terms,digest,issued_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [quote.id, c.tenantId, c.id, pkg.id, quote.providerId, requestId, quote, quote.digest, issuedAt, expiresAt]);
  return quote;
}

async function approvedBeforeExpiry(db: Db, c: Commission, quote: ControlledScheduleQuote, row: QuoteRow) {
  if (!row.approval_id || !row.approved_at || row.approved_at.getTime() > Date.parse(quote.expiresAt)) return false;
  const receipt = (await db.query<{ actor_id: string; payload: { kind: string; actor: string; commission: string; digest: string; at: string }; signature: string; plan_digest: string; created_at: Date }>("SELECT actor_id,payload,signature,plan_digest,created_at FROM guild_approval_receipts WHERE id=$1 AND tenant_id=$2 AND commission_id=$3", [row.approval_id, c.tenantId, c.id])).rows[0];
  if (!receipt || !process.env.AUTH_SECRET || receipt.payload.kind !== "guild.server_signed_receipt.v1" || receipt.payload.actor !== receipt.actor_id || receipt.payload.commission !== c.id || receipt.payload.digest !== receipt.plan_digest || receipt.created_at.getTime() !== row.approved_at.getTime() || receipt.created_at.getTime() > Date.parse(quote.expiresAt)) return false;
  if (createHmac("sha256", process.env.AUTH_SECRET).update(canonical(receipt.payload)).digest("hex") !== receipt.signature) return false;
  // A legitimate receipt for another plan is not approval of this offer. The
  // command result retains the exact approved snapshot without rewriting it.
  const snapshots = (await db.query<{ snapshot: Commission }>("SELECT result->'commission' AS snapshot FROM guild_commands WHERE tenant_id=$1 AND commission_id=$2 AND result->'commission'->>'approvedPlanDigest'=$3 ORDER BY created_at", [c.tenantId, c.id, receipt.plan_digest])).rows;
  const current = c.packages.find(pkg => pkg.id === quote.packageId);
  return snapshots.some(({ snapshot }) => {
    const pkg = snapshot.packages.find(item => item.id === quote.packageId);
    return snapshot.id === c.id && snapshot.tenantId === c.tenantId && planDigest(snapshot) === receipt.plan_digest && snapshot.schedule?.quoteIds.includes(quote.id)
      && pkg?.contractVersion === quote.contractVersion + 1 && current && schedulingContractDigest(pkg) === schedulingContractDigest(current);
  });
}

/** Read-only deadline projection. It grants no authority and changes no hashes. */
export async function readAuthorityDeadline(db: Db, c: Commission, session: Session): Promise<AuthorityDeadline> {
  const limits: AuthorityDeadline["limits"] = [{ source: "workspace", label: "Current workspace access", expiresAt: session.expiresAt },
    ...c.mandates.map(page => ({ source: "passport" as const, label: page.title, expiresAt: page.expiresAt }))];
  try {
    for (const pkg of c.packages) {
      const correction = pkg.narrationFollowupCorrection ?? pkg.narrationTargetedCorrection ?? pkg.narrationCorrection;
      if (correction) limits.push({ source: "agreement", label: `${pkg.title} · original correction authority`, expiresAt: correction.proposal.providerOffer.expiresAt });
      if (pkg.kind === "captions" && pkg.acceptancePack.version === "2.0.0") {
        const ceiling = captionAuthorityCeilingSchema.parse(pkg.acceptancePack.parameters?.authorityCeiling);
        limits.push({ source: "agreement", label: `${pkg.title} · original work authority`, expiresAt: ceiling.expiresAt });
      }
    }
    for (const id of c.schedule?.quoteIds ?? []) {
      const input = (await db.query<{ terms: ControlledScheduleQuote }>("SELECT terms FROM guild_schedule_quotes WHERE id=$1 AND tenant_id=$2 AND commission_id=$3", [id, c.tenantId, c.id])).rows[0]?.terms;
      if (!input) fail("QUOTE_LINEAGE", "A bound agreement's original deadline is unavailable. Work remains on hold.");
      const { quote } = await readQuoteChain(db, c, input);
      limits.push({ source: "agreement", label: `${c.providers.find(provider => provider.id === quote.providerId)?.name ?? quote.providerId} · original agreement ceiling`, expiresAt: quote.authorityExpiresAt });
    }
    const deadlines = limits.map(limit => Date.parse(limit.expiresAt));
    if (!deadlines.length || deadlines.some(value => !Number.isFinite(value))) throw new Error("Missing deadline");
    return { effectiveUntil: new Date(Math.min(...deadlines)).toISOString(), limits };
  } catch { return { effectiveUntil: null, limits, unavailable: "The complete signed deadline could not be verified. Work remains on hold; retained agreements are unchanged." }; }
}

export async function validateScheduleQuote(db: Db, c: Commission, input: ControlledScheduleQuote, stage: "proposal" | "approval" | "production") {
  const { quote, row } = await readQuoteChain(db, c, input);
  requireScheduleWindow(c, [quote]);
  const policy = servicePolicy(c, quote.providerId), pkg = c.packages.find(item => item.id === quote.packageId);
  if (!pkg || quote.providerPolicyDigest !== policy.ownerPolicyDigest || quote.servicePolicyDigest !== digest(policy) || quote.capacityUnits !== policy.capacityUnits || digest(quote.calendar) !== digest(policy.calendar) || row.state === "withdrawn") fail("QUOTE_CHANGED", "The provider's policy, calendar, capacity or offer changed. Request and review current terms.");
  if (stage === "proposal") {
    if (row.state !== "offered" || pkg.contractVersion !== quote.contractVersion || schedulingContractDigest(pkg) !== quote.contractDigest) fail("QUOTE_CONTRACT_CHANGED", "This offer belongs to a different contract revision.");
    if (quote.renewal) {
      if (!c.schedule?.quoteIds.includes(quote.renewal.quoteId)) fail("QUOTE_RENEWAL_CHANGED", "The prepared offer changed before this renewal was reviewed.");
    } else {
      const report = (await db.query<{ id: string; artifact_id: string; artifact_hash: string; criteria_digest: string }>("SELECT id,artifact_id,artifact_hash,criteria_digest FROM guild_verifications WHERE tenant_id=$1 AND commission_id=$2 AND package_id=$3 AND contract_version=$4 AND artifact_id=ANY($5::uuid[]) ORDER BY created_at DESC LIMIT 1", [c.tenantId, c.id, pkg.id, pkg.contractVersion, pkg.artifactIds])).rows[0];
      if (!report || digest({ artifactId: report.artifact_id, artifactHash: report.artifact_hash, verificationId: report.id, criteriaDigest: report.criteria_digest }) !== digest(quote.failedSubmission)) fail("QUOTE_REPORT_CHANGED", "The failed submission or its current report changed. Review a current offer.");
    }
  } else {
    if (row.state !== "accepted" || !row.prepared_at || row.prepared_at.getTime() > Date.parse(quote.expiresAt)) fail("QUOTE_CONTRACT_CHANGED", "The retained offer was not prepared within its real expiry.");
    await preparedContract(db, c, quote, pkg);
    // An already approved agreement survives its offer window. A later schedule
    // adjustment cannot borrow approval for changed provider terms or a renewal.
    if (await approvedBeforeExpiry(db, c, quote, row)) return quote;
    if (stage === "production") fail("QUOTE_APPROVAL_EXPIRED", "The exact offer needs its own Passport approval before work. Retain expired terms and explicitly renew them.");
  }
  if (Date.parse(quote.expiresAt) <= Date.now()) fail("QUOTE_EXPIRED", "This offer expired in real time. Request new terms and review them before approval.");
  return quote;
}

export async function recordScheduleQuoteApproval(db: PoolClient, c: Commission, receiptId: string) {
  if (!c.schedule) return;
  for (const id of c.schedule.quoteIds) await db.query("UPDATE guild_schedule_quotes SET approval_id=$1,approved_at=now() WHERE id=$2 AND tenant_id=$3 AND commission_id=$4 AND state='accepted' AND approval_id IS NULL AND expires_at>now()", [receiptId, id, c.tenantId, c.id]);
}
