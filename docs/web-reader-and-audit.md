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

Each case retains native axe results in six states (default, expanded, chapter map, settings, source and share), the complete Lighthouse report and 17 interaction observations. The declared gates require zero serious or critical axe violations, an actual Lighthouse accessibility score of at least 0.95, and every required interaction observation. The separately versioned v2 measurement policy adds an original-palette contrast gate: the four opaque body/paper, muted/paper, light/dark and ink/accent pairs must each reach an unrounded 4.5:1. It reads the original computed CSS custom properties before any reading preference, binds those values to the exact saved design, and retains the raw RGB values and ratios in `palette-contrast.json`. This narrow gate is not a universal accessibility claim. Missing scores do not pass; a score below 0.95 never passes through display rounding. All other native violations, incomplete findings and warnings remain visible for review.

Each case has a fixed 240-second measurement limit, 16 MiB per evidence file and 64 MiB total evidence capacity. Large native JSON is retained in ordered, hash-bound byte chunks. If a report cannot fit, an explicit retention-failure receipt records its original byte length and hash; the case remains incomplete. Partial evidence cannot count as a complete report. Interrupted attempts retain their evidence and stop their own process only.

The original v1 browser pass retained all 20 attempts and failed. Cue/map accessible names, modal focus cycling, narrow-screen overflow and interaction failures were retained. The strict seal rejected a runner completion flag that omitted three required axe states. The contrast mutation produced native axe incomplete findings with an observed 1:1 ratio; Lighthouse returned 1.0, so that score alone did not detect the intended defect. The immutable first edition remains failed. See [the original qualification record](evidence/web-browser-v1-qualification.json).

The corrected source retains the same exact Sample content, media and timings. A new helper rerenders those originals into a new directory; it neither regenerates media nor changes the old input:

```sh
node_modules/.bin/tsx tests/helpers/rerender-web-qualification.ts /absolute/old/qualification-set.json /absolute/new/sample-inputs
```

V2 preserves axe incomplete findings separately and requires the identical-color mutation to fail the explicit palette gate. It also retains actual focus/layout state on interaction failures, closes failed dialogs through their authored control, and cannot label a missing measurement register complete. The independent HTML/ZIP parser checks 192 files, 78 exact labels/media references and 48 chapter sections. Actual v2 browser qualification remains pending until its fresh full retained report exists.

The contrast calculation follows [WCAG 2.2's minimum contrast guidance](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) and its [sRGB relative-luminance definition](https://www.w3.org/WAI/WCAG22/Understanding/relative-luminance.html). It compares the full calculated ratio with 4.5; display rounding never changes the decision. Native audits and human screen-reader, keyboard, visual and language/listening review remain separate.
