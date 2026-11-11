import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { digest } from "@/domain/primitives";
import { webAuditPolicy } from "@/domain/web-exhibition";
import { validateWebPaletteMeasurement, wcagSrgbContrast } from "@/domain/web-contrast";
import { validateWebEvidence } from "@/server/web/audit-evidence";
import { webAuditFixture } from "./helpers/web-audit-fixture";

const modulePath = "../tools/web-audit/contrast.mjs";
const native = await import(modulePath);

test("opaque contrast uses the WCAG sRGB formula without rounding a near miss into acceptance", () => {
  for (const calculate of [wcagSrgbContrast, native.contrastRatio]) {
    assert.equal(calculate([0, 0, 0], [255, 255, 255]), 21);
    assert.equal(calculate([37, 61, 82], [37, 61, 82]), 1);
    const near = calculate([119, 119, 119], [255, 255, 255]);
    assert(near > 4.47 && near < 4.48); assert.equal(Math.round(near * 10) / 10, 4.5); assert.equal(near >= 4.5, false);
    assert(calculate([118, 118, 118], [255, 255, 255]) > 4.5);
  }
});

test("source and isolated measuring tool declare the same strengthened v2 policy and four pairs", async () => {
  assert.deepEqual(native.palettePolicy, webAuditPolicy.paletteContrast);
  assert.deepEqual(JSON.parse(await readFile("tools/web-audit/policy.json", "utf8")), webAuditPolicy);
  assert.equal(webAuditPolicy.version, "guild.web-measurements.v2");
  assert.equal(webAuditPolicy.minimumLighthouseAccessibilityScore, .95);
  assert.equal(webAuditPolicy.maximumSeriousOrCriticalAxeViolations, 0);
  assert.equal(webAuditPolicy.incompleteAxeFindings, "retained_for_separate_manual_review");
});

test("equal colors are a separately measured failure and do not invent native axe violations", async () => {
  const f = await webAuditFixture(), design = structuredClone(f.design);
  design.palette.ink = design.palette.paper; design.palette.mutedInk = design.palette.paper;
  design.palette.darkInk = design.palette.dark; design.palette.accentInk = design.palette.accent;
  const request = { ...f.request, designDigest: digest(design) };
  const report = native.createPaletteMeasurement(request, { design }, { css: design.palette, readerContrast: "false" }, f.result.startedAt);
  const verified = validateWebPaletteMeasurement(request, report);
  assert.equal(verified.sourceBound, true); assert.equal(verified.opaque, true); assert.equal(verified.passes, false);
  assert.deepEqual(verified.pairs.map(item => item.ratio), [1, 1, 1, 1]);
  assert(f.result.axe.every(item => item.seriousCritical === 0 && item.incomplete === 0), "Native report contents are never rewritten by this gate.");
});

test("computed preferences, substituted colors and nonopaque values cannot pass as the original palette", async () => {
  const f = await webAuditFixture();
  for (const observed of [
    { css: f.design.palette, readerContrast: "true" },
    { css: { ...f.design.palette, paper: "#FFFFFF", ink: "#000000" }, readerContrast: "false" },
    { css: { ...f.design.palette, ink: "rgba(0,0,0,0.5)" }, readerContrast: "false" },
  ]) {
    const report = native.createPaletteMeasurement(f.request, { design: f.design }, observed, f.result.startedAt);
    assert.equal(native.validatePaletteMeasurement(f.request, report).passes, false);
    assert.equal(validateWebPaletteMeasurement(f.request, report).passes, false);
  }
});

test("saved ratios, source identity, missing pairs and forged pass flags are independently rejected", async () => {
  const f = await webAuditFixture(), original = JSON.parse(f.values.get("palette-contrast.json")!.toString());
  assert.equal(validateWebPaletteMeasurement(f.request, original).passes, true);
  const variants = [
    { ...original, sourceDigest: "0".repeat(64) }, { ...original, locale: "ar" },
    { ...original, pairs: original.pairs.slice(1) },
    { ...original, pairs: [{ ...original.pairs[0], ratio: 21 }, ...original.pairs.slice(1)] },
    { ...original, pairs: [{ ...original.pairs[0], minimumRatio: 3 }, ...original.pairs.slice(1)] },
    { ...original, pairs: [{ ...original.pairs[0], foregroundRgb: [0, 0, 0] }, ...original.pairs.slice(1)] },
    { ...original, design: { ...original.design, palette: { ...original.design.palette, ink: "#000000" } } },
  ];
  for (const raw of variants) {
    assert.throws(() => validateWebPaletteMeasurement(f.request, raw));
    assert.throws(() => native.validatePaletteMeasurement(f.request, raw));
  }
  const raw = { ...f.result, interactions: f.result.interactions.map(item => item.id === "palette_contrast" ? { ...item, passed: false } : item) };
  assert.throws(() => validateWebEvidence(f.request, raw, f.values));
  const missing = new Map(f.values); missing.delete("palette-contrast.json");
  assert.throws(() => validateWebEvidence(f.request, { ...f.result, files: f.result.files.filter(item => item.path !== "palette-contrast.json") }, missing));
  assert.throws(() => validateWebEvidence(f.request, { ...f.result, version: "guild.web-audit-result.v1" }, f.values));
});
