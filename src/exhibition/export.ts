import type { ExhibitionChapter, ExhibitionDocument, Locale, SourceAsset } from "@/contracts/guild";
import type { ExhibitionUi } from "./locales";
import { exhibitionCopy, exhibitionLocaleNames, exhibitionLocaleOrder, localizedSource } from "./locales";
import { museumArchiveRecord } from "./archive";
import { museumFontLicenses } from "./font-licenses";
import { escapeHtml as html, safeExternalUrl, safeMediaUrl, safeScriptJson } from "./safety";

export type ExportProgress = { completed: number; total: number };
const fontAssets = ["/museum/fonts/fraunces-latin.woff2", "/museum/fonts/inter-latin.woff2", "/museum/fonts/noto-naskh-arabic.woff2"];
const embeddedBinary = (value: string | undefined) => value && /^data:[a-z\d.+/-]+;base64,[a-z\d+/=]*$/i.test(value) ? value : null;

export function exhibitionAssetUrls(exhibition: ExhibitionDocument): string[] {
  const urls = new Set<string>();
  for (const source of exhibition.sources) { const url = safeMediaUrl(source.imagePath); if (url) urls.add(url); }
  for (const chapter of exhibition.chapters) {
    const image = safeMediaUrl(chapter.imagePath); if (image) urls.add(image);
    for (const audio of Object.values(chapter.audio)) { const url = safeMediaUrl(audio?.url); if (url) urls.add(url); }
  }
  return [...urls];
}

async function asDataUrl(response: Response): Promise<string> {
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Invalid binary file"));
    reader.onerror = () => reject(new Error("File could not be read"));
    reader.readAsDataURL(blob);
  });
}

/** Every binary is embedded; exports make no external request when opened. */
export async function createPortableExhibition(exhibition: ExhibitionDocument, initialLocale: Locale, onProgress: (progress: ExportProgress) => void, signal?: AbortSignal): Promise<Blob> {
  const urls = [...exhibitionAssetUrls(exhibition), ...fontAssets];
  const assets = new Map<string, string>();
  onProgress({ completed: 0, total: urls.length });
  for (let index = 0; index < urls.length; index += 4) {
    await Promise.all(urls.slice(index, index + 4).map(async (url) => {
      signal?.throwIfAborted();
      const response = await fetch(url, { signal, credentials: "same-origin" });
      if (!response.ok) throw new Error("An exhibition asset is unavailable");
      const type = (response.headers.get("content-type") ?? "").split(";")[0] ?? "";
      if (!/^(image\/[a-z\d.+-]+|audio\/[a-z\d.+-]+|font\/[a-z\d.+-]+|application\/(octet-stream|font-[a-z\d.+-]+))$/i.test(type)) throw new Error("Unexpected media type");
      const data = await asDataUrl(response);
      signal?.throwIfAborted();
      assets.set(url, data);
      onProgress({ completed: assets.size, total: urls.length });
    }));
  }
  signal?.throwIfAborted();
  return new Blob([buildPortableHtml(exhibition, initialLocale, assets)], { type: "text/html;charset=utf-8" });
}

