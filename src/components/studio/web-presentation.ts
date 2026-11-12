import type { Locale } from "@/contracts/guild";
import type { WebAuditResult } from "@/domain/web-audits";
import type { WebDesign } from "@/domain/web-exhibition";

export const webFamilyNames: Record<WebDesign["chapters"][number]["family"], string> = {
  cover: "An invitation", full_bleed: "Immersive photograph", split: "Side by side", collection_grid: "The collection",
  comparison: "A closer comparison", audio: "The listening room", timeline: "A catalogue sequence", credits: "Sources & credits",
};
export const webWidths = [390, 768, 1440] as const;
export const requiredWebInteractions = ["source_text", "original_media_register", "images_decoded", "no_autoplay", "document_overflow", "rtl", "keyboard_register", "dialog_focus", "locale_keyboard", "original_audio", "captions_seek", "reader_preferences", "chapter_navigation", "reduced_motion", "no_external_resources", "no_page_errors"];
export function displayedWebOutcome(result: WebAuditResult) {
  const complete = result.complete && result.errors.length === 0;
  const axe = complete && ["default", "expanded", "map", "settings", "source", "share"].every(state => result.axe.some(item => item.state === state)) && result.axe.every(item => item.seriousCritical === 0);
  const lighthouse = complete && result.lighthouse?.accessibilityScore != null && result.lighthouse.accessibilityScore >= .95;
  const interaction = complete && requiredWebInteractions.every(id => result.interactions.some(item => item.id === id && item.passed)) && result.interactions.every(item => item.passed);
  return { complete, axe, lighthouse, interaction, passed: axe && lighthouse && interaction };
}
export function webScoreLabel(score: number | null | undefined) {
  // Preserve the exact stored fraction beside the readable number. A rounded 95
  // must never present a sub-threshold native result as a passing measurement.
  return score == null ? "Not measured" : `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 10 }).format(score * 100)} / 100`;
}
export function readingCopyUrl(artifactId: string, ordinal: number, locale: Locale, options: { element?: string; state?: string; chapter?: string } = {}) {
  const query = new URLSearchParams({ lang: locale });
  if (options.element && /^[A-Za-z][A-Za-z0-9_-]{0,200}$/.test(options.element)) query.set("review", options.element);
  if (options.state && ["default", "expanded", "map", "settings", "source", "share"].includes(options.state)) query.set("reviewState", options.state);
  if (query.has("review") || query.has("reviewState")) query.set("inspection", "original");
  const fragment = options.chapter && /^[a-z_]+$/.test(options.chapter) ? `#${options.chapter}` : "";
  return `/api/artifacts/${artifactId}/exhibition/${ordinal}/index.html?${query}${fragment}`;
}
/** Select only a literal authored DOM id, never execute an audit CSS selector. */
export function findingElement(target: unknown): string | undefined {
  if (!Array.isArray(target)) return undefined;
  for (const item of target.flat(3)) {
    if (typeof item !== "string") continue;
    const match = /^#([A-Za-z][A-Za-z0-9_-]{0,200})$/.exec(item);
    if (match) return match[1];
  }
  return undefined;
}
