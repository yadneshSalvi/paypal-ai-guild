# Guild contracts v2

`src/contracts/guild.ts` is the shared DTO boundary (`guild.v2`); `src/contracts/payments.ts` is the strict financial command boundary. The integration lead owns both. Dependent workers request a versioned contract change before changing shared fields. Browser and model output never establish money authority or acceptance.

The app is a root-level Next.js App Router project under `src/app`. Shared types come from `@/contracts/guild`. Client components cannot import server modules. Semantic CSS tokens are `--paper`, `--canvas`, `--ink`, `--muted`, `--line`, `--brass`, `--green`, `--red`, `--display-font`, `--ui-font`, `--mono-font` and `--arabic-font`.

## Commands, identity and persistence

Ordinary mutations carry `commandId` and `expectedRevision`, derive tenant and actor from a signed HttpOnly session, and return `CommandResult`. Revision conflicts return 409 and the canonical snapshot. Accepted commands, their results and domain events commit atomically. Duplicate command IDs return their recorded result; replay cannot execute external money. Artifacts are immutable by hash. Acceptance binds the current package contract, exact artifact hash, verified criteria and the actor's review acknowledgement.

`GET /api/workspace` returns `WorkspaceSnapshot`; the optional `commission` UUID selects an owned commission. `POST /api/judge/sessions` creates an isolated tenant/session and sample commission; reset preserves prior records. `POST /api/commissions` creates a live draft. `POST /api/commissions/:id/commands` accepts the application command union. Generation is a persisted job with canonical progress, lease ownership and recorded model outputs. Safe errors expose a code, message and recoverability, never credentials or raw private provider bodies.

`record_automated_review` binds the exact package version, artifact hash and immutable findings. It records `humanReviewed:false` and `accepted:false`; it does not mutate checks, acceptance or payment eligibility. `amend_image_contract` freezes the executable image pack before image production. `amend_draft_dependencies` explicitly versions the four dependent contracts to allow checked, automatically reviewed upstream drafts as production inputs. Both amendments preserve the original contracts in `guild_contract_amendments`, invalidate approval and require a fresh Passport. They cannot change begun work or existing billing authority.

`ArtifactInputBinding` retains the exact upstream package version, artifact ID/hash, review kind and review identity. Original contracts require accepted inputs. An amended `inputPolicy:reviewed_drafts` additionally permits the current submitted artifact only when its exact immutable deterministic checks pass and an attributed automated review exists. Authority checks revalidate these bindings before each new model/storage operation. Downstream human acceptance still requires human acceptance of the same upstream identities; changing an input or recording an automated note does not make the output payable.

## Financial boundary

`POST /api/commissions/:id/payments` accepts only the discriminated command union:

- `prepare_checkout`: current revision and either authorization or exact package route.
- `complete_checkout`, `resume_checkout`, `cancel_checkout`: stored intent identity, original owned order and/or original challenge as required by the command schema.
- `capture_package`, `close_authorization`, `pay_provider`: current revision and exact domain target.
- `retry_operation`, `retry_payout`, `cancel_payout`: an existing owned durable operation identity.
- `reconcile`, `inspect_order`: owned-resource reads; they do not authorize a new charge or model retry.

There are no browser amount, recipient or final-capture fields. Strict schemas reject additional properties. Admission binds the current signed plan, accepted artifact and criteria, approval actor, merchant fingerprint and ancestor authority. An actual owner/judge acceptance is required for payable work; sample, replay and disclosed system-operator qualification remain nonpayable. Current authority is rechecked before dispatch. The tenant ceiling covers exposure across commissions, not just the visible commission.

Checkout return/cancel routes bind the session and HMAC challenge to the original intent. GET performs no financial mutation. An SDK popup dismissal is presentation-only. Explicit same-order resume requires a fresh owned `APPROVED` order, no authorization/capture, the latest original unexpired challenge and current approved authority. It preserves the original cancellation and expiry; it creates no replacement order.

