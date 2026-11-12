import { DomainError } from "@/domain/primitives";
import { errorResponse, readJson } from "../http";
import { requireSameOrigin, SESSION_COOKIE, sessionFromToken, type Session } from "../session";
import { approvalConsumeSchema, consumeApprovalLink } from "./approval-links";
import { marketOrigin } from "./registry";

export function privateMcpResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store, max-age=0"); headers.set("Referrer-Policy", "no-referrer"); headers.set("X-Content-Type-Options", "nosniff");
  headers.append("Vary", "Authorization, Cookie");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
export function requireConfiguredOrigin(request: Request, browserPost = false): void {
  const expected = new URL(marketOrigin()), actual = new URL(request.url), host = request.headers.get("host"), origin = request.headers.get("origin");
  if (actual.origin !== expected.origin || host && host.toLowerCase() !== expected.host.toLowerCase()) throw new DomainError("MCP_HOST_REFUSED", "This endpoint is available only at its configured Guild origin.", 403, false);
  if (origin && origin !== expected.origin) throw new DomainError("ORIGIN_MISMATCH", "This request must stay at its original Guild origin.", 403, false);
  if (browserPost) requireSameOrigin(request);
}
/** A bearer never substitutes for the original browser cookie. */
export async function approvalBrowserSession(request: Request): Promise<Session> {
  const values = (request.headers.get("cookie") ?? "").split(";").map(part => part.trim()).filter(part => part.startsWith(`${SESSION_COOKIE}=`));
  if (values.length !== 1) throw new DomainError("SESSION_REQUIRED", "Open this link in the original owner's Guild browser workspace.", 401, false);
  let cookie: string;
  try { cookie = decodeURIComponent(values[0]!.slice(SESSION_COOKIE.length + 1)); } catch { throw new DomainError("SESSION_REQUIRED", "The original browser workspace could not be verified.", 401, false); }
  const session = await sessionFromToken(cookie);
  if (!session) throw new DomainError("SESSION_REQUIRED", "Open this link in the original owner's active Guild browser workspace.", 401, false);
  return session;
}
export async function handleApprovalLinkConsume(request: Request, id: string): Promise<Response> {
  try {
    requireConfiguredOrigin(request, true);
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new DomainError("APPROVAL_BODY_TYPE", "This continuation requires its original JSON request.", 415, false);
    const session = await approvalBrowserSession(request), input = approvalConsumeSchema.parse(await readJson(request, 2_048));
    return privateMcpResponse(Response.json(await consumeApprovalLink(session, id, input.challenge)));
  } catch (error) { return privateMcpResponse(errorResponse(error)); }
}
