import { ArrowUpRight, MapPin } from "lucide-react";
import type { ExhibitionDocument, Locale } from "@/contracts/guild";
import type { ExhibitionUi } from "@/exhibition/locales";

export function ExhibitionMap({ document, locale, ui, activeId, navigate }: { document: ExhibitionDocument; locale: Locale; ui: ExhibitionUi; activeId: string; navigate: (id: string) => void }) {
  return <div className="ex-map-panel">
    <p className="ex-dialog-intro">{ui.mapDescription}</p>
    <div className="ex-harbor-map" aria-label={ui.map}>
      <svg viewBox="0 0 800 480" aria-hidden="true" focusable="false">
        <defs><pattern id="ex-map-grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="currentColor" strokeWidth=".5" opacity=".16" /></pattern><pattern id="ex-map-water" width="38" height="26" patternUnits="userSpaceOnUse"><path d="M2 13c5-3 9-3 14 0s9 3 14 0" fill="none" stroke="currentColor" strokeWidth=".8" opacity=".14" /></pattern></defs>
        <rect width="800" height="480" fill="var(--ex-map-water)" />
        <rect width="800" height="480" fill="url(#ex-map-water)" />
        <path d="M0 0H590L581 59 607 89 583 122 624 155 603 193 559 203 547 250 510 260 500 220 459 236 452 283 427 287 413 257 364 268 355 318 326 323 312 284 267 292 257 342 230 350 216 312 171 332 150 381 118 391 111 350 66 376 40 417 0 429Z" fill="var(--ex-paper)" stroke="var(--ex-map-outline)" strokeWidth="2" />
        <path d="M0 0H590L581 59 607 89 583 122 624 155 603 193 559 203 547 250 510 260 500 220 459 236 452 283 427 287 413 257 364 268 355 318 326 323 312 284 267 292 257 342 230 350 216 312 171 332 150 381 118 391 111 350 66 376 40 417 0 429Z" fill="url(#ex-map-grid)" />
        <path d="M35 304 141 276 231 242 329 218 430 187 531 151 554 110" fill="none" stroke="var(--ex-brass)" strokeWidth="2" strokeDasharray="5 7" />
        <path d="M40 92 132 115 215 100 330 124 460 90 551 55M100 0 126 115 162 244M273 0 260 107 288 225M410 0 401 104 425 185" fill="none" stroke="var(--ex-map-outline)" strokeWidth="1" opacity=".55" />
        <g fill="var(--ex-paper)" stroke="var(--ex-map-outline)" strokeWidth="1.4"><path d="m647 75 21-10 25 8 9 21-14 16-29-3-16-16Z" /><path d="m648 77 18-3 9 11-5 14-16-2Z" /><path d="m690 298 22-31 8 19-4 23-26 13Z" /></g>
        <g fill="none" stroke="var(--ex-map-outline)" strokeWidth="1.5"><circle cx="725" cy="401" r="23" /><path d="M725 371v60m-30-30h60m-42-12 24 24m0-24-24 24" /><path d="m725 373-6 23h12Z" fill="var(--ex-map-outline)" /></g>
        <path d="M82 385c76 40 179 55 283 23S530 315 641 241" fill="none" stroke="var(--ex-map-outline)" strokeWidth="1" strokeDasharray="2 8" opacity=".5" />
      </svg>
      {document.chapters.map((chapter) => <button key={chapter.id} type="button" className="ex-map-pin" style={{ left: `${Math.max(5, Math.min(95, chapter.mapPosition.x))}%`, top: `${Math.max(5, Math.min(92, chapter.mapPosition.y))}%` }} onClick={() => navigate(chapter.id)} aria-label={`${chapter.number}: ${chapter.content[locale].title.replace(/\n/g, " ")}`} aria-current={activeId === chapter.id ? "step" : undefined}><span>{new Intl.NumberFormat(locale, { minimumIntegerDigits: 2 }).format(Number(chapter.number) || 0)}</span><span className="ex-map-pin-title">{chapter.content[locale].title.replace(/\n/g, " ")}</span></button>)}
    </div>
    <div className="ex-map-list-heading"><span>{ui.chapterList}</span><span><MapPin size={13} aria-hidden="true" />{ui.youAreHere}</span></div>
    <ol className="ex-chapter-list">{document.chapters.map((chapter) => <li key={chapter.id}><button type="button" onClick={() => navigate(chapter.id)} aria-current={activeId === chapter.id ? "step" : undefined}><span className="ex-list-number" aria-hidden="true">{new Intl.NumberFormat(locale, { minimumIntegerDigits: 2 }).format(Number(chapter.number) || 0)}</span><span>{chapter.content[locale].title.replace(/\n/g, " ")}</span><ArrowUpRight size={17} aria-hidden="true" /></button></li>)}</ol>
  </div>;
}
