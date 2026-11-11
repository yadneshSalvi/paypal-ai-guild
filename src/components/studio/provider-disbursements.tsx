"use client";
import { useState } from "react";
import { ArrowRight, CheckCheck, ChevronDown, Clock3, HandCoins, RefreshCw, WalletCards } from "lucide-react";
import type { Commission, ProviderPayoutView } from "@/contracts/guild";
import type { GuildPaymentCommand } from "@/contracts/payments";
import { Modal, money, when } from "./ui";

type Decision = { kind: "send" | "recover" | "cancel"; packageId: string; payoutId?: string };
const label = (status: string): string => ({ SUCCESS: "Provider award received", UNCLAIMED: "Awaiting recipient claim", PENDING: "Individual payout pending", PROCESSING: "Batch accepted · individual receipt pending", RETURNED: "Unclaimed award returned", REFUNDED: "Provider payout refunded", FAILED: "Payout failed · award remains due", DENIED: "Payout denied · award remains due", BLOCKED: "Payout blocked · review needed", NOT_SENT: "Not sent · review needed", PENDING_RECONCILIATION: "Outcome awaiting reconciliation", CLAIMED: "Saved · awaiting dispatch", DISPATCHING: "Sending original payout" } as Record<string, string>)[status] ?? status.replaceAll("_", " ").toLowerCase();

