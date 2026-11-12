# Provider invitations and agent connections

An explicitly invited operator can open its own provider console without replacing the customer workspace. Customers manage their agent credentials at `/connections`; provider operators use `/provider/connections`. The two pages use fixed API routes and separate HttpOnly cookies. Opening either page creates no provider, policy, credential, commission or work.

Invitation links put their private challenge in the URL fragment. The browser sends it in a preview header and an explicit claim body; it does not send it in an HTTP URL or referrer. Preview GET/HEAD is read-only. Claiming opens one original provider session with a fixed absolute expiry. The browser retains the original claim ID and challenge digest for recovery. An exact claim retry can recover only that same original session/cookie; another claim, changed provider identity, revocation or expired original session cannot mint a replacement or extend the ceiling. Preserve the original private invitation link for recovery.

Credentials are shown once. Only a hash, safe prefix, label, original actor/provider binding, scopes and expiry are saved. The credential can never outlive its original workspace session. If issuance has an unknown response, the UI reads the original command status; it does not automatically issue another token. A retained summary supports explicit revocation followed by a separate new issue decision. A bearer cannot issue or revoke credentials, even if a browser cookie is also present.

| Entry | Authentication | Permitted actions |
|---|---|---|
| Customer connections | Original customer cookie | Issue/read/revoke own `mcp` and `a2a` credentials |
| Provider connections | Separate original provider cookie | Issue/read/revoke own provider-agent credentials |
| MCP `/api/mcp` | Customer `mcp` bearer | `commission.create`, `commission.status`, `approval.link`; no owner approval or payment |
| Enrolled A2A service | Customer `a2a` bearer or exact retained operation credential | Existing contract-bound offer/task actions; current buyer approval still required for delegation |
| `/api/provider-agent/workspace` | Provider bearer with `provider:read` | Read this provider's requested contracts, negotiations, tasks and exact artifacts |
| Provider-agent commands | Read plus `provider:negotiate` or `provider:cancel` | Counter/decline owned offers, or cancel eligible unstarted owned tasks, inside the current provider policy |

Provider agent credentials are for the disclosed Guild provider API. They cannot edit the provider profile/policy, discover endpoints, select a buyer offer, approve a Passport, delegate buyer work, accept an artifact or move money. The command transaction rechecks and locks the original session and credential. Durable attribution binds the credential, provider identity, permission and exact command digest, while the existing market command retains the original decision/result. Revocation cannot race past that transaction's authority check.

Provider artifacts have separate fixed human and agent routes. Both enforce the original task/provider/artifact binding and return the retained bytes. Provider completion, artifact verification, customer acceptance, capture and payout remain separate records.

## Explicit operator setup

The operator script is `scripts/provider-access-operator.ts`. It never loads `.env`, initializes a schema, seeds from a GET, sets a provider policy, fetches a service, starts a job or performs a financial action. All private inputs are absolute regular files with mode0600. Output directories are mode0700. Keep plans, raw invitation delivery, receipts and database configuration outside source control.

Run with Node22 and the installed `tsx` loader. `--database-url-file` accepts a private file containing the exact PostgreSQL URL or JSON with a `databaseUrl` field. It must already point to the reviewed migrated schema.

1. `--mode plan` requires explicit `--operation` UUID, `--browser-origin`, `--service-origin`, `--issuer`, `--synthetic-fixture true|false`, `--invitation-expires-at`, `--session-ceiling-at`, and a new `--output-dir`. It saves a complete plan and private fragment-link delivery. The dry run writes no database rows.
2. Review the plan's actual database/server/schema identity, catalog and registry fingerprints, seven service capabilities/owners/endpoints, provenance, absolute deadlines and digest.
3. `--mode apply` requires that exact `--plan`, `--expect-digest`, both configured origins and an existing private `--journal-dir`. It journals intent before the database transaction. Existing providers are preserved byte for byte; differing endpoints, owner bindings, capabilities or provenance require a separate reviewed migration. No policy is approved automatically.
4. `--mode inspect --operation <original UUID> --output-dir <new private directory>` reads the retained result. After inspecting an unknown response, an explicit `--resume-original true` on the same apply request can recover only that original operation/result. It does not recreate links or renew deadlines. Keep the original private delivery file; raw challenges cannot be recovered from database hashes.
5. `--mode revoke` takes the original reviewed plan/digest, the exact `--invitation`, a stable new `--operation`, `--issuer`, a private `--reason-file`, and `--journal-dir`. It revokes that invitation, its original provider session and associated provider credentials. Other customer/provider sessions, jobs, artifacts and financial records are unchanged. Repeated original revocation preserves its original timestamp.

Browser entry origins and enrolled service origins are different boundaries. `GUILD_MARKET_BROWSER_ORIGIN` is the reviewed browser entry; `APP_URL` remains an accepted configured public entry. On a Vercel deployment with exposed system variables, the exact `VERCEL_URL` hostname is accepted only when `VERCEL=1`. Vercel documents that generated hostname separately from the public domain. [Vercel system environment variables](https://vercel.com/docs/environment-variables/system-environment-variables)

`GUILD_MARKET_APP_URL` identifies the controlled service origin at enrollment. Existing service and operation endpoints are never silently moved when a preview or public alias changes. Preserve their reachability and reconcile unknown original operations before an explicit origin migration.

## Schema and evidence boundary

Migration023 adds invitation/setup/credential-command/agent-attribution tables and nullable protocol-client metadata. It contains no provider seed, default policy, backfill or existing credential rewrite. Existing legacy customer credentials retain their provider restriction and original expiry. Production use requires an actual read-only catalog/row preflight, verified backup, reviewed additive migration and before/after preservation evidence. Do not run a blind initializer against production.

Controlled verification uses the existing portable launcher with `--qualification access` and an owned loopback app port plus a new restricted socketPG55568 schema. The source/build/runtime ownership and non-replay rules in [the qualification guide](PROVIDER_MARKET_QUALIFICATION.md) still apply. The profile selects `scripts/check-provider-access-next-http.ts` and `tests/provider-access-next-http.test.ts`; it cannot change after the original freeze. The script retains private original intents, credentials, HTTP hashes, failures and a full row baseline for native review. Synthetic artifact/approval fixtures do not establish actual model output, human listening/fluent review, acceptance or financial settlement.

This unit implements controlled Guild provider entry and bounded credentials. External provider ownership verification/OAuth federation, broad A2A conformance, official AP2 conformance and the actual six-package producer/payment workflow remain separate acceptance gates.
