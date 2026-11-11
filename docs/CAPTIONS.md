# Original-audio captions and easy read

Northlight’s measured caption contract binds the exact original narration, every true producing speech/media identity, complete source scripts, translation and research ancestors, source reviews, the existing independent narration report, and the original approval/expiry ceiling. Its $35 award, $5 service fee and one included correction are preserved. These are Guild-controlled service terms, not an independently negotiated marketplace quote.

Implementation and synthetic qualification are separate from an actual provider run. The original commission’s narration evidence and expired authority are unchanged. A new caption amendment cannot renew an expired original agreement.

## Agreement and authority

The owner reviews acceptance pack `2.0.0` before production. Preparing it preserves the old contract, creates a new contract version and invalidates the previous plan approval. A fresh Passport must match the exact new plan. Where a persisted schedule exists, its source change needs explicit reconciliation as well.

The pack freezes the source register, review and report hashes, timestamp capability, script prompt/tokenizer, normalization, locale limits, easy-read policy, correction policy and the earliest original authority limit. That limit is derived from the original signed receipt and its immutable approval-command snapshot, including the approving workspace’s expiry at that time. Continuing the same workspace cannot extend old work. The Passport displays both local time and the exact UTC caption ceiling.

Before each new timestamp request, model create, media write and publication, the producer checks the current job lease, exact sources, unchanged contract, schedule, signed current Passport and active approving actor. Historical narration is read against the approval that produced its exact artifact; a later plan with a different total does not relabel earlier authority or signatures.

## Prompted timestamp capability

`guild.whisper-word-timestamps.v1` uses `whisper-1` on `/v1/audio/transcriptions`, temperature zero, `verbose_json`, and word plus segment timestamps. It is deliberately separate from the unchanged blind `gpt-transcribe` narration verification. The timestamp request includes an explicit source-script excerpt and must always be described as **prompted production alignment**.

