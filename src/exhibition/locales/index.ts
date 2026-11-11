import type { Locale, SourceAsset } from "@/contracts/guild";
import type { ExhibitionLocale, SourceTranslation } from "./types";
import en from "./en";
import pt from "./pt";
import es from "./es";
import fr from "./fr";
import ja from "./ja";
import ar from "./ar";

export { chapterIds, exhibitionLocaleNames, exhibitionLocaleOrder } from "./types";
export type { ExhibitionLocale, ExhibitionUi, SourceTranslation } from "./types";
export const exhibitionCopy: Record<Locale, ExhibitionLocale> = { en, pt, es, fr, ja, ar };
export function isExhibitionLocale(value: unknown): value is Locale { return typeof value === "string" && ["en", "pt", "es", "fr", "ja", "ar"].includes(value); }
export function localizedSource(source: SourceAsset, locale: Locale): SourceTranslation {
  return exhibitionCopy[locale].sources[source.id] ?? { title: source.title, alt: source.alt, note: source.description };
}
