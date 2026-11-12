# Publication native review protocol

Use the exact frozen source, dependency copy, production build and `native-*` private fixture supplied in the handoff. Root owns browser actions. No native result is claimed by the HTTP or integration suites. Keep all failures and observations; do not renew expired sessions, reseed a previously tested fixture or edit original bytes to obtain a pass.

The native fixture has fictional owner/acceptance records and synthetic tone recordings. The publication room must prominently state that no person accepted the work, no fluent-language review occurred and no actual model/browser qualification is represented. The original reader is a synthetic collection. Never describe tone playback as commissioned speech or fluent listening.

## Setup and evidence

1. Verify the source/build/fixture manifest and start the exact launcher on4542. Use `http://localhost:4542`; do not change the protected servers or their cookies. If a lead-owned listener ended, root can own the same launcher without rebuilding or changing data.
2. Use only the private native cookie/name supplied with this fixture. Authenticate the browser through the approved browser/session mechanism, without adding a production bypass route. Keep the cookie and signing keys out of screenshots and reports.
3. Record build ID, source/dependency/fixture hashes, server PID, native browser/executable/platform, start/end time, viewport, URL, observed result and retained screenshot or recording per case. Record the native database baseline before browser work. The separate HTTP schema is not a substitute for native data.
4. Review at desktop1440×1000, then390×844. Check horizontal overflow, focus visibility, zoom and long identifiers. A wide file table may scroll inside its named region; the page and dialog must remain within the viewport.

## Owned reading copy and proposal

1. Open the commission Overview. **Publication & editions** opens the publication room for the same commission. **Read the exhibition** opens the exact original selected design rather than the curated sample. Keep the sample explicitly named when checking a workspace with no generated web artifact.
2. In the new native publication room, verify owner-only status, six exact accepted artifacts, prominent synthetic disclosure, the original reading-copy link and empty publication history. No public edition should exist merely because automated checks passed.
3. Follow the original reading-copy link. Record the actual artifact/selected design and original source/evidence access, then return. Open the publication room using keyboard navigation.
4. Choose the exact artifact, enter an edition note and prepare it. The button shows that files are being checked. The dialog must expose six source/decision/report records, eighteen retained independent cases, the complete194-entry register (192 originals, manifest, ZIP), source/disclosure details, selected design, the full64-character proposal digest and expiry/revision.
5. Expand a source record and the public file register. Verify table scrolling at390px and keyboard access to every disclosure. Source acceptance remains separate from automated/fluent review. Links to original artifacts, evidence and the full independent report work in the owner workspace.
6. The publish button stays disabled until the explicit public-files acknowledgment is checked. Closing or pressing Escape before publishing leaves history unchanged. Preparing again produces a fresh proposal ID/expiry after revalidation; it must not return an expired or previously closed proposal through a stale client command.

## Dialog Escape and focus cases

These exercise the shared native dialog, including the scoped cancellation fix. Record actual native behavior, not just a DOM source inspection.

| State and action | Required observation |
| --- | --- |
| Prepare asynchronously, open the resulting dialog, move focus inside, press Escape | Dialog closes, React state clears, focus returns to the original Prepare button even if focus moved to BODY while preparation was pending; reopening works normally |
| Open an edition record, Tab and Shift-Tab through the ends | Focus stays in the modal; Escape closes and restores the record button |
| Confirm publish and press Escape while its actual request is pending | The dialog stays open, remains modal and shows the pending state; no second command is created |
| After that request completes | The dialog closes normally, current edition/history reflect one publication and the visible preparation heading receives focus when the original Prepare button is disabled pending an earlier-edition choice |
| Open withdrawal, press Escape before confirming | Dialog closes without withdrawing; focus returns to the publication-history heading |
| Confirm withdrawal and press Escape while pending | Dialog stays open until completion; the final history heading receives focus after its launcher disappears |

If the network request finishes before the busy Escape action, record that case as unobserved and repeat with a fresh permitted edition. Do not claim the busy case from a normal close. Use only an explicitly approved external test transport pause if native timing requires one; do not weaken the production policy or add an application bypass.

