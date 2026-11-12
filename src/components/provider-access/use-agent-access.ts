"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { agentAccessCommandSchema, type AgentAccessCommand, type AgentAccessScope, type AgentAccessSnapshot, type ProtocolClientSummary } from "@/contracts/provider-access";
import { AccessFailure, agentAccessTransport, type AgentAccessTransport } from "./transport";
import { clearAccessCommand, readAccessCommand, saveAccessCommand, summaryMatches, useServerClock, viewerKey, type RetainedAccessCommand } from "./state";

export function useAgentAccess(scope: AgentAccessScope, supplied?: AgentAccessTransport) {
  const transport = useMemo(() => supplied ?? agentAccessTransport(scope), [scope, supplied]);
  const [snapshot, setSnapshot] = useState<AgentAccessSnapshot | null>(null), [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<RetainedAccessCommand | null>(null), [recovery, setRecovery] = useState<string | null>(null), [storageError, setStorageError] = useState<string | null>(null);
  const [token, setToken] = useState<{ value: string; credential: ProtocolClientSummary } | null>(null), [lostCredentialId, setLostCredentialId] = useState<string | null>(null);
  const source = useRef<AgentAccessSnapshot | null>(null), retained = useRef<RetainedAccessCommand | null>(null), active = useRef(false), reading = useRef(false), live = useRef(false), generation = useRef(0);
  const serverClock = useRef({ at: Date.now(), local: Date.now() }), statusRef = useRef<"loading" | "ready" | "error">("loading");
  const now = useServerClock(snapshot?.serverTime);
  const currentTime = () => serverClock.current.at + Math.max(0, Date.now() - serverClock.current.local);
  const keepPending = (value: RetainedAccessCommand | null) => { retained.current = value; setPending(value); };
  const applySummary = (summary: ProtocolClientSummary) => {
    const current = source.current;
    if (!current || !summaryMatches(current, summary)) throw new Error("The credential summary crossed its original authority boundary.");
    const next = { ...current, credentials: [summary, ...current.credentials.filter(item => item.id !== summary.id)] };
    source.current = next; setSnapshot(next);
    if (summary.revokedAt || summary.state !== "active") setLostCredentialId(value => value === summary.id ? null : value);
  };
  const forgetPending = (value: RetainedAccessCommand): boolean => {
    try { clearAccessCommand(scope, value.owner); keepPending(null); return true; }
    catch { setStorageError("The result is retained, but the browser could not clear its original recovery record. Keep checking that original request before making another change."); return false; }
  };
  const refresh = useCallback(async () => {
    if (active.current) return;
    const current = ++generation.current; reading.current = true; statusRef.current = "loading"; setStatus("loading"); setError(null);
    try {
      const value = await transport.snapshot();
      if (!live.current || generation.current !== current) return;
      if (value.scope !== scope) throw new Error("Wrong workspace scope.");
      const owner = viewerKey(value), previous = source.current ? viewerKey(source.current) : null;
      if (owner !== previous) { keepPending(null); setToken(null); setLostCredentialId(null); setNotice(null); setRecovery(null); }
      source.current = value; setSnapshot(value); serverClock.current = { at: Date.parse(value.serverTime), local: Date.now() };
      try {
        const saved = readAccessCommand(scope, owner);
        if (retained.current?.owner === owner && saved && JSON.stringify(saved) !== JSON.stringify(retained.current)) throw new Error("A different original request is already retained.");
        keepPending(saved ?? (retained.current?.owner === owner ? retained.current : null)); setStorageError(null);
      } catch { setStorageError("The browser could not read its original command record. Access changes are paused until session storage is available."); }
      statusRef.current = "ready"; setStatus("ready");
    } catch (failure) {
      if (!live.current || generation.current !== current) return;
      statusRef.current = "error"; setStatus("error"); setToken(null);
      setError(failure instanceof AccessFailure ? failure.detail.message : "Current access could not be verified. Refresh to recover the original workspace.");
    } finally { if (generation.current === current) reading.current = false; }
  }, [scope, transport]);
  useEffect(() => { live.current = true; void refresh(); return () => { live.current = false; generation.current++; source.current = null; }; }, [refresh]);
  useEffect(() => {
    const clear = () => setToken(null); window.addEventListener("pagehide", clear); window.addEventListener("pageshow", clear);
    return () => { window.removeEventListener("pagehide", clear); window.removeEventListener("pageshow", clear); };
  }, []);
  useEffect(() => { if (token && (Date.parse(token.credential.expiresAt) <= now || snapshot && Date.parse(snapshot.viewer.sessionExpiresAt) <= now)) setToken(null); }, [now, token, snapshot]);

  async function execute(input: AgentAccessCommand): Promise<"confirmed" | "unknown" | "refused" | "paused"> {
    const current = source.current;
    if (active.current || reading.current || retained.current || !current || statusRef.current !== "ready" || storageError || Date.parse(current.viewer.sessionExpiresAt) <= currentTime()) return "paused";
    const parsed = agentAccessCommandSchema.safeParse(input);
    if (!parsed.success) { setError("Review a valid label, exact scopes and absolute expiry before issuing access."); return "paused"; }
    const command = parsed.data;
    if (command.type === "issue_credential") {
      if (!current.permissions.issue || command.scopes.some(item => !current.allowedScopes.includes(item)) || Date.parse(command.expiresAt) <= currentTime() || Date.parse(command.expiresAt) > Date.parse(current.viewer.sessionExpiresAt)) { setError("The original session or allowed scopes changed. Review the current ceiling again."); return "paused"; }
    } else {
      const target = current.credentials.find(item => item.id === command.clientId);
      if (!current.permissions.revoke || !target?.canRevoke) { setError("This exact credential cannot be revoked by the current owner."); return "paused"; }
    }
    const request = { owner: viewerKey(current), command };
    try { saveAccessCommand(scope, request); }
    catch { setStorageError("The browser could not retain the original command ID. No request was sent. Allow session storage, then refresh access."); return "paused"; }
    active.current = true; keepPending(request); setBusy(true); setError(null); setNotice(null); setRecovery(null);
    if (command.type === "revoke_credential") setToken(value => value?.credential.id === command.clientId ? null : value);
    try {
      const result = await transport.command(command);
      if (!live.current || !source.current || viewerKey(source.current) !== request.owner) return "unknown";
      if (result.commandId !== command.commandId) throw new Error("Wrong original command.");
      if (!result.ok) {
        setError(result.error.message);
        if (result.error.unknownOutcome) return "unknown";
        forgetPending(request); return "refused";
      }
      if (!summaryMatches(current, result.credential, command) || command.type === "revoke_credential" && (result.state === "issued_now" || result.credential.state !== "revoked")) throw new Error("Unbound credential result.");
      applySummary(result.credential);
      if (result.state === "issued_now") {
        if (command.type !== "issue_credential") throw new Error("A revocation cannot issue a credential.");
        setToken({ value: result.token, credential: result.credential }); setNotice("Credential issued. Save its one-time token privately before leaving this page.");
      } else if (command.type === "issue_credential") {
        setToken(null); setLostCredentialId(result.credential.state === "active" ? result.credential.id : null);
        setNotice("The original credential is retained. Its token is unavailable. To replace it, explicitly revoke it and review a new issuance.");
      } else setNotice("The exact credential is revoked. Original operation records remain retained.");
      forgetPending(request); return "confirmed";
    } catch (failure) {
      if (failure instanceof AccessFailure && !failure.detail.unknownOutcome) {
        if (live.current) { setError(failure.detail.message); forgetPending(request); }
        return "refused";
      }
      if (live.current) setError("The response was lost or could not be bound to the original owner and command. Check that original request. No replacement credential will be issued automatically.");
      return "unknown";
    } finally { active.current = false; if (live.current) setBusy(false); }
  }

  async function checkOriginal(): Promise<void> {
    const request = retained.current, current = source.current;
    if (!request || !current || request.owner !== viewerKey(current) || active.current || reading.current || statusRef.current !== "ready") return;
    active.current = true; setBusy(true); setError(null); setRecovery(null);
    try {
      const result = await transport.status(request.command.commandId);
      if (!live.current || !source.current || viewerKey(source.current) !== request.owner) return;
      if (result.commandId !== request.command.commandId || result.state !== "not_found" && result.operation !== request.command.type) throw new Error("Wrong original command status.");
      if (result.state === "pending" || result.state === "not_found") {
        setRecovery(result.state === "pending" ? "The original request is still pending. Keep this exact identity and check again." : "The server has not confirmed an original result yet. Keep this request and check again; another issuance is paused."); return;
      }
      if (result.state === "refused") {
        setError(result.error?.message ?? "The original request was refused.");
        if (!result.error?.unknownOutcome) forgetPending(request); return;
      }
      if (!result.credential || !summaryMatches(current, result.credential, request.command) || request.command.type === "revoke_credential" && result.credential.state !== "revoked") throw new Error("Unbound retained summary.");
      applySummary(result.credential); setToken(null);
      if (request.command.type === "issue_credential") {
        setLostCredentialId(result.credential.state === "active" ? result.credential.id : null);
        setNotice("Original issuance recovered as a credential summary. The one-time token cannot be returned again. Revoke it, then explicitly review a new credential if you need a replacement.");
      } else setNotice("The original revocation is confirmed. No new credential was created.");
      forgetPending(request);
    } catch { if (live.current) setError("The original result could not be verified. Its command ID is still retained for a summary-only recovery read."); }
    finally { active.current = false; if (live.current) setBusy(false); }
  }

  return { snapshot, status, error, notice, busy, pending, recovery, storageError, token, lostCredentialId, now, refresh, execute, checkOriginal,
    clearToken() { setToken(null); setNotice("The token is cleared from this page. Its original credential remains listed until it expires or you revoke it."); } };
}