export function ProviderDisbursements({ c, busy, mayArrange, request, onNotice }: { c: Commission; busy: boolean; mayArrange: boolean; request: (command: GuildPaymentCommand) => Promise<{ commission: Commission }>; onNotice: (message: string) => void }) {
  const [decision, setDecision] = useState<Decision | null>(null), [error, setError] = useState<string | null>(null);
  const payouts = c.payments.payouts ?? [], packages = c.packages.filter(pkg => pkg.paymentState === "paid" || payouts.some(payout => payout.packageId === pkg.id && payout.contractVersion === pkg.contractVersion));
  const selected = c.packages.find(pkg => pkg.id === decision?.packageId);
  const selectedPayout = payouts.find(payout => payout.id === decision?.payoutId);
  const history = payouts.filter(payout => !c.packages.some(pkg => pkg.id === payout.packageId && pkg.contractVersion === payout.contractVersion));
  const open = (next: Decision) => { setError(null); setDecision(next); };
  const inspect = () => { void request({ type: "reconcile" }).catch(() => undefined); };
  const confirm = async () => {
    if (!decision || !selected) return; setError(null);
    const command: GuildPaymentCommand = decision.kind === "send" ? { type: "pay_provider", packageId: selected.id, expectedRevision: c.revision } : decision.kind === "recover" ? { type: "retry_payout", payoutId: selectedPayout!.id } : { type: "cancel_payout", payoutId: selectedPayout!.id };
    try { await request(command); setDecision(null); onNotice("The payout instruction is saved. Its individual provider outcome appears in the award record."); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Inspect the original payout before trying again."); }
  };
  return <section className="provider-disbursements"><div className="section-title"><div><p className="eyebrow">THE PEOPLE BEHIND THE WORK</p><h2>Provider disbursements</h2></div><HandCoins size={22}/></div><p>Each accepted award has its own receipt. Send the provider’s share after the buyer capture is confirmed; the disclosed service fee stays in the commission account.</p>
    {packages.length ? <div className="provider-payout-list">{packages.map(pkg => {
      const provider = c.providers.find(candidate => candidate.id === pkg.providerId), payout = payouts.find(candidate => candidate.packageId === pkg.id && candidate.contractVersion === pkg.contractVersion);
      return <article className="provider-payout-card" key={pkg.id}><span className="provider-monogram" style={{ background: provider?.color }}>{provider?.monogram}</span><div className="payout-meta"><strong>{provider?.name}</strong><small>{pkg.title} · contract {pkg.contractVersion}</small></div><strong>{money(pkg.providerAwardMinor)}</strong>
        <div className="payout-card-body"><span className={`payout-status ${payout?.status === "SUCCESS" ? "paid" : ""}`}>{payout?.status === "SUCCESS" ? <CheckCheck size={15}/> : payout ? <Clock3 size={15}/> : <HandCoins size={15}/>} {payout ? label(payout.status) : "Accepted award · ready to send"}</span>
          {payout?.errorCode && <p className="payout-note">{payout.errorCode === "PAYOUT_ITEM_BINDING" ? "The individual receipt did not match the original award. Reconciliation is still required." : ["PRIVATE_DOCUMENT_UNREADABLE", "PAYOUT_DOCUMENT_BINDING"].includes(payout.errorCode) ? "The private payment record needs review before another instruction can be sent." : "This instruction needs attention. Its original recipient and award remain saved."}</p>}
          {payout?.cancellationState && <p className="payout-note">Cancellation: {payout.cancellationState.replaceAll("_", " ")}</p>}
          <div className="payout-actions">{!payout && <button className="button" disabled={busy || !mayArrange} onClick={() => open({ kind: "send", packageId: pkg.id })}>Send {money(pkg.providerAwardMinor)} award <ArrowRight size={14}/></button>}{payout?.canRetry && <button className="text-button" disabled={busy || !mayArrange} onClick={() => open({ kind: "recover", packageId: pkg.id, payoutId: payout.id })}>Recover original payout <RefreshCw size={14}/></button>}{payout?.canCancel && <button className="text-button" disabled={busy || !mayArrange} onClick={() => open({ kind: "cancel", packageId: pkg.id, payoutId: payout.id })}>{payout.cancellationState ? "Recover original cancellation" : "Cancel unclaimed payout"}</button>}{payout && payout.operationState !== "succeeded" && <button className="text-button" disabled={busy} onClick={inspect}>Check status <RefreshCw size={13}/></button>}</div>
          {payout && <PayoutEvidence payout={payout} grossMinor={pkg.grossMinor} serviceFeeMinor={pkg.serviceFeeMinor}/>}
        </div></article>;
    })}</div> : <div className="provider-payout-empty"><WalletCards size={21}/><p>Provider awards become payable after accepted work has a confirmed buyer capture.</p></div>}
    {history.length > 0 && <details className="payout-history"><summary>Earlier contract payouts ({history.length})</summary>{history.map(payout => <article key={payout.id}><h3>{c.providers.find(provider => provider.id === payout.providerId)?.name} · {money(payout.amountMinor)}</h3><p>Contract {payout.contractVersion} · {label(payout.status)}</p><PayoutEvidence payout={payout}/></article>)}</details>}
    {decision && selected && <Modal title={decision.kind === "send" ? "An award for accepted work." : decision.kind === "recover" ? "Recover the original payout." : "Return an unclaimed award."} onClose={() => setDecision(null)}>
      <div className="payment-dialog-amount"><span>{c.providers.find(provider => provider.id === selected.providerId)?.name} · provider award</span><strong>{money(selected.providerAwardMinor)}<small>USD</small></strong></div><div className="approval-summary"><div><span>Accepted work</span><strong>{selected.title}</strong></div><div><span>Buyer capture</span><strong>{money(selected.grossMinor)}</strong></div><div><span>Service fee retained</span><strong>{money(selected.serviceFeeMinor)}</strong></div></div>
      <p>{decision.kind === "send" ? "Send this exact award to the provider’s registered controlled sandbox account. Guild will check the accepted contract, current Passport and confirmed capture immediately before sending." : decision.kind === "recover" ? "Recover the same saved payout, with its original recipient, amount and batch identity. An uncertain earlier submission remains reserved until PayPal identifies its individual result." : "PayPal must confirm this individual item is still unclaimed. A returned payout keeps the provider’s accepted award outstanding for a separate resolution."}</p>
      <div className="dialog-actions"><button className="button" onClick={() => setDecision(null)}>Return to the ledger</button><button className="button primary" disabled={busy} onClick={() => void confirm()}>{decision.kind === "send" ? `Send ${money(selected.providerAwardMinor)} award` : decision.kind === "recover" ? "Recover saved payout" : "Cancel unclaimed item"} <ArrowRight size={15}/></button></div>{error && <p className="form-error" role="alert">{error}</p>}
    </Modal>}
  </section>;
}

function PayoutEvidence({ payout, grossMinor, serviceFeeMinor }: { payout: ProviderPayoutView; grossMinor?: number; serviceFeeMinor?: number }) {
  return <details className="payout-receipt"><summary>View payout evidence <ChevronDown size={12}/></summary><dl><div><dt>Provider award</dt><dd>{money(payout.amountMinor)}</dd></div>{grossMinor !== undefined && <div><dt>Buyer capture</dt><dd>{money(grossMinor)}</dd></div>}{serviceFeeMinor !== undefined && <div><dt>Service fee retained</dt><dd>{money(serviceFeeMinor)}</dd></div>}<div><dt>PayPal payout fee</dt><dd>{payout.feeMinor === null ? "Not supplied" : money(payout.feeMinor)}</dd></div><div><dt>Individual item</dt><dd>{payout.resourceLabel ?? "Not yet identified"}</dd></div><div><dt>Transport</dt><dd>{payout.transport}</dd></div><div><dt>Last observation</dt><dd>{payout.observedAt ? when(payout.observedAt) : "Awaiting provider evidence"}</dd></div></dl><small>Provider payment is confirmed only by this exact individual item’s success.</small></details>;
}