## Public edition and all six languages

1. Acknowledge the public file disclosure and deliberately publish. Verify a single current edition, version, publication time, exact source and note, saved history event, public link and portable ZIP. Open the public URL without the owner cookie in a separate browser context.
2. For en/pt/es/fr/ja/ar, use the actual reader controls and verify the displayed label, direction (Arabic RTL), chapter navigation, map, settings, source panel and source/rights links. The public reader must use the original accepted design/bytes with no substituted draft.
3. At desktop and390px, inspect cover, chapter/collection layout, photograph, source panel, map and settings. Check keyboard navigation, visible focus, dialogs and recovery from opening/closing panels. Retain visible and console/network failures.
4. Play one synthetic recording with deliberate user action. Check play/pause, seek, speed, transcript, VTT/caption cue seeking and captions after a language change. Describe the audio as synthetic tones, never intelligible commissioned narration. The server must support audio range requests and return original bytes.
5. Download the public manifest and portable ZIP, and compare their SHA-256/length with the edition record. Check the immutable private receipt and the original artifact/report references. The UI's ZIP count denotes response records, not readers or completed downloads.

## Editions, withdrawal and reload

1. Prepare and publish another edition after explicitly choosing **Keep earlier links available**. Confirm that the first public identifier still opens its own original bytes, its history remains unchanged, and the new edition has a new identifier and current status.
2. Open the first edition's withdrawal dialog. The exact public path is visible. A short/empty reason or absent copies-remain acknowledgment keeps confirmation disabled. Cancel once; verify no event or state change.
3. Enter a meaningful fixture reason, acknowledge that loaded/downloaded copies cannot be recalled, and withdraw. Verify actor/time/reason and closed status while the original private reader, source/report context and receipt remain available.
4. Keep an already opened public page. After withdrawal, reload that exact page; request a new audio range, a conditional response, HEAD, manifest and ZIP. All new requests must return410. The page already loaded may remain visible; the UI explains that limit. A downloaded ZIP remains unchanged.
5. Republish after withdrawal. It receives a new edition and public identifier. The withdrawn identifier stays closed. Explicitly choose **Withdraw earlier public links** for another publication and verify those earlier links close with retained withdrawal events.

## Authorization and recovery

1. With the separate native operator identity, inspect history and original references; publishing/withdrawal controls remain unavailable and corresponding HTTP mutations return403. A provider identity cannot read this owner publication history. A foreign tenant cannot select the commission.
2. Check a stale proposal by changing publication history in a second authorized context, then trying the earlier proposal. No duplicate/new edition is created. The dialog explains the conflict and refreshes history. Close it and prepare the current exact revision successfully.
3. Check a withdrawal conflict after a second authorized context changes history. The error must explicitly instruct closing the dialog, reviewing refreshed history and opening withdrawal again. A refresh/retry in the existing dialog retains the original command/revision; closing and reopening issues a new command against the reviewed revision. This preserves unknown-outcome idempotency.
4. Observe a temporarily unavailable response or an interrupted response using the approved browser/network control. An unconfirmed command keeps its ID for retry; a history refresh reconciles an already committed publication/withdrawal. Do not infer success from a spinner or a network error alone.
5. A revoked or expired actor cannot prepare/publish/withdraw. Original accepted work and already active public editions remain readable without creating new production authority. Do not extend the original approval to make this case pass.

The separate `scripts/check-publication-dom.mjs` regression harness uses pinned jsdom26.1.0 outside application dependencies and actual React components. It checks asynchronous focus restoration, normal and busy cancellation, retry identity and conflict recovery, and retains deliberate failing variants that remove the focus target or cancellation prevention. Its dialog shim cannot qualify browser focus trapping, geometry or native Escape; the cases above remain required.

Record the final native database/publication baseline, source/build hashes and remaining unobserved cases. HTTP-only evidence, injected audit receipts and synthetic acceptance decisions remain explicitly separate from native UI observations and real provider/human qualification.