/** Pure, testable safe renderer. Document strings never become executable markup. */
export function buildPortableHtml(exhibition: ExhibitionDocument, initialLocale: Locale, assets: ReadonlyMap<string, string>): string {
  const imageKeys = new Map<string, string>();
  for (const url of exhibitionAssetUrls(exhibition)) if (assets.has(url)) imageKeys.set(url, `image-${imageKeys.size}`);
  const sourceById = new Map(exhibition.sources.map((source) => [source.id, source]));
  const allSources = exhibition.sources;
  const first = exhibition.chapters[0];
  const number = (n: number, locale: Locale) => new Intl.NumberFormat(locale).format(n);
  const link = (url: string, label: string) => { const safe = safeExternalUrl(url); return safe ? `<a href="${html(safe)}" target="_blank" rel="noopener noreferrer">${html(label)} ↗</a>` : html(label); };
  function photograph(path: string | null, alt: string, className = "") {
    const key = path ? imageKeys.get(path) : undefined;
    if (!key) return "";
    return `<svg class="photograph ${className}" role="img" aria-label="${html(alt)}" viewBox="0 0 2200 1760"><use href="#${key}"/></svg>`;
  }
  function sourceFigure(source: SourceAsset, locale: Locale) {
    const translated = localizedSource(source, locale);
    return `<figure>${photograph(source.imagePath, translated.alt)}<figcaption><span>${html(source.date)}</span><strong>${html(translated.title)}</strong><p>${html(translated.note)}</p><a href="#${locale}-source-${html(source.id)}">${html(exhibitionCopy[locale].ui.sourceNotes)} ↗</a></figcaption></figure>`;
  }
  function harborMap(locale: Locale, ui: ExhibitionUi) {
    return `<details class="portable-map"><summary>${html(ui.map)}</summary><p>${html(ui.mapDescription)}</p><div class="portable-harbor"><svg viewBox="0 0 800 480" aria-hidden="true"><rect width="800" height="480" fill="#dce5df"/><path d="M0 0H590L581 59 607 89 583 122 624 155 603 193 559 203 547 250 510 260 500 220 459 236 452 283 427 287 413 257 364 268 355 318 326 323 312 284 267 292 257 342 230 350 216 312 171 332 150 381 118 391 111 350 66 376 40 417 0 429Z" fill="#f6f1e7" stroke="#697d73" stroke-width="2"/><path d="M35 304 141 276 231 242 329 218 430 187 531 151 554 110" fill="none" stroke="#916a30" stroke-width="2" stroke-dasharray="5 7"/><path d="M40 92 132 115 215 100 330 124 460 90 551 55M100 0 126 115 162 244M273 0 260 107 288 225M410 0 401 104 425 185" fill="none" stroke="#697d73" opacity=".5"/><path d="m647 75 21-10 25 8 9 21-14 16-29-3-16-16Z" fill="#f6f1e7" stroke="#697d73"/><circle cx="725" cy="401" r="23" fill="none" stroke="#697d73"/><path d="M725 371v60m-30-30h60" stroke="#697d73"/></svg>${exhibition.chapters.map((chapter) => `<a class="portable-map-pin" style="left:${Math.max(5, Math.min(95, chapter.mapPosition.x))}%;top:${Math.max(5, Math.min(92, chapter.mapPosition.y))}%" href="#${locale}-${html(chapter.id)}" aria-label="${html(chapter.content[locale].title.replace(/\n/g, " "))}">${number(Number(chapter.number) || 0, locale)}</a>`).join("")}</div></details>`;
  }
  function fontLicenses(ui: ExhibitionUi) {
    return `<details class="font-licences"><summary>${html(ui.fontLicenses)}</summary>${Object.entries(museumFontLicenses).map(([name, license]) => `<h3 lang="en" dir="ltr">${html(name)}</h3><pre lang="en" dir="ltr">${html(license)}</pre>`).join("")}</details>`;
  }
  function renderChapter(chapter: ExhibitionChapter, locale: Locale) {
    if (!["cover", "full_bleed", "split", "collection_grid", "comparison", "audio", "timeline", "credits"].includes(chapter.layout)) throw new Error("Unsupported exhibition layout");
    const text = chapter.content[locale];
    const ui = exhibitionCopy[locale].ui;
    const sources = chapter.sourceIds.flatMap((id) => { const source = sourceById.get(id); return source ? [source] : []; });
    const heading = `<div class="chapter-heading"><p class="eyebrow">${html(text.eyebrow)}</p><${chapter.layout === "cover" ? "h1" : "h2"}>${html(text.title)}</${chapter.layout === "cover" ? "h1" : "h2"}></div>`;
    const body = `<div class="reading"><p>${html(text.body)}</p></div>`;
    const caption = `<p class="caption">${html(text.caption)}${sources[0] ? ` <a href="#${locale}-source-${html(sources[0].id)}">${html(ui.sourceNotes)} ↗</a>` : ""}</p>`;
    const image = photograph(chapter.imagePath, chapter.imageAlt[locale]);
    let inner = "";
    switch (chapter.layout) {
      case "cover": inner = `${image}<div class="cover-text">${heading}<p class="cover-deck">${html(exhibition.subtitle[locale])}</p><a class="button" href="#${locale}-${html(exhibition.chapters[1]?.id ?? chapter.id)}">${html(ui.begin)} ↓</a><div class="counts">${number(exhibition.sources.length, locale)} ${html(ui.photographs)} · ${number(6, locale)} ${html(ui.languages)} · ${number(exhibition.chapters.length, locale)} ${html(ui.chapters)}</div></div><div class="cover-note">${html(exhibition.provenance.mode === "sample" ? ui.sampleDisclosure : exhibition.provenance.label)}</div>`; break;
      case "full_bleed": inner = `${heading}<figure>${image}${caption}</figure>${body}`; break;
      case "split": inner = `<div class="split-visual">${image}${caption}</div><div>${heading}${body}</div>`; break;
      case "collection_grid": inner = `${heading}${body}<div class="collection">${sources.map((source) => sourceFigure(source, locale)).join("")}</div>${caption}`; break;
      case "comparison": inner = `${heading}${body}<div class="comparison">${sources.map((source) => sourceFigure(source, locale)).join("")}</div><p class="notice">${html(ui.comparisonNote)}</p>`; break;
      case "audio": {
        const audio = chapter.audio[locale];
        const audioUrl = audio ? safeMediaUrl(audio.url) : null;
        const binary = audioUrl ? embeddedBinary(assets.get(audioUrl)) : null;
        const cues = audio?.segments.filter((cue, index, all) => Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.start >= 0 && cue.end > cue.start && (index === 0 || cue.start >= (all[index - 1]?.end ?? 0))) ?? [];
        const timed = binary && cues.length ? `<label class="follow-cues"><input data-follow type="checkbox" checked>${html(ui.followTranscript)}</label><ol class="timed-cues">${cues.map((cue) => `<li><button data-start="${cue.start}" data-end="${cue.end}" aria-label="${html(`${ui.jumpToSegment}: ${cue.text}`)}"><span dir="ltr">${Math.floor(cue.start / 60)}:${String(Math.floor(cue.start % 60)).padStart(2, "0")}</span>${html(cue.text)}</button></li>`).join("")}</ol>` : "";
        inner = `<div>${image}${caption}</div><div>${heading}${body}<div class="transcript portable-audio"><p class="eyebrow">${html(binary ? ui.audio : ui.transcriptOnly)}</p>${binary ? `<audio controls preload="metadata" src="${html(binary)}" aria-label="${html(ui.audio)}"></audio><label class="audio-speed">${html(ui.playbackSpeed)} <select data-speed>${[.75, 1, 1.25, 1.5].map((speed) => `<option value="${speed}"${speed === 1 ? " selected" : ""}>${number(speed, locale)}×</option>`).join("")}</select></label><p data-audio-error hidden>${html(ui.audioUnavailable)}</p>` : `<p>${html(ui.transcriptDisclosure)}</p>`}<details open><summary>${html(ui.transcript)}</summary>${timed}<p>${html(text.transcript)}</p></details></div></div>`;
        break;
      }
      case "timeline": inner = `${heading}${body}<p class="notice">${html(ui.timelineNote)}</p><ol class="timeline">${sources.map((source) => `<li><span class="date" dir="ltr">${html(source.date)}</span>${sourceFigure(source, locale)}</li>`).join("")}</ol>`; break;
      case "credits": inner = `${heading}${body}<div class="review-note"><strong>${html(ui.reviewCount.replace("{count}", number(exhibitionLocaleOrder.filter((language) => exhibition.languageReviews[language].fluentReviewed).length, locale)))}</strong><p>${html(exhibition.languageReviews[locale].disclosure)}</p></div><div class="archive-list">${allSources.map((source, index) => `<details id="${locale}-source-${html(source.id)}"><summary>${number(index + 1, locale).padStart(2, "0")} · ${html(localizedSource(source, locale).title)}</summary>${sourceDetails(source, locale, ui)}</details>`).join("")}</div><details><summary>${html(ui.accessTitle)}</summary><p>${html(ui.accessibilityStatement)}</p></details>${fontLicenses(ui)}<p class="notice">${html(exhibition.provenance.mode === "sample" ? ui.noAcceptance : exhibition.provenance.label)}</p><a class="button" href="#${locale}-${html(first?.id ?? "")}">${html(ui.restart)} ↑</a>`; break;
    }
    return `<section id="${locale}-${html(chapter.id)}" data-chapter="${html(chapter.id)}" class="chapter layout-${chapter.layout}">${inner}</section>`;
  }
  function sourceDetails(source: SourceAsset, locale: Locale, ui: ExhibitionUi) {
    const record = museumArchiveRecord(source.id);
    return `${photograph(source.imagePath, localizedSource(source, locale).alt)}<p>${html(localizedSource(source, locale).note)}</p><p class="small">${html(ui.sourceLanguage)}</p><div lang="en" dir="ltr"><h3>${html(record?.nativeTitle ?? source.title)}</h3><dl><dt>${html(ui.creator)}</dt><dd>${html(source.creator)}</dd><dt>${html(ui.date)}</dt><dd>${html(source.date)}</dd><dt>${html(ui.rights)}</dt><dd>${html(source.rights)}</dd><dt>${html(ui.checksum)}</dt><dd class="hash">${html(source.contentHash)}</dd></dl>${record?.nativeSummary?.map((summary) => `<p>${html(summary)}</p>`).join("") ?? ""}<ul>${record?.nativeNotes?.map((note) => `<li>${html(note)}</li>`).join("") ?? ""}</ul></div><p>${link(source.sourceUrl, ui.archiveRecord)}</p>`;
  }

  const symbols = [...imageKeys.entries()].map(([url, key]) => {
    const data = embeddedBinary(assets.get(url));
    if (!data?.startsWith("data:image/")) return "";
    return `<symbol id="${key}" viewBox="0 0 2200 1760"><image href="${html(data)}" width="2200" height="1760" preserveAspectRatio="xMidYMid meet"/></symbol>`;
  }).join("");
  const languages = exhibitionLocaleOrder.map((locale) => {
    const ui = exhibitionCopy[locale].ui;
    const review = exhibition.languageReviews[locale];
    return `<article data-language="${locale}" lang="${locale}" dir="${locale === "ar" ? "rtl" : "ltr"}"${locale === initialLocale ? "" : " hidden"}><header class="masthead"><a href="#${locale}-${html(first?.id ?? "")}" class="brand">H<span>·</span>S</a><div><strong>${html(exhibition.museum)}</strong><small>${html(ui.exhibition)} · ${html(exhibition.provenance.mode === "sample" ? ui.sample : exhibition.provenance.label)}</small></div><label><span class="sr-only">${html(ui.language)}</span><select data-language-select>${exhibitionLocaleOrder.map((language) => `<option value="${language}"${language === locale ? " selected" : ""}>${exhibitionLocaleNames[language]}</option>`).join("")}</select></label></header><nav class="chapter-list" aria-label="${html(ui.chapterList)}">${exhibition.chapters.map((chapter) => `<a href="#${locale}-${html(chapter.id)}">${html(chapter.number)} ${html(chapter.content[locale].title.replace(/\n/g, " "))}</a>`).join("")}</nav>${harborMap(locale, ui)}<div class="settings"><button data-setting="contrast" aria-pressed="false">${html(ui.highContrast)}</button><button data-setting="spacious" aria-pressed="false">${html(ui.dyslexia)}</button><label>${html(ui.readingWidth)} <select data-width><option value="comfortable">${html(ui.comfortable)}</option><option value="compact">${html(ui.compact)}</option><option value="wide">${html(ui.wide)}</option></select></label><button data-kiosk data-enter="${html(ui.kiosk)}" data-exit="${html(ui.exitKiosk)}" aria-pressed="false">${html(ui.kiosk)}</button></div><p class="language-review">${html(review.fluentReviewed ? ui.fluentReview : ui.notFluentReviewed)} · ${html(review.disclosure)}</p><main>${exhibition.chapters.map((chapter) => renderChapter(chapter, locale)).join("")}</main><footer>${html(ui.creditLine)}<p>${html(ui.madeWithGuild)}</p></footer></article>`;
  }).join("");
  const fontFaces = fontAssets.map((path, index) => { const data = embeddedBinary(assets.get(path)); return data ? `@font-face{font-family:"${["Museum Display", "Museum UI", "Museum Arabic"][index]}";src:url("${data}") format("woff2");font-weight:100 900;font-display:swap}` : ""; }).join("");
  return `<!doctype html><html lang="${initialLocale}" dir="${initialLocale === "ar" ? "rtl" : "ltr"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; media-src data:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${html(exhibition.title[initialLocale])} · ${html(exhibition.museum)}</title><style>${fontFaces}${portableCss}${portableExtraCss}</style></head><body><svg aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden"><defs>${symbols}</defs></svg>${languages}<script type="application/json" id="exhibition-document">${safeScriptJson(exhibition)}</script><script>${portableScript}${portableMediaScript}</script></body></html>`;
}

