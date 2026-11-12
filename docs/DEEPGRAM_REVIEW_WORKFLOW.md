# Six-language caption listening edition

Version 3 is an explicitly agreed Deepgram-assisted human-review capability. It retains all original recordings, complete titles and bodies, source acceptance history, original recognition and every failure. The English, Portuguese, Spanish, French, Arabic and Japanese tracks share the same workflow. The complete collection is bounded to 78 recordings.

Automatic six-language alignment qualification remains `not-qualified`. The original commissioned Whisper edition remains failed under its original contract and expired authority. No original authority is extended, no earlier artifact is relabeled, and no held-out result is implied. The review implementation makes no new provider experiment.

## Supported decisions

1. On a fresh unstarted caption package, review and prepare `pack-captions-deepgram-review-v3`. Its source register, original authority ceiling, pinned Nova models, source mapping, raw/rounded timing policy, human measurement policy, cue limits and unchanged $35 + $5 commercial terms are frozen.
2. Approve the exact amended Passport. Enable `GUILD_ENABLE_DEEPGRAM_REVIEW=true` only for this separately agreed capability, with server-side `DEEPGRAM_API_KEY`, the agreed `OPENAI_MODEL=gpt-6.1-sol`, its key and normal private media storage configured. Configuration is checked before reserving the first job; configuration is never authority.
3. The original worker job submits each unchanged recording at most once. It retains raw bytes and signed request/response bindings. The six easy-read responses are source-linked. Missing, malformed, mismatched, overlapping and ambiguous observations stay visible. Only complete exact-source candidates receive automatic VTTs.
4. Open a recording’s **Listening desk**. Compare its complete source and original recognition, hear original words or cues, inspect decimal and rounded boundaries, and enter measured boundaries for the exact source units. Save a draft with a note. Unknown or unheard wording remains untimed, and prevents a complete corrected edition. Source text and audio cannot be rewritten here.
5. A human owner separately records a named full-recording, full-source and timing declaration against an exact saved draft. Operators can annotate drafts but cannot make the declaration. Software verifies the declaration’s identity and integrity; it cannot prove that a person listened. Fluent-language review remains explicitly unverified.
6. Once every original track has a complete named declaration and the original independent report is retained, agree the exact revision set. A fresh Passport authorizes the one included correction assembly. It retains the original audio, source, provider responses and easy-read output, and sends **zero new ASR, narration or easy-read requests**.
7. Independently reverify the correction, including actual original audio bytes and duration, raw provider response signatures, complete source spans, each named revision, reading limits and actual VTT bytes. A complete human correction can pass these structural checks even when the original recognizer disagreed with spelling or diacritics. The original automatic findings and unqualified status remain unchanged.
8. Curator acceptance requires the exact upstream source acceptances and an explicit acknowledgment of the listening and per-language review disclosures. An operator or AI annotation cannot perform this decision. Fluent review is never fabricated. Payment remains a separate existing application process.

The two bounded jobs count every attempt. Partial and lost responses remain indeterminate; a new label, a replay or a refreshed browser cannot dispatch another request. A failed job has an owner-scoped original-operation evidence download even when it produced no complete artifact.

## History and expiry

Earlier v2 and v3 caption artifacts open in the same reader, with their original provider label and raw response download. The original source, audio, manifests and observation bytes are immutable. Review saves append a signed revision; stale parents and request-identity reuse with different content are rejected. Database triggers forbid updating or deleting review revisions and agreed correction receipts.

An active owner workspace can read old evidence and save/export attributed drafts after production authority expires. This grants no new provider or assembly authority. The UI shows the original deadline and opens the normal **New commission** flow for separately bounded successor work. It never extends the original date or imports an old acceptance into a new agreement.

## Interfaces

