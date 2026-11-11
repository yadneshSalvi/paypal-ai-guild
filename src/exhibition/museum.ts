import type { ExhibitionChapter, ExhibitionDocument, ExhibitionLayout, Locale, SourceAsset } from "@/contracts/guild";
import manifest from "../../fixtures/museum/media-manifest.json";
import { exhibitionCopy, exhibitionLocaleOrder } from "./locales";
import type { MuseumChapterId } from "./locales/types";

function byLocale<T>(value: (locale: Locale) => T): Record<Locale, T> {
  return { en: value("en"), pt: value("pt"), es: value("es"), fr: value("fr"), ja: value("ja"), ar: value("ar") };
}

/** Real archive inputs; membership in this sample is not commissioned acceptance. */
export const museumSources: SourceAsset[] = manifest.records.map((record) => ({
  id: record.id,
  title: record.nativeTitle ?? record.title,
  description: record.description,
  imagePath: record.imagePath,
  thumbnailPath: record.thumbnailPath,
  sourceUrl: record.sourceUrl,
  creator: `${record.nativeContributors.join("; ")} Individual photographer not identified in the record.`,
  date: record.nativeDate || record.createdPublished,
  rights: record.rights,
  rightsUrl: record.rightsUrl,
  contentHash: record.contentHash,
  alt: record.alt,
  provenance: { mode: "sample", label: "Real archival photograph · sample collection", sourceId: record.itemId, observedAt: record.observedAt, sandbox: false },
}));

interface ChapterPlan {
  id: MuseumChapterId; layout: ExhibitionLayout; sources: string[]; image: string;
  position: string; map: { x: number; y: number };
}
const sourceId = (digitalId: string) => `loc-det-${digitalId}`;
const chapterPlans: ChapterPlan[] = [
  { id: "arrival", layout: "cover", sources: ["4a22773"], image: "4a22773", position: "50% 58%", map: { x: 13, y: 68 } },
  { id: "departures", layout: "full_bleed", sources: ["4a20344"], image: "4a20344", position: "50% 50%", map: { x: 31, y: 79 } },
  { id: "hands", layout: "split", sources: ["4a12861"], image: "4a12861", position: "48% 50%", map: { x: 44, y: 56 } },
  { id: "vessels", layout: "collection_grid", sources: ["4a16590", "4a21996", "4a16836", "4a20920"], image: "4a21996", position: "50% 50%", map: { x: 63, y: 70 } },
  { id: "two-waterfronts", layout: "comparison", sources: ["4a17226", "4a25770"], image: "4a17226", position: "50% 50%", map: { x: 80, y: 48 } },
  { id: "listening-room", layout: "audio", sources: ["4a25819"], image: "4a25819", position: "50% 50%", map: { x: 86, y: 20 } },
  { id: "time-and-tide", layout: "timeline", sources: ["4a25819", "4a12861", "4a10172"], image: "4a10172", position: "50% 50%", map: { x: 51, y: 24 } },
  { id: "colophon", layout: "credits", sources: museumSources.map((source) => source.id.replace("loc-det-", "")), image: "4a25811", position: "50% 50%", map: { x: 22, y: 29 } },
];

function requiredSource(digitalId: string): SourceAsset {
  const source = museumSources.find((asset) => asset.id === sourceId(digitalId));
  if (!source) throw new Error(`Missing exhibition source ${digitalId}`);
  return source;
}

const chapters: ExhibitionChapter[] = chapterPlans.map((plan, index) => ({
  id: plan.id, number: String(index + 1).padStart(2, "0"), layout: plan.layout,
  sourceIds: plan.sources.map(sourceId), imagePath: requiredSource(plan.image).imagePath,
  imageAlt: byLocale((locale) => exhibitionCopy[locale].sources[sourceId(plan.image)]?.alt ?? requiredSource(plan.image).alt),
  imagePosition: plan.position, mapPosition: plan.map,
  content: byLocale((locale) => exhibitionCopy[locale].chapters[plan.id]),
  audio: {},
}));

/** The public route deliberately renders a sample, never a fabricated accepted manifest. */
export const museumExhibition: ExhibitionDocument = {
  id: "harbor-street-sample-v1", slug: "harbor-street",
  title: byLocale((locale) => exhibitionCopy[locale].title),
  subtitle: byLocale((locale) => exhibitionCopy[locale].subtitle),
  museum: "Harbor Street Maritime Museum", chapters, sources: museumSources,
  languageReviews: byLocale((locale) => ({ fluentReviewed: false, reviewer: null, reviewedAt: null, disclosure: exhibitionCopy[locale].ui.reviewDisclosure })),
  provenance: { mode: "sample", label: "Sample exhibition · real archival photographs", sourceId: "harbor-street-sample-v1", observedAt: manifest.observedAt, sandbox: false },
  acceptedArtifactIds: [], createdAt: manifest.observedAt,
  palette: { background: "#f6f1e7", foreground: "#1b2333", accent: "#916a30" },
  accessibilityStatement: exhibitionCopy.en.ui.accessibilityStatement,
};

export const museumLanguageStatus = exhibitionLocaleOrder.map((locale) => ({ locale, fluentReviewed: false, audioAttached: false, requiredChapterCount: chapters.length }));
