# Accepted exhibition publication

The publication room at `/commissions/:commissionId/publication` separates an owned reading copy from a deliberately published edition. Open it from **Publication & editions** on the commission Overview. An active owner or judge chooses the accepted original exhibition, reviews a prepared proposal, acknowledges its complete public file register and publishes that exact proposal. Operators can inspect the room and retained evidence; they cannot prepare, publish or withdraw.

Publication makes no model, browser-audit, speech, transcription, acceptance, budget or payment request. It does not renew a Passport, provider offer or production deadline. Current provider availability and production authority can end while the accepted original work remains readable.

## Admission and decisions

Migration `018_exhibition_publication.sql` is additive. It creates a separate publication head for each tenant/commission, prepared proposals, immutable editions, append-only publication/withdrawal events, idempotent commands and original-file response records. It does not rewrite artifact manifests or the existing acceptance, production or commercial tables.

Preparation validates all of the following through one database transaction client:

- The current authenticated actor and tenant exist, retain the claimed role, have not expired or been revoked, and belong to the commission.
- The exact submitted exhibition artifact and selected ordinal match the original producing job, approved snapshot, signed receipt, original bundle and source manifest.
- The exact research, translation, narration, image, caption and web artifacts each have an existing owner/judge acceptance decision for their artifact hash, contract version and original acceptance pack. An operator or automated acknowledgment does not satisfy this gate.
- Each decision retains its human-review declaration and explicit unverified fluent-language limitation. Translation retains all six individual curator acknowledgments. This implementation cannot invent a fluent reviewer, fluent-review date or supported fluent-review claim.
- Every source retains its bound passing verification. The media families and web retain their original independent verification jobs. Web retains all original file checks, the complete eighteen-case independent report and the original signed case evidence bytes.
- Every public file matches the exact original type, byte length, SHA-256 and source identity. Authored paths are allowlisted; media paths come only from the original source register. The source-record JSON must equal the approved original public source/design/disclosure structure. Credential-shaped values in authored text are refused, without rewriting the source.

The prepared record contains these identities and hashes, the complete portable bundle manifest, canonical manifest bytes, deterministic ZIP hash/length, actor, publication revision, next edition number, older active edition identities, older-link policy, note, disclosure and a digest. The proposal expires within thirty minutes or at the actor's expiry, whichever comes first. Preparing it does not expose a public link.

The separate publish command requires the exact proposal ID and digest, expected publication revision and `acknowledgePublicFiles: true`. It locks the owned commission and publication head, rechecks the actor, validates all original bindings and bytes again, compares the complete proposal binding, and rechecks time and actor immediately before commit. The original acceptance decisions remain separate from the immutable publication record.

Each command ID belongs to one actor, commission, action and payload. Repeating the same command returns its stored result; changing its payload or actor is refused. Concurrent duplicate commands create one decision. Competing publish/withdraw commands at the same expected revision have one successful decision; the other must refresh. Failed validation rolls back and releases its client and locks.

## Public originals

Every edition receives a new random 192-bit identifier. Its reader lives at `/published/:publicId/index.html`. The public route accepts only that identifier, one exact registered relative path and an optional single supported `lang` value. It cannot select arbitrary tenants, artifacts, ordinals, private objects or unselected designs. It never fabricates an owner session.

The route first takes a shared lock on the publication head and verifies the retained edition and event chain. Only an active recorded edition may read its original bound bundle. Authored bytes come from the signed saved bundle; media bytes come from the source-bound private objects. Every response verifies its original length and SHA-256. It does not rerender the design, regenerate audio, replace missing files or substitute a newer artifact.

The public register contains the selected reader HTML/CSS/JavaScript, source record, README, three local font files and their licences, original photographs, all seventy-eight narration recordings and their seventy-eight VTT files. `bundle-manifest.json` returns the exact canonical manifest bytes saved with the edition. `exhibition.zip` uses the original file order and deterministic ZIP format whose hash was approved in the proposal. Public source identifiers and original automated review references are explicitly disclosed before publication. Raw model prompts, payer/recipient records, credentials, unrelated commission history and unselected designs are excluded.

