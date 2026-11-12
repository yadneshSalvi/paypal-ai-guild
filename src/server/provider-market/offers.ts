import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { Commission, WorkPackage } from "@/contracts/guild";
import type { MarketPolicyDecision, OfferMessage, OfferMessageKind, OfferTerms, ProviderPolicy } from "@/contracts/provider-market";
import { assertQuotedContract, buyerOfferDecision, marketWorkCeiling, providerOfferDecision, quoteTerms } from "@/domain/provider-market";
import { digest, DomainError } from "@/domain/primitives";
import { planDigest } from "@/domain/fixture";
import { appendEvent, saveCommission } from "../commissions";
import type { Session } from "../session";
import { currentProviderPolicy, providerCapacity, providerRow, type ProviderRow } from "./registry";
import { marketCommission, type MarketThreadRow } from "./snapshot";

export async function writablePackage(db: PoolClient, c: Commission, packageId: string): Promise<WorkPackage> {
  const pkg = c.packages.find(item => item.id === packageId);
  if (!pkg) throw new DomainError("PACKAGE_NOT_FOUND", "That package is not in this commission.", 404, false);
  if (pkg.acceptedAt || pkg.paymentState !== "not_eligible" || pkg.artifactIds.length || ["producing", "verifying"].includes(pkg.state)) throw new DomainError("MARKET_CONTRACT_STARTED", "Submitted or accepted work keeps its original contract. Use its explicit review and amendment flow.", 422, false);
  const started = await db.query("SELECT id FROM guild_jobs WHERE tenant_id=$1 AND commission_id=$2 AND input->>'packageId'=$3 AND (input->>'contractVersion')::int=$4 AND NOT (state='failed' AND attempts=0 AND error='Cancelled by owner before any worker dispatch') LIMIT 1", [c.tenantId, c.id, pkg.id, pkg.contractVersion]);
  if (started.rowCount) throw new DomainError("MARKET_ORIGINAL_WORK_RETAINED", "An original worker already belongs to this contract. Retain that result before negotiating replacement work.", 409, false);
  return pkg;
}

export async function readyPolicy(db: PoolClient, providerId: string): Promise<{ provider: ProviderRow; policy: ProviderPolicy; activeTasks: number }> {
  const provider = await providerRow(db, providerId, true), policy = await currentProviderPolicy(db, provider);
  if (provider.revoked_at || provider.enrollment_state !== "ready" || !policy || Date.parse(policy.validUntil) <= Date.now()) throw new DomainError("PROVIDER_UNAVAILABLE", "This provider needs a current owner policy and verified service connection before accepting offers.", 422, false);
  const capacity = await providerCapacity(db, providerId);
  return { provider, policy, activeTasks: capacity.active + capacity.reserved };
}

export async function createOfferThread(db: PoolClient, session: Session, c: Commission, pkg: WorkPackage, providerId: string): Promise<MarketThreadRow> {
  const { policy } = await readyPolicy(db, providerId);
  const ceiling = marketWorkCeiling(c, session.expiresAt);
  quoteTerms(c, pkg, policy, policy.askingAwardMinor, ceiling);
  const prior = await db.query("SELECT t.id FROM guild_market_threads t WHERE t.tenant_id=$1 AND t.commission_id=$2 AND t.package_id=$3 AND t.provider_id=$4 AND t.state IN ('requesting','open','selected','needs_review') AND (t.state IN ('selected','needs_review') OR t.latest_terms IS NULL OR (t.latest_terms->>'expiresAt')::timestamptz>now() OR EXISTS(SELECT 1 FROM guild_market_operations o WHERE o.thread_id=t.id AND o.state IN ('prepared','dispatching','needs_review'))) LIMIT 1", [c.tenantId, c.id, pkg.id, providerId]);
  if (prior.rowCount) throw new DomainError("MARKET_ORIGINAL_OFFER_REQUIRED", "This provider already has an open offer for the package. Continue that retained thread.", 409, false);
  return (await db.query<MarketThreadRow>("INSERT INTO guild_market_threads(id,tenant_id,commission_id,provider_id,package_id,state,original_contract,original_work_ceiling) VALUES($1,$2,$3,$4,$5,'requesting',$6,$7) RETURNING *", [randomUUID(), c.tenantId, c.id, providerId, pkg.id, pkg, ceiling])).rows[0]!;
}

