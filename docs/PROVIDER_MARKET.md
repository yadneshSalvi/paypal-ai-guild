# Provider market and agent interfaces

The source connects `/market` and `/provider` to the same retained offers, policy decisions and delegated work used by the agent interfaces. It adds migrations 021–022. A market read creates no provider, policy, discovery request or job. An empty registry stays empty until explicit reviewed setup.

The customer chooses an exact work package, reviews a provider's observed card and owner policy, requests a quote and can counter, decline or select its terms. Award and service fee remain separate. Selecting terms prepares a new contract version and clears approval for different terms. Delegation requires the current approved plan, exact offer/source/acceptance-pack digests and the original authority ceiling. Unknown responses retain the original operation and task identity for recovery.

The provider console requires both a provider session and its durable owner binding. It exposes only that provider's contracts, negotiations, tasks and award obligations. A new floor or policy revision cannot rewrite an earlier offer. Provider completion, independent checks, customer acceptance, buyer capture and provider payout are separate records.

## A2A profile

Each of the seven Guild-controlled services exposes:

- `GET /api/providers/{providerId}/.well-known/agent-card.json`
- `POST /api/providers/{providerId}/a2a`

The source pins `@a2a-js/sdk` 1.3.0 and the [A2A 1.0.1 specification](https://a2a-protocol.org/v1.0.1/specification/). Cards advertise the JSON-RPC binding and wire version `1.0`, together with the required `urn:guild:provider-market:v1` extension. The service implementation version, SDK version, specification revision and negotiated wire version are distinct.

Messages carry typed quote/counter/accept/decline/delegation data. The server derives authority from the authenticated owner and retained state; model prose cannot select another tenant, change a provider floor or authorize payment. Task results retain the original job and exact artifact bindings. Artifact bytes are withheld if that binding fails. GetTask, cursor-based task lists, streaming, eligible cancellation and exact original-result recovery share the same scope checks.

The addressed services are operated by Guild. They are not represented as seven outside businesses. Push notifications, gRPC, HTTP+JSON and extended authenticated cards are unadvertised optional capabilities. The exercised JSON-RPC profile and official-client round trips do not establish full A2A 1.0.1 conformance. The longer-lived streaming window, broad transport interoperability and production identity/TLS behavior retain their own gates.

## Three MCP tools

`POST /api/mcp` uses the official MCP server/client 2.4.0 packages with scoped bearer credentials. A browser cookie alone is not an MCP credential.

| Tool | Result and authority boundary |
| --- | --- |
| `commission.create` | Creates an unapproved draft from a typed brief and proposed cap. It starts no work or payment. |
| `commission.status` | Returns authorized redacted status for the same owner. |
| `approval.link` | Issues a short-lived continuation bound to the original owner, commission revision, plan digest and one-use challenge. |

A continuation GET/HEAD is read-only. The owner must deliberately continue with its original browser session; an agent bearer cannot impersonate that session. Consuming the link opens the matching Passport and approves nothing. Exact retry, stale revision, expired authority, cross-owner access and already-used links are distinct retained outcomes.

## Configuration and remaining entry work

`GUILD_MARKET_APP_URL` is an exact configured origin. Local qualification uses an explicitly owned loopback port; hosted enrollment requires the reviewed HTTPS service origin. Endpoint/card identities are retained and cannot be silently retargeted when an operation has an unknown result.

The controlled qualification provisions separate provider-owner fixtures and scoped protocol clients in a fresh restricted schema. Production provider setup, provider invitations and customer/provider agent-connection UI are separate entry work; these fixtures do not establish a completed production onboarding journey. External endpoint ownership verification, observed reputation, AP2 mandates, actual provider output and financial closure also remain separate gates.

## Reproduce source checks

```sh
npm ci
npm test
npm run test:market:ui
npm run typecheck
npm run build
```

The component checks use the pinned development dependencies in this checkout. They perform no network or database work and do not claim native-browser acceptance. Database/HTTP suites are explicit opt-ins: they require fresh uniquely named schemas on the dedicated restricted local PostgreSQL port, empty model/media/payment keys and an owned loopback listener. Their tests refuse an existing fixture/schema and preserve original reports on failure. Follow [the production HTTP qualification instructions](PROVIDER_MARKET_QUALIFICATION.md) for the actual Next run.

The canonical caption/exhibition release has a [separate scope and source identity](CAPTION_WEB_HOSTED_RELEASE.md). A marketplace source merge does not by itself deploy these routes or provision any provider account.
