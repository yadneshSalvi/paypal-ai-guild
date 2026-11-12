import { useEffect, useState } from "react";
import { agentAccessCommandSchema, type AgentAccessCommand, type AgentAccessScope, type AgentAccessSnapshot, type AgentScope, type ProtocolClientSummary } from "@/contracts/provider-access";

export const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export const formatTime = (value: string) => new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(value));
export const scopeText: Record<AgentScope, { title: string; description: string }> = {
  mcp: { title: "MCP tools", description: "Create a commission, read its status, and request a human approval link." },
  a2a: { title: "Customer A2A actions", description: "Use the declared contract-bound provider actions under your current buyer authority." },
  "provider:read": { title: "Read workshop", description: "Read this provider’s own requests, contracts and task results." },
  "provider:negotiate": { title: "Negotiate offers", description: "Counter or decline this provider’s own offers within the owner policy. Requires read." },
  "provider:cancel": { title: "Cancel unstarted work", description: "Cancel eligible work for this provider under the original task rules. Requires read." },
};
export function useServerClock(serverTime?: string): number {
  const [clock, setClock] = useState(() => serverTime ? Date.parse(serverTime) : Date.now());
  useEffect(() => {
    const server = serverTime ? Date.parse(serverTime) : Date.now(), started = Date.now(); setClock(server);
    const timer = setInterval(() => setClock(server + Math.max(0, Date.now() - started)), 1000);
    return () => clearInterval(timer);
  }, [serverTime]);
  return clock;
}
export function claimStorageKey(id: string): string { return `guild.provider-access.claim.v1:${id}`; }
export interface RetainedClaim { invitationId: string; claimId: string; challengeDigest: string }
export async function challengeDigest(challenge: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(challenge));
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
}
export function readClaim(id: string): RetainedClaim | null {
  const raw = window.sessionStorage.getItem(claimStorageKey(id));
  if (raw === null) return null;
  const value = JSON.parse(raw) as Partial<RetainedClaim>;
  if (value.invitationId !== id || !uuidPattern.test(value.claimId ?? "") || !/^[a-f0-9]{64}$/.test(value.challengeDigest ?? "")) throw new Error("The original saved claim is not valid. Keep this invitation and its original request identity for review.");
  return value as RetainedClaim;
}
export function saveClaim(value: RetainedClaim): void {
  const key = claimStorageKey(value.invitationId), existing = window.sessionStorage.getItem(key), encoded = JSON.stringify(value);
  if (existing !== null && existing !== encoded) throw new Error("A different original claim is already retained for this invitation.");
  window.sessionStorage.setItem(key, encoded);
  if (window.sessionStorage.getItem(key) !== encoded) throw new Error("The browser could not retain the original claim identity.");
}
export const viewerKey = (snapshot: AgentAccessSnapshot) => [snapshot.scope, snapshot.viewer.tenantId, snapshot.viewer.actorId, snapshot.viewer.role,
  snapshot.viewer.providerBinding?.id ?? "customer", snapshot.viewer.providerBinding?.bindingDigest ?? "customer", snapshot.viewer.sessionExpiresAt].join(":");
export const commandStorageKey = (scope: AgentAccessScope, owner: string) => `guild.agent-access.pending.v1:${scope}:${owner}`;
export interface RetainedAccessCommand { owner: string; command: AgentAccessCommand }
export function readAccessCommand(scope: AgentAccessScope, owner: string): RetainedAccessCommand | null {
  const raw = window.sessionStorage.getItem(commandStorageKey(scope, owner));
  if (raw === null) return null;
  const value = JSON.parse(raw) as RetainedAccessCommand;
  if (value.owner !== owner) throw new Error("The saved request belongs to a different original owner.");
  return { owner, command: agentAccessCommandSchema.parse(value.command) };
}
export function saveAccessCommand(scope: AgentAccessScope, request: RetainedAccessCommand): void {
  const key = commandStorageKey(scope, request.owner), value = JSON.stringify(request), current = window.sessionStorage.getItem(key);
  if (current !== null && current !== value) throw new Error("An original request is still awaiting recovery.");
  window.sessionStorage.setItem(key, value);
  if (window.sessionStorage.getItem(key) !== value) throw new Error("The browser could not retain this command identity.");
}
export function clearAccessCommand(scope: AgentAccessScope, owner: string): void { window.sessionStorage.removeItem(commandStorageKey(scope, owner)); }
export function summaryMatches(snapshot: AgentAccessSnapshot, summary: ProtocolClientSummary, command?: AgentAccessCommand): boolean {
  if (summary.scope !== snapshot.scope || summary.actorId !== snapshot.viewer.actorId || snapshot.scope === "provider" && summary.providerId !== snapshot.viewer.providerBinding?.id || Date.parse(summary.expiresAt) > Date.parse(snapshot.viewer.sessionExpiresAt)) return false;
  if (!command) return true;
  if (command.type === "revoke_credential") return command.clientId === summary.id;
  return command.label === summary.label && command.expiresAt === summary.expiresAt && [...command.scopes].sort().join("|") === [...summary.scopes].sort().join("|");
}
export function localDateInput(value: string): string {
  const date = new Date(value); return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
}
export function safeEndpoint(value: string): string | null {
  try { const url = new URL(value); return !url.username && !url.password && (url.protocol === "https:" || url.protocol === "http:" && url.hostname === "127.0.0.1") ? url.href : null; } catch { return null; }
}