export async function appendOfferMessage(db: PoolClient, row: MarketThreadRow, commandId: string, kind: OfferMessageKind, side: "buyer" | "provider", senderLabel: string, note: string, terms: OfferTerms | null, decisions: MarketPolicyDecision[]): Promise<OfferMessage> {
  const previous = (await db.query<{ digest: string }>("SELECT digest FROM guild_market_messages WHERE tenant_id=$1 AND thread_id=$2 ORDER BY revision DESC LIMIT 1", [row.tenant_id, row.id])).rows[0];
  const value = { id: randomUUID(), commandId, revision: row.revision + 1, parentDigest: previous?.digest ?? null,
    kind, side, senderLabel, createdAt: new Date().toISOString(), terms, termsDigest: terms ? digest(terms) : null, note, decisions };
  const message: OfferMessage = { ...value, digest: digest(value) };
  await db.query("INSERT INTO guild_market_messages(id,tenant_id,thread_id,revision,command_id,message,digest,previous_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [message.id, row.tenant_id, row.id, message.revision, commandId, message, message.digest, message.parentDigest]);
  await db.query("UPDATE guild_market_threads SET revision=$2,latest_terms=COALESCE($3,latest_terms),latest_terms_digest=COALESCE($4,latest_terms_digest),updated_at=now() WHERE id=$1 AND tenant_id=$5", [row.id, message.revision, terms, message.termsDigest, row.tenant_id]);
  row.revision = message.revision;
  if (terms) { row.latest_terms = terms; row.latest_terms_digest = message.termsDigest; }
  return message;
}

export async function requireOfferThread(db: PoolClient, tenantId: string, id: string, expectedRevision?: number): Promise<MarketThreadRow> {
  const row = (await db.query<MarketThreadRow>("SELECT * FROM guild_market_threads WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [id, tenantId])).rows[0];
  if (!row) throw new DomainError("OFFER_NOT_FOUND", "That offer is not available in your workspace.", 404, false);
  if (expectedRevision !== undefined && row.revision !== expectedRevision) throw new DomainError("OFFER_REVISION_CONFLICT", "The offer changed while you were reviewing it. Keep your draft and refresh the current terms.", 409, true);
  return row;
}

function withOriginalExpiry(terms: OfferTerms, prior: OfferTerms | null): OfferTerms {
  return prior ? { ...terms, expiresAt: new Date(Math.min(Date.parse(terms.expiresAt), Date.parse(prior.expiresAt))).toISOString() } : terms;
}

/** Business operation behind both the provider service and the provider console. */
export async function proposeOffer(db: PoolClient, session: Session, row: MarketThreadRow, commandId: string, awardMinor?: number, note?: string, side: "buyer" | "provider" = "buyer"): Promise<void> {
  if (!["requesting", "open"].includes(row.state)) throw new DomainError("OFFER_CLOSED", "This offer thread no longer accepts counters.", 409, false);
  const c = await marketCommission(db, row.tenant_id, row.commission_id, true), pkg = await writablePackage(db, c, row.package_id);
  const { provider, policy, activeTasks } = await readyPolicy(db, row.provider_id);
  if (row.latest_terms) assertQuotedContract(c, pkg, row.latest_terms);
  if (row.latest_terms && (row.latest_terms.providerPolicyDigest !== policy.digest || row.latest_terms.providerPolicyRevision !== policy.revision)) throw new DomainError("PROVIDER_POLICY_CHANGED", "The provider owner changed its policy. Retain this history and request a current offer.", 409, false);
  if (awardMinor === undefined) {
    await appendOfferMessage(db, row, commandId, "quote.request", "buyer", c.museum, "Please quote the exact work, sources and acceptance criteria shown in this contract.", null, []);
    const terms = quoteTerms(c, pkg, policy, policy.askingAwardMinor, row.original_work_ceiling.toISOString());
    const decisions = [buyerOfferDecision(c, pkg, terms), providerOfferDecision(policy, terms, activeTasks)];
    await appendOfferMessage(db, row, commandId, "offer.propose", "provider", provider.profile.displayName, "This proposal follows the provider owner's current asking award and work policy.", terms, decisions);
    row.state = decisions.find(item => item.side === "provider")!.allowed ? "open" : "declined";
  } else {
    const counters = Number((await db.query<{ n: string }>("SELECT count(*) AS n FROM guild_market_messages WHERE thread_id=$1 AND message->>'kind'='offer.counter'", [row.id])).rows[0]!.n);
    if (counters >= policy.counterofferLimit) throw new DomainError("PROVIDER_COUNTER_LIMIT", "This provider's counteroffer allowance is exhausted. Retain the thread for review.", 422, false);
    const terms = withOriginalExpiry(quoteTerms(c, pkg, policy, awardMinor, row.original_work_ceiling.toISOString()), row.latest_terms);
    const buyer = buyerOfferDecision(c, pkg, terms), own = providerOfferDecision(policy, terms, activeTasks);
    if (!buyer.allowed) throw new DomainError(buyer.code, buyer.reason, 422, false);
    if (side === "provider" && !own.allowed) throw new DomainError(own.code, own.reason, 422, false);
    await appendOfferMessage(db, row, commandId, "offer.counter", side, side === "buyer" ? c.museum : provider.profile.displayName, note ?? "A counteroffer for the same agreed work.", terms, [buyer, own]);
    if (side === "buyer" && !own.allowed) {
      await appendOfferMessage(db, row, commandId, "offer.decline", "provider", provider.profile.displayName, own.reason, terms, [buyer, own]);
      if (own.code === "PROVIDER.FLOOR" && counters + 1 < policy.counterofferLimit) {
        const floor = withOriginalExpiry(quoteTerms(c, pkg, policy, policy.minimumAwardMinor, row.original_work_ceiling.toISOString()), terms), next = [buyerOfferDecision(c, pkg, floor), providerOfferDecision(policy, floor, activeTasks)];
        await appendOfferMessage(db, row, commandId, "offer.counter", "provider", provider.profile.displayName, "The owner floor permits this counteroffer for the exact same work and service fee.", floor, next);
        row.state = next.every(item => item.allowed) ? "open" : "declined";
      } else row.state = "declined";
    } else row.state = "open";
  }
  await db.query("UPDATE guild_market_threads SET state=$2 WHERE id=$1", [row.id, row.state]);
}

export async function selectOffer(db: PoolClient, session: Session, row: MarketThreadRow, commandId: string, termsDigest: string, expectedCommissionRevision: number): Promise<void> {
  if (row.state !== "open" || !row.latest_terms || row.latest_terms_digest !== termsDigest || digest(row.latest_terms) !== termsDigest) throw new DomainError("OFFER_CHANGED", "Review the current exact offer before selecting it.", 409, false);
  const c = await marketCommission(db, row.tenant_id, row.commission_id, true), pkg = await writablePackage(db, c, row.package_id), terms = row.latest_terms;
  if (c.revision !== expectedCommissionRevision) throw new DomainError("COMMISSION_REVISION_CONFLICT", "The commission changed. Refresh its contract and Passport before selecting terms.", 409, true);
  assertQuotedContract(c, pkg, terms);
  const { policy, activeTasks } = await readyPolicy(db, row.provider_id), decisions = [buyerOfferDecision(c, pkg, terms), providerOfferDecision(policy, terms, activeTasks)];
  for (const decision of decisions) if (!decision.allowed) throw new DomainError(decision.code, decision.reason, 422, false);
  if (terms.correctionAllowance !== pkg.acceptancePack.correctionAllowance) throw new DomainError("OFFER_CRITERIA_CHANGED", "The correction allowance differs from the agreed acceptance pack.", 422, false);
  const billing = await db.query("SELECT id FROM guild_payment_intents WHERE tenant_id=$1 AND commission_id=$2 LIMIT 1", [c.tenantId, c.id]);
  if (billing.rowCount) throw new DomainError("MARKET_BILLING_AMENDMENT_REQUIRED", "This commission already has a buyer payment agreement. Review its commercial amendment before changing provider terms.", 422, false);
  const reservation = await db.query("SELECT id FROM guild_budget_reservations WHERE tenant_id=$1 AND commission_id=$2 AND state IN ('reserved','committed') LIMIT 1", [c.tenantId, c.id]);
  if (reservation.rowCount) throw new DomainError("MARKET_RESERVATION_ACTIVE", "The commission has current work commitments. Retain them and review a separate amendment before changing its approval.", 422, false);
  const previous = structuredClone(pkg), previousPlan = c.approvedPlanDigest;
  await appendOfferMessage(db, row, commandId, "offer.accept", "buyer", c.museum, "These exact terms are selected for a fresh Passport review. No artifact acceptance or payment is made.", terms, decisions);
  Object.assign(pkg, { contractVersion: pkg.contractVersion + 1, providerId: terms.providerId, providerAwardMinor: terms.providerAwardMinor,
    serviceFeeMinor: terms.serviceFeeMinor, grossMinor: terms.grossMinor, workingHours: terms.workingHours, state: "awarded",
    marketOffer: { threadId: row.id, offerRevision: row.revision, offerDigest: termsDigest, providerPolicyRevision: terms.providerPolicyRevision,
      providerPolicyDigest: terms.providerPolicyDigest, sourceDigest: terms.sourceDigest, originalWorkCeiling: row.original_work_ceiling.toISOString() } });
  c.approvedPlanDigest = null; c.state = "awaiting_approval"; for (const page of c.mandates) if (page.status === "active") page.status = "draft";
  const proposedPlan = planDigest(c);
  await db.query("INSERT INTO guild_contract_amendments(id,tenant_id,commission_id,package_id,from_version,to_version,previous_plan_digest,proposed_plan_digest,previous_contract,proposed_contract,actor_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
    [randomUUID(), c.tenantId, c.id, pkg.id, previous.contractVersion, pkg.contractVersion, previousPlan, proposedPlan, previous, pkg, session.id, "Exact marketplace offer selected; fresh Passport approval is required before delegation."]);
  await db.query("UPDATE guild_market_threads SET state='superseded',updated_at=now() WHERE tenant_id=$1 AND commission_id=$2 AND package_id=$3 AND id<>$4 AND state IN ('open','selected','requesting')", [c.tenantId, c.id, pkg.id, row.id]);
  await db.query("UPDATE guild_market_threads SET state='selected',selected_terms=$2,selected_terms_digest=$3,prepared_contract=$4,selected_at=now(),updated_at=now() WHERE id=$1", [row.id, terms, termsDigest, pkg]);
  appendEvent(c, "provider.offer_selected", "Provider terms selected for approval", "The exact offer, policy, sources and service fee are retained. Review the new Passport before delegating work.", "Curator", pkg.id);
  c.revision++; await saveCommission(db, c);
}

export async function declineOffer(db: PoolClient, row: MarketThreadRow, commandId: string, side: "buyer" | "provider", senderLabel: string, note: string): Promise<void> {
  if (!["open", "requesting"].includes(row.state)) throw new DomainError("OFFER_CLOSED", "This offer already has a final decision.", 409, false);
  await appendOfferMessage(db, row, commandId, "offer.decline", side, senderLabel, note, row.latest_terms, []);
  await db.query("UPDATE guild_market_threads SET state='declined',updated_at=now() WHERE id=$1", [row.id]);
}
