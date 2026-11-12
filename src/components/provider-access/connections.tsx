"use client";

import { useEffect, useRef, useState } from "react";
import { agentIssueCredentialCommandSchema, type AgentAccessCommand, type AgentAccessScope, type AgentScope, type ProtocolClientSummary } from "@/contracts/provider-access";
import type { AgentAccessTransport } from "./transport";
import { localDateInput, scopeText, viewerKey } from "./state";
import { useAgentAccess } from "./use-agent-access";
import { AccessBadge, AccessDate, AccessDialog, AccessEmpty, AccessError, AccessFrame, AccessLoading, EndpointInstructions, ScopeBadges } from "./shared";

export interface AgentConnectionsProps { scope: AgentAccessScope; commissionId?: string; transport?: AgentAccessTransport }
type Review = { owner: string; command: AgentAccessCommand; credential?: ProtocolClientSummary };
export function AgentConnections({ scope, commissionId, transport }: AgentConnectionsProps) {
  const model = useAgentAccess(scope, transport), { snapshot } = model;
  const [label, setLabel] = useState(""), [scopes, setScopes] = useState<AgentScope[]>([]), [expiry, setExpiry] = useState("");
  const [review, setReview] = useState<Review | null>(null), [agreed, setAgreed] = useState(false), [formError, setFormError] = useState<string | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null), [revealed, setRevealed] = useState(false), [copyMessage, setCopyMessage] = useState<string | null>(null);
  const formOwner = useRef<string | null>(null), tokenHeading = useRef<HTMLHeadingElement>(null);
  const owner = snapshot ? viewerKey(snapshot) : null;
  useEffect(() => {
    if (!snapshot || owner === formOwner.current) return;
    formOwner.current = owner; setLabel(""); setScopes([]); setExpiry(localDateInput(new Date(Math.min(Date.parse(snapshot.viewer.sessionExpiresAt), Date.parse(snapshot.serverTime) + 3_600_000)).toISOString()));
    setReview(null); setFormError(null); setDialogError(null); setRevealed(false); setCopyMessage(null);
  }, [owner, snapshot]);
  useEffect(() => { if (model.token) { setRevealed(false); setCopyMessage(null); tokenHeading.current?.focus(); } }, [model.token]);
  const expired = !!snapshot && Date.parse(snapshot.viewer.sessionExpiresAt) <= model.now;
  const lostOriginal = model.lostCredentialId ? snapshot?.credentials.find(item => item.id === model.lostCredentialId && !item.revokedAt && item.state === "active" && Date.parse(item.expiresAt) > model.now) : null;
  const paused = model.busy || model.status !== "ready" || !!model.pending || !!model.storageError || expired;
  const canIssue = !!snapshot?.permissions.issue && !paused && !lostOriginal;
  const canRevoke = !!snapshot?.permissions.revoke && !paused;

  function reviewIssue(): void {
    if (!snapshot || !canIssue) return;
    const date = Date.parse(expiry);
    if (!Number.isFinite(date) || date <= model.now || date > Date.parse(snapshot.viewer.sessionExpiresAt)) { setFormError("Choose an absolute expiry after the current time and within your original session ceiling."); return; }
    const parsed = agentIssueCredentialCommandSchema.safeParse({ type: "issue_credential", commandId: globalThis.crypto.randomUUID(), label, scopes, expiresAt: new Date(date).toISOString() });
    if (!parsed.success || scopes.some(scope => !snapshot.allowedScopes.includes(scope))) { setFormError("Choose a label and at least one permitted scope. Provider negotiation and cancellation require read access."); return; }
    setFormError(null); setDialogError(null); setAgreed(false); setReview({ owner: viewerKey(snapshot), command: parsed.data });
  }
  function reviewRevoke(credential: ProtocolClientSummary): void {
    if (!snapshot || !canRevoke || !credential.canRevoke) return;
    setDialogError(null); setAgreed(false); setReview({ owner: viewerKey(snapshot), command: { type: "revoke_credential", commandId: globalThis.crypto.randomUUID(), clientId: credential.id }, credential });
  }
  const reviewedClientId = review?.command.type === "revoke_credential" ? review.command.clientId : null;
  const reviewCurrent = !!review && !!snapshot && review.owner === owner && model.status === "ready" && !model.pending && !model.storageError && !expired
    && (review.command.type === "issue_credential" ? canIssue && Date.parse(review.command.expiresAt) > model.now && Date.parse(review.command.expiresAt) <= Date.parse(snapshot.viewer.sessionExpiresAt) && review.command.scopes.every(item => snapshot.allowedScopes.includes(item))
      : canRevoke && !!snapshot.credentials.find(item => item.id === reviewedClientId && item.canRevoke));
  async function confirm(): Promise<void> {
    if (!review || !agreed || !reviewCurrent || model.busy) return;
    const outcome = await model.execute(review.command);
    if (outcome === "paused") setDialogError("Current authority or original request storage could not be confirmed. Keep this review and refresh access before sending.");
    else setReview(null);
  }

  return <AccessFrame scope={scope} commissionId={commissionId} title={scope === "provider" ? "An agent for your workshop." : "Connect an agent."} eyebrow={scope === "provider" ? "Provider connections · your service only" : "Agent connections · your original buyer authority"}
    intro={scope === "provider" ? "Give an agent a deliberate role in your own requests and tasks, under a fixed expiry." : "Choose the tools an agent can use, review its access, and keep a clear record of every credential."}
    viewer={snapshot?.viewer.label} busy={model.busy || model.status === "loading"} refresh={() => void model.refresh()}>
    {model.status === "loading" && !snapshot ? <AccessLoading/> : null}
    {model.error ? <AccessError message={model.error} title={snapshot ? "Current access needs attention." : "Your access settings could not be opened."}/> : null}
    {model.storageError ? <AccessError message={model.storageError} title="Original request storage needs attention."/> : null}
    {model.notice ? <p className="pm-notice pm-notice--good" role="status">{model.notice}</p> : null}
    {model.status === "loading" && snapshot ? <p className="pm-inline-status" role="status">Loading current access. Changes are paused.</p> : null}
    {model.status === "error" && snapshot ? <p className="pm-disabled-reason">Showing the last confirmed credential summaries. Refresh access before changing them.</p> : null}
    {snapshot ? <>
      <div className="pa-context"><AccessBadge tone={scope === "provider" ? "good" : "quiet"}>{scope === "provider" ? "Separate provider session" : "Customer session"}</AccessBadge><strong dir="auto">{snapshot.viewer.providerBinding?.displayName ?? snapshot.viewer.label}</strong><span>Original session ends <AccessDate value={snapshot.viewer.sessionExpiresAt}/></span></div>
      {expired ? <AccessError title="Your original session has expired." message="Credential issuance and revocation are paused. Returning here or retrying a request cannot extend the original session."/> : null}
      {model.pending ? <section className="pa-original" aria-labelledby="pa-command-recovery"><p className="pm-eyebrow">Original request retained</p><h2 id="pa-command-recovery">{model.pending.command.type === "issue_credential" ? "Recover the original issuance." : "Confirm the original revocation."}</h2><p>{model.busy ? "Waiting for the original response. Other changes are paused." : "Read the saved command’s status. Recovery returns a credential summary; it never issues another token."}</p>
        {model.recovery ? <p role="status">{model.recovery}</p> : null}
        <div className="pm-actions"><button className="pm-button" disabled={model.busy || model.status !== "ready" || expired} onClick={() => void model.checkOriginal()}>{model.busy ? "Checking original result…" : "Check original request"}</button></div>
        <details className="pm-evidence"><summary>Original command identity and review</summary><p className="pm-mono">{model.pending.command.commandId}</p>{model.pending.command.type === "issue_credential" ? <><p dir="auto">{model.pending.command.label}</p><ScopeBadges scopes={model.pending.command.scopes}/><p>Requested absolute expiry <AccessDate value={model.pending.command.expiresAt}/></p></> : <p className="pm-mono">Credential {model.pending.command.clientId}</p>}</details>
      </section> : null}
      {model.token ? <section className="pa-token" aria-labelledby="pa-token-heading"><p className="pm-eyebrow">One-time credential delivery</p><h2 id="pa-token-heading" ref={tokenHeading} tabIndex={-1}>Save this token privately.</h2><p>The token is available in this page’s memory once. Reloading, leaving or clearing this page removes it. The saved credential list contains only its summary.</p>
        <label className="pm-sr-only" htmlFor="pa-one-time-token">One-time bearer token</label><input id="pa-one-time-token" readOnly type={revealed ? "text" : "password"} value={model.token.value} autoComplete="off" spellCheck={false} aria-describedby="pa-token-expiry"/>
        <p id="pa-token-expiry" className="pa-quiet-note">Expires <AccessDate value={model.token.credential.expiresAt}/>.</p><div className="pm-actions"><button className="pm-button" disabled={model.busy} onClick={() => setRevealed(value => !value)}>{revealed ? "Hide token" : "Reveal token"}</button><button className="pm-button" disabled={model.busy} onClick={() => {
          if (!navigator.clipboard) { setCopyMessage("Clipboard is unavailable. Reveal the token and copy it privately."); return; }
          void navigator.clipboard.writeText(model.token!.value).then(() => setCopyMessage("Token copied. Keep it on your agent’s trusted server."), () => setCopyMessage("Copy is unavailable. Reveal the token and copy it privately."));
        }}>Copy token</button><button className="pm-text-button" disabled={model.busy} onClick={() => { model.clearToken(); setRevealed(false); }}>Clear token from this page</button></div>{copyMessage ? <p className="pa-quiet-note" role="status">{copyMessage}</p> : null}
      </section> : null}
      <div className="pa-layout"><section className="pa-panel" aria-labelledby="pa-create-heading"><p className="pm-eyebrow">A deliberate grant of access</p><h2 id="pa-create-heading">Create a credential</h2><p>Choose an agent label, its exact scopes and an absolute end time. You will review these before a token is issued.</p>
        {lostOriginal ? <p className="pm-disabled-reason">The original token for “{lostOriginal.label}” is unavailable. Revoke that credential below before reviewing its replacement.</p> : null}
        <form aria-label="New agent credential" noValidate onSubmit={event => { event.preventDefault(); reviewIssue(); }}><fieldset disabled={!canIssue} className="pa-form-fields"><div className="pa-form-field"><label htmlFor="pa-agent-label">Agent label</label><input id="pa-agent-label" name="label" value={label} onChange={event => setLabel(event.target.value)} maxLength={80} autoComplete="off" placeholder="For example, research assistant" required/></div>
          <fieldset className="pa-scopes"><legend>Allowed scopes · choose explicitly</legend>{snapshot.allowedScopes.map(scopeName => { const dependent = scopeName === "provider:negotiate" || scopeName === "provider:cancel", readRequired = scopeName === "provider:read" && scopes.some(item => item === "provider:negotiate" || item === "provider:cancel");
            return <label className="pa-scope" key={scopeName}><input type="checkbox" name="scopes" value={scopeName} checked={scopes.includes(scopeName)} disabled={dependent && !scopes.includes("provider:read") || readRequired} onChange={event => setScopes(current => event.target.checked ? [...current, scopeName] : current.filter(item => item !== scopeName))}/><span><strong>{scopeText[scopeName].title}{readRequired ? " · required by selected scopes" : ""}</strong><small>{scopeText[scopeName].description}</small></span></label>;
          })}</fieldset>
          <div className="pa-form-field"><label htmlFor="pa-agent-expiry">Absolute credential expiry</label><input id="pa-agent-expiry" name="expiresAt" type="datetime-local" step="1" value={expiry} max={localDateInput(snapshot.viewer.sessionExpiresAt)} onChange={event => setExpiry(event.target.value)} aria-describedby="pa-expiry-ceiling" required/><small id="pa-expiry-ceiling">Your original session ceiling is <AccessDate value={snapshot.viewer.sessionExpiresAt}/>. The credential cannot outlive it.</small></div>
          {formError ? <p className="pm-field-error" role="alert">{formError}</p> : null}<button className="pm-button pm-button--primary" type="submit">Review credential</button></fieldset></form>
      </section><aside className="pa-panel pa-sticky"><p className="pm-eyebrow">Access with an accountable owner</p><h2>{scope === "provider" ? "Your workshop stays yours." : "Your decisions stay yours."}</h2><p>{scope === "provider" ? "Provider agents use the named Guild provider agent API, bound to this workshop and the exact scopes you choose." : "An agent acts under your current buyer authority. Human Passport approval and work acceptance remain deliberate actions."}</p><div className="pa-boundaries"><h3>Clear boundaries</h3><ul>{scope === "provider" ? <><li>Read, negotiate and eligible cancellation apply only to this provider’s own work.</li><li>Agents cannot edit the owner profile/policy or issue credentials.</li><li>Buyer delegation, approval, acceptance and payment stay outside these provider scopes.</li></> : <><li>MCP exposes commission creation, status and an approval link.</li><li>A2A uses declared contract-bound actions and original work authority.</li><li>Credential access never substitutes for the original human approval or acceptance.</li></>}</ul></div><p className="pa-quiet-note" dir="auto">{snapshot.disclosure}</p></aside></div>
      <section className="pa-credentials" aria-labelledby="pa-saved-heading"><div className="pm-section-heading"><div><p className="pm-eyebrow">Your access register</p><h2 id="pa-saved-heading">Credential summaries</h2></div><span className="pa-section-count">{snapshot.credentials.length} retained</span></div><p className="pm-section-description">Tokens are never returned in this list. Revocation keeps the original record and its expiry.</p>
        {snapshot.credentials.length ? <div className="pa-credential-list">{snapshot.credentials.map(client => { const state = client.revokedAt ? "revoked" : client.state === "expired" || Date.parse(client.expiresAt) <= model.now ? "expired" : "active";
          return <article key={client.id} className="pa-credential" aria-label={`${client.label} credential`}><header><div><h3 dir="auto">{client.label}</h3><p className="pm-mono">{client.prefix}…</p></div><AccessBadge tone={state === "active" ? "good" : state === "revoked" ? "bad" : "warning"}>{state === "active" ? "Active" : state === "revoked" ? "Revoked" : "Expired"}</AccessBadge></header><ScopeBadges scopes={client.scopes}/>
            <p className="pa-target">{client.providerId ? <><strong>{client.scope === "customer" ? "Retained target restriction" : "Provider binding"}:</strong> <span dir="auto">{client.providerId}</span></> : "Customer access follows the exact chosen scopes and current owner authority."}</p>
            <dl className="pa-deadlines"><div><dt>Issued</dt><dd><AccessDate value={client.issuedAt}/></dd></div><div><dt>Original expiry</dt><dd><AccessDate value={client.expiresAt}/></dd></div>{client.revokedAt ? <div><dt>Revoked</dt><dd><AccessDate value={client.revokedAt}/></dd></div> : null}</dl>
            <details className="pm-evidence"><summary>Permitted actions and original identity</summary><ul>{client.permittedActions.map(action => <li key={action} dir="auto">{action}</li>)}</ul><dl><div><dt>Credential</dt><dd>{client.id}</dd></div><div><dt>Original actor</dt><dd>{client.actorId}</dd></div></dl></details><div className="pa-credential-actions"><p className="pm-muted">{client.id === model.token?.credential.id ? "One-time token is available above in this page only." : "Token unavailable. Revoke this credential before issuing a replacement."}</p><button className="pm-button pm-button--quiet" disabled={!canRevoke || !client.canRevoke || state === "revoked"} onClick={() => reviewRevoke(client)}>Revoke {client.label}</button></div></article>;
        })}</div> : <AccessEmpty title="No credentials yet.">Start with the smallest scopes your agent needs. Every issuance begins with your review.</AccessEmpty>}
      </section><EndpointInstructions endpoints={snapshot.endpoints} busy={model.busy}/>
    </> : model.status === "error" ? <AccessEmpty title="Return to your original workspace." action={<a href={scope === "provider" ? "/provider" : "/"} className="pm-button">{scope === "provider" ? "Open provider console" : "Open buyer workspace"}</a>}>Open the original session for this role, then refresh these settings.</AccessEmpty> : null}
    {review ? <AccessDialog title={review.command.type === "issue_credential" ? "Review agent access" : `Revoke ${review.credential?.label ?? "this credential"}`} busy={model.busy} onClose={() => setReview(null)}>
      {review.command.type === "issue_credential" ? <><p>Issue one credential for <strong dir="auto">{review.command.label}</strong> under the original {scope === "provider" ? "provider" : "customer"} session.</p><ScopeBadges scopes={review.command.scopes}/><dl className="pa-review-facts"><div><dt>Original owner</dt><dd dir="auto">{snapshot?.viewer.label}</dd></div>{snapshot?.viewer.providerBinding ? <div><dt>Exact provider</dt><dd dir="auto">{snapshot.viewer.providerBinding.displayName}</dd></div> : null}<div><dt>Requested absolute expiry</dt><dd><AccessDate value={review.command.expiresAt}/></dd></div></dl></>
        : <><p>Revoke the exact credential <strong dir="auto">{review.credential?.label}</strong>. Its retained original identity and operation history remain available.</p><dl className="pa-review-facts"><div><dt>Credential</dt><dd className="pm-mono">{review.command.clientId}</dd></div>{review.credential ? <div><dt>Original expiry</dt><dd><AccessDate value={review.credential.expiresAt}/></dd></div> : null}</dl></>}
      <label className="pa-agree"><input type="checkbox" checked={agreed} disabled={model.busy} onChange={event => setAgreed(event.target.checked)}/><span>{review.command.type === "issue_credential" ? "I reviewed these exact scopes and expiry. I understand the token is delivered once and must be kept private." : "I understand this revokes this exact credential and does not issue a replacement."}</span></label>
      {!reviewCurrent && !model.busy ? <p className="pm-disabled-reason">Current authority changed or an original request needs recovery. Close this review and refresh access.</p> : null}{dialogError ? <AccessError message={dialogError}/> : null}
      <div className="pm-actions"><button className="pm-button pm-button--quiet" disabled={model.busy} onClick={() => setReview(null)}>Keep reviewing</button><button className={`pm-button ${review.command.type === "revoke_credential" ? "pm-button--danger" : "pm-button--primary"}`} disabled={!agreed || !reviewCurrent || model.busy} onClick={() => void confirm()}>{model.busy ? "Waiting for original result…" : review.command.type === "issue_credential" ? "Issue this credential" : "Revoke this credential"}</button></div>
    </AccessDialog> : null}
  </AccessFrame>;
}