`paymentSummary` exposes safe projections of operations, checkout, authorization, captures, refunds, provider payouts, `toolRuns` and completed `toolEvidence`. Resource labels are masked. Pending/unknown status is distinct from success. Service fees are earned only by actual successful package capture. Provider-paid totals require an independently read exact payout item `SUCCESS`. Payout fees are displayed separately from the service allocation. Terminal returned/refunded payouts do not remain paid.

`ProviderPayoutView` binds package and contract version, provider, exact award, state, masked reference, observation time, safe error, operation and cancellation state, and permitted recovery actions. It never includes recipient destinations, full provider bodies, OAuth credentials or encrypted request documents. Those documents use authenticated encryption with independent tenant/commission/operation/purpose associated data. Stable sender batch/item/request IDs survive retries; uncertain dispatches keep their reservation.

`PaymentToolRun` persists running/completed/failed state and a safe failure code before Toolkit initialization. Completed `PaymentToolEvidence` records actual transport, time, masked resource, provider status, capture amounts/fees/net values and body hash. The only enabled tool is `get_order`; independent strict validation enforces the owned order before official Toolkit transport. The model cannot choose write tools or recipients. Initialization and failed calls remain visible after reload.

## Workers and webhooks

`/api/jobs/recover` requires `CRON_SECRET`; the CLI worker uses the same production, payment and webhook recovery functions. Committed, unclaimed financial work may resume under a lease. Unknown dispatched writes are reconciled rather than blindly resent. Payout recovery may explicitly resend only the original identical unknown-create batch within its supported duplicate window. An interrupted unclaimed cancellation first performs reads and requires explicit conditional recovery before another mutation.

`POST /api/webhooks/paypal` requires a configured registered PayPal webhook verifier. It uses the immutable core's normalized, deduplicated observations and rejects conflicting identities. The queue stores a minimal observation and reads independently owned exact resources before projection. Unknown or early observations await ownership; no guessed resource is probed and no event payload creates a financial action. Invoice observation intake is present; domain invoice bookkeeping is not implemented. Authentic signed webhook delivery is not yet qualified.

Migrations 001–012 define the current application schema. PostgreSQL is authoritative; no in-memory financial store is used. Core is consumed only from the immutable versioned archive, never sibling source. Background model receipts, immutable production parts and private media-object identities survive individual request lifetimes.

## Production and private media

Structured background generation commits the provider response ID before polling. Each worker step performs at most one external HTTP operation. Known responses may be read across pause/revocation to retain original output; new requests still require current authority. Unconfirmed creates, input/schema changes and unavailable original responses require review rather than a replacement request. Research uses five batches containing the whole frozen source manifest. Translation uses five target-language calls, each carrying all 13 original labels and the exact input lineage; English is copied unchanged.

Image pack 2.0.0 freezes the registered source/rights hashes, Sharp/libvips/WebP versions, full-frame treatment, dimensions, byte caps, sRGB profile and measured comparison thresholds. Actual image bytes are supplied to the description model. Generated descriptions retain false fluent-review flags. Independent verification retrieves each private file and recomputes its hash, geometry, ICC profile and aligned pixel/perceptual comparisons against the registered source. It requires the exact producing job and immutable media/model receipts; declarations alone cannot pass it. Historical fidelity remains a human review criterion.

`GET /api/media/:id` authenticates tenant ownership before fetching a private object, verifies its saved hash, and returns private/no-store bytes with bounded range support. It exposes no private Blob URL, token or pathname. Stable object identities are reserved before upload. An unknown upload is read at that same path; matching bytes are adopted, changed identities are rejected and no overwrite occurs. Verification work is independently resumable, one private-file read per step. Local native-byte calibration and one actual private upload/read are qualified; hosted native-runtime parity remains open.

## Exhibition and museum source boundary