GET and HEAD return the correct media type, `nosniff`, a SHA-256 ETag, single byte-range support and `no-store` for browsers and CDN layers. Strong `If-Match`, weak/list `If-None-Match`, exact ETag `If-Range`, suffix/open-ended ranges and invalid-range responses are handled after publication authorization. A stale ETag cannot bypass withdrawal. HTML uses the hashes of its original inline script/styles, same-origin media/fonts/images, no connections or embedded frames, `frame-ancestors 'none'`, no form actions and no base URL. The public response does not weaken the original reader's own CSP.

Range handling applies to GET. HEAD and unrecognized range units ignore the Range header, consistent with [RFC9110 section14.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-14.2).

The pinned Next16.4.6 Route Handler adapter strips `Content-Length` framing headers. Real HTTP HEAD therefore returns the type, ETag, range capability and no body without promising a length header. The immutable manifest supplies the exact file length; HTTP checks verify actual GET/range bytes and retain this adapter observation.

The shared head lock stays held until the original bytes have been verified and the response assembled. A withdrawal waits for already admitted requests. Once it commits, all later requests—including HEAD, ranges, conditional requests and ZIP downloads—are denied. A response already admitted can finish, and an already loaded page or downloaded archive cannot be recalled. This ordering is tested with six concurrent reads, the same size as the production PostgreSQL pool; every nested database read uses the transaction client.

## Versions, history and withdrawal

The preparation dialog explicitly chooses whether earlier active links remain available or are withdrawn with the new publication. Older editions retain their original source, acceptance and report identities. There is one separately revisioned current pointer, but earlier active editions keep their own working links. Withdrawing the current edition does not silently promote an older one.

Withdrawal requires an exact edition ID, current revision, recorded reason and `acknowledgeCopiesRemain: true`. It appends an actor/time/reason event and closes the link without deleting accepted work, original files or response history. A withdrawn URL returns HTTP410 with an accessible explanation; an unknown link returns404. Publishing again always creates a new edition and public identifier. There is no reactivation command.

History distinguishes current, earlier active and withdrawn editions. The owner can inspect each source and decision, download the original private reading copy/ZIP and export `/api/commissions/:commissionId/publications/:editionId/evidence`. That private receipt reads exactly the original acceptance and verification records named by the edition. A changed or missing original report produces an error; a later report is never substituted.

Response records retain edition, original file path/hash/length, response disposition and time. No reader identity, IP or user-agent is stored by this feature. The UI calls the ZIP total **recorded responses**, including HEAD, range and conditional requests. It does not claim completed downloads or unique readers.

Edition/proposal/event/command/response rows reject UPDATE and DELETE. HMAC signatures and an event hash chain detect mismatched saved records; they are application receipts, not independent notarization. Keep the original `AUTH_SECRET` available for these signed histories. Secret rotation needs an explicit historical-key migration; changing the key alone causes old signatures to fail closed.

## HTTP and runtime configuration

| Route | Access and effect |
| --- | --- |
| `GET /api/commissions/:id/publications` | Active owner/judge/operator, owned history only |
| `POST .../prepare` | Active owner/judge; exact read-only admission and saved proposal |
| `POST .../publish` | Active owner/judge; revalidation and one new edition |
| `POST .../withdraw` | Active owner/judge; one exact withdrawal |
| `GET .../:editionId/evidence` | Active owner/judge/operator; original private receipt |
| `GET, HEAD /published/:publicId/[[...path]]` | Active recorded public edition and registered original files only |

Mutations retain the existing same-origin and cross-site checks. The configured session issuer, lifetime, Secure/HttpOnly/SameSite attributes and authority gates are unchanged. `GUILD_SESSION_COOKIE` optionally supplies a separate 1–64 character letter-led cookie name containing letters, digits, `_` or `-`; the default remains `guild_session`. This is useful for independent QA servers sharing localhost and grants no additional authority.

