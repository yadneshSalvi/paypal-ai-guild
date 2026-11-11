import type { ExhibitionText, Locale } from "@/contracts/guild";

export const exhibitionLocaleOrder: Locale[] = ["en", "pt", "es", "fr", "ja", "ar"];
export const exhibitionLocaleNames: Record<Locale, string> = { en: "English", pt: "Português", es: "Español", fr: "Français", ja: "日本語", ar: "العربية" };
export const chapterIds = ["arrival", "departures", "hands", "vessels", "two-waterfronts", "listening-room", "time-and-tide", "colophon"] as const;
export type MuseumChapterId = typeof chapterIds[number];
export type SourceTranslation = { title: string; alt: string; note: string };

export interface ExhibitionUi {
  exhibition: string; skip: string; returnToGuild: string; sample: string; live: string; replay: string; modelled: string;
  sampleDisclosure: string; begin: string; photographs: string; languages: string; chapters: string;
  map: string; mapTitle: string; mapDescription: string; chapterList: string; youAreHere: string;
  access: string; accessTitle: string; accessDescription: string; language: string; readingWidth: string;
  comfortable: string; compact: string; wide: string; highContrast: string; dyslexia: string; dyslexiaDescription: string;
  kiosk: string; exitKiosk: string; kioskDescription: string; close: string; previous: string; next: string;
  sourceNotes: string; source: string; sources: string; sourceTitle: string; collectionNote: string; originalNotes: string;
  sourceLanguage: string; creator: string; date: string; rights: string; checksum: string; fullFrame: string;
  archiveRecord: string; downloadImage: string; originalJpeg: string; measuredChecksum: string;
  transcript: string; transcriptOnly: string; transcriptDisclosure: string; audioUnavailable: string;
  audio: string; playbackSpeed: string; followTranscript: string; jumpToSegment: string; downloadAudio: string;
  fluentReview: string; notFluentReviewed: string; reviewDisclosure: string; reviewCount: string;
  share: string; shareTitle: string; copyLink: string; copied: string; copyFailed: string;
  portable: string; exportDescription: string; exportHtml: string; exportManifest: string; preparing: string;
  exportSuccess: string; exportError: string; cancel: string; restart: string; comparisonNote: string;
  timelineNote: string; creditLine: string; imageUnavailable: string; imageUnavailableDescription: string;
  accessibilityStatement: string; noAcceptance: string; madeWithGuild: string; fontLicenses: string; untitled: string;
}

export interface ExhibitionLocale {
  title: string; subtitle: string; ui: ExhibitionUi;
  chapters: Record<MuseumChapterId, ExhibitionText>;
  sources: Record<string, SourceTranslation>;
}
