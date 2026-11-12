"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { providerMarketCommandSchema, type ProviderMarketCommand, type ProviderMarketCommandResult, type ProviderMarketError, type ProviderMarketSnapshot, type ProviderMarketViewProps } from "@/contracts/provider-market";
import { safeHref } from "./format";

type CommandInput = ProviderMarketCommand extends infer T ? T extends ProviderMarketCommand ? Omit<T, "commandId"> : never : never;
interface OriginalRequest { command: ProviderMarketCommand; label: string }
export interface RetainedCommand extends OriginalRequest { state: "sending" | "unknown" | "retryable"; original?: OriginalRequest }
export interface MarketController {
  snapshot: ProviderMarketSnapshot | null; status: ProviderMarketViewProps["status"]; error: string | null;
  now: number; pending: RetainedCommand | null; notice: string | null; commandError: ProviderMarketError | null;
  refreshing: boolean; busy: boolean; approvalLinks: Record<string, string>;
  execute: (input: CommandInput, label: string) => Promise<ProviderMarketCommandResult | null>;
  retryOriginal: () => Promise<void>; refresh: () => Promise<void>; canRecover: (operationId: string) => boolean;
}
function storageKey(snapshot: ProviderMarketSnapshot | null): string | null {
  return snapshot ? `guild.provider-market.request.v1:${snapshot.scope}:${snapshot.commission?.id ?? "none"}:${snapshot.viewer.providerId ?? "buyer"}:${snapshot.viewer.role}` : null;
}
export function useMarketController(props: ProviderMarketViewProps): MarketController {
  const [response, setResponse] = useState<{ source: ProviderMarketSnapshot | null; value: ProviderMarketSnapshot } | null>(null);
  const snapshot = response?.source === props.snapshot ? response.value : props.snapshot;
  const [pending, setPending] = useState<RetainedCommand | null>(null);
  const pendingRef = useRef<RetainedCommand | null>(null), sending = useRef(false), refreshLock = useRef(false);
  const [notice, setNotice] = useState<string | null>(null), [commandError, setCommandError] = useState<ProviderMarketError | null>(null);
  const [refreshing, setRefreshing] = useState(false), [approvalLinks, setApprovalLinks] = useState<Record<string, string>>({});
  const [now, setNow] = useState(() => Date.parse(props.snapshot?.serverTime ?? "") || Date.now());
  const key = storageKey(snapshot), activeKey = useRef<string | null>(null);
  useEffect(() => {
    const base = Date.parse(snapshot?.serverTime ?? "") || Date.now(), started = Date.now();
    setNow(base);
    const timer = window.setInterval(() => setNow(base + Date.now() - started), 15_000);
    return () => window.clearInterval(timer);
  }, [snapshot?.serverTime]);
  useEffect(() => {
    if (!key || activeKey.current === key) return;
    activeKey.current = key;
    pendingRef.current = null; setPending(null); setCommandError(null); setNotice(null);
    try {
      const raw = window.sessionStorage.getItem(key);
      if (!raw) return;
      const saved: unknown = JSON.parse(raw);
      if (!saved || typeof saved !== "object" || !("command" in saved)) return;
      const parsed = providerMarketCommandSchema.safeParse(saved.command);
      if (!parsed.success) { window.sessionStorage.removeItem(key); return; }
      const original = "original" in saved && saved.original && typeof saved.original === "object" && "command" in saved.original ? providerMarketCommandSchema.safeParse(saved.original.command) : null;
      const retained: RetainedCommand = { command: parsed.data, label: "Retained request", state: "unknown", ...(original?.success ? { original: { command: original.data, label: "Original request" } } : {}) };
      pendingRef.current = retained; setPending(retained);
    } catch { /* A private browser may withhold session storage. The in-memory identity remains intact. */ }
  }, [key]);
  useEffect(() => {
    if (!pending) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [pending]);

  const retain = useCallback((value: RetainedCommand | null) => {
    if (activeKey.current === key) { pendingRef.current = value; setPending(value); }
    if (!key) return;
    try { if (value) window.sessionStorage.setItem(key, JSON.stringify({ command: value.command, label: value.label, original: value.original })); else window.sessionStorage.removeItem(key); } catch { /* Preserve the exact request in memory when storage is unavailable. */ }
  }, [key]);
  const refresh = useCallback(async () => {
    if (refreshLock.current) return;
    refreshLock.current = true; setRefreshing(true);
    try { await props.onRefresh(); }
    catch { setNotice("The latest state could not be loaded. Your draft and original request are still here."); }
    finally { refreshLock.current = false; setRefreshing(false); }
  }, [props.onRefresh]);

  const dispatch = useCallback(async (record: RetainedCommand): Promise<ProviderMarketCommandResult | null> => {
    if (sending.current) return null;
    sending.current = true;
    retain({ ...record, state: "sending" }); setNotice(null); setCommandError(null);
    try {
      const result = await props.onCommand(record.command);
      if (result.commandId !== record.command.commandId) throw new Error("Response identity did not match the retained request.");
      const stillCurrent = activeKey.current === key;
      if (result.snapshot && stillCurrent) setResponse({ source: props.snapshot, value: result.snapshot });
      if (result.ok) {
        const originalOperation = record.original ? result.snapshot.threads.flatMap(thread => thread.operations).find(operation => operation.commandId === record.original?.command.commandId) : null;
        if (record.original && !["completed", "refused"].includes(originalOperation?.state ?? "")) retain({ ...record.original, state: "unknown" });
        else retain(null);
        if (stillCurrent) setNotice(result.message);
        const href = safeHref(result.approvalUrl);
        if (result.threadId && href && stillCurrent) setApprovalLinks(current => ({ ...current, [result.threadId!]: href }));
      } else {
        if (stillCurrent) setCommandError(result.error);
        if (result.error.unknownOutcome || result.error.retryable) retain({ ...record, state: result.error.unknownOutcome ? "unknown" : "retryable" });
        else retain(record.original ? { ...record.original, state: "unknown" } : null);
        if (stillCurrent && !result.snapshot && (result.error.currentRevision !== undefined || /stale|revision|conflict/i.test(result.error.code))) void refresh();
      }
      return result;
    } catch {
      const error: ProviderMarketError = { code: "response_unknown", message: "The response was lost. The original request may have reached Guild. Recover it before starting another change.", retryable: true, unknownOutcome: true };
      if (activeKey.current === key) setCommandError(error); retain({ ...record, state: "unknown" }); return null;
    } finally { sending.current = false; }
  }, [key, props.onCommand, props.snapshot, refresh, retain]);
  const canRecover = useCallback((operationId: string) => {
    if (props.status !== "ready" || sending.current) return false;
    const operation = snapshot?.threads.flatMap(thread => thread.operations).find(item => item.id === operationId && item.canRecoverOriginal);
    if (!operation) return false;
    const retained = pendingRef.current;
    return !retained || retained.state !== "sending" && retained.command.type !== "recover_original" && operation.commandId === retained.command.commandId;
  }, [props.status, snapshot]);
  const execute = useCallback(async (input: CommandInput, label: string) => {
    const original = pendingRef.current;
    const recovery = input.type === "recover_original" && canRecover(input.operationId);
    if (sending.current || original && !recovery || props.status !== "ready" || !snapshot || !key || activeKey.current !== key) return null;
    const command = providerMarketCommandSchema.parse({ ...input, commandId: crypto.randomUUID() });
    const record: RetainedCommand = { command, label, state: "sending", ...(original && recovery ? { original: { command: original.command, label: original.label } } : {}) };
    // Lock before React renders: two clicks in the same event turn cannot create two identities.
    pendingRef.current = record;
    return dispatch(record);
  }, [canRecover, dispatch, key, props.status, snapshot]);
  const retryOriginal = useCallback(async () => {
    const original = pendingRef.current;
    if (!original || sending.current || props.status !== "ready") return;
    await dispatch(original);
  }, [dispatch, props.status]);
  return { snapshot, status: props.status, error: props.error, now, pending, notice, commandError, refreshing, busy: Boolean(pending) || props.status !== "ready", approvalLinks, execute, retryOriginal, refresh, canRecover };
}