const portableScript = `(()=>{let language=document.documentElement.lang;const articles=[...document.querySelectorAll('[data-language]')];function current(){return articles.find(a=>a.dataset.language===language)}document.querySelectorAll('[data-language-select]').forEach(select=>select.addEventListener('change',()=>{const old=current();const sections=[...old.querySelectorAll('[data-chapter]')];const active=sections.find(s=>s.getBoundingClientRect().bottom>100)||sections[0];const ratio=active?Math.max(0,(100-active.getBoundingClientRect().top)/active.offsetHeight):0;const id=active?.dataset.chapter;language=select.value;document.querySelectorAll('audio').forEach(a=>a.pause());articles.forEach(a=>a.hidden=a.dataset.language!==language);document.documentElement.lang=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';document.querySelectorAll('[data-language-select]').forEach(s=>s.value=language);if(id){const target=[...current().querySelectorAll('[data-chapter]')].find(s=>s.dataset.chapter===id);if(target)scrollTo(0,scrollY+target.getBoundingClientRect().top+target.offsetHeight*ratio-100)}}));document.querySelectorAll('[data-setting]').forEach(button=>button.addEventListener('click',()=>{const key=button.dataset.setting;const on=!document.body.classList.contains(key);document.body.classList.toggle(key,on);document.querySelectorAll('[data-setting='+key+']').forEach(b=>b.setAttribute('aria-pressed',String(on)))}));document.querySelectorAll('[data-width]').forEach(select=>select.addEventListener('change',()=>{document.body.dataset.width=select.value;document.querySelectorAll('[data-width]').forEach(s=>s.value=select.value)}));document.addEventListener('click',e=>{const link=e.target.closest('a[href^="#"]');if(!link)return;const target=document.getElementById(decodeURIComponent(link.hash.slice(1)));if(target?.tagName==='DETAILS')target.open=true});})();`;

