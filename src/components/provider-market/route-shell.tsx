"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MARKET_VERSION, type ProviderMarketCommand, type ProviderMarketCommandResult, type ProviderMarketSnapshot } from "@/contracts/provider-market";
import { ProviderMarket } from "./market";
import { ProviderConsole } from "./provider-console";

function isSnapshot(value: unknown): value is ProviderMarketSnapshot {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ProviderMarketSnapshot>;
  return item.version === MARKET_VERSION && ["buyer", "provider"].includes(item.scope ?? "") && typeof item.serverTime === "string"
    && typeof item.viewer?.role === "string" && Array.isArray(item.providers) && Array.isArray(item.packages)
    && Array.isArray(item.threads) && Array.isArray(item.tasks);
}

/** Routes provide data and an explicit client transport; no server function or
 * credential is serialized into the marketplace component interface. */
export function ProviderMarketRoute({ mode, commissionId }: { mode: "buyer" | "provider"; commissionId?: string }) {
  const [snapshot, setSnapshot] = useState<ProviderMarketSnapshot | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0), hasSnapshot = useRef(false);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    if (!hasSnapshot.current) setStatus("loading");
    try {
      const query = commissionId ? `?commission=${encodeURIComponent(commissionId)}` : "";
      const response = await fetch(`/api/provider-market${query}`, { cache: "no-store", credentials: "same-origin", referrerPolicy: "no-referrer" });
      const value: unknown = await response.json();
      if (!response.ok || !isSnapshot(value)) {
        const message = value && typeof value === "object" && "message" in value && typeof value.message === "string" ? value.message : "The provider workspace could not be loaded. Open your original workspace or retry this read.";
        throw new Error(message);
      }
      if (generation.current !== current) return;
      hasSnapshot.current = true; setSnapshot(value); setStatus("ready"); setError(null);
    } catch (failure) {
      if (generation.current !== current) return;
      setError(failure instanceof Error ? failure.message : "The provider workspace is unavailable."); setStatus("error");
      throw failure;
    }
  }, [commissionId]);
  useEffect(() => { void refresh().catch(() => undefined); return () => { generation.current++; }; }, [refresh]);

  const command = useCallback(async (input: ProviderMarketCommand): Promise<ProviderMarketCommandResult> => {
    const response = await fetch("/api/provider-market/commands", { method: "POST", credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
    const value: unknown = await response.json();
    if (value && typeof value === "object" && "commandId" in value && value.commandId === input.commandId && "ok" in value) {
      const result = value as ProviderMarketCommandResult;
      if (result.ok && isSnapshot(result.snapshot) || !result.ok && result.error && typeof result.error.code === "string"
        && typeof result.error.message === "string" && typeof result.error.retryable === "boolean" && typeof result.error.unknownOutcome === "boolean"
        && (!result.snapshot || isSnapshot(result.snapshot))) {
        // The component controller retains the exact request and handles the
        // returned snapshot atomically with its original response identity.
        return result;
      }
    }
    if (!response.ok && response.status < 500 && value && typeof value === "object" && "message" in value && typeof value.message === "string") {
      return { ok: false, commandId: input.commandId, error: { code: "code" in value && typeof value.code === "string" ? value.code : "MARKET_REQUEST_REFUSED",
        message: value.message, retryable: false, unknownOutcome: false } };
    }
    throw new Error("The original command response could not be verified. Retain its exact identity for recovery.");
  }, []);
  const props = { snapshot, status, error, onRefresh: refresh, onCommand: command };
  return mode === "provider" ? <ProviderConsole {...props}/> : <ProviderMarket {...props}/>;
}
