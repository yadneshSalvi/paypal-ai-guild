"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { AgentEndpointInstruction, AgentScope } from "@/contracts/provider-access";
import { formatTime, safeEndpoint, scopeText, uuidPattern } from "./state";
import "../provider-market/provider-market.css";
import "./provider-access.css";

export function AccessFrame({ scope, title, eyebrow, intro, viewer, commissionId, busy = false, refresh, children }: {
  scope: "customer" | "provider" | "invitation"; title: string; eyebrow: string; intro: string; viewer?: string; commissionId?: string;
  busy?: boolean; refresh?: () => void; children: ReactNode;
}) {
  const context = commissionId && uuidPattern.test(commissionId) ? commissionId : null;
  const query = context ? `?commission=${encodeURIComponent(context)}` : "";
  return <div className="pm-root pa-root"><a className="pa-skip" href="#main">Skip to access settings</a>
    <header className="pm-topbar"><a className="pm-wordmark" href="/" aria-label="Guild home">guild<span aria-hidden="true">✳</span></a>
      <nav aria-label="Workspace"><a href={context ? `/${query}` : "/"}>Commission studio</a><a href={`/market${query}`}>Provider market</a><a href="/provider">Provider console</a><a href={scope === "provider" ? `/provider/connections${query}` : `/connections${query}`} aria-current={scope !== "invitation" ? "page" : undefined}>Agent connections</a></nav>
      <span className="pm-viewer" dir="auto">{viewer ?? (scope === "invitation" ? "Provider invitation" : "Your original workspace")}</span></header>
    <main id="main" className="pm-main pa-main" tabIndex={-1}><div className="pm-heading"><div><p className="pm-eyebrow">{eyebrow}</p><h1>{title}</h1><p className="pm-intro">{intro}</p></div>
      {refresh ? <button className="pm-button pm-button--quiet" disabled={busy} onClick={refresh}><span aria-hidden="true">↻</span>Refresh access</button> : null}</div>
      {children}
      <footer className="pm-footer"><span className="pm-footer-mark" aria-hidden="true">g.</span><p>Good work, together.</p><span>Access has a clear owner, a clear scope and an original expiry.</span></footer>
    </main></div>;
}
export function AccessBadge({ children, tone = "quiet" }: { children: ReactNode; tone?: "quiet" | "good" | "warning" | "bad" | "sample" }) { return <span className={`pm-badge pm-badge--${tone}`}>{children}</span>; }
export function AccessDate({ value }: { value: string }) { return <time dateTime={value}>{formatTime(value)}</time>; }
export function AccessError({ message, title = "This action could not be confirmed.", children }: { message: string; title?: string; children?: ReactNode }) {
  return <div className="pm-notice pm-notice--warning" role="alert"><strong>{title}</strong><p>{message}</p>{children}</div>;
}
export function AccessLoading({ label = "Loading your access settings…" }: { label?: string }) { return <div className="pm-loading" role="status"><p>{label}</p><div className="pm-loading-grid" aria-hidden="true"><div/><div/></div></div>; }
export function AccessEmpty({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) { return <div className="pm-empty"><span className="pm-empty-mark" aria-hidden="true">✳</span><h2>{title}</h2><p>{children}</p>{action}</div>; }
export function ScopeBadges({ scopes }: { scopes: AgentScope[] }) { return <div className="pa-scope-badges">{scopes.map(scope => <AccessBadge key={scope}>{scopeText[scope].title}</AccessBadge>)}</div>; }
export function AccessDialog({ title, busy = false, children, onClose }: { title: string; busy?: boolean; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null), titleId = useId();
  useEffect(() => {
    const dialog = ref.current, previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog) return;
    if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
    dialog.querySelector<HTMLElement>("input:not([disabled]), button:not([disabled]), [tabindex='0']")?.focus();
    return () => { if (dialog.open && typeof dialog.close === "function") dialog.close(); previous?.focus(); };
  }, []);
  return <dialog ref={ref} className="pm-dialog pa-dialog" tabIndex={-1} aria-labelledby={titleId} aria-busy={busy} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} onKeyDown={event => {
    if (event.key === "Escape") { event.preventDefault(); if (!busy) onClose(); }
    if (event.key !== "Tab") return;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex='0']")].filter(item => !item.hidden && !item.closest("[hidden], [aria-hidden='true']"));
    const first = items[0], last = items.at(-1);
    if (!first) { event.preventDefault(); event.currentTarget.focus(); }
    else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }}><div className="pm-dialog-heading"><div><p className="pm-eyebrow">Review your access</p><h2 id={titleId}>{title}</h2></div><button className="pm-icon-button" disabled={busy} aria-label="Close access review" onClick={onClose}>×</button></div>{children}</dialog>;
}
export function CopyValue({ value, label, disabled = false }: { value: string; label: string; disabled?: boolean }) {
  const [message, setMessage] = useState<string | null>(null);
  return <div className="pa-copy"><code dir="ltr">{value}</code><button className="pm-button pm-button--quiet" disabled={disabled} onClick={() => {
    void navigator.clipboard?.writeText(value).then(() => setMessage("Copied."), () => setMessage("Copy is unavailable. Select the value and copy it manually."));
    if (!navigator.clipboard) setMessage("Copy is unavailable. Select the value and copy it manually.");
  }}>{label}</button>{message ? <span className="pm-muted" role="status">{message}</span> : null}</div>;
}
export function EndpointInstructions({ endpoints, busy }: { endpoints: AgentEndpointInstruction[]; busy: boolean }) {
  return <section className="pa-endpoints" aria-labelledby="pa-endpoints-heading"><div className="pm-section-heading"><div><p className="pm-eyebrow">Connect with the right API</p><h2 id="pa-endpoints-heading">Connection instructions</h2></div></div>
    <p className="pm-section-description">Use a Bearer credential with only the scopes you chose. Keep it on your agent’s trusted server.</p>
    <div className="pa-endpoint-grid">{endpoints.map(endpoint => { const url = safeEndpoint(endpoint.url), discovery = endpoint.discoveryUrl ? safeEndpoint(endpoint.discoveryUrl) : null;
      return <article className="pa-endpoint" key={endpoint.id}><AccessBadge>{endpoint.protocol}</AccessBadge><h3 dir="auto">{endpoint.name}</h3><ScopeBadges scopes={endpoint.scopes}/>
        {url ? <CopyValue value={url} label="Copy endpoint" disabled={busy}/> : <p className="pm-disabled-reason">This endpoint could not be verified.</p>}
        {discovery ? <details className="pm-evidence"><summary>Discovery address</summary><CopyValue value={discovery} label="Copy discovery URL" disabled={busy}/></details> : null}
        <h4>Permitted actions</h4><ul>{endpoint.allowedActions.map(action => <li key={action} dir="auto">{action}</li>)}</ul><p className="pm-muted" dir="auto">{endpoint.disclosure}</p>
      </article>;
    })}</div>
  </section>;
}
