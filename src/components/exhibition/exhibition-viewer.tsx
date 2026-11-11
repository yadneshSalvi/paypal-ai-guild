"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { ArrowLeft, ArrowRight, ArrowUpRight, Check, Copy, Download, Globe2, LoaderCircle, Map, Maximize, Minimize, Share2, SlidersHorizontal, X } from "lucide-react";
import type { ExhibitionDocument, Locale } from "@/contracts/guild";
import { exhibitionCopy, exhibitionLocaleNames, exhibitionLocaleOrder, isExhibitionLocale, localizedSource } from "@/exhibition/locales";
import { museumArchiveRecord } from "@/exhibition/archive";
import { safeExternalUrl, safeHexColor, safeMediaUrl } from "@/exhibition/safety";
import type { ExportProgress } from "@/exhibition/export";
import { ArchiveImage, ExhibitionChapterView } from "./exhibition-chapter";
import { ExhibitionMap } from "./exhibition-map";
import "./exhibition.css";

type ReadingWidth = "comfortable" | "compact" | "wide";
type Panel = "map" | "settings" | "share" | "source" | null;
type ExportState = "idle" | "preparing" | "ready" | "error";
const settingsKey = "guild.exhibition.reading.v1";

/** A bounded artifact renderer: data selects authored layouts, never executable HTML. */
export function ExhibitionViewer({ document: exhibition }: { document: ExhibitionDocument }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const chaptersRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const exportController = useRef<AbortController | null>(null);
  const languagePosition = useRef<{ id: string; ratio: number } | null>(null);
  const activeRef = useRef(exhibition.chapters[0]?.id ?? "");
  const [locale, setLocale] = useState<Locale>("en");
  const [ready, setReady] = useState(false);
  const [activeId, setActiveId] = useState(exhibition.chapters[0]?.id ?? "");
  const [panel, setPanel] = useState<Panel>(null);
  const [sourceId, setSourceId] = useState(exhibition.sources[0]?.id ?? "");
  const [contrast, setContrast] = useState(false);
  const [spacious, setSpacious] = useState(false);
  const [width, setWidth] = useState<ReadingWidth>("comfortable");
  const [kiosk, setKiosk] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [shareUrl, setShareUrl] = useState("");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [exportState, setExportState] = useState<ExportState>("idle");
  const [exportProgress, setExportProgress] = useState<ExportProgress>({ completed: 0, total: 0 });
  const copy = exhibitionCopy[locale];
  const ui = copy.ui;
  const activeIndex = Math.max(0, exhibition.chapters.findIndex((chapter) => chapter.id === activeId));
  const activeChapter = exhibition.chapters[activeIndex];
  const selectedSource = exhibition.sources.find((source) => source.id === sourceId) ?? exhibition.sources[0];
  const selectedRecord = selectedSource ? museumArchiveRecord(selectedSource.id) : undefined;
  const selectedTranslation = selectedSource ? localizedSource(selectedSource, locale) : undefined;
  const review = exhibition.languageReviews[locale];
  const fluentCount = exhibitionLocaleOrder.filter((language) => exhibition.languageReviews[language].fluentReviewed).length;
  const format = (value: number) => new Intl.NumberFormat(locale).format(value);
  const chapterElement = (id: string) => [...(chaptersRef.current?.querySelectorAll<HTMLElement>("[data-exhibition-chapter]") ?? [])].find((element) => element.dataset.exhibitionChapter === id);

  useEffect(() => {
    let stored: Record<string, unknown> = {};
    try { const candidate: unknown = JSON.parse(localStorage.getItem(settingsKey) ?? "{}"); if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) stored = candidate as Record<string, unknown>; } catch { /* Reading remains available when device storage is disabled. */ }
    const params = new URLSearchParams(window.location.search);
    const requested = params.get("lang");
    setLocale(isExhibitionLocale(requested) ? requested : isExhibitionLocale(stored.locale) ? stored.locale : "en");
    setContrast(stored.contrast === true); setSpacious(stored.spacious === true);
    if (["comfortable", "compact", "wide"].includes(String(stored.width))) setWidth(stored.width as ReadingWidth);
    setKiosk(params.get("kiosk") === "1");
    const readHash = () => {
      let id = ""; try { id = decodeURIComponent(window.location.hash.slice(1)); } catch { /* Ignore malformed fragments. */ }
      if (exhibition.chapters.some((chapter) => chapter.id === id)) {
        setActiveId(id); activeRef.current = id;
        requestAnimationFrame(() => chapterElement(id)?.scrollIntoView({ behavior: "instant", block: "start" }));
      }
      const language = new URLSearchParams(window.location.search).get("lang");
      if (isExhibitionLocale(language)) setLocale(language);
    };
    setReady(true); readHash();
    window.addEventListener("popstate", readHash); window.addEventListener("hashchange", readHash);
    return () => { window.removeEventListener("popstate", readHash); window.removeEventListener("hashchange", readHash); exportController.current?.abort(); };
    // A document has a stable chapter identity; browser navigation is scoped to that document.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exhibition.id]);

  useEffect(() => {
    if (!ready) return;
    try { localStorage.setItem(settingsKey, JSON.stringify({ locale, contrast, spacious, width })); } catch { /* Optional persistence. */ }
    const url = new URL(window.location.href); url.searchParams.set("lang", locale);
    window.history.replaceState(window.history.state, "", url);
  }, [ready, locale, contrast, spacious, width]);

  useLayoutEffect(() => {
    const saved = languagePosition.current;
    if (!saved) return;
    const element = chapterElement(saved.id);
    if (element) {
      const fullscreenRoot = document.fullscreenElement === rootRef.current ? rootRef.current : null;
      const top = (fullscreenRoot?.scrollTop ?? window.scrollY) + element.getBoundingClientRect().top + element.offsetHeight * saved.ratio - 90;
      if (fullscreenRoot) fullscreenRoot.scrollTo({ top, behavior: "instant" }); else window.scrollTo({ top, behavior: "instant" });
    }
    languagePosition.current = null;
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) chaptersRef.current?.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 250, easing: "ease-out" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale]);

  useEffect(() => {
    const sections = chaptersRef.current?.querySelectorAll<HTMLElement>("[data-exhibition-chapter]");
    if (!sections?.length) return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      const id = (visible?.target as HTMLElement | undefined)?.dataset.exhibitionChapter;
      if (!id || activeRef.current === id) return;
      activeRef.current = id; setActiveId(id);
      const url = new URL(window.location.href); url.hash = id; window.history.replaceState(window.history.state, "", url);
    }, { rootMargin: "-18% 0px -58% 0px", threshold: 0 });
    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, [exhibition.id]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (panel && !dialog.open) dialog.showModal();
    else if (!panel && dialog.open) dialog.close();
    if (panel === "share") { setShareUrl(window.location.href); setCopyState("idle"); }
  }, [panel]);

  useEffect(() => {
    if (!kiosk) return;
    const exit = (event: KeyboardEvent) => { if (event.key === "Escape" && !dialogRef.current?.open) setKiosk(false); };
    const fullscreen = () => { if (!document.fullscreenElement) setKiosk(false); };
    window.addEventListener("keydown", exit); document.addEventListener("fullscreenchange", fullscreen);
    return () => { window.removeEventListener("keydown", exit); document.removeEventListener("fullscreenchange", fullscreen); };
  }, [kiosk]);

  function changeLanguage(next: Locale) {
    if (locale === next) return;
    const element = chapterElement(activeRef.current);
    if (element) languagePosition.current = { id: activeRef.current, ratio: Math.max(0, (90 - element.getBoundingClientRect().top) / Math.max(1, element.offsetHeight)) };
    rootRef.current?.querySelectorAll("audio").forEach((audio) => audio.pause());
    setLocale(next); setAnnouncement(exhibitionLocaleNames[next]);
  }

  function navigate(id: string) {
    const chapter = exhibition.chapters.find((item) => item.id === id);
    if (!chapter) return;
    if (dialogRef.current?.open) dialogRef.current.close();
    setPanel(null); setActiveId(id); activeRef.current = id;
    const url = new URL(window.location.href); url.hash = id; window.history.pushState(window.history.state, "", url);
    requestAnimationFrame(() => {
      const element = chapterElement(id);
      element?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
      element?.querySelector<HTMLElement>("[data-chapter-title]")?.focus({ preventScroll: true });
    });
    setAnnouncement(chapter.content[locale].title.replace(/\n/g, " "));
  }
  function inspect(id: string) { setSourceId(id); setPanel("source"); }
  async function toggleKiosk() {
    if (kiosk) { setKiosk(false); if (document.fullscreenElement) await document.exitFullscreen().catch(() => {}); return; }
    if (dialogRef.current?.open) dialogRef.current.close();
    setPanel(null); setKiosk(true);
    if (rootRef.current?.requestFullscreen) await rootRef.current.requestFullscreen().catch(() => {});
  }
  async function copyLink() {
    try { await navigator.clipboard.writeText(shareUrl); setCopyState("copied"); } catch { setCopyState("failed"); }
  }
  function save(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob); const anchor = document.createElement("a");
    anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
  async function exportHtml() {
    exportController.current?.abort(); const controller = new AbortController(); exportController.current = controller;
    setExportState("preparing");
    try {
      const { createPortableExhibition } = await import("@/exhibition/export");
      const blob = await createPortableExhibition(exhibition, locale, setExportProgress, controller.signal);
      save(blob, `${exhibition.slug || "exhibition"}-offline.html`); setExportState("ready");
    } catch (error) { controller.abort(); setExportState(error instanceof DOMException && error.name === "AbortError" ? "idle" : "error"); }
  }
  function exportJson() { save(new Blob([JSON.stringify(exhibition, null, 2)], { type: "application/json" }), `${exhibition.slug || "exhibition"}.json`); }
  function closePanel() { setPanel(null); }
  const panelTitle = panel === "map" ? ui.mapTitle : panel === "settings" ? ui.accessTitle : panel === "source" ? ui.sourceTitle : ui.shareTitle;
  const palette = { "--ex-paper": safeHexColor(exhibition.palette.background, "#f6f1e7"), "--ex-ink": safeHexColor(exhibition.palette.foreground, "#1b2333"), "--ex-brass": safeHexColor(exhibition.palette.accent, "#916a30") } as CSSProperties;

  return <div ref={rootRef} className="exhibition" lang={locale} dir={locale === "ar" ? "rtl" : "ltr"} data-contrast={contrast || undefined} data-spacious={spacious || undefined} data-width={width} data-kiosk={kiosk || undefined} style={palette}>
    <a href="#main" className="ex-skip">{ui.skip}</a>
    <header className="ex-masthead">
      <a href="/" className="ex-museum-brand" aria-label={`${exhibition.museum} · ${ui.returnToGuild}`}><span className="ex-museum-monogram" aria-hidden="true">H<span>·</span>S</span><span className="ex-museum-name"><strong>{exhibition.museum}</strong><span>{ui.exhibition}</span></span></a>
      <div className="ex-header-tools">
        <label className="ex-language"><Globe2 size={16} aria-hidden="true" /><span className="ex-sr-only">{ui.language}</span><select value={locale} onChange={(event) => { if (isExhibitionLocale(event.target.value)) changeLanguage(event.target.value); }}>{exhibitionLocaleOrder.map((language) => <option key={language} value={language} lang={language}>{exhibitionLocaleNames[language]}</option>)}</select></label>
        <button type="button" className="ex-icon-button" onClick={() => setPanel("settings")} aria-label={ui.access} aria-haspopup="dialog"><SlidersHorizontal size={18} aria-hidden="true" /></button>
        <button type="button" className="ex-icon-button ex-header-share" onClick={() => setPanel("share")} aria-label={ui.share} aria-haspopup="dialog"><Share2 size={18} aria-hidden="true" /></button>
        <button type="button" className="ex-icon-button ex-kiosk-button" onClick={() => void toggleKiosk()} aria-label={kiosk ? ui.exitKiosk : ui.kiosk} aria-pressed={kiosk}>{kiosk ? <Minimize size={18} aria-hidden="true" /> : <Maximize size={18} aria-hidden="true" />}{kiosk && <span>{ui.exitKiosk}</span>}</button>
      </div>
    </header>
    <div className="ex-provenance-line"><span><i aria-hidden="true" />{ui[exhibition.provenance.mode]}</span><button type="button" onClick={() => setPanel("settings")}>{review.fluentReviewed ? ui.fluentReview : ui.notFluentReviewed}<ArrowUpRight size={12} aria-hidden="true" /></button></div>
    <main id="main" tabIndex={-1} aria-label={exhibition.title[locale]}><div ref={chaptersRef} className="ex-chapters">{exhibition.chapters.map((chapter) => <ExhibitionChapterView key={chapter.id} chapter={chapter} document={exhibition} locale={locale} ui={ui} inspect={inspect} navigate={navigate} showSettings={() => setPanel("settings")} />)}</div></main>
    {activeChapter && <nav className="ex-reading-nav" aria-label={ui.chapterList}>
      <button type="button" className="ex-map-button" onClick={() => setPanel("map")} aria-haspopup="dialog"><Map size={17} aria-hidden="true" /><span>{ui.map}</span></button>
      <div className="ex-current-chapter"><span className="ex-current-number" aria-label={`${format(activeIndex + 1)} / ${format(exhibition.chapters.length)}`}>{new Intl.NumberFormat(locale, { minimumIntegerDigits: 2 }).format(activeIndex + 1)}<span aria-hidden="true"> / {new Intl.NumberFormat(locale, { minimumIntegerDigits: 2 }).format(exhibition.chapters.length)}</span></span><span className="ex-current-title">{activeChapter.content[locale].title.replace(/\n/g, " ")}</span></div>
      <div className="ex-reading-arrows"><button type="button" aria-label={ui.previous} disabled={activeIndex === 0} onClick={() => { const previous = exhibition.chapters[activeIndex - 1]; if (previous) navigate(previous.id); }}><ArrowLeft size={19} aria-hidden="true" /></button><button type="button" aria-label={ui.next} disabled={activeIndex === exhibition.chapters.length - 1} onClick={() => { const next = exhibition.chapters[activeIndex + 1]; if (next) navigate(next.id); }}><ArrowRight size={19} aria-hidden="true" /></button></div>
    </nav>}
    <div className="ex-sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</div>

    <dialog ref={dialogRef} className={`ex-dialog ex-dialog-${panel ?? "closed"}`} lang={locale} dir={locale === "ar" ? "rtl" : "ltr"} aria-labelledby="ex-dialog-title" onCancel={(event) => { event.preventDefault(); closePanel(); }} onClose={() => setPanel(null)} onClick={(event) => { if (event.target === event.currentTarget) closePanel(); }}>
      <div className="ex-dialog-inner"><header className="ex-dialog-heading"><div><p className="ex-eyebrow">{exhibition.museum}</p><h2 id="ex-dialog-title">{panelTitle}</h2></div><button className="ex-dialog-close ex-icon-button" type="button" onClick={closePanel} aria-label={ui.close} autoFocus><X size={21} aria-hidden="true" /></button></header>
        {panel === "map" && <ExhibitionMap document={exhibition} locale={locale} ui={ui} activeId={activeId} navigate={navigate} />}
        {panel === "settings" && <div className="ex-settings-panel"><p className="ex-dialog-intro">{ui.accessDescription}</p><label className="ex-setting-language">{ui.language}<select value={locale} onChange={(event) => { if (isExhibitionLocale(event.target.value)) changeLanguage(event.target.value); }}>{exhibitionLocaleOrder.map((language) => <option key={language} value={language}>{exhibitionLocaleNames[language]}</option>)}</select></label><fieldset className="ex-width-options"><legend>{ui.readingWidth}</legend>{(["compact", "comfortable", "wide"] as const).map((option) => <label key={option} data-selected={width === option || undefined}><input type="radio" name="ex-reading-width" value={option} checked={width === option} onChange={() => setWidth(option)} /><span className={`ex-width-illustration ex-width-${option}`} aria-hidden="true"><i /><i /><i /></span><span>{ui[option]}</span></label>)}</fieldset><div className="ex-access-toggle"><span>{ui.highContrast}</span><button type="button" role="switch" aria-checked={contrast} aria-label={ui.highContrast} onClick={() => setContrast(!contrast)}><span /></button></div><div className="ex-access-toggle"><span>{ui.dyslexia}</span><button type="button" role="switch" aria-checked={spacious} aria-label={ui.dyslexia} onClick={() => setSpacious(!spacious)}><span /></button></div><p className="ex-setting-explanation">{ui.dyslexiaDescription}</p><button type="button" className="ex-setting-kiosk" onClick={() => void toggleKiosk()}>{kiosk ? <Minimize size={19} aria-hidden="true" /> : <Maximize size={19} aria-hidden="true" />}<span>{kiosk ? ui.exitKiosk : ui.kiosk}</span><ArrowUpRight size={16} aria-hidden="true" /></button><p className="ex-setting-explanation">{ui.kioskDescription}</p><div className="ex-review-detail"><p className="ex-eyebrow">{ui.fluentReview}</p><strong>{ui.reviewCount.replace("{count}", format(fluentCount))}</strong><p>{review.disclosure}</p><ul>{exhibitionLocaleOrder.map((language) => <li key={language}><span lang={language}>{exhibitionLocaleNames[language]}</span><span>{exhibition.languageReviews[language].fluentReviewed ? <Check size={15} aria-label={ui.fluentReview} /> : ui.notFluentReviewed}</span></li>)}</ul></div></div>}
        {panel === "source" && selectedSource && selectedTranslation && <div className="ex-source-panel"><label className="ex-source-picker"><span>{ui.source} {format(exhibition.sources.findIndex((source) => source.id === selectedSource.id) + 1)} / {format(exhibition.sources.length)}</span><select value={selectedSource.id} onChange={(event) => setSourceId(event.target.value)} aria-label={ui.sourceNotes}>{exhibition.sources.map((source, index) => <option key={source.id} value={source.id}>{new Intl.NumberFormat(locale, { minimumIntegerDigits: 2 }).format(index + 1)} · {localizedSource(source, locale).title}</option>)}</select></label><figure className="ex-source-full-frame"><ArchiveImage key={selectedSource.imagePath} path={selectedSource.imagePath} alt={selectedTranslation.alt} source={selectedSource} priority ui={ui} /><figcaption>{ui.fullFrame}</figcaption></figure><div className="ex-source-interpretation"><p className="ex-eyebrow">{ui.collectionNote}</p><h3>{selectedTranslation.title}</h3><p>{selectedTranslation.note}</p></div><p className="ex-native-language-note">{ui.sourceLanguage}</p><h3 className="ex-native-title" lang="en" dir="ltr">{selectedRecord?.nativeTitle ?? selectedSource.title}</h3><dl className="ex-source-metadata"><dt>{ui.creator}</dt><dd lang="en" dir="ltr">{selectedSource.creator}</dd><dt>{ui.date}</dt><dd lang="en" dir="ltr">{selectedSource.date}</dd><dt>{ui.rights}</dt><dd lang="en" dir="ltr">{selectedSource.rights}{safeExternalUrl(selectedSource.rightsUrl) && <a className="ex-native-rights" href={selectedSource.rightsUrl} target="_blank" rel="noopener noreferrer"><ArrowUpRight size={14} aria-label={ui.archiveRecord} /></a>}</dd></dl>{selectedRecord && <div className="ex-native-notes"><p className="ex-eyebrow">{ui.originalNotes}</p><div lang="en" dir="ltr">{selectedRecord.nativeSummary?.map((summary, index) => <p key={index}>{summary}</p>)}<ul>{selectedRecord.nativeNotes?.map((note, index) => <li key={index}>{note}</li>)}</ul>{selectedRecord.nativeNotesCaveat && <p className="ex-marc-caveat">{selectedRecord.nativeNotesCaveat}</p>}<p className="ex-native-credit">{selectedRecord.creditLine}</p>{selectedRecord.marcxmlUrl && <a href={selectedRecord.marcxmlUrl} target="_blank" rel="noopener noreferrer">MARCXML<ArrowUpRight size={14} aria-hidden="true" /></a>}</div></div>}<div className="ex-source-fingerprint"><p className="ex-eyebrow">{ui.checksum}</p><code dir="ltr">{selectedSource.contentHash}</code><p>{ui.measuredChecksum}</p></div><div className="ex-source-actions">{safeExternalUrl(selectedSource.sourceUrl) && <a href={selectedSource.sourceUrl} target="_blank" rel="noopener noreferrer">{ui.archiveRecord}<ArrowUpRight size={16} aria-hidden="true" /></a>}{safeMediaUrl(selectedSource.imagePath) && <a href={selectedSource.imagePath} download><Download size={16} aria-hidden="true" />{ui.downloadImage}</a>}{selectedRecord && safeMediaUrl(selectedRecord.originalPath) && <a href={selectedRecord.originalPath} download><Download size={16} aria-hidden="true" />{ui.originalJpeg}</a>}</div></div>}
        {panel === "share" && <div className="ex-share-panel"><p className="ex-dialog-intro">{ui.exportDescription}</p><div className="ex-share-link"><label htmlFor="ex-chapter-url">{ui.copyLink}</label><div><input id="ex-chapter-url" type="url" readOnly value={shareUrl} dir="ltr" onFocus={(event) => event.currentTarget.select()} /><button type="button" className="ex-icon-button" onClick={() => void copyLink()} aria-label={ui.copyLink}>{copyState === "copied" ? <Check size={18} aria-hidden="true" /> : <Copy size={18} aria-hidden="true" />}</button></div>{copyState !== "idle" && <p role="status">{copyState === "copied" ? ui.copied : ui.copyFailed}</p>}</div><div className="ex-export-block"><p className="ex-eyebrow">{ui.portable}</p><button type="button" className="ex-export-primary" onClick={() => void exportHtml()} disabled={exportState === "preparing"}>{exportState === "preparing" ? <LoaderCircle className="ex-loading-icon" size={18} aria-hidden="true" /> : <Download size={18} aria-hidden="true" />}{ui.exportHtml}<span dir="ltr">.html</span></button><button type="button" className="ex-export-secondary" onClick={exportJson}><Download size={17} aria-hidden="true" />{ui.exportManifest}<span dir="ltr">.json</span></button>{exportState === "preparing" && <div className="ex-export-progress" role="status"><span>{ui.preparing} · {format(exportProgress.completed)} / {format(exportProgress.total)}</span><progress max={Math.max(1, exportProgress.total)} value={exportProgress.completed} aria-label={ui.preparing} /><button type="button" className="ex-text-button" onClick={() => exportController.current?.abort()}>{ui.cancel}</button></div>}{exportState === "ready" && <p className="ex-export-status" role="status"><Check size={17} aria-hidden="true" />{ui.exportSuccess}</p>}{exportState === "error" && <p className="ex-export-error" role="alert">{ui.exportError}</p>}</div></div>}
      </div>
    </dialog>
  </div>;
}
