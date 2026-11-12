"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProviderClaim, ProviderClaimResult, ProviderInvitationPreview } from "@/contracts/provider-access";
import { AccessFailure, invitationTransport, type InvitationTransport } from "./transport";
import { challengeDigest, readClaim, saveClaim, useServerClock, uuidPattern, type RetainedClaim } from "./state";
import { AccessBadge, AccessDate, AccessDialog, AccessEmpty, AccessError, AccessFrame, AccessLoading } from "./shared";

export interface ProviderInvitationAccessProps { invitationId: string; transport?: InvitationTransport }
export function ProviderInvitationAccess({ invitationId, transport: supplied }: ProviderInvitationAccessProps) {
  const transport = useMemo(() => supplied ?? invitationTransport(), [supplied]);
  const [challenge, setChallenge] = useState<string | null>(null), [digest, setDigest] = useState<string | null>(null);
  const [linkRevision, setLinkRevision] = useState(0);
  const [preview, setPreview] = useState<ProviderInvitationPreview | null>(null), [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [saved, setSaved] = useState<RetainedClaim | null>(null), [storageError, setStorageError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null), [unknown, setUnknown] = useState(false), [busy, setBusy] = useState(false);
  const [review, setReview] = useState(false), [agreed, setAgreed] = useState(false), [result, setResult] = useState<ProviderClaimResult | null>(null);
  const active = useRef(false), generation = useRef(0), original = useRef<ProviderClaim | null>(null), recoveryHeading = useRef<HTMLHeadingElement>(null);
  const now = useServerClock(preview?.serverTime);
  const currentTime = useRef(now); currentTime.current = now;
  const privateMessage = useCallback((message: string) => challenge ? message.replaceAll(challenge, "[private invitation]") : message, [challenge]);

  useEffect(() => {
    const read = () => {
      generation.current++; original.current = null; setPreview(null); setResult(null); setReview(false); setUnknown(false); setDigest(null); setSaved(null); setStorageError(null); setError(null);
      setLinkRevision(value => value + 1);
      const parameters = new URLSearchParams(window.location.hash.slice(1)), values = parameters.getAll("challenge");
      const value = values.length === 1 && /^[A-Za-z0-9_-]{32,256}$/.test(values[0] ?? "") ? values[0]! : null;
      setChallenge(value);
      if (!value || !uuidPattern.test(invitationId)) { setStatus("error"); setError("Open the original invitation link with its private invitation fragment. No access has been opened."); }
      else if (active.current) { setStatus("error"); setError("The invitation link changed while the original claim was awaiting a response. Reopen its original link to recover the same session. Your original request remains saved."); }
      else setStatus("loading");
    };
    read(); window.addEventListener("hashchange", read);
    return () => { generation.current++; window.removeEventListener("hashchange", read); };
  }, [invitationId]);

  const refresh = useCallback(async () => {
    if (!challenge || !uuidPattern.test(invitationId) || active.current) return;
    const current = ++generation.current; setStatus("loading"); setError(null);
    try {
      const hash = await challengeDigest(challenge);
      if (generation.current !== current) return;
      setDigest(hash);
      try {
        const retained = readClaim(invitationId);
        if (retained && retained.challengeDigest !== hash) throw new Error("This link differs from the saved original claim. Open the original invitation link to recover that same session.");
        setSaved(retained); setStorageError(null);
      } catch (failure) { setStorageError(failure instanceof Error ? privateMessage(failure.message) : "The original claim could not be retained in this browser."); }
      const value = await transport.preview(invitationId, challenge);
      if (generation.current !== current) return;
      if (value.invitationId !== invitationId) throw new Error("The invitation response belongs to a different invitation.");
      setPreview(value); setStatus("ready");
    } catch (failure) {
      if (generation.current !== current) return;
      setStatus("error"); setError(failure instanceof AccessFailure ? privateMessage(failure.detail.message) : "The invitation could not be verified. Retry this preview read to recover its current state.");
    }
  }, [challenge, invitationId, transport, privateMessage]);
  useEffect(() => { if (challenge && uuidPattern.test(invitationId)) void refresh(); }, [challenge, invitationId, linkRevision, refresh]);
  useEffect(() => { if (unknown) recoveryHeading.current?.focus(); }, [unknown]);

  const sessionEnded = preview?.sessionCeilingAt ? Date.parse(preview.sessionCeilingAt) <= now : false;
  const originalSessionEnded = preview?.originalSessionExpiresAt ? Date.parse(preview.originalSessionExpiresAt) <= now : false;
  const invitationEnded = preview?.invitationExpiresAt ? Date.parse(preview.invitationExpiresAt) <= now : false;
  const effective = sessionEnded || originalSessionEnded || invitationEnded && preview?.state === "available" ? "expired" : preview?.state;
  const canOpen = status === "ready" && !busy && !!digest && !storageError && effective === "available" && preview?.permissions.claim;
  const canRecover = status === "ready" && !busy && !!saved && !storageError && !sessionEnded && !originalSessionEnded && preview?.state === "claimed" && !!preview.originalSessionExpiresAt && preview.permissions.recoverOriginal;

  async function claim(recover = false): Promise<void> {
    if (active.current || !challenge || !digest || !preview?.provider || !(recover ? canRecover || unknown && canOpen : canOpen)) return;
    let request: ProviderClaim;
    try {
      const retained = saved ?? { invitationId, claimId: globalThis.crypto.randomUUID(), challengeDigest: digest };
      saveClaim(retained); setSaved(retained);
      request = original.current ?? { claimId: retained.claimId, challenge };
      if (retained.challengeDigest !== digest || request.claimId !== retained.claimId || request.challenge !== challenge) throw new Error("The original invitation request changed. Keep its original link and request identity for recovery.");
      original.current = request;
    } catch (failure) { setStorageError(failure instanceof Error ? privateMessage(failure.message) : "The browser could not retain the original claim. Access is paused."); return; }
    const current = generation.current;
    active.current = true; setBusy(true); setError(null); setUnknown(false);
    try {
      const value = await transport.claim(invitationId, request);
      if (generation.current !== current) return;
      if (value.invitationId !== invitationId || value.claimId !== request.claimId || value.providerId !== preview.provider.id || !preview.sessionCeilingAt
        || Date.parse(value.sessionExpiresAt) > Date.parse(preview.sessionCeilingAt) || Date.parse(value.sessionExpiresAt) <= currentTime.current
        || preview.state === "claimed" && (!value.restoredOriginal || !preview.originalSessionExpiresAt || Date.parse(value.sessionExpiresAt) !== Date.parse(preview.originalSessionExpiresAt))) throw new Error("The original provider-session result could not be verified.");
      setResult(value); setReview(false);
    } catch (failure) {
      if (generation.current !== current) return;
      setReview(false);
      const uncertain = !(failure instanceof AccessFailure) || failure.detail.unknownOutcome;
      setUnknown(uncertain);
      setError(failure instanceof AccessFailure ? privateMessage(failure.detail.message) : "The claim response was lost or could not be verified. Your original request is retained. Recover that same session with the same invitation.");
    } finally { active.current = false; setBusy(false); }
  }

  const successExpired = !!result && Date.parse(result.sessionExpiresAt) <= now;
  return <AccessFrame scope="invitation" title="Your workshop starts here." eyebrow="A personal invitation to provide good work" intro="Review the service you have been invited to operate, then deliberately open your provider session." viewer={preview?.provider?.displayName} busy={busy || status === "loading"} refresh={challenge ? () => void refresh() : undefined}>
    {status === "loading" && !preview ? <AccessLoading label="Checking this invitation…"/> : null}
    {error ? <AccessError message={error} title={unknown ? "The original claim needs recovery." : "The invitation could not be opened."}/> : null}
    {storageError ? <AccessError message={storageError} title="Original request storage is unavailable."><p>Allow session storage for this site, then refresh the invitation. Cookies, invitation challenges and bearer tokens are never saved there.</p></AccessError> : null}
    {status === "loading" && preview ? <p className="pm-inline-status" role="status">Refreshing the invitation. Claims are paused.</p> : null}
    {result ? <section className="pa-success" aria-labelledby="pa-claim-result"><p className="pm-eyebrow">{result.restoredOriginal ? "Original session recovered" : "Invitation accepted"}</p><h2 id="pa-claim-result">{successExpired ? "Your original session has expired." : `${preview?.provider?.displayName ?? "Your provider"} is ready to open.`}</h2>
      <p>{result.restoredOriginal ? "This restores the exact original provider session under its original expiry." : "Your provider session is separate. Your buyer workspace remains signed in."}</p><p>Original session ends <AccessDate value={result.sessionExpiresAt}/>.</p>
      <div className="pm-actions">{!successExpired ? <a className="pm-button pm-button--primary" href="/provider">Enter provider console</a> : null}<a className="pm-button pm-button--quiet" href="/">Return to buyer workspace</a></div></section> : preview ? <div className="pa-layout">
      <section className="pa-panel" aria-labelledby="pa-invited-provider"><div className="pm-inline-heading"><span className="pa-provider-mark" aria-hidden="true">{preview.provider?.displayName.slice(0, 2) ?? "g."}</span><AccessBadge tone={effective === "available" ? "good" : effective === "claimed" ? "warning" : "bad"}>{effective === "claimed" ? "Claimed · original recovery only" : effective === "available" ? "Invitation available" : effective === "expired" ? "Invitation expired" : effective === "revoked" ? "Invitation revoked" : "Invitation unavailable"}</AccessBadge></div>
        <h2 id="pa-invited-provider" className="pa-provider-name" dir="auto">{preview.provider?.displayName ?? "This invitation is unavailable."}</h2>
        {preview.provider ? <><p dir="auto">{preview.provider.description}</p><p className="pm-muted" dir="auto">Operated by {preview.provider.ownerDisplayName} · {preview.provider.specialty}</p><div className="pa-scope-badges"><AccessBadge tone={preview.provider.provenance.syntheticFixture ? "sample" : "quiet"}>{preview.provider.provenance.label}</AccessBadge><AccessBadge>{preview.provider.provenance.kind === "guild_controlled_service" ? "Guild-controlled service" : "External service"}</AccessBadge></div></> : null}
        <p dir="auto">{effective === "expired" && preview.state === "available" ? "The original invitation deadline has passed. It will not be renewed by a retry." : preview.message}</p>
        <dl className="pa-deadlines">{preview.invitationExpiresAt ? <div><dt>Original invitation deadline</dt><dd><AccessDate value={preview.invitationExpiresAt}/></dd></div> : null}{preview.sessionCeilingAt ? <div><dt>Provider session ceiling</dt><dd><AccessDate value={preview.sessionCeilingAt}/></dd></div> : null}{preview.originalSessionExpiresAt ? <div><dt>Original claimed session expiry</dt><dd><AccessDate value={preview.originalSessionExpiresAt}/></dd></div> : null}</dl>
        {canOpen && !unknown ? <button className="pm-button pm-button--primary" onClick={() => { setAgreed(false); setReview(true); }}>Review provider access</button> : null}
        {busy ? <p className="pm-inline-status" role="status">Confirming the original claim…</p> : null}
        {(unknown || preview.state === "claimed") && saved ? <section className="pa-original" aria-label="Original invitation claim recovery"><h3 ref={recoveryHeading} tabIndex={-1}>Recover your original session</h3><p>The saved request can restore only its original session and expiry. Recovery does not create a replacement identity.</p><div className="pm-actions"><button className="pm-button" disabled={!(canRecover || unknown && canOpen)} onClick={() => void claim(true)}>Recover original provider session</button></div><details className="pm-evidence"><summary>Original request identity</summary><p className="pm-mono">{saved.claimId}</p></details></section> : null}
        {preview.state === "claimed" && !saved ? <p className="pm-disabled-reason">This invitation has already been claimed. Original recovery is available only in the browser session that retained its claim identity.</p> : null}
        {preview.state === "claimed" && saved && !preview.originalSessionExpiresAt ? <p className="pm-disabled-reason">The original session expiry is unavailable. Refresh this invitation before recovering its original session.</p> : null}
        <p className="pa-quiet-note" dir="auto">{preview.disclosure}</p>
      </section>
      <aside className="pa-panel pa-sticky"><p className="pm-eyebrow">A separate provider session</p><h2>Your service. Your terms.</h2><p>Complete your workshop profile and owner policy, confirm discovery, and return to your own negotiations and tasks.</p><div className="pa-boundaries"><h3>What this opens</h3><ul><li>A provider console bound to this exact service and original owner.</li><li>An HttpOnly provider session with the original absolute ceiling.</li><li>Your existing buyer workspace stays separate and available.</li></ul></div><div className="pm-links"><a href="/">Return to buyer workspace</a><a href="/provider">Open an existing provider session</a></div></aside>
    </div> : status !== "loading" ? <AccessEmpty title="Keep the original invitation link." action={<a className="pm-button" href="/">Return to your workspace</a>}>The private fragment stays in your browser. It is sent only to the invitation preview header and the explicit claim request.</AccessEmpty> : null}
    {review && preview?.provider ? <AccessDialog title={`Open ${preview.provider.displayName}`} busy={busy} onClose={() => setReview(false)}><p>You are opening the provider role for <strong dir="auto">{preview.provider.displayName}</strong>, operated by <span dir="auto">{preview.provider.ownerDisplayName}</span>.</p><dl className="pa-review-facts"><div><dt>Original invitation deadline</dt><dd>{preview.invitationExpiresAt ? <AccessDate value={preview.invitationExpiresAt}/> : "Unavailable"}</dd></div><div><dt>Original provider session ceiling</dt><dd>{preview.sessionCeilingAt ? <AccessDate value={preview.sessionCeilingAt}/> : "Unavailable"}</dd></div></dl>
      <label className="pa-agree"><input type="checkbox" checked={agreed} disabled={busy} onChange={event => setAgreed(event.target.checked)}/><span>I understand this opens the provider console for this exact service under the original expiry. My buyer session stays separate.</span></label><div className="pm-actions"><button className="pm-button pm-button--quiet" disabled={busy} onClick={() => setReview(false)}>Keep reviewing</button><button className="pm-button pm-button--primary" disabled={!agreed || !canOpen || busy} onClick={() => void claim()}>{busy ? "Opening original session…" : "Open provider session"}</button></div></AccessDialog> : null}
  </AccessFrame>;
}
