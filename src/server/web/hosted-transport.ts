/** Vercel SDK3.9.1 retries network/429/5xx failures by default. An uncertain
 * create/command must keep its original durable identity without redelivery.
 * AbortError is the SDK's documented implementation-level no-retry escape;
 * the retained code below still identifies this as an unknown outcome. */
export class HostedTransportUncertain extends Error {
  readonly code = "WEB_HOSTED_TRANSPORT_UNKNOWN";
  constructor(public readonly method: string, public readonly path: string, public readonly originalStatus: number | null) {
    super("The original hosted worker request has an uncertain result. Recover its retained identity without submitting another request.");
    this.name = "AbortError";
  }
}

export function singleAttemptSandboxFetch(transport: typeof fetch = fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const url = new URL(input instanceof Request ? input.url : String(input));
    const mutation = !["GET", "HEAD", "OPTIONS"].includes(method);
    // No response URLs, headers, request bodies or credential-bearing error
    // objects are copied into an exception or the public diagnostic surface.
    try {
      const response = await transport(input, init);
      if (mutation && (response.status === 429 || response.status >= 500)) {
        await response.body?.cancel().catch(() => undefined);
        throw new HostedTransportUncertain(method, url.pathname, response.status);
      }
      return response;
    } catch (error) {
      if (error instanceof HostedTransportUncertain) throw error;
      if (mutation) throw new HostedTransportUncertain(method, url.pathname, null);
      throw error;
    }
  }) as typeof fetch;
}