const portableMediaScript = `
(()=>{
  function kiosk(on){
    document.body.classList.toggle('kiosk',on);
    document.querySelectorAll('[data-kiosk]').forEach(button=>{button.setAttribute('aria-pressed',String(on));button.textContent=on?button.dataset.exit:button.dataset.enter});
    if(on&&!document.fullscreenElement&&document.documentElement.requestFullscreen)document.documentElement.requestFullscreen().catch(()=>{});
    if(!on&&document.fullscreenElement&&document.exitFullscreen)document.exitFullscreen().catch(()=>{});
  }
  document.querySelectorAll('[data-kiosk]').forEach(button=>button.addEventListener('click',()=>kiosk(!document.body.classList.contains('kiosk'))));
  document.addEventListener('fullscreenchange',()=>{if(!document.fullscreenElement)kiosk(false)});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&document.body.classList.contains('kiosk'))kiosk(false)});
  document.querySelectorAll('[data-language-select]').forEach(select=>select.addEventListener('change',()=>{
    const article=[...document.querySelectorAll('[data-language]')].find(item=>!item.hidden);
    if(article&&!matchMedia('(prefers-reduced-motion: reduce)').matches)article.animate([{opacity:.35},{opacity:1}],{duration:250,easing:'ease-out'});
    const active=[...article.querySelectorAll('[data-chapter]')].find(item=>item.getBoundingClientRect().bottom>100);
    if(active)try{history.replaceState(null,'','#'+article.dataset.language+'-'+active.dataset.chapter)}catch{}
  }));
  document.querySelectorAll('.portable-audio').forEach(room=>{
    const audio=room.querySelector('audio');if(!audio)return;
    const cues=[...room.querySelectorAll('[data-start]')];const follow=room.querySelector('[data-follow]');const list=room.querySelector('.timed-cues');
    room.querySelector('[data-speed]')?.addEventListener('change',event=>{audio.playbackRate=Number(event.target.value)});
    cues.forEach(cue=>cue.addEventListener('click',()=>{audio.currentTime=Number(cue.dataset.start);audio.play().catch(()=>{})}));
    audio.addEventListener('error',()=>{const message=room.querySelector('[data-audio-error]');if(message)message.hidden=false});
    audio.addEventListener('timeupdate',()=>{let current=null;cues.forEach(cue=>{const active=audio.currentTime>=Number(cue.dataset.start)&&audio.currentTime<Number(cue.dataset.end);if(active){cue.setAttribute('aria-current','true');current=cue}else cue.removeAttribute('aria-current')});if(current&&follow?.checked&&!audio.paused&&list)list.scrollTo(0,current.offsetTop-list.offsetTop-10)});
  });
})();`;