Runtime still requires the existing PostgreSQL URL, `AUTH_SECRET`, `JUDGE_SESSION_SECRET` and private Blob credentials for original media. Publication requires no model/provider/worker credential. Next's Turbopack and output-tracing roots are pinned to the application directory so isolated checkouts cannot trace an ancestor workspace's dependencies. Preparation and publish traces explicitly include the pinned Whisper tokenizer used when validating the original caption ancestry. The original renderer warning about dynamic file tracing remains separately inspectable; qualification must check the actual trace, its required assets and private-file exclusions.

Browser-worker platform qualification and hosted provider integration are separate work. A synthetic eighteen-case fixture does not qualify a browser or represent actual native interaction. Publication does not substitute an unqualified browser beneath an old capability digest.

## Verification and isolated fixtures

`tests/web-publication.test.ts` covers strict commands, acknowledgments, original-byte validators/ranges/HEAD, path/query denial and public errors. `tests/publication-cookie.test.ts` covers the default and validated isolated name. `tests/integration/web-publication.test.ts` exercises real PostgreSQL admission, every source gate, exact report and byte mutations, actor/tenant isolation, proposal expiry, idempotency, immutable editions, original receipts, expired production history, publication/withdrawal races and six-client resource release. Existing source-history, audit-storage and reader tests remain part of the focused regression check.

Tests use synthetic provider/model/browser transports. They deliberately seed fictional owner decisions with `humanReviewed: true` to exercise the unchanged production gate, and tag every such decision and every language acknowledgment with synthetic provenance and an explicit statement that no person or fluent reviewer participated. The production code has no acceptance bypass. A displayed fixture notice is disclosure only; it never changes admission.

For a retained HTTP/native pair, use only the dedicated loopback PostgreSQL harness on55496, role `guild_web_fixture`, database `guild_web_tests`:

```sh
DATABASE_URL=postgresql://guild_web_fixture@127.0.0.1:55496/guild_web_tests \
  node --import tsx scripts/seed-web-publication.ts http-example
DATABASE_URL=postgresql://guild_web_fixture@127.0.0.1:55496/guild_web_tests \
  node --import tsx scripts/seed-web-publication.ts native-example
```

Each run creates a new schema, fresh signing/session secrets, fictional owner identity and private media directory. It drives the complete five-family ancestry and original web production/verification through application jobs with synthetic transports, then persists the exact original files. Native and destructive HTTP QA use different schemas, tenants, cookies and secrets. The generated private `fixture.json` is never committed or included in a bundle. The seed refuses to overwrite a fixture directory.

After a clean isolated production build, start the retained HTTP fixture with:

```sh
node scripts/build-publication-candidate.mjs
node scripts/serve-publication-fixture.mjs ../web-publication-checks-v1/http-example/fixture.json
node --import tsx scripts/check-publication-http.ts ../web-publication-checks-v1/http-example/fixture.json
```

Use `http://localhost:4542` as the QA origin. The listener binds loopback. The launcher passes an explicit private environment and rejects `.env` files in its source copy. The unmodified production Blob gateway and SDK read exact retained objects through a process-only Undici mock; all actual outbound transports through that dispatcher are disabled. Nothing in this transport is imported by the application. The real HTTP check verifies every original public file, all six language URLs, headers, ranges, roles, tenant isolation, duplicate commands, prior editions, withdrawal and private originals. It records failures as well as successes without cookies or credentials. Passing it makes no native UI or real provider claim.

The launcher can also take a frozen manifest as its third argument. It verifies source/build hashes and the private fixture manifest before starting. It never rebuilds, reseeds, extends a session or alters an approval. Root-operated native review follows [the publication protocol](PUBLICATION_NATIVE_PROTOCOL.md) against the separate native fixture.
