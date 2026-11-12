"use client";

import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from "react";
import type { MarketPackage, MarketPolicyDecision, MarketProvider, OfferTerms, ProviderMarketSnapshot, ProviderPolicy } from "@/contracts/provider-market";
import type { MarketController } from "./controller";
import { dateLabel, kindLabel, money, readable, safeHref, shortDigest, studioHref } from "./format";

export function Badge({ children, tone = "quiet" }: { children: ReactNode; tone?: "quiet" | "good" | "warning" | "bad" | "sample" }) {
  return <span className={`pm-badge pm-badge--${tone}`}>{children}</span>;
}
export function EmptyState({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="pm-empty"><span className="pm-empty-mark" aria-hidden="true">✳</span><h3>{title}</h3><p>{children}</p>{action}</div>;
}
export function MarketFrame({ controller, title, eyebrow, mode, children }: { controller: MarketController; title: string; eyebrow: string; mode: "buyer" | "provider"; children: ReactNode }) {
  const { snapshot, status, error } = controller;
  const studio = snapshot ? studioHref(snapshot) : "/";
  return <div className="pm-root">
    <header className="pm-topbar">
      <a className="pm-wordmark" href="/" aria-label="Guild home">guild<span aria-hidden="true">✳</span></a>
      <nav aria-label="Workspace"><a href={studio ?? "/"}>Commission studio</a><a href="/market" aria-current={mode === "buyer" ? "page" : undefined}>Provider market</a><a href="/provider" aria-current={mode === "provider" ? "page" : undefined}>Provider console</a></nav>
      <span className="pm-viewer" dir="auto">{snapshot?.viewer.label ?? "Guild workspace"}</span>
    </header>
    <main id="main" className="pm-main" tabIndex={-1}>
      <div className="pm-heading"><div><p className="pm-eyebrow">{eyebrow}</p><h1>{title}</h1><p className="pm-intro">{mode === "buyer" ? "Clear work. Accountable providers. Terms you can inspect before you delegate." : "Your service, your terms. Follow each request from first offer to accepted work."}</p></div>
        <button className="pm-button pm-button--quiet" disabled={controller.refreshing || status === "loading"} onClick={() => void controller.refresh()}><span aria-hidden="true">↻</span>{controller.refreshing ? "Refreshing…" : "Refresh state"}</button>
      </div>
      {snapshot ? <div className="pm-context"><span dir="auto">{snapshot.commission?.title ?? "Provider workspace"}</span><Badge tone={snapshot.syntheticFixture ? "sample" : "quiet"}>{snapshot.syntheticFixture ? "Sample · controlled fixture" : "Current workspace"}</Badge><span className="pm-context-time">Last confirmed <time dateTime={snapshot.serverTime}>{dateLabel(snapshot.serverTime)}</time></span></div> : null}
      {status === "error" && snapshot ? <div className="pm-notice pm-notice--warning" role="alert"><strong>Showing the last confirmed state.</strong><p>{error ?? "The latest state could not be loaded."} Changes are paused until the connection recovers.</p><button className="pm-text-button" onClick={() => void controller.refresh()}>Try loading again</button></div> : null}
      {status === "loading" && snapshot ? <p className="pm-inline-status" role="status">Loading current authority and provider state. Changes are paused.</p> : null}
      <CommandFeedback controller={controller}/>
      {!snapshot ? status === "loading" ? <div className="pm-loading" role="status"><p>Loading the provider workspace…</p><div className="pm-loading-grid" aria-hidden="true"><div/><div/><div/></div></div> : <EmptyState title="The workspace could not be opened" action={<button className="pm-button" onClick={() => void controller.refresh()}>Try again</button>}>{error ?? "No current workspace was returned. Reload to recover your saved work."}</EmptyState> : children}
      <footer className="pm-footer"><span className="pm-footer-mark" aria-hidden="true">g.</span><p>Good work, together.</p>{snapshot ? <span>{snapshot.disclosure}</span> : null}</footer>
    </main>
  </div>;
}
export function CommandFeedback({ controller }: { controller: MarketController }) {
  const pending = controller.pending;
  const originalCommandId = pending?.original?.command.commandId ?? pending?.command.commandId;
  const recoverable = originalCommandId ? controller.snapshot?.threads.flatMap(thread => thread.operations).find(operation => operation.commandId === originalCommandId && operation.canRecoverOriginal) : undefined;
  const conflict = controller.commandError && (controller.commandError.currentRevision !== undefined || /stale|revision|conflict/i.test(controller.commandError.code));
  return <div className="pm-feedback">
    {controller.notice ? <p className="pm-notice pm-notice--good" role="status">{controller.notice}</p> : null}
    {controller.commandError ? <div className="pm-notice pm-notice--warning" role="alert"><strong>{conflict ? "The saved version changed." : pending?.state === "unknown" ? "The result needs to be recovered." : "This change could not be completed."}</strong><p>{controller.commandError.message}</p>{conflict ? <p>Your unsaved edits are preserved. Compare them with the current server state before saving again.</p> : null}<details className="pm-evidence"><summary>Response details</summary><dl><dt>Code</dt><dd>{controller.commandError.code}</dd>{controller.commandError.currentRevision !== undefined ? <><dt>Current revision</dt><dd>{controller.commandError.currentRevision}</dd></> : null}</dl></details></div> : null}
    {pending ? <section className="pm-retained" aria-label="Original request recovery" aria-live="polite"><div><p className="pm-eyebrow">{pending.state === "sending" ? "Request in progress" : "Original request retained"}</p><h2>{pending.label}</h2><p>{pending.state === "sending" ? "Waiting for a confirmed result. Other changes are paused." : "Retrying sends this exact request and command ID. It does not create a second request."}</p></div><div className="pm-actions"><button className="pm-button" disabled={pending.state === "sending" || controller.status !== "ready"} onClick={() => void controller.retryOriginal()}>{pending.state === "sending" ? "Waiting for confirmation…" : "Recover same request"}</button>{recoverable && pending.command.type !== "recover_original" ? <button className="pm-button pm-button--quiet" disabled={!controller.canRecover(recoverable.id)} onClick={() => void controller.execute({ type: "recover_original", operationId: recoverable.id }, "Recover original provider result")}>Recover original provider result</button> : null}<button className="pm-text-button" disabled={controller.refreshing} onClick={() => void controller.refresh()}>Refresh current state</button></div><details className="pm-evidence"><summary>Retained request identity</summary><p className="pm-mono">{pending.command.commandId}</p><pre>{JSON.stringify(pending.command, null, 2)}</pre>{pending.original ? <><p>Original request retained during recovery</p><p className="pm-mono">{pending.original.command.commandId}</p><pre>{JSON.stringify(pending.original.command, null, 2)}</pre></> : null}</details></section> : null}
  </div>;
}
export function MoneyBreakdown({ award, fee, gross, compact = false }: { award: number; fee: number; gross: number; compact?: boolean }) {
  return <dl className={`pm-money${compact ? " pm-money--compact" : ""}`} aria-label="USD price breakdown"><div><dt>Provider award</dt><dd>{money(award)}</dd></div><div><dt>Service fee</dt><dd>{money(fee)}</dd></div><div className="pm-money-total"><dt>Customer gross</dt><dd>{money(gross)}</dd></div></dl>;
}
export function IdentityDetails({ entries, title = "Contract & source identity" }: { title?: string; entries: [string, string | number | null][] }) {
  return <details className="pm-evidence"><summary>{title}</summary><dl>{entries.map(([label, value]) => <div key={label}><dt>{label}</dt><dd className="pm-mono" dir="ltr">{value ?? "Not recorded"}</dd></div>)}</dl></details>;
}
export function PolicySummary({ policy, now }: { policy: ProviderPolicy; now: number }) {
  return <div className="pm-policy-summary"><div className="pm-inline-heading"><strong>Current owner policy</strong><Badge tone={Date.parse(policy.validUntil) > now ? "good" : "bad"}>Revision {policy.revision}{Date.parse(policy.validUntil) <= now ? " · expired" : ""}</Badge></div>
    <dl className="pm-facts"><div><dt>Minimum award</dt><dd>{money(policy.minimumAwardMinor)}</dd></div><div><dt>Asking award</dt><dd>{money(policy.askingAwardMinor)}</dd></div><div><dt>Working duration</dt><dd>{policy.workingHours} business hours</dd></div><div><dt>Concurrent tasks</dt><dd>Up to {policy.maximumConcurrentTasks}</dd></div><div><dt>Corrections included</dt><dd>{policy.correctionAllowance}</dd></div><div><dt>Counteroffer limit</dt><dd>{policy.counterofferLimit}</dd></div><div><dt>Allowed work</dt><dd>{policy.allowedKinds.map(kindLabel).join(", ")}</dd></div><div><dt>Valid until</dt><dd><time dateTime={policy.validUntil}>{dateLabel(policy.validUntil)}</time></dd></div></dl><p className="pm-content-rule" dir="auto"><strong>Content rules</strong> {policy.contentRules}</p><p className="pm-muted">{policy.disclosure}</p>
    <IdentityDetails title="Policy evidence" entries={[["Policy", policy.id], ["Owner", policy.ownerId], ["Revision", policy.revision], ["Digest", policy.digest], ["Previous digest", policy.previousDigest], ["Calendar", policy.calendarId], ["Recorded", policy.createdAt]]}/>
  </div>;
}
export function ProviderCard({ provider, now, action, selected = false }: { provider: MarketProvider; now: number; action?: ReactNode; selected?: boolean }) {
  const portfolio = safeHref(provider.portfolioUrl), card = safeHref(provider.cardUrl);
  const style = { "--pm-provider-color": /^#[a-fA-F0-9]{6}$/.test(provider.color) ? provider.color : "#dce3d2" } as CSSProperties;
  const free = Math.max(0, provider.capacity.maximum - provider.capacity.active - provider.capacity.reserved);
  return <article className={`pm-provider-card${selected ? " pm-provider-card--selected" : ""}`} style={style} aria-label={`${provider.displayName} provider`}>
    <div className="pm-provider-heading"><span className="pm-monogram" aria-hidden="true">{provider.monogram}</span><div><p className="pm-eyebrow" dir="auto">{provider.specialty}</p><h3 dir="auto">{provider.displayName}</h3><p className="pm-owner" dir="auto">Owned by {provider.ownerDisplayName}</p></div><Badge tone={provider.enrollment.state === "ready" ? "good" : ["revoked", "unavailable"].includes(provider.enrollment.state) ? "bad" : "warning"}>{readable(provider.enrollment.state)}</Badge></div>
    <div className="pm-provider-provenance"><Badge tone={provider.provenance.syntheticFixture ? "sample" : "quiet"}>{provider.provenance.syntheticFixture ? "Sample · " : ""}{provider.provenance.label}</Badge><span>{provider.provenance.kind === "guild_controlled_service" ? "Guild-operated service" : "External service"}</span></div>
    <p className="pm-provider-description" dir="auto">{provider.description}</p><div className="pm-kind-list">{provider.kinds.map(kind => <span key={kind}>{kindLabel(kind)}</span>)}</div>
    <div className="pm-capacity"><strong>{free} of {provider.capacity.maximum} slots available</strong><span>{provider.capacity.active} active · {provider.capacity.reserved} reserved</span></div>
    <p className="pm-enrollment-message" dir="auto">{provider.enrollment.message}</p>
    {provider.enrollment.requiredActions.length > 0 ? <ul className="pm-next-steps">{provider.enrollment.requiredActions.map((step, index) => <li key={`${index}-${step}`} dir="auto">{step}</li>)}</ul> : null}
    {provider.enrollment.lastFailure ? <p className="pm-field-error">Last discovery: {provider.enrollment.lastFailure}</p> : null}
    {provider.policy ? <details className="pm-card-details"><summary>Owner policy · minimum {money(provider.policy.minimumAwardMinor)}</summary><PolicySummary policy={provider.policy} now={now}/></details> : <p className="pm-muted">No owner policy has been published.</p>}
    <details className="pm-card-details"><summary>{provider.protocol.cardDigest ? "Observed discovery & service details" : "Discovery not yet confirmed"}</summary><dl className="pm-facts"><div><dt>Service owner</dt><dd dir="auto">{provider.ownerDisplayName}</dd></div><div><dt>Discovery observed</dt><dd>{provider.protocol.observedAt ? dateLabel(provider.protocol.observedAt) : "Not yet observed"}</dd></div><div><dt>Protocol advertised</dt><dd>A2A {provider.protocol.version} · {provider.protocol.binding}</dd></div><div><dt>Streaming advertised</dt><dd>{provider.protocol.streaming ? "Yes" : "No"}</dd></div><div><dt>Track record</dt><dd>{provider.history ? `${provider.history.accepted} accepted · ${provider.history.rejected} rejected` : "No verified history recorded"}</dd></div></dl><p className="pm-muted">{provider.history?.disclosure ?? "No rating is inferred from an unknown history."}</p><IdentityDetails title="Discovery evidence" entries={[["Provider", provider.id], ["Card digest", provider.protocol.cardDigest], ["Service endpoint", provider.endpoint], ["Specification", provider.protocol.specification]]}/><div className="pm-links">{card ? <a href={card} target="_blank" rel="noreferrer">Observed provider card <span aria-hidden="true">↗</span></a> : null}{portfolio ? <a href={portfolio} target="_blank" rel="noreferrer">Owner’s portfolio <span aria-hidden="true">↗</span></a> : null}</div></details>
    {action ? <div className="pm-card-action">{action}</div> : null}
  </article>;
}
export function PackageContract({ work }: { work: MarketPackage }) {
  return <article className="pm-contract"><p className="pm-eyebrow">The work contract · v{work.contractVersion}</p><h2 dir="auto">{work.title}</h2><p dir="auto">{work.description}</p><div className="pm-inline-heading"><Badge>{kindLabel(work.kind)}</Badge><Badge>{readable(work.state)}</Badge></div><div className="pm-contract-rule"/><h3>What counts as accepted work</h3>{work.criteria.length ? <ol className="pm-criteria">{work.criteria.map((criterion, index) => <li key={criterion.id}><span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span><div><strong dir="auto">{criterion.label}</strong><p>{criterion.blocking ? "Required" : "Advisory"} · {criterion.kind === "human" ? "Human review" : criterion.kind === "deterministic" ? "Deterministic check" : "Advisory review"}</p></div></li>)}</ol> : <p className="pm-muted">Acceptance criteria have not been published. Review the contract in the studio.</p>}
    <div className="pm-contract-bound"><span>Available for this package</span><strong>{money(work.availableGrossMinor)} <small>customer gross</small></strong><p>Original work authority ends <time dateTime={work.workAuthorityExpiresAt}>{dateLabel(work.workAuthorityExpiresAt)}</time>.</p></div>
    <IdentityDetails entries={[["Package", work.id], ["Contract version", work.contractVersion], ["Contract digest", work.contractDigest], ["Acceptance pack", work.acceptancePackDigest], ["Source digest", work.sourceDigest], ["Allowed providers", work.allowedProviderIds.join(", ")]]}/>
  </article>;
}
export function TermsSummary({ terms, termsDigest, title = "Exact offer terms" }: { terms: OfferTerms; termsDigest: string | null; title?: string }) {
  return <section className="pm-terms" aria-label={title}><div className="pm-inline-heading"><h3>{title}</h3><Badge>USD</Badge></div><MoneyBreakdown award={terms.providerAwardMinor} fee={terms.serviceFeeMinor} gross={terms.grossMinor}/><dl className="pm-facts"><div><dt>Working duration</dt><dd>{terms.workingHours} business hours</dd></div><div><dt>Calendar</dt><dd>Museum weekdays</dd></div><div><dt>Corrections included</dt><dd>{terms.correctionAllowance}</dd></div><div><dt>Quote expires</dt><dd><time dateTime={terms.expiresAt}>{dateLabel(terms.expiresAt)}</time></dd></div><div><dt>Work authority ends</dt><dd><time dateTime={terms.workAuthorityExpiresAt}>{dateLabel(terms.workAuthorityExpiresAt)}</time></dd></div></dl><IdentityDetails title={`Offer identity · ${shortDigest(termsDigest)}`} entries={[["Terms digest", termsDigest], ["Provider", terms.providerId], ["Package", terms.packageId], ["Work kind", terms.kind], ["Contract version", terms.contractVersion], ["Contract digest", terms.contractDigest], ["Acceptance pack", terms.acceptancePackDigest], ["Source digest", terms.sourceDigest], ["Provider policy revision", terms.providerPolicyRevision], ["Provider policy digest", terms.providerPolicyDigest], ["Calendar", terms.calendarId]]}/></section>;
}
export function PolicyDecisions({ decisions }: { decisions: MarketPolicyDecision[] }) {
  return <div className="pm-decisions" aria-label="Buyer and provider policy decisions">{(["buyer", "provider"] as const).map(side => {
    const entries = decisions.filter(decision => decision.side === side);
    return <div key={side} className="pm-decision-side"><strong>{side === "buyer" ? "Buyer policy" : "Provider policy"}</strong>{entries.length ? entries.map((decision, index) => <div className={`pm-decision pm-decision--${decision.allowed ? "allowed" : "refused"}`} key={`${decision.policyId}-${index}`}><Badge tone={decision.allowed ? "good" : "bad"}>{decision.allowed ? "Allowed" : "Refused"}</Badge><p dir="auto">{decision.reason}</p><IdentityDetails title={`Decision evidence · revision ${decision.policyRevision}`} entries={[["Code", decision.code], ["Policy", decision.policyId], ["Revision", decision.policyRevision], ["Policy digest", decision.policyDigest], ["Checked", decision.checkedAt]]}/></div>) : <p className="pm-muted">No decision recorded for this message.</p>}</div>;
  })}</div>;
}
export function ReviewDialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null), titleId = useId();
  useEffect(() => {
    const dialog = ref.current, previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog) return;
    if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
    const first = dialog.querySelector<HTMLElement>("button, [href], input, textarea, select, [tabindex='0']"); first?.focus();
    return () => { if (typeof dialog.close === "function" && dialog.open) dialog.close(); previous?.focus(); };
  }, []);
  return <dialog ref={ref} className="pm-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => {
    if (event.key === "Escape") { event.preventDefault(); onClose(); }
    if (event.key !== "Tab") return;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary, [tabindex='0']")].filter(item => {
      if (item.hidden || item.matches(":disabled") || item.closest('[hidden], [aria-hidden="true"]')) return false;
      for (let ancestor = item.parentElement; ancestor && ancestor !== event.currentTarget; ancestor = ancestor.parentElement) {
        if (ancestor.tagName === "DETAILS" && !ancestor.hasAttribute("open")) {
          const summary = [...ancestor.children].find(child => child.tagName === "SUMMARY");
          if (!summary?.contains(item)) return false;
        }
      }
      return true;
    });
    const first = items[0], last = items.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }}><div className="pm-dialog-heading"><div><p className="pm-eyebrow">Review before you decide</p><h2 id={titleId}>{title}</h2></div><button className="pm-icon-button" aria-label="Close offer review" onClick={onClose}>×</button></div>{children}</dialog>;
}