const portableExtraCss = `
.portable-map{padding:0 4vw;border-bottom:1px solid #c9c0ae}.portable-map>summary{font-size:.8rem}.portable-map>p{font-size:.8rem;line-height:1.9;max-width:80ch}.portable-harbor{position:relative;aspect-ratio:5/3;max-width:900px;margin:1.5rem auto;border:1px solid #aaa18e}.portable-harbor>svg{width:100%;height:100%;display:block}.portable-map-pin{position:absolute;transform:translate(-50%,-50%);display:grid;place-items:center;width:31px;height:31px;background:#f6f1e7;border:1px solid #1b2333;color:#1b2333;font-family:monospace;font-size:.7rem;text-decoration:none}.font-licences pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:20rem;overflow:auto;font-size:.65rem;line-height:1.7;border:1px solid #b9ae99;padding:1rem}.font-licences h3{font-family:'Museum UI',Arial,sans-serif;font-size:1rem}.follow-cues{display:flex;gap:.6rem;align-items:center;font-size:.75rem;margin:1rem 0}.timed-cues{position:relative;list-style:none;padding:0;max-height:20rem;overflow:auto;margin:1rem 0}.timed-cues button{display:flex;gap:1rem;text-align:start;line-height:1.9;width:100%;border:0;border-inline-start:2px solid transparent;padding:.6rem}.timed-cues button>span{font-family:monospace;font-size:.65rem;min-width:3rem}.timed-cues button[aria-current=true]{border-inline-start-color:#916a30;background:#e5dccb}.audio-speed{display:flex;gap:1rem;align-items:center;font-size:.75rem;margin-top:1rem}.kiosk .chapter-list,.kiosk .portable-map{display:none}.kiosk .settings{padding-block:.5rem}.kiosk .language-review{font-size:.7rem}.contrast .portable-map-pin{background:#fff;color:#000;border:2px solid #000}article[lang=ar] .portable-map>summary{font-size:1rem}article[lang=ar] .portable-map>p{font-size:1.1rem}article[lang=ar] .timed-cues button{font-family:'Museum Arabic',serif;font-size:1.15rem;letter-spacing:0}@media(max-width:700px){.portable-map-pin{width:27px;height:27px}.settings{gap:.5rem;font-size:.75rem}.settings button{padding:.6rem}.portable-harbor{margin-inline:-1vw}}`;

