# Authored exhibition reader and browser measurements

This source checkpoint provides eight fixed exhibition layouts, six language interfaces, exact original-media references, a portable ZIP writer and a separately pinned browser measurement tool. The application's complete web producer and acceptance journey are a later integration unit. No browser score, successful provider run or human review is implied by this code checkpoint.

The renderer accepts bounded design tokens: palette, typography, source order, crop and chapter treatment. It does not execute model-generated code or invent labels, photographs, recordings or captions. A stored design retains its submitted colors even if their actual contrast fails. Every original media file is identified by its producing chain, byte length and SHA-256. The portable edition includes its source record, authored reader, original media and font licenses.

The reading interface includes language tabs, Arabic direction, Japanese wrapping, chapter navigation, native dialogs, keyboard focus return, reading preferences, source inspection and original-recording controls. Audio never starts when opening an exhibition or selecting a caption. A source-linked inspection URL can open a measured state and an exact literal element ID; native CSS selectors are shown as text rather than executed.

## Separate qualification

The `tools/web-audit` package pins Node 22.22.3, Playwright 1.65.0, Chromium revision 1254 (158.0.8127.18), axe 4.14.0 and Lighthouse 13.6.0. It uses a dedicated local browser distribution and a fresh profile for each case. It cannot fall back to the system browser, an existing browser profile or a different engine version. Browser processes receive a narrow environment with no application or provider credentials.

Qualification uses an explicitly labeled Sample set: authored synthetic geometry, multilingual interface text and 78 distinct locally generated test tones. These files prove neither speech quality nor caption alignment. The helper creates a new directory and will not overwrite an existing set:

```sh
node_modules/.bin/tsx tests/helpers/create-web-qualification.ts /absolute/new/sample-inputs
```

Install the independent toolchain in `tools/web-audit`, not the application's shared dependency directory. Install its pinned Chromium into a new, dedicated `PLAYWRIGHT_BROWSERS_PATH`. Review the full source and input manifests before invoking `qualify.mjs prepare BROWSER_ROOT EXACT_EXECUTABLE SAMPLE_SET NEW_WORKSPACE`. Preparation reads and hashes the exact tools, browser distribution, dependencies and inputs; it does not launch a browser.

Each `qualify.mjs step RUNTIME` dispatches one original browser case. The complete pass has 18 baseline cases (six locales × 390, 768 and 1440 pixels) and two declared verifier mutations (contrast and missing alternative text). Every attempt is retained. An existing dispatch with an uncertain outcome cannot be rerun automatically. A failed edition stays failed; repair requires a separate source and qualification record.

`qualify.mjs seal RUNTIME diagnostic-browser-only` rereads every exact request, result and native file. It requires all 18 baseline cases to pass and both explicit mutations to be detected before marking the engine qualified. `qualify.mjs verify RUNTIME` rechecks the original evidence and the entire pinned engine without launching a browser. This diagnostic qualification is separate from production authority, human review, acceptance, publication and payment.

## Measured acceptance boundary

Each case retains native axe results in six states (default, expanded, chapter map, settings, source and share), the complete Lighthouse report and 16 interaction observations. The declared gates require zero serious or critical axe violations, an actual Lighthouse accessibility score of at least 0.95, and every required interaction observation. Missing scores do not pass; a score below 0.95 never passes through display rounding. All other native violations, incomplete findings and warnings remain visible for review.

Each case has a fixed 240-second measurement limit, 16 MiB per evidence file and 64 MiB total evidence capacity. Large native JSON is retained in ordered, hash-bound byte chunks. If a report cannot fit, an explicit retention-failure receipt records its original byte length and hash; the case remains incomplete. Partial evidence cannot count as a complete report. Interrupted attempts retain their evidence and stop their own process only.

Current local evidence is 19 passing synthetic structural/integrity tests and an independent HTML/ZIP parse of 192 files, 78 labels/recordings and 48 chapter sections. These do not establish browser accessibility, native playback, human screen-reader use or fluent-language quality. Actual browser qualification remains pending until its full retained report exists.
