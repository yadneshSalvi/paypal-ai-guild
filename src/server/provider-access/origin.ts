import { DomainError } from "@/domain/primitives";

function exactOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new DomainError("ACCESS_ORIGIN_CONFIG", "This deployment's browser entry is not configured.", 503, false); }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)))) {
    throw new DomainError("ACCESS_ORIGIN_CONFIG", "Browser entry requires a reviewed HTTPS origin or explicit local qualification origin.", 503, false);
  }
  return url.origin;
}

/** A browser entry never retargets an enrolled service or retained operation. */
export function browserEntryOrigins(): string[] {
  const configured = process.env.GUILD_MARKET_BROWSER_ORIGIN || process.env.APP_URL || process.env.GUILD_MARKET_APP_URL;
  if (!configured) throw new DomainError("ACCESS_NOT_CONFIGURED", "Agent and provider entry is not configured for this deployment.", 503, true);
  const values = [exactOrigin(configured)];
  if (process.env.APP_URL) values.push(exactOrigin(process.env.APP_URL));
  if (process.env.VERCEL === "1" && process.env.VERCEL_URL) {
    const hostname = process.env.VERCEL_URL;
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.vercel\.app$/i.test(hostname)) {
      throw new DomainError("ACCESS_ORIGIN_CONFIG", "The deployment hostname could not be verified.", 503, false);
    }
    values.push(exactOrigin(`https://${hostname}`));
  }
  return [...new Set(values)];
}

export function requireBrowserEntryOrigin(request: Request, browserPost = false): string {
  const origins = browserEntryOrigins(), actual = new URL(request.url);
  const host = request.headers.get("host"), origin = request.headers.get("origin");
  const accepted = origins.find(value => {
    const expected = new URL(value);
    const normalizedLoopback = expected.hostname === "127.0.0.1" && actual.hostname === "localhost"
      && actual.protocol === expected.protocol && actual.port === expected.port
      && host?.toLowerCase() === expected.host.toLowerCase();
    return (actual.origin === expected.origin || normalizedLoopback)
      && (!host || host.toLowerCase() === expected.host.toLowerCase());
  });
  if (!accepted) throw new DomainError("MCP_HOST_REFUSED", "This endpoint is available only at a configured Guild browser origin.", 403, false);
  if (origin && origin !== accepted || browserPost && !origin) {
    throw new DomainError("ORIGIN_MISMATCH", "This action must stay in its original Guild browser workspace.", 403, false);
  }
  if (browserPost && request.headers.get("sec-fetch-site") === "cross-site") {
    throw new DomainError("CROSS_SITE_COMMAND", "Open Guild to continue this action.", 403, false);
  }
  return accepted;
}
