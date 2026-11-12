"use client";

import { useRef, useState } from "react";
import type { ApprovalLinkPreview } from "@/server/provider-market/approval-links";
import "./approval-link.css";

export function ApprovalLink({ preview, challenge, error }: { preview: ApprovalLinkPreview | null; challenge: string | null; error: string | null }) {
  const lock = useRef(false), [state, setState] = useState<"ready" | "sending" | "unknown" | "unavailable" | "used">("ready"), [message, setMessage] = useState<string | null>(null), [destination, setDestination] = useState<string | null>(null);
  async function continueToPassport() {
    if (!preview || !challenge || lock.current || state === "used" || state === "unavailable") return;
    lock.current = true; setState("sending"); setMessage(null);
    try {
      const response = await fetch(`/api/provider-market/approval-links/${encodeURIComponent(preview.id)}/consume`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, cache: "no-store", referrerPolicy: "no-referrer", body: JSON.stringify({ challenge }) });
      const result: unknown = await response.json();
      if (!response.ok || !result || typeof result !== "object" || !("ok" in result) || result.ok !== true || !("continueUrl" in result) || typeof result.continueUrl !== "string" || result.continueUrl !== preview.passportUrl || !("commissionId" in result) || result.commissionId !== preview.commissionId || !("approvalRequired" in result) || result.approvalRequired !== true || !("paymentAuthorized" in result) || result.paymentAuthorized !== false) {
        const text = result && typeof result === "object" && "message" in result && typeof result.message === "string" ? result.message : "This continuation could not be verified. No approval was granted.";
        setMessage(text); setState(response.status >= 500 ? "unknown" : "unavailable"); return;
      }
      setDestination(result.continueUrl); setState("used");
    } catch { setState("unknown"); setMessage("The response was lost. Retry this same continuation or open your commission’s Passport to inspect its current state."); }
    finally { lock.current = false; }
  }
  return <div className="pm-approval-link"><header><a href="/" aria-label="Guild home">guild<span aria-hidden="true">✳</span></a><span>The original owner’s workspace</span></header><main id="main" tabIndex={-1}><p className="al-eyebrow">A deliberate human handoff</p><h1>{preview ? "Your Passport is ready to review." : "This link cannot continue."}</h1>{preview ? <><p className="al-intro">Your assistant prepared a way back to this exact commission. Continue in your own workspace to inspect the contracts and current authority.</p><section className="al-context" aria-label="Bound commission"><p className="al-eyebrow">Commission revision {preview.expectedRevision}</p><h2 dir="auto">{preview.title}</h2><dl><div><dt>Application cap</dt><dd>{new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(preview.capMinor / 100)}</dd></div><div><dt>Work packages</dt><dd>{preview.packageCount}</dd></div><div><dt>Link expires</dt><dd><time dateTime={preview.expiresAt}>{new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(preview.expiresAt))} UTC</time></dd></div></dl></section><div className="al-boundary"><strong>Continue to review.</strong><p>This one-use link opens Passport. You still review and approve the plan there. Customer payment approval, capture, and provider payout stay separate.</p></div>{message ? <p className="al-error" role="alert">{message}</p> : null}{destination ? <div className="al-success" role="status"><p>The continuation was checked and used. No plan or payment was approved.</p><a className="al-button" href={destination}>Open Passport for review <span aria-hidden="true">→</span></a></div> : <button className="al-button" disabled={!challenge || state === "sending" || state === "unavailable"} onClick={() => void continueToPassport()}>{state === "sending" ? "Checking this continuation…" : state === "unknown" ? "Retry same continuation" : state === "unavailable" ? "This continuation is unavailable" : "Continue to Passport"}<span aria-hidden="true">→</span></button>}<a className="al-studio-link" href={preview.passportUrl}>Open this commission in the studio</a><p className="al-fineprint">Opening or refreshing this page does not use the link. Only the continue button can consume it, in the original owner’s active browser session.</p></> : <><p className="al-error" role="alert">{error ?? "Open this link in the original owner's active Guild browser workspace."}</p><a className="al-button" href="/">Open the commission studio</a></>}</main><footer>Good work, together.</footer></div>;
}
