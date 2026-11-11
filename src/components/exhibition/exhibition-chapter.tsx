import { useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpRight, ImageOff, LibraryBig } from "lucide-react";
import type { ExhibitionChapter, ExhibitionDocument, Locale, SourceAsset } from "@/contracts/guild";
import type { ExhibitionUi } from "@/exhibition/locales";
import { exhibitionLocaleOrder, localizedSource } from "@/exhibition/locales";
import { safeImagePosition, safeMediaUrl } from "@/exhibition/safety";
import { museumArchiveRecord } from "@/exhibition/archive";
import { ExhibitionAudio } from "./exhibition-audio";

export function ArchiveImage({ path, alt, position = "50% 50%", source, priority = false, ui, className = "" }: { path: string | null; alt: string; position?: string; source?: SourceAsset; priority?: boolean; ui: ExhibitionUi; className?: string }) {
  const [failed, setFailed] = useState(false);
  const url = safeMediaUrl(path);
  const thumbnail = safeMediaUrl(source?.thumbnailPath);
  const dimensions = source ? museumArchiveRecord(source.id)?.dimensions : undefined;
  if (!url || failed) return <div className={`ex-image-unavailable ${className}`} role="img" aria-label={`${alt}. ${ui.imageUnavailable}`}><ImageOff size={30} aria-hidden="true" /><p>{ui.imageUnavailable}</p><span>{ui.imageUnavailableDescription}</span></div>;
  return <img className={`ex-photograph ${className}`} src={url} srcSet={thumbnail && source?.imagePath === path ? `${thumbnail} 640w, ${url} 2200w` : undefined} sizes={className.includes("ex-cover-image") ? "100vw" : "(max-width: 700px) 100vw, 70vw"} width={dimensions?.width} height={dimensions?.height} alt={alt} loading={priority ? "eager" : "lazy"} decoding="async" fetchPriority={priority ? "high" : "auto"} style={{ objectPosition: safeImagePosition(position) }} onError={() => setFailed(true)} />;
}

interface ChapterProps { chapter: ExhibitionChapter; document: ExhibitionDocument; locale: Locale; ui: ExhibitionUi; inspect: (id: string) => void; navigate: (id: string) => void; showSettings: () => void }