Exhibition ownership is `src/components/exhibition/`, `src/exhibition/`, `fixtures/museum/`, `public/museum/`, `src/app/exhibitions/` and `docs/evidence/media/`. `ExhibitionViewer({ document }: { document: ExhibitionDocument })` consumes the shared contract; `museumExhibition` and `museumSources` are exported from `src/exhibition/museum.ts`.

The current twelve-photo, eight-layout, six-locale document is a curated sample. Its `acceptedArtifactIds` is empty, every fluent-review flag is false and no audio recording exists. Source URLs, creators/dates where known, native catalogue metadata, rights advisories and asset hashes accompany each image. Fictional museum narrative stays distinct from source facts. No generated JavaScript or unbounded HTML executes in the renderer.

`/exhibitions/harbor-street` is the useful public sample. A later accepted-document integration must use only actually accepted artifact identities through this renderer. Source drawer, chapter/map navigation, Arabic RTL/type scale, high contrast, reading width, dyslexia-friendly type, kiosk/phone controls and HTML export are implemented. Transcript fallback does not claim narration. Download integrity is qualified; offline execution remains unqualified because the browser refused local-file navigation.

## Scheduling contract for the next unit

Scheduling ownership is `src/scheduling/`, `src/components/schedule/` and `docs/evidence/scheduling/`. Use the defined `ScheduleSnapshot` and `RecoveryCandidate` shapes. Drag and AI results are proposals; a current server revision and authority gate must validate before commit. Native Bryntum Gantt/Scheduler Enterprise integration is still required.

Keep fixture date/time separate from actual quote expiry. The business calendar is America/New_York weekdays 09–17, with November 17 at 15:00 start and November 20 at 10:00 opening. The comparison is 24h plus 4h review versus 8h plus 4h review, with an image task 2h early baseline. Engine evidence must come from actual Bryntum. Generic store writes cannot gain budget authority.

## Verification and remaining contracts

Current qualification is 44 domain/transport tests and 82 PostgreSQL/actual-SDK/typed-REST fixture tests, production build, strict typechecking and authenticated HTTP smoke. Those fixtures cover the six-package $580/$530/$50 arithmetic, exact draft lineage, contract amendments, private-media recovery and byte verification; they are not live payment receipts. Actual full research contains 13 labels and passes five deterministic checks, with an attributed automated review and no human acceptance. Separate actual Guild financial evidence proves one $640 authorization and zero-capture void, plus one model-selected Toolkit order read, with $0 captures and $0 payouts.

Seven independent provider services, A2A 1.0.1, MCP tools, signed per-package AP2-shaped exports, recourse/refund/invoice/Vault workflows, full production and scheduling remain required. Add their contracts explicitly before integration. Full scope is maintained in the private requirement ledger and summarized in `docs/BUILD_HANDOFF.md`.


## Full language successor and review stability

`amend_translation_contract` binds the current unaccepted original draft/hash, source research, proposed glossary/pack digest and contract version. It refuses active production/verification, prior dependent production, billing authority, accepted work or an unresolved original model result. The original contract, draft, check reports and review notes remain immutable. Only the matching unaccepted reservation is released; a fresh Passport approves the same-price successor and its new production reservation. The old submission is never evaluated retroactively as if it had agreed the new pack.

The successor uses five complete target-language model calls with the full original collection and exact source lineage. English is copied exactly. All six files have exact required keys, no declared placeholders/copied English body, per-label protected-name compliance, frozen script/direction metadata and `franc@6.2.0` language identification without a candidate allowlist. Short samples cannot pass the language check. Human/fluent review remains distinct.

