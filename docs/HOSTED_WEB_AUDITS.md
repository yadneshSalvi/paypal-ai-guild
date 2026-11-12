# Hosted web audit worker

The server can run the existing qualified audit inside an immutable Vercel Sandbox snapshot. Local qualified runtimes remain supported. HTTP callers select neither runtime, snapshot, executable, paths nor credentials.

This integration does not qualify new caption sources, grant a Passport, accept an exhibition or publish it. Existing deadlines and all original failed or uncertain attempts remain fixed. Automated measurements and human review remain separate.

## Configure an independently qualified snapshot

Retain the original full qualification archive and complete read-only verification of all 18 baselines and two negative controls before sealing metadata. A snapshot ID or compact summary alone is insufficient. The original snapshot stops its producing VM; never resume/rebuild that VM to replace its proof.

Prepare these private local inputs:

- The original qualified `guild.web-audit-runtime.v2` JSON and complete `guild.web-audit-qualification.v2` JSON.
- The retained original archive, at most 64 MiB compressed.
- A normalized snapshot metadata JSON object containing exactly `id`, `sourceSessionId`, `createdAt`, `expiresAt` and `region` (`iad1`). Obtain it through a read-only provider lookup and verify original ownership/timestamps. Preserve the original expiry.

With the server's `AUTH_SECRET` provided privately, run the local-only utility. It hashes the archive, validates the complete metadata, creates a new mode0600 HMAC-sealed file and makes no provider request:

```sh
node --import tsx scripts/seal-hosted-web-runtime.ts \
  --runtime /absolute/private/original-runtime.json \
  --qualification /absolute/private/original-qualification.json \
  --snapshot-metadata /absolute/private/original-snapshot.json \
  --archive /absolute/private/qualification-original.tar.gz \
  --team team_YOURTEAM --project prj_YOURPROJECT \
  --output /absolute/private/new-hosted-runtime.json
```

Supply exactly one server configuration:

- `GUILD_WEB_AUDIT_RUNTIME`: an absolute private JSON path, for either local or hosted mode.
- `GUILD_WEB_AUDIT_HOSTED_RUNTIME_JSON`: the complete bounded sealed hosted JSON supplied through server-only deployment configuration. It needs no private runtime file in the deployment bundle.

The HMAC key must be the same `AUTH_SECRET` used when sealing. No real metadata, seal key or token belongs in source control. `GUILD_WEB_AUDIT_EVIDENCE_DIR` is required only in local mode; hosted originals are retained durably in PostgreSQL.

Prefer the configured hosting project's OIDC context. The public `@vercel/oidc` helper obtains credentials, and the worker checks the token's project/team scope before sending a control-plane request. Alternatively set `GUILD_WEB_SANDBOX_TOKEN` server-side; the sealed configuration selects its team/project. Tokens never enter the VM, logs, output metadata or browser.

Apply all migrations, including `019_web_hosted_attempts.sql`, before running this source. Publication uses its separately owned migration018. The worker does not modify business expiry or introduce a second financial operation.

## Dispatch and retain one original

The app reads the trusted local metadata and verifies the current authored renderer, runner and lock hashes. It does not pretend the function/Mac host verified Linux binaries.

For each exact case:

1. Read/hash every original source file. Atomically claim the existing prepared case once and preserve its original dispatch timestamp/deadline.
2. Persist one HMAC-bound deterministic creation intent before a single snapshot-backed create: persistentfalse, two vCPUs, ten-minute runtime limit, denied outbound network, no exposed ports, empty injected environment.
3. Save the exact original session. Use only direct `Session` operations; `Sandbox.get({resume:false})` is used solely to read identity. Sandbox instance filesystem/command methods can automatically resume and must never be substituted.
4. Run the unchanged full `qualify.mjs verify` inside that original session. This independently checks every original raw report/chunk, sample bundle, binary, dependency, OS, policy and qualification binding without launching a browser. Compare its result and original runtime/qualification JSON with the trusted seal.
5. Upload only the exact bundle bytes and browser request. Rehash the entire remote bundle after upload.
6. Recheck current application authority, actor, original job/source/request and worker lease immediately before the actual browser command. Renew only that lease. Dispatch one bounded330-second command, saving its ID via the non-detached Session `onStart` hook before awaiting the result. A remote exclusive file guard also prevents a second invocation in that original case/session.
7. Retain every bounded native JSON/chunk plus original process dispatch, result, complete output index, runtime proof and upload proof. Verify hashes, native findings, exact process/session/command and source bindings. Only then save the existing signed observation.
8. Stop only that original session after the signed observation and complete bytes have been read back from durable storage. A lost stop response remains a separate retained cleanup uncertainty; it cannot erase an observation or trigger another stop/browser.