- Manifest: `guild.captions.v3`, validated by `deepgramCaptionArtifactSchema`. `tracks[].candidate` is the unchanged automatic observation result. `tracks[].effective` identifies the submitted cue set and whether it uses original provider or attributed listening measurements. `reviewRevision` binds the exact signed correction. `originalProductionJobId` and `correction.baseArtifactId/baseArtifactHash` preserve lineage.
- Report: `guild.caption-verification.v3`. Each required recording has separate source, timing, actual VTT, original automatic alignment and listening-declaration findings. Automatic qualification stays open as an advisory; every structural and listening criterion remains blocking.
- VTT metadata: `northlight.deepgram-caption-vtt.v1`. It binds original audio, complete script, original producing job, raw-response receipt, candidate digest, exact review revision and effective cues.
- `GET/POST /api/artifacts/:id/caption-review`: exact track workbench and append-only save/declaration. JSON/VTT downloads select an exact revision. A candidate VTT is exported only for a structurally complete draft, and does not imply acceptance.
- `GET /api/artifacts/:id/caption-alignment?runId=...`: owner-scoped original response, including raw bytes and original request identity. v2 retains its original Whisper meaning.
- `GET /api/commissions/:id/caption-operations?jobId=...`: retained original request outcomes for a job, including failures without an artifact. Add `runId` for its original complete or partial response.
- Mutation commands: `amend_deepgram_caption_contract`, `agree_deepgram_caption_review`; final acceptance additionally requires `acknowledgeCaptionListeningAndLanguageDisclosure`.
- Migration: `020_deepgram_caption_review.sql`. Existing Deepgram ledger tables and signatures are reused.

Downstream consumers must use the accepted artifact’s `effective` cues and actual private VTT objects, retain candidate/review provenance, and check the exact acceptance decision. The immutable manifest’s `productionAccepted:false` is historical; the separately retained curator decision is authoritative. Reading or displaying the artifact does not create a new acceptance.

## Verification and native handoff

The synthetic tests use a fresh loopback PostgreSQL cluster and isolated schemas, a controlled Deepgram gateway, generated tone recordings and explicitly fake easy-read responses. They establish application behavior and failure boundaries. No fixture is acoustic, language, fluent-review or held-out qualification.

`tests/integration/deepgram-caption-workflow.test.ts` exercises the complete fresh agreement, original job, separate measured drafts/declarations, zero-request correction, actual-byte and signature corruption controls, source-acceptance boundary, current authorizer revocation and indeterminate outcomes. `caption-retained-review.test.ts` checks historical v2 drafting and evidence after expiry. Existing caption and Deepgram-ledger tests remain applicable.

The optional `scripts/prepare-deepgram-review-native.ts` creates a separate 78-recording synthetic fixture in an explicitly named loopback database, with one operator-authored draft and **zero listening declarations or acceptances**. Its private manifest stays under `.local/native-caption-review/`. `scripts/serve-deepgram-review-native.ts` serves the built Next app on loopback port 4547 with external providers disabled. Its media route uses the actual ownership/hash/range checks against retained local fixture bytes. This harness is never deployed or used as real qualification evidence.

Native review should inspect six-language navigation, complete source comparisons, original and rounded word timing, word/cue playback, manual draft edits, conflict/error recovery, attributed history/export, expired-authority guidance, Arabic direction, Japanese wrapping, keyboard focus, narrow layouts and reduced motion. Open the listening-declaration dialog for inspection without submitting a claim of real listening to synthetic tones.

The candidate was checked with 128 unit tests, 10 full v3 workflow checks, 10 existing Deepgram ledger checks, 8 retained/legacy caption regression checks and 28 workspace/session/dependency/scheduling checks. Strict TypeScript, the production build and authenticated HTTP evidence/media checks passed. These are behavioral checks using controlled data; native visual and playback review is a separate handoff.

The broader scheduling tests require `OPENAI_MODEL=gpt-6.1-sol` even with their network-denying fake transport. The first minimal-environment run had 27 passes and one model-configuration failure before reaching the expected authority check; the configured rerun passed all 28 without changing production code. The candidate keeps the initial logs alongside the successful reruns under `.local/checks/`.