export function ExhibitionChapterView({ chapter, document, locale, ui, inspect, navigate, showSettings }: ChapterProps) {
  const text = chapter.content[locale];
  const sourceById = new Map(document.sources.map((source) => [source.id, source]));
  const sources = chapter.sourceIds.flatMap((id) => { const source = sourceById.get(id); return source ? [source] : []; });
  const primary = document.sources.find((source) => source.imagePath === chapter.imagePath) ?? sources[0];
  const formattedNumber = (value: number) => new Intl.NumberFormat(locale, { minimumIntegerDigits: 2 }).format(value);
  const titleId = `ex-title-${chapter.id}`;
  const heading = <div className="ex-chapter-heading"><p className="ex-eyebrow"><span className="ex-chapter-rule" aria-hidden="true" />{text.eyebrow}</p>{chapter.layout === "cover" ? <h1 id={titleId} tabIndex={-1} data-chapter-title>{text.title}</h1> : <h2 id={titleId} tabIndex={-1} data-chapter-title>{text.title}</h2>}</div>;
  const body = <div className="ex-reading">{text.body.split(/\n\n/).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>;
  const sourceButton = (source: SourceAsset | undefined, label = ui.sourceNotes) => source ? <button type="button" className="ex-source-link" onClick={() => inspect(source.id)} aria-label={`${label}: ${localizedSource(source, locale).title}`}><LibraryBig size={14} aria-hidden="true" />{label}<ArrowUpRight size={14} aria-hidden="true" /></button> : null;
  const caption = <figcaption className="ex-caption"><span>{text.caption}</span>{sourceButton(primary)}</figcaption>;
  const image = <ArchiveImage key={chapter.imagePath} path={chapter.imagePath} alt={chapter.imageAlt[locale]} position={chapter.imagePosition} source={primary} priority={chapter.layout === "cover"} ui={ui} />;
  const figure = (source: SourceAsset, index: number) => {
    const translated = localizedSource(source, locale);
    return <figure key={source.id} className="ex-collection-object"><button className="ex-photo-inspect" type="button" onClick={() => inspect(source.id)} aria-label={`${ui.sourceNotes}: ${translated.title}`}><ArchiveImage path={source.imagePath} alt={translated.alt} source={source} ui={ui} /><span className="ex-photo-index" aria-hidden="true">{formattedNumber(index + 1)}</span><span className="ex-photo-arrow" aria-hidden="true"><ArrowUpRight size={20} /></span></button><figcaption><span className="ex-object-date" lang="en" dir="ltr">{source.date}</span><h3>{translated.title}</h3><p>{translated.note}</p>{sourceButton(source)}</figcaption></figure>;
  };

  let content;
  switch (chapter.layout) {
    case "cover": content = <>
      <ArchiveImage key={chapter.imagePath} path={chapter.imagePath} alt={chapter.imageAlt[locale]} position={chapter.imagePosition} source={primary} priority ui={ui} className="ex-cover-image" />
      <div className="ex-cover-shade" aria-hidden="true" />
      <div className="ex-cover-copy">{heading}<p className="ex-cover-subtitle">{document.subtitle[locale]}</p><button type="button" className="ex-begin" onClick={() => navigate(document.chapters[1]?.id ?? chapter.id)}>{ui.begin}<ArrowDown size={18} aria-hidden="true" /></button><div className="ex-cover-counts"><span><b>{new Intl.NumberFormat(locale).format(document.sources.length)}</b>{ui.photographs}</span><i aria-hidden="true" /><span><b>{new Intl.NumberFormat(locale).format(6)}</b>{ui.languages}</span><i aria-hidden="true" /><span><b>{new Intl.NumberFormat(locale).format(document.chapters.length)}</b>{ui.chapters}</span></div></div>
      <div className="ex-cover-source"><span className="ex-cover-coordinate" aria-hidden="true">H / S — 001</span>{sourceButton(primary)}</div>
      <div className="ex-cover-introduction"><p className="ex-eyebrow">{document.provenance.mode === "sample" ? ui.sample : document.provenance.label}</p>{body}<p className="ex-sample-disclosure">{document.provenance.mode === "sample" ? ui.sampleDisclosure : document.provenance.label}</p></div>
    </>; break;
    case "full_bleed": content = <><div className="ex-editorial-head">{heading}{body}</div><figure className="ex-full-figure">{image}{caption}</figure><span className="ex-section-figure" aria-hidden="true">{formattedNumber(2)}</span></>; break;
    case "split": content = <><figure className="ex-split-figure">{image}{caption}</figure><div className="ex-split-copy">{heading}{body}</div></>; break;
    case "collection_grid": content = <><div className="ex-centered-head">{heading}{body}</div><div className="ex-object-grid">{sources.map(figure)}</div><p className="ex-editorial-note">{text.caption}</p></>; break;
    case "comparison": content = <><div className="ex-centered-head">{heading}{body}</div><div className="ex-comparison-spread">{sources.map(figure)}</div><p className="ex-comparison-note">{ui.comparisonNote}</p></>; break;
    case "audio": content = <><div className="ex-audio-visual"><figure className="ex-lighthouse-mount">{image}{caption}</figure><div className="ex-quiet-lines" aria-hidden="true"><span /><span /><span /></div></div><div className="ex-audio-copy">{heading}{body}<ExhibitionAudio chapter={chapter} locale={locale} ui={ui} /></div></>; break;
    case "timeline": content = <><div className="ex-editorial-head">{heading}{body}</div><p className="ex-editorial-note">{ui.timelineNote}</p><ol className="ex-archive-timeline">{sources.map((source) => { const translated = localizedSource(source, locale); return <li key={source.id}><div className="ex-timeline-date" lang="en" dir="ltr">{source.date}</div><button type="button" className="ex-timeline-image" onClick={() => inspect(source.id)} aria-label={`${ui.sourceNotes}: ${translated.title}`}><ArchiveImage path={source.imagePath} alt={translated.alt} source={source} ui={ui} /></button><div className="ex-timeline-copy"><h3>{translated.title}</h3><p>{translated.note}</p>{sourceButton(source)}</div></li>; })}</ol></>; break;
    case "credits": {
      const reviewCount = exhibitionLocaleOrder.filter((language) => document.languageReviews[language].fluentReviewed).length;
      content = <><div className="ex-colophon-heading">{heading}<figure className="ex-colophon-stamp">{image}<figcaption>{text.caption}</figcaption></figure></div>{body}<div className="ex-review-record"><div><span className="ex-status-dot" aria-hidden="true" /><strong>{ui.reviewCount.replace("{count}", new Intl.NumberFormat(locale).format(reviewCount))}</strong></div><p>{document.languageReviews[locale].disclosure}</p><button type="button" className="ex-text-button" onClick={showSettings}>{ui.language}<ArrowUpRight size={15} aria-hidden="true" /></button></div><div className="ex-source-register"><div className="ex-register-heading"><span>{ui.sourceNotes}</span><span>{new Intl.NumberFormat(locale).format(document.sources.length)} {ui.photographs}</span></div><ol>{document.sources.map((source, index) => <li key={source.id}><button type="button" onClick={() => inspect(source.id)}><span className="ex-register-index" aria-hidden="true">{formattedNumber(index + 1)}</span><span>{localizedSource(source, locale).title}</span><span className="ex-register-date" lang="en" dir="ltr">{source.date}</span><ArrowUpRight size={17} aria-hidden="true" /></button></li>)}</ol></div><details className="ex-access-statement"><summary>{ui.accessTitle}</summary><p>{ui.accessibilityStatement}</p></details><div className="ex-colophon-end"><p>{document.provenance.mode === "sample" ? ui.noAcceptance : document.provenance.label}</p><button type="button" className="ex-text-button" onClick={() => navigate(document.chapters[0]?.id ?? chapter.id)}>{ui.restart}<ArrowUp size={17} aria-hidden="true" /></button></div><footer className="ex-footer"><div className="ex-footer-mark" aria-hidden="true">H<span>·</span>S</div><p>{ui.creditLine}</p><a href="/">{ui.madeWithGuild}<ArrowUpRight size={14} aria-hidden="true" /></a></footer></>;
      break;
    }
  }
  return <section id={chapter.id} className={`ex-chapter ex-layout-${chapter.layout}`} data-exhibition-chapter={chapter.id} aria-labelledby={titleId}>{content}</section>;
}
