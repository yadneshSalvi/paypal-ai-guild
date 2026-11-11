# Continuing a working session

The museum workspace has an eight-hour browser session. During its final hour, the active owner or judge can use **A note about this studio → Continue this workspace** to keep the same workspace open for another eight hours. This is an explicit action; polling and background work never renew access.

The command verifies the signed current cookie, exact origin, active unrevoked actor, role and expected expiry. A locked PostgreSQL transaction records its request identity and both expiry times. Concurrent requests cannot stack extensions, and a lost response can replay the original request. Expired, revoked, provider and operator sessions cannot use this route. The request cannot select a tenant, role or duration.

The continuation updates only workspace and browser-session expiry. It does not change any Passport mandate, purpose, spending cap, delegated scope, mandate expiry, payment approval, checkout challenge, artifact acceptance or provider credential. Commercial actions continue to require their original independent authority and expiry checks. Saved commissions, artifacts and financial history remain byte-for-byte unchanged.

An expired studio no longer silently opens an unrelated sample over a requested commission. Its saved work remains retained. Recovery after expiry requires a separate authenticated recovery mechanism; this continuation endpoint cannot recover expired access.

Migration 13 adds only the append-only session-renewal receipt table. The PostgreSQL regression checks concurrent replay, distinct concurrent commands, early/stale/changed requests, invalid roles, expiry, revocation, forged cookies, foreign origins and unchanged saved commercial state.
