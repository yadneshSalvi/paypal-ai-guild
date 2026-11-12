import { createHmac } from "node:crypto";
import { DomainError } from "@/domain/primitives";
import { getPool } from "../db";
import { SESSION_COOKIE, sessionFromToken, type Session } from "../session";
import { requireAccessActor } from "./identity";

const configured = process.env.GUILD_PROVIDER_SESSION_COOKIE || "guild_provider_session";
if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(configured) || configured === SESSION_COOKIE) {
  throw new Error("GUILD_PROVIDER_SESSION_COOKIE must be a valid cookie name distinct from the customer session cookie.");
}
export const PROVIDER_SESSION_COOKIE = configured;

function cookieValue(request: Request, name: string): string | undefined {
  const matches = (request.headers.get("cookie") ?? "").split(";").map(item => item.trim()).filter(item => item.startsWith(`${name}=`));
  if (matches.length !== 1) return undefined;
  try { const value = decodeURIComponent(matches[0]!.slice(name.length + 1)); return value.length <= 512 ? value : undefined; }
  catch { return undefined; }
}

export async function requireAccessBrowserSession(request: Request, scope: "customer" | "provider"): Promise<Session> {
  if (request.headers.has("authorization")) throw new DomainError("BROWSER_SESSION_REQUIRED", "Manage access from the original browser workspace. Agent credentials cannot issue or revoke credentials.", 403, false);
  const value = cookieValue(request, scope === "provider" ? PROVIDER_SESSION_COOKIE : SESSION_COOKIE);
  const session = await sessionFromToken(value);
  if (!session) throw new DomainError("SESSION_REQUIRED", scope === "provider" ? "Open your original provider invitation or return to its active provider session." : "Open your original customer workspace to manage agent connections.", 401, false);
  await requireAccessActor(getPool(), session, scope);
  return session;
}

function sessionSecret(): string {
  const secret = process.env.JUDGE_SESSION_SECRET;
  if (!secret || secret.length < 24) throw new DomainError("PROVIDER_SESSION_UNAVAILABLE", "Provider session signing is not available.", 503, false);
  return secret;
}

/** Recoverable only from the exact original claim/session and unchanged signer.
 * No raw session token is persisted, and a different claim derives no old token. */
export function originalProviderCookie(invitationId: string, claimId: string, sessionId: string): { token: string; cookie: string } {
  const secret = sessionSecret();
  const token = createHmac("sha256", secret).update(`guild-provider-session-v1:${invitationId}:${claimId}:${sessionId}`).digest("base64url");
  const signature = createHmac("sha256", secret).update(token).digest("hex");
  return { token, cookie: `${token}.${signature}` };
}

export function providerCookieHeader(value: string, expiresAt: string, origin: string): string {
  const seconds = Math.floor((Date.parse(expiresAt) - Date.now()) / 1000);
  if (seconds <= 0) throw new DomainError("PROVIDER_SESSION_EXPIRED", "The original provider session has expired. It cannot be restored or extended.", 410, false);
  return `${PROVIDER_SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Expires=${new Date(expiresAt).toUTCString()}; Max-Age=${seconds}${new URL(origin).protocol === "https:" ? "; Secure" : ""}`;
}