const portableCss = `*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:7rem}body{margin:0;background:#f6f1e7;color:#1b2333;font-family:"Museum UI",Arial,sans-serif}body.contrast{background:#fff;color:#080b12}button,select,a{touch-action:manipulation}button,select{font:inherit;color:inherit;background:transparent;border:1px solid #a59d8f;border-radius:0;padding:.7rem}a{color:inherit;text-underline-offset:.2em}button:focus-visible,select:focus-visible,a:focus-visible,summary:focus-visible{outline:3px solid #8c5c21;outline-offset:5px}[hidden]{display:none!important}.masthead{position:sticky;top:0;z-index:3;display:flex;align-items:center;gap:1rem;padding:1rem 4vw;background:#f6f1e7;border-bottom:1px solid #c9c0ae}.masthead>div{flex:1}.masthead small{display:block;margin-top:.3rem;font-size:.7rem}.brand{font-family:"Museum Display",Georgia,serif;font-size:2rem;text-decoration:none}.brand span{color:#8c5c21}.chapter-list{display:flex;overflow:auto;gap:1.5rem;padding:1rem 4vw;font-size:.75rem;border-bottom:1px solid #c9c0ae}.chapter-list a{white-space:nowrap}.settings{display:flex;flex-wrap:wrap;gap:.7rem;align-items:center;padding:1rem 4vw}.language-review{padding:.5rem 4vw;font-size:.75rem;max-width:70rem;line-height:1.6}.chapter{padding:6rem 7vw;border-top:1px solid #c9c0ae;scroll-margin-top:7rem}.eyebrow{font-size:.7rem;letter-spacing:.1em;text-transform:uppercase;line-height:1.8}h1,h2,h3{font-family:"Museum Display",Georgia,serif;font-weight:400;text-wrap:balance}h1,h2{font-size:clamp(3rem,7vw,7rem);line-height:1.02;white-space:pre-line;margin:1.5rem 0 2.5rem;letter-spacing:-.05em}.reading{max-width:64ch;line-height:1.9;font-size:1.05rem}.reading p{margin:0 0 2.5rem}.photograph{display:block;width:100%;height:auto;background:#e4dccb}figure{margin:0}figcaption,.caption{font-size:.76rem;line-height:1.7;margin-top:1rem}figcaption strong{display:block;font-size:1.15rem;font-weight:400;font-family:"Museum Display",Georgia,serif;margin-top:.5rem}figcaption p{max-width:55ch}figcaption span,.date{font-size:.7rem;font-variant-numeric:tabular-nums}.layout-cover{position:relative;min-height:90svh;padding:0;color:#fff;background:#1b2333}.layout-cover>.photograph{position:absolute;inset:0;height:100%;object-fit:cover;opacity:.5}.cover-text{position:relative;padding:6rem 7vw;background:linear-gradient(90deg,rgba(8,18,25,.75),rgba(8,18,25,.05));min-height:80svh}.cover-text h1{font-size:clamp(4.5rem,10vw,10rem)}.cover-deck{max-width:37ch;line-height:1.8}.cover-note{position:relative;padding:1.3rem 7vw;background:#18232b;font-size:.75rem;line-height:1.8}.counts{margin-top:2rem;font-size:.7rem;letter-spacing:.08em}.button{display:inline-block;padding:.9rem 1.2rem;border:1px solid currentColor;text-decoration:none;font-size:.85rem}.layout-full_bleed{background:#1c2b32;color:#f6f1e7}.layout-full_bleed .reading{margin:2rem auto 0}.layout-split,.layout-audio{display:grid;grid-template-columns:1fr 1fr;gap:6vw;align-items:center}.layout-split h2,.layout-audio h2{font-size:clamp(3rem,5vw,5.5rem)}.collection,.comparison{display:grid;grid-template-columns:1fr 1fr;gap:3rem 2rem;margin-top:3rem}.collection figure:nth-child(even){padding-top:5rem}.notice,.review-note{padding:1.4rem;border-inline-start:3px solid #916a30;background:#ede6d8;line-height:1.8;font-size:.85rem;max-width:75ch}.timeline{list-style:none;margin:4rem 0 0;padding:0;border-inline-start:1px solid #8c5c21}.timeline li{display:grid;grid-template-columns:8rem 1fr;gap:2rem;padding:0 0 4rem 2rem}.timeline .photograph{max-width:45rem}.date{font-family:monospace}.transcript{border-top:1px solid #a59d8f;padding-top:1.5rem;margin-top:2rem;line-height:1.8}audio{width:100%}summary{cursor:pointer;padding:1rem 0;line-height:1.6}.archive-list{margin:3rem 0}.archive-list details{border-top:1px solid #c9c0ae;padding:0 0 1rem}.archive-list details[open]{padding-bottom:2rem}.archive-list .photograph{max-width:55rem}dl{display:grid;grid-template-columns:10rem 1fr;gap:1rem;line-height:1.7;font-size:.85rem}dd{margin:0}dt{font-weight:600}.hash{font-family:monospace;overflow-wrap:anywhere}.small{font-size:.8rem;line-height:1.8}.layout-credits h2{font-size:clamp(3rem,7vw,6rem)}footer{padding:3rem 7vw 5rem;border-top:1px solid #c9c0ae;font-size:.75rem}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}body[data-width=compact] .reading{max-width:46ch}body[data-width=wide] .reading{max-width:80ch}.spacious h1,.spacious h2,.spacious h3,.spacious .reading{font-family:"Museum UI",Arial,sans-serif;letter-spacing:.04em;word-spacing:.13em;line-height:1.6}article[lang=ar]{font-family:"Museum Arabic","Museum UI",serif}article[lang=ar] h1,article[lang=ar] h2,article[lang=ar] h3{font-family:"Museum Arabic",serif;letter-spacing:0;line-height:1.45}article[lang=ar] .reading{font-size:1.35rem;line-height:2.05}article[lang=ar] .eyebrow{letter-spacing:0;font-size:1rem}article[lang=ar] h1{font-size:clamp(4rem,8vw,8rem)}article[lang=ar] h2{font-size:clamp(3rem,6vw,6rem)}.spacious article[lang=ar] *{letter-spacing:0}.contrast .notice,.contrast .review-note,.contrast .masthead{background:#fff;color:#080b12}.contrast .layout-full_bleed{background:#080b12;color:#fff}@media(max-width:700px){.masthead{padding:1rem 5vw}.masthead strong{font-size:.7rem}.masthead small{font-size:.6rem}.masthead select{max-width:7rem}.chapter{padding:4rem 6vw}.layout-cover{padding:0}.cover-text{padding:4rem 6vw}.cover-text h1{font-size:clamp(3.5rem,14vw,7rem)}.layout-split,.layout-audio,.comparison{grid-template-columns:1fr;gap:2.5rem}.collection{gap:2rem 1rem}.collection figure:nth-child(even){padding-top:2.5rem}.timeline li{grid-template-columns:1fr;gap:.7rem;padding-inline-start:1rem}dl{grid-template-columns:1fr;gap:.4rem}dd{margin-bottom:1rem}.chapter h2{font-size:clamp(2.8rem,11vw,5rem)}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}@media print{.masthead{position:static}.settings,.chapter-list{display:none}.chapter{break-inside:avoid;padding:2rem}.layout-cover{min-height:20rem}h1,h2{font-size:3rem}}`;
