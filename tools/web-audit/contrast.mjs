import { digest } from './identity.mjs';

export const palettePolicy = {
  version: 'guild.opaque-palette-contrast.v1', minimumRatio: 4.5,
  formula: 'wcag22-srgb-relative-luminance-0.04045-unrounded',
  pairs: [
    { id: 'paper_body', foreground: 'ink', background: 'paper' },
    { id: 'paper_muted', foreground: 'mutedInk', background: 'paper' },
    { id: 'dark_body', foreground: 'darkInk', background: 'dark' },
    { id: 'accent_body', foreground: 'accentInk', background: 'accent' },
  ],
  scope: 'four_original_opaque_text_palette_pairs_only_not_universal_accessibility',
};
export const paletteProperties = { paper: '--paper', ink: '--ink', mutedInk: '--muted', dark: '--dark', darkInk: '--dark-ink', accent: '--accent', accentInk: '--accent-ink' };
export function opaqueRgb(value) {
  return typeof value === 'string' && /^#[a-f0-9]{6}$/i.test(value) ? [1, 3, 5].map(offset => parseInt(value.slice(offset, offset + 2), 16)) : null;
}
export function contrastRatio(first, second) {
  const luminance = rgb => rgb.map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}
/** This named deterministic gate does not relabel native axe incomplete nodes. */
export function createPaletteMeasurement(request, record, observed, observedAt = new Date().toISOString()) {
  const css = observed.css, opaque = Object.keys(paletteProperties).every(key => opaqueRgb(css[key]));
  const sourceBound = observed.readerContrast === 'false' && Object.keys(paletteProperties).every(key => typeof css[key] === 'string' && css[key].toLowerCase() === record.design.palette[key].toLowerCase());
  const pairs = palettePolicy.pairs.map(pair => {
    const foreground = opaqueRgb(css[pair.foreground]), background = opaqueRgb(css[pair.background]);
    const ratio = foreground && background ? contrastRatio(foreground, background) : null;
    return { ...pair, foregroundRgb: foreground, backgroundRgb: background, ratio, minimumRatio: palettePolicy.minimumRatio, passes: ratio !== null && ratio >= palettePolicy.minimumRatio };
  });
  return { version: palettePolicy.version, sourceDigest: request.sourceDigest, designDigest: request.designDigest, rendererDigest: request.rendererDigest,
    locale: request.locale, viewport: request.viewport, observedAt, design: record.design, css, readerContrast: observed.readerContrast,
    opaque, sourceBound, pairs, passes: opaque && sourceBound && pairs.every(pair => pair.passes) };
}
export function validatePaletteMeasurement(request, report) {
  if (!report || typeof report !== 'object' || !report.design || !report.css || Object.keys(report.css).sort().join() !== Object.keys(paletteProperties).sort().join()
    || Object.values(report.css).some(value => typeof value !== 'string' || value.length > 3000) || !['false', 'true', null].includes(report.readerContrast)
    || !Number.isFinite(Date.parse(report.observedAt)) || digest(report.design) !== request.designDigest) throw new Error('PALETTE_CONTRAST_BINDING: The original computed palette or design identity changed.');
  const expected = createPaletteMeasurement(request, { design: report.design }, { css: report.css, readerContrast: report.readerContrast }, report.observedAt);
  if (digest(expected) !== digest(report)) throw new Error('PALETTE_CONTRAST_BINDING: The exact original pair, ratio, source or unrounded threshold changed.');
  return report;
}
