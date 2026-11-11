# Deepgram timestamp candidate

Guild has a separate Deepgram prerecorded-audio adapter and exact-source caption candidate builder. This capability is in development. It does not replace a commissioned Whisper contract, change an earlier failed artifact, or permit production acceptance.

`DeepgramTimestampGateway` sends the exact audio bytes once, with a pinned language/model version, no source prompt, no text replacements, no redirects and no automatic retries. The caller must durably claim the operation before dispatch. A lost response remains unknown; another call is not recovery. Successful and malformed responses retain their original bytes, body hash, request/audio binding, provider identity and parse diagnostics. `checkedDeepgramReceipt` independently rebuilds parsed evidence against the expected request descriptor.

`inspectDeepgramTimings` checks raw positivity, order, overlap and independently measured audio bounds. A separately versioned policy rounds each original boundary to the nearest millisecond, retains the original value and displacement, then checks the resulting intervals again. It never clips an overrun, closes an overlap or invents a missing interval. A usable measurement does not establish source coverage.

`buildDeepgramCaptionCandidate` requires the complete source and timed words to match. It permits typographic apostrophe equivalence and internal letter-to-letter hyphens as word separators; all original display characters remain in the cues. Letters, diacritics, numeral scripts and mixed-script names are not rewritten. Unsupported symbols, ambiguous boundaries, spelling differences and absent words withhold the candidate. The deterministic cue partition uses the existing language-specific duration, line and reading-speed limits. A generated VTT is `ready-for-review`, never accepted or human reviewed automatically.

## Measured development outcome

Two independently frozen provider candidates used 36 requests: multilingual Nova3 and six pinned single-language Nova3 models, each with six retained recordings, six digital-silence controls and six fresh Gemini recordings. All requests returned HTTP200. The fixed-language adapter parses all18 retained responses. Eight spoken recordings have ordered positive timings within the measured audio bounds; Arabic and Japanese retain timing failures. All silence controls are withheld.

Under the new source policy, the two English development recordings each produce eight complete caption cues. Six Portuguese/Spanish/French recordings retain text disagreements; four Arabic/Japanese recordings retain timing failures. Recognition disagreement alone does not prove an audible omission. The18 held-out cases have not been inspected, and production admission remains closed.

The earlier multilingual analysis incorrectly filtered the silence case label. That original report is retained; a corrected offline analysis is explicitly identified in [the development evidence](evidence/deepgram-word-timestamps-development-v1.json). No provider calls were repeated to correct the analysis.

## Integration requirements

`runDeepgramOnce` now provides database-backed preparation, an atomic single-dispatch claim, exact owned-media binding and signed original observations. Its required internal authorizer must check the current agreement, source, actor and worker lease both at preparation and immediately before dispatch. It reuses the existing alignment tables with a separate capability and operation namespace. A recording cannot acquire another attempt by changing its operation label; all attempted states count toward the 78-recording job capacity.

`readDeepgramRun` verifies the saved request and signed original response, including raw bytes, without a provider key or renewed production authority. Complete HTTP errors remain original evidence. Partial and lost responses remain indeterminate, and concurrent workers cannot dispatch again or overwrite the owning worker's state. The observation explicitly reports `productionAccepted: false`.

No HTTP route or old Whisper producer is wired to this internal primitive. Production integration still needs a qualified capability, its explicit acceptance-pack amendment and current bounded Passport, independently checked source lineage, private evidence/download UI, independent artifact verification and complete held-out qualification. The existing failed edition and expired authority remain unchanged. Use `DEEPGRAM_API_KEY` only on the server. A provider confidence score is not human listening or timing ground truth.

Validation: 18 focused gateway/mapping checks, 30 combined new/existing caption checks, strict TypeScript, and an offline replay of all18 retained development responses with independent `ffprobe` audio duration measurements. No API requests are made by these tests.

The durable primitive additionally passes ten PostgreSQL integration tests with network-denied synthetic transport: dispatch/replay, concurrency, lost/partial responses, changed sources and tenant, expiry/revocation, signed-evidence tampering, label aliasing, late response retention, missing configuration and the full capacity boundary. These tests establish transport behavior, not six-language recognition or caption acceptance.

References: [prerecorded API](https://developers.deepgram.com/reference/speech-to-text/listen-pre-recorded), [model versions](https://developers.deepgram.com/docs/version), [model metadata](https://developers.deepgram.com/guides/fundamentals/model-metadata).
