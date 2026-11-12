# Explicit Sample entry

An anonymous Studio visit checks for an existing workspace. A page load, refresh, preview probe or empty authenticated workspace read creates no Sample. **Open a Sample commission** is an explicit action; it does not approve a Passport, queue production, accept an artifact or move money.

The tab retains one versioned request before sending it. Double clicks share that request, and a lost response offers **Recover this Sample**. Recovery returns the original session, cookie and first commission with the original expiry. A changed proof, revoked session, expired original grant or missing original commission refuses replacement. The recovery request cannot inherit a later session renewal. An expired unopened request requires a separate explicit preparation and click.

An existing customer or operator keeps their original role, cookie and current expiry. Opening an existing workspace creates nothing. If it has no commission, explicit entry saves its first Sample and an original request receipt in one transaction. Provider access remains separate and cannot become customer authority through this endpoint. Workspace reads no longer seed a commission.

The request uses `guild.sample-entry.v1`, the `open_sample` intent, a UUID, a random recovery proof and its original timestamp. The server accepts no caller-selected tenant, role, duration or expiry. Recovery proofs are private credentials: never copy them to public logs, URLs, screenshots or evidence.

No migration or backfill is needed. Existing sessions, commissions, artifacts, jobs and their deadlines are retained. Admissions created by an earlier automatic-entry build remain retained; their requester is not inferred from timing.

Run the focused source and mounted React cases with:

```sh
npx tsx --test tests/sample-entry.test.ts tests/sample-entry-ui.test.ts
```

For actual Next HTTP and PostgreSQL, use the [portable qualification launcher](PROVIDER_MARKET_QUALIFICATION.md) with `--qualification entry` on every mode and an explicitly owned loopback app port. It selects `scripts/check-sample-entry-next-http.ts`, a fresh `guild_entry_next_worker_<random>` schema, and two port-scoped cookie names. Follow the documented freeze, clean build, refreeze, typecheck, prepare, start and single test sequence. Never repeat the mutating test on an already claimed fixture.

The HTTP suite covers inert reads, bounded parsing, origin/Host refusal, six concurrent admissions, discarded-response recovery, original cookie and role continuity, empty-owner entry, expired/revoked/renewed recovery, missing original records and rate-limit rollback. Its provider/operator rows and response loss are controlled qualification fixtures. Native layout, keyboard and browser-cookie checks are a separate acceptance step.

The exact source passed the focused, mounted HTTP and native entry checks and is now canonical. The [hosted release record](PROVIDER_ACCESS_HOSTED_RELEASE.md) separates those results from retained provider-access evidence, the bounded hosted MCP check and complete row/session preservation.