The capability fails closed at `2027-02-26T00:00:00.000Z`, when `GUILD_DISABLE_WHISPER_TIMESTAMPS=true`, or after a definitive 404/410 availability response in the workspace. A replacement requires a separately qualified capability and reviewed agreement; changing a configured model name cannot substitute it. The relevant official references are [timestamp support](https://developers.openai.com/api/docs/guides/speech-to-text#timestamps) and [model deprecations](https://developers.openai.com/api/docs/deprecations).

The exact Whisper multilingual merge ranks and upstream tokenizer definition are vendored under the MIT license from commit `86098128c0b4f24f0e2aa2994de830614b474227`. The ranks SHA-256 is `b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126`. Node 22 and `js-tiktoken@1.0.21` use that frozen regex/rank asset. Thirty-six saved vectors across all six locales compare token IDs with the official Python implementation; this is tokenizer qualification, not language or speech qualification.

The prompt is an exact contiguous source suffix, bounded to 224 tokens using the greater of the plain and leading-space token counts. Its policy, text, UTF-16 start/end offsets, complete script UTF-8 hash, excerpt hash and token-ID hashes are retained in the pack. No provider truncation is assumed. Full-script coverage remains required even when the prompt contains only an excerpt. Unsupported controls, special tokens, malformed Unicode, nonstandard whitespace or an ambiguous round trip fail before dispatch.

## Word alignment and VTT

The deterministic standard uses NFC and locale lowercase, retaining diacritics, numeral scripts, word separation and internal lexical punctuation. Japanese sentence/display punctuation is classified explicitly and remains in the rendered original text. Unsupported or ambiguous normalization fails. It is distinct from the older advisory ASR comparison method.

Every word must map to the complete exact source in original response order. Word/segment coverage, positive durations, no overlaps or backwards timestamps, millisecond-representable timing and original decoded duration are checked. A cue begins at a supplied word start and ends at a supplied word end. The partitioner cannot infer a missing timestamp, divide a timed word, interpolate, stretch, truncate or pad a cue.

All locales use 1–7 second cues with at most two lines. English, Portuguese, Spanish, French and Arabic permit at most 42 grapheme clusters per line and 20 per second; Japanese permits 20 per line and 10 per second. Reading-speed counts include spaces. Response duration tolerance is 0.1 seconds; final word-end tolerance is 0.05 seconds. These are frozen product targets, not universal accessibility or calibrated reading-grade claims.

If no valid contiguous partition exists, the track stays failed with its original response and diagnostics. A complete submission retains every failed track in its denominator. A successful VTT uses immutable `text/vtt` media and binds original audio identity/hash, complete script, source, raw response, word timings and rendered cue hashes. No replacement narration is generated.

## Durable operations and the one correction

Migration `016_caption_alignment.sql` adds the original timestamp ledger, immutable observation table, explicit correction agreements and persistent capability holds. A timestamp operation moves from `prepared` to `dispatching` before its only POST, then retains its complete or partial observation. The request UUID is a correlation identity, not an assumed provider idempotency guarantee. This API has no assumed GET recovery for a lost timestamp response. An indeterminate dispatch is held without replay.

Each approved job permits at most one original timestamp POST per registered original recording and one original easy-read response per locale. Known model response IDs can be read without another create, including after a pause or revocation. A late timestamp response is retained as evidence even when current authority prevents publication.

Exactly two producing jobs are permitted under the measured caption contract: the original and one separately reviewed included correction. All saved attempts count, including failures or interrupted attempts. A second job requires a recorded exact note, first-job input/output and all-operation hashes, any original artifact and its exact independent report, the prior signed Passport, a separately signed correction agreement and a fresh current Passport. The source, model/prompt policy, limits, price and original ceiling remain fixed. Unknown original outcomes block correction; a third job is rejected. The original reservation is reused rather than silently charging for the correction. Every first submission and report stays immutable.

## Easy read and independent verification

Each locale uses one `gpt-6.1-sol` structured response with maximum reasoning. It must contain every registered label, 1–5 paragraphs per label, no more than 360 visible graphemes per paragraph, every frozen factual/context/uncertainty concept ID and the exact permitted source quotes. The output cannot claim human or fluent review. Identifier, quotation and size checks establish presence and source integrity; meaning, uncertainty and the reading experience remain for a person to review.

The independent verifier decodes the actual original audio and rereads actual VTT bytes. It reparses the retained raw timestamp body, recomputes normalization and every cue, checks immutable storage/metadata and verifies the producing approval. It independently checks each saved easy-read request, original response text and source references. It does not call speech, timestamps, the easy-read model or blind recognition again. Deterministic failure blocks acceptance, while human meaning/listening/fluent review remains explicitly open. Reviewed draft inputs may begin work only under the separately agreed draft policy; exact upstream acceptance remains required for final acceptance.

## Review and exports

The owner review includes six keyboard-operable language tabs, original audio controls, a cue timeline, failed-track diagnostics, complete source and prompt text, VTT downloads, source-linked easy read and independent per-file reports. Cue selection seeks without autoplay. Arabic retains right-to-left text, and tables/language strips scroll inside their own bounded regions.

The ordinary artifact evidence download includes a caption response index and its exact historical producing contract/approval. Each raw original response is available separately at the owner-only `/api/artifacts/:id/caption-alignment?runId=…` route, with complete script, prompt, actual raw body, parsed timestamps and hashes. It requires matching tenant, commission, artifact, producing job, track, original media and receipt bindings. Credentials and HTTP authorization headers are never included. Expiry does not turn an evidence read into new work authority.

Native application review passed on three isolated synthetic fixtures: unstarted agreement, retained failed track and complete files. The [retained native receipt](evidence/caption-native-root-qualification.json) records the exact amendment and separate correction approvals, unchanged source hashes and prices, a 390-pixel review, keyboard language controls, Arabic/Japanese rendering, seek without autoplay, user-initiated playback, downloads and reload. Its read-only database audit recorded no additional provider, acceptance or financial operations. A private fixture-navigation link needed direct bootstrap navigation after correction approval; this limitation is retained in the receipt.

Actual provider qualification, fluent/human review and final accepted exhibition integration remain separate gates. Synthetic tone files and stubbed model/timestamp transports never substitute for commissioned audio or actual provider results.