Independent Gemini verification is durable in `guild_verifier_batches` (migration 011). It reserves one exact request/schema/artifact/contract identity, saves a returned batch ID before polling, retains original provider bodies before parsing, and never replaces an ambiguous create. A known ID is read across pause to retain its original result. Complete repeated checks reuse the same immutable advisory. The selected real recipe is Gemini 3.8 Flash, `responseSchema`, temperature 1, explicit output shape; both preregistered studies and all 15 attempted cases remain recorded. Word-multiset F1 is a lexical review flag, not a semantic verdict: one sample per language scored 0.694–0.839, so no semantic threshold or accuracy is qualified. All passages remain available for review even when the score is high.

`record_automated_review` now accepts the exact `criteriaDigest` visible when the dialog opened. Only this attributed annotation may tolerate an unrelated commission revision, and only when the current latest artifact ID/hash, content hash, contract version and complete check-report digest still match. This exception cannot approve a plan, accept work or initiate a financial operation. A failed save keeps the dialog and typed findings. Owner-scoped evidence exports exclude credentials, model inputs and HTTP headers, and preserve earlier contract reports without relabeling them.

## Measured narration contract

`amend_narration_contract` requires the exact current full `guild.translation.v2` source, displayed pack digest, package version and explicit AI-voice acknowledgment before any narration attempt, existing obligation or checkout. It preserves the original contract, keeps the $87 gross/$80 provider award, and requires a fresh Passport. The full actual source means 78 exact title/body recordings across six locales; the production path cannot replace them with a smaller sample. Draft production preserves the explicit input policy, while final acceptance still requires acceptance of the same upstream source.

Pack `2.0.0` freezes `gpt-realtime-2.1`, Marin, mono 24 kHz original PCM, mono 24 kHz/96 kb/s MP3, script hashes, per-language duration estimates and the exact measured FFmpeg binary. The bounded tempo adjustment is 0.85–1.20×, followed by the calibrated loudness normalization. No inserted silence or truncated text manufactures a duration pass. The deterministic criteria require exact coverage, source/stream/file binding, the agreed encoding, −18 to −14 LUFS, true peak ≤−1 dBTP, no clipped decoded samples, ±10% duration and complete normalized provider transcripts.

Migration 012 persists `guild_speech_runs`, ordered original `guild_speech_chunks` and `guild_transcription_runs`. Current job lease, signed plan, active actor, ancestor authority and exact input lineage are checked before a recording's dispatch. The original response and every chunk are committed before completion; the receipt must reconstruct the exact complete PCM hash. Realtime cannot retrieve a lost stream by ID, so interruption retains partial evidence and blocks a replacement pending review. It never creates a complete artifact from partial audio. Known complete speech and immutable media uploads survive worker restarts.

Independent verification reads each owned final MP3, reconstructs the original stream and frozen transform, examines every encoded frame and independently decodes all samples. It recomputes duration, loudness and peaks. A bounded verification step permits one private-file read plus one independent `gpt-transcribe` request; the recognition input contains audio and a language hint, never expected wording. Each original recognition body/hash is retained before use. Unknown recognition remains an unavailable advisory and is never recreated by a repeated check. Normalized error uses words for Latin scripts, Japanese characters and diacritic-insensitive Arabic words. The proposed ≤10% target remains advisory; accent, pronunciation and naturalness require listening review.

The original twelve speech calibration cases and twelve preregistered normalization/recognition cases remain recorded. The selected full model passed six measured cases; two mini-model duration failures remain in the denominator. The implemented narration unit has passed synthetic transport/database tests, not an actual 78-recording commissioned run. Human listening/fluent review, the actual player browser matrix and the deployment-host binary qualification remain open. Only the measured darwin/arm64 engine is currently qualified; Linux parity is not inferred.

`JobRun.contractVersion` is projected from the durable job input for older snapshots. The review room shows current-contract progress; an earlier translation or another package's completed artifact cannot appear as the successor's status. Original historical jobs remain unchanged. Agreement modals freeze their displayed source and pack while open; changes require a fresh review rather than silently updating consent. The narration player retains its chosen recording during unrelated snapshots, uses one audio element, starts only on a user action and exposes the exact full script alongside recognition evidence.