The installed SDK retries mutations by default. The included one-attempt fetch wrapper prevents mutation redelivery on network loss,429 and5xx. Streaming command loss may read the same known command; it never starts another one. Unknown create/upload/command identities remain held. A definite complete failing measurement is retained as its actual failure, even if the subprocess exited successfully.

The function routes which can dispatch hosted work request800 seconds. Confirm the project's supported Fluid Compute duration before deployment; the worker still bounds VM lifetime and individual commands independently. [Vercel duration configuration](https://vercel.com/docs/functions/configuring-functions/duration), [function limits](https://vercel.com/docs/functions/limitations).

## Read-only recovery

The original worker name/session/command, request/configuration digests, worker identity and original deadline are durably retained. Losing a response never authorizes a replacement name, create, upload, session, browser command or expiry renewal.

`POST /api/web-jobs/{jobId}/recover` accepts only `{ "caseId": "original-case-uuid" }` from an active same-origin owner workspace. It checks tenant/job ownership and addresses the saved original identity. The existing authenticated `/api/jobs/recover` also reads at most one previously dispatched original before current job validation. This preserves late output when the job or business authority is already held or expired.

Complete original files in storage can finish recovery without a live VM, current renderer or unexpired snapshot. Otherwise the worker reads the same original command/session without resume. Missing files or missing command identity stay unknown. A terminated command whose final index is absent permits only a bounded read-only listing/hash of its original output directory; this distinct read is journaled and never imports the browser runner. Partial files are saved before returning a hold.

Only a validated original hosted attempt may move an indeterminate case to received. Exact duplicate observation bytes are idempotent; different bytes fail. Original dispatch/session/command IDs and earlier failure history remain intact. Recovery does not requeue an expired job, authorize another case, complete the artifact, accept work or pay anyone.

Owners can open “Read original browser attempts” in the job's evidence view. Loading the register reads saved rows; the separate action collects only its already-dispatched original result. Source and automated/human-review limits remain visible.

## Source verification

```sh
GUILD_HOSTED_TEST_NODE=/absolute/path/to/node22 \
GUILD_HOSTED_PG_BIN=/absolute/path/to/postgresql/bin \
sh scripts/test-hosted-web-isolated.sh
npm run typecheck
npm run build
node --import tsx scripts/check-hosted-web-trace.ts
```

The launcher creates a new PostgreSQL cluster/database using a private Unix socket, injects only disposable fixture values, disables environment-file loading and unstubbed HTTP/fetch, and retains logs under `.private/hosted-checks/`. Its SDK and remote gateway transports are controlled synthetic fixtures. The dispatcher fence additionally executes a filesystem-only stub, without Playwright or a browser. These source tests are not an actual hosted browser qualification or production admission. Actual original snapshot execution, native UI review and deployment remain separate operator gates.

The trace check rejects private or out-of-project inputs, requires every renderer/runner/lock file in each dispatch/readiness function and the real SDK in recovery functions, then stages only traced files. It recomputes the original renderer/runner identities and imports the actual Sandbox SDK from that staged dependency closure without making a request. The existing immutable renderer can still cause a broad dynamic-filesystem tracing warning; explicit project roots and private exclusions contain it without changing qualified source bytes.

Retention is bounded per case:200 native files,16MiB/file and64MiB of native evidence, plus bounded original metadata. Native bytes currently appear in both the existing audit store and the hosted recovery store so partials and complete observations remain independently bound. Monitor this explicit storage cost. No credential-bearing arbitrary provider error object is persisted or returned.
## Original recovery roles

Same-tenant owners, judges and operators may inspect a saved web job and deliberately collect its already-dispatched original hosted result. Provider identities cannot do so. The session must still be active and unrevoked; the original business deadline may be expired because collecting retained evidence grants no new work authority. The case must belong to the exact owned job. This recovery path never creates another VM, recognition request, browser attempt, payment or renewed deadline.

