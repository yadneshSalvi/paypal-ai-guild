/* Authored Guild reader v1. Provider text is data, never JavaScript or markup. */
"use strict";
(() => {
  const dataElement = document.getElementById("exhibit-data");
  if (!dataElement) return;
  const data = JSON.parse(dataElement.textContent || "{}");
  const languages = ["en", "pt", "es", "fr", "ja", "ar"];
  const families = data.families;
  const storageKey = "guild.exhibition.reader.v1:" + data.sourceDigest;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(storageKey) || "{}"); } catch { /* Reading works without storage. */ }
  const query = new URLSearchParams(location.search), inspection = query.get("inspection") === "original";
  if (inspection) saved = {};
  const requested = query.get("lang");
  let language = languages.includes(requested) ? requested : languages.includes(saved.language) ? saved.language : "en";
  let chapter = families.includes(location.hash.slice(1)) ? location.hash.slice(1) : families.includes(saved.chapter) ? saved.chapter : "cover";
  const preferences = { width: ["compact", "balanced", "wide"].includes(saved.width) ? saved.width : data.defaultMeasure, contrast: saved.contrast === true, spacious: saved.spacious === true, easy: saved.easy === true };
  const invokers = new Map();
  let navigationTarget = null, navigationTimer;
  function releaseNavigation() { navigationTarget = null; clearTimeout(navigationTimer); }
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const message = key => data.messages[language][key] || key;
  const activeArticle = () => $(".web-article[data-locale='" + language + "']");
  const time = value => Math.floor(Math.max(0, value) / 60) + ":" + String(Math.floor(Math.max(0, value) % 60)).padStart(2, "0");
  const announce = value => { const node = $("#web-status"); if (node) node.textContent = value; };
  const save = () => { if (inspection) return; try { localStorage.setItem(storageKey, JSON.stringify({ language, chapter, ...preferences })); } catch { /* Optional preference persistence. */ } };
  function updateLocation() {
    try { const url = new URL(location.href); url.searchParams.set("lang", language); url.hash = chapter; history.replaceState(null, "", url); } catch { /* File readers may restrict history. */ }
  }
  function element(name, text, className) {
    const node = document.createElement(name);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  }
  function externalLink(url, text) {
    const link = element("a", text);
    try { const parsed = new URL(url); if (parsed.protocol !== "https:" || parsed.username || parsed.password) return element("span", text); link.href = parsed.href; }
    catch { return element("span", text); }
    link.target = "_blank"; link.rel = "noopener noreferrer";
    return link;
  }
  function closeDialog(dialog, reason = "") { if (dialog.open) dialog.close(reason); }
  function openDialog(id, invoker) {
    const dialog = document.getElementById(id);
    if (!(dialog instanceof HTMLDialogElement)) return;
    for (const open of $$("dialog[open]")) closeDialog(open);
    invokers.set(id, invoker || document.activeElement);
    dialog.returnValue = "";
    dialog.showModal();
    $("[data-close]", dialog)?.focus();
  }
  for (const dialog of $$("dialog")) {
    // Keep the authored modal's keyboard cycle inside the document. Native
    // dialog inertness alone may send Tab to browser chrome at the boundary.
    dialog.addEventListener("keydown", event => {
      if (event.key !== "Tab" || !dialog.open) return;
      const controls = $$("a[href],button,input,select,textarea,summary,[tabindex]", dialog).filter(control => control.tabIndex >= 0 && !control.matches(":disabled") && control.getClientRects().length && getComputedStyle(control).visibility === "visible");
      const first = controls[0], last = controls.at(-1), current = document.activeElement;
      if (!first) { event.preventDefault(); return; }
      if (!dialog.contains(current) || event.shiftKey && current === first || !event.shiftKey && current === last) {
        event.preventDefault(); (event.shiftKey ? last : first).focus();
      }
    });
    dialog.addEventListener("close", () => {
      const target = invokers.get(dialog.id);
      if (dialog.returnValue !== "navigate") queueMicrotask(() => {
        const current = document.activeElement;
        // Native close already restores focus on supported browsers. A delayed
        // close event must not steal a subsequent, intentional focus move.
        const needsReturn = !current || current === document.body || current === document.documentElement || dialog.contains(current) || !current.isConnected;
        if (needsReturn && !$('dialog[open]') && target instanceof HTMLElement && target.isConnected && !target.hasAttribute("disabled")) target.focus({ preventScroll: true });
      });
    });
    $("[data-close]", dialog)?.addEventListener("click", () => closeDialog(dialog));
    dialog.addEventListener("click", event => {
      if (event.target !== dialog) return;
      const r = dialog.getBoundingClientRect();
      if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) closeDialog(dialog);
    });
  }
  function applyPreferences() {
    document.body.dataset.width = preferences.width;
    document.body.dataset.contrast = String(preferences.contrast);
    document.body.dataset.spacious = String(preferences.spacious);
    document.body.dataset.easy = String(preferences.easy);
    for (const name of ["contrast", "spacious", "easy"]) { const control = $("[data-setting='" + name + "']"); if (control) control.checked = preferences[name]; }
    const width = $("[data-setting='width']"); if (width) width.value = preferences.width;
  }
  function updateChapter(value, persist = true) {
    if (!families.includes(value)) return;
    chapter = value;
    const index = families.indexOf(value);
    $("[data-chapter-progress]").textContent = String(index + 1).padStart(2, "0") + " / " + families.length;
    // These fixed controls remain in the tab order as their availability
    // changes with scrolling, so a focused navigation control cannot vanish.
    $("[data-previous]").setAttribute("aria-disabled", String(index === 0));
    $("[data-next]").setAttribute("aria-disabled", String(index === families.length - 1));
    for (const node of $$("[data-goto-family]")) {
      const current = node.dataset.gotoFamily === value;
      if (current) node.setAttribute("aria-current", "location"); else node.removeAttribute("aria-current");
    }
    if (persist) { save(); updateLocation(); }
  }
  function goTo(value, focus = true, smooth = true) {
    if (!families.includes(value)) return;
    releaseNavigation(); navigationTarget = value;
    navigationTimer = setTimeout(releaseNavigation, 1800);
    updateChapter(value);
    const section = $("[data-chapter='" + value + "']", activeArticle());
    const heading = $("[data-chapter-heading]", section);
    section?.scrollIntoView({ behavior: smooth && !matchMedia("(prefers-reduced-motion: reduce)").matches ? "smooth" : "instant", block: "start" });
    if (focus) heading?.focus({ preventScroll: true });
  }
  function stopAll(reset = false) {
    for (const player of $$("[data-player]")) {
      const audio = $("audio", player);
      audio.pause();
      player.pendingSeek = null;
      if (reset) { try { audio.currentTime = 0; } catch { /* Metadata is not loaded yet. */ } }
    }
  }
  function setLanguage(next, preservePosition, announceChange = true) {
    if (!languages.includes(next)) return;
    stopAll(true);
    language = next;
    document.documentElement.lang = next;
    document.documentElement.dir = next === "ar" ? "rtl" : "ltr";
    for (const article of $$(".web-article")) article.hidden = article.dataset.locale !== next;
    for (const button of $$("[data-language]")) { const selected = button.dataset.language === next; button.setAttribute("aria-selected", String(selected)); button.tabIndex = selected ? 0 : -1; }
    for (const node of $$("[data-i18n]")) node.textContent = message(node.dataset.i18n);
    for (const node of $$("[data-i18n-label]")) node.setAttribute("aria-label", message(node.dataset.i18nLabel));
    for (const node of $$("[data-map-label]")) { const title = data.chapterTitles[next][node.dataset.mapLabel]; node.textContent = title; }
    for (const node of $$(".web-map-node")) node.setAttribute("aria-label", node.textContent.trim() + ". " + data.chapterTitles[next][node.dataset.gotoFamily]);
    document.title = data.titles[next] + " · " + data.museum;
    applyPreferences(); updateChapter(chapter, false); save(); updateLocation();
    if (preservePosition) requestAnimationFrame(() => goTo(chapter, false, false));
    if (announceChange) announce(message("languageStopped"));
  }
  for (const button of $$("[data-language]")) {
    button.addEventListener("click", () => setLanguage(button.dataset.language, true));
    button.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const index = languages.indexOf(language), next = event.key === "Home" ? 0 : event.key === "End" ? languages.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + languages.length) % languages.length;
      setLanguage(languages[next], true); $("[data-language='" + languages[next] + "']").focus();
    });
  }
  for (const control of $$("[data-setting]")) control.addEventListener("change", () => {
    const name = control.dataset.setting;
    if (name === "width") { if (["compact", "balanced", "wide"].includes(control.value)) preferences.width = control.value; }
    else if (["contrast", "spacious", "easy"].includes(name)) preferences[name] = control.checked;
    applyPreferences(); save();
  });
  // Native select menus differ across platforms. Provide the same explicit
  // first/last shortcuts while preserving the native menu and arrow keys.
  for (const control of $$("select[data-setting='width'],select[data-speed]")) {
    control.setAttribute("aria-keyshortcuts", "Home End");
    control.addEventListener("keydown", event => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !["Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const index = event.key === "Home" ? 0 : control.options.length - 1;
      if (control.selectedIndex === index) return;
      control.selectedIndex = index;
      control.dispatchEvent(new Event("input", { bubbles: true }));
      control.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  for (const button of $$("[data-open-dialog]")) button.addEventListener("click", () => {
    if (button.dataset.openDialog === "share-dialog") { const field = $("#share-url"); field.value = location.href; $("#share-status").textContent = ""; }
    openDialog(button.dataset.openDialog, button);
  });
  for (const button of $$("[data-goto-family]")) button.addEventListener("click", event => {
    event.preventDefault();
    const dialog = button.closest("dialog"); if (dialog) closeDialog(dialog, "navigate");
    goTo(button.dataset.gotoFamily);
  });
  $("[data-previous]").addEventListener("click", () => { const index = families.indexOf(chapter); if (index > 0) goTo(families[index - 1]); });
  $("[data-next]").addEventListener("click", () => { const index = families.indexOf(chapter); if (index < families.length - 1) goTo(families[index + 1]); });
  for (const button of $$("[data-inspect-source]")) button.addEventListener("click", () => {
    const photo = data.photographs.find(item => item.id === button.dataset.inspectSource);
    if (!photo) return;
    const body = $("#source-content"); body.replaceChildren();
    const image = element("img", null, "source-view-image"); image.src = photo.fullPath; image.alt = photo.alt[language]; image.width = photo.width; image.height = photo.height; body.append(image);
    body.append(element("p", message("sourceLanguage")));
    const original = element("section", null, "source-record-copy"); original.lang = "en"; original.dir = "ltr";
    original.append(element("h3", photo.title), element("p", photo.description));
    const table = element("dl", null, "source-data");
    for (const [label, value] of [["Creator / publisher", photo.creator], ["Catalogue date", photo.date], ["Rights advisory", photo.rights], ["Original source SHA-256", photo.sourceHash], ["Displayed complete image SHA-256", photo.fullHash]]) { table.append(element("dt", label), element("dd", value, label.includes("SHA") ? "source-hash" : "")); }
    original.append(table); body.append(original);
    const links = element("div", null, "web-end-links"); links.append(externalLink(photo.sourceUrl, message("archiveRecord")), externalLink(photo.rightsUrl, message("rights")));
    const download = element("a", message("downloadImage")); download.href = photo.fullPath; download.download = photo.id + ".webp"; links.append(download); body.append(links);
    openDialog("source-dialog", button);
  });
  function playerState(player) {
    const audio = $("audio", player), running = !audio.paused && !audio.ended;
    const button = $("[data-play]", player), l = player.dataset.locale;
    button.setAttribute("aria-label", data.messages[l][running ? "pause" : "play"] + ": " + player.dataset.title);
    $("[data-play-label]", player).textContent = data.messages[l][running ? "pause" : "play"];
    $("[data-play-icon]", player).toggleAttribute("hidden", running); $("[data-pause-icon]", player).toggleAttribute("hidden", !running);
    const duration = Number.isFinite(audio.duration) ? audio.duration : Number(player.dataset.duration);
    const progress = $("[data-seek]", player); progress.max = String(duration); progress.value = String(Math.min(audio.currentTime || 0, duration)); progress.setAttribute("aria-valuetext", time(audio.currentTime || 0) + " / " + time(duration));
    $("[data-elapsed]", player).textContent = time(audio.currentTime || 0); $("[data-duration]", player).textContent = time(duration);
    const cues = $$("[data-cue-start]", player), current = cues.find(cue => audio.currentTime >= Number(cue.dataset.cueStart) && audio.currentTime < Number(cue.dataset.cueEnd));
    for (const cue of cues) { if (cue === current) cue.setAttribute("aria-current", "true"); else cue.removeAttribute("aria-current"); }
    $("[data-current-caption]", player).textContent = current ? $("[data-cue-text]", current).textContent : "";
    if (current && $("[data-follow]", player)?.checked && current !== player.previousCue && current.closest("details")?.open) {
      const list = $(".web-cues", player); const offset = current.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
      if (offset < list.scrollTop || offset + current.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTo({ top: offset, behavior: "instant" });
    }
    player.previousCue = current;
  }
  function seek(player, value) {
    const audio = $("audio", player), target = Math.max(0, Math.min(value, Number(player.dataset.duration)));
    if (!Number.isFinite(target)) return;
    if (audio.readyState < 1) { player.pendingSeek = target; audio.load(); }
    else { audio.currentTime = Math.min(target, audio.duration); playerState(player); }
  }
  for (const player of $$("[data-player]")) {
    const audio = $("audio", player);
    const errorMessage = $("[data-audio-error]", player);
    player.pendingSeek = null;
    $("[data-play]", player).addEventListener("click", async () => {
      if (!audio.paused) { audio.pause(); return; }
      for (const other of $$("audio")) if (other !== audio) other.pause();
      if (audio.error) audio.load();
      try { await audio.play(); errorMessage.hidden = true; } catch { errorMessage.hidden = false; }
      playerState(player);
    });
    $("[data-seek]", player).addEventListener("input", event => seek(player, Number(event.target.value)));
    $("[data-speed]", player).addEventListener("change", event => { const value = Number(event.target.value); if ([.75, 1, 1.25, 1.5].includes(value)) audio.playbackRate = value; });
    for (const cue of $$("[data-cue-start]", player)) cue.addEventListener("click", () => seek(player, Number(cue.dataset.cueStart)));
    for (const event of ["timeupdate", "play", "pause", "ended", "seeked", "durationchange"]) audio.addEventListener(event, () => playerState(player));
    audio.addEventListener("loadedmetadata", () => { if (player.pendingSeek !== null) { audio.currentTime = Math.min(player.pendingSeek, audio.duration); player.pendingSeek = null; } playerState(player); });
    audio.addEventListener("error", () => { errorMessage.hidden = false; playerState(player); });
    playerState(player);
  }
  for (const image of $$("img.web-image")) image.addEventListener("error", () => {
    if (image.dataset.failed) return;
    image.dataset.failed = "true"; image.hidden = true;
    const holder = element("div", null, "web-image-error"); holder.setAttribute("role", "img"); holder.setAttribute("aria-label", image.alt);
    holder.append(element("p", message("imageUnavailable")), element("p", message("imageUnavailableDescription"), "web-error-details")); image.after(holder);
  });
  $("#copy-chapter").addEventListener("click", async () => {
    const field = $("#share-url"); field.value = location.href;
    try { if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable"); await navigator.clipboard.writeText(field.value); $("#share-status").textContent = message("copied"); }
    catch { $("#share-status").textContent = message("copyFailed"); field.focus(); field.select(); }
  });
  $("#kiosk-toggle").addEventListener("click", async () => {
    if (document.body.dataset.kioskBusy === "true") return;
    document.body.dataset.kioskBusy = "true";
    $("#kiosk-toggle").setAttribute("aria-busy", "true");
    const opening = document.body.dataset.kiosk !== "true";
    document.body.dataset.kiosk = String(opening);
    try { if (opening && !document.fullscreenElement) await document.documentElement.requestFullscreen(); else if (!opening && document.fullscreenElement) await document.exitFullscreen(); }
    catch { announce(message("fullscreenFailed")); }
    finally { document.body.dataset.kioskBusy = "false"; $("#kiosk-toggle").removeAttribute("aria-busy"); }
    $("#kiosk-toggle").textContent = message(document.body.dataset.kiosk === "true" ? "exitKiosk" : "kiosk");
  });
  document.addEventListener("fullscreenchange", () => { document.body.dataset.kiosk = String(!!document.fullscreenElement); $("#kiosk-toggle").textContent = message(document.fullscreenElement ? "exitKiosk" : "kiosk"); });
  document.addEventListener("keydown", event => { if (event.key === "Escape" && !$('dialog[open]') && document.body.dataset.kiosk === "true") { document.body.dataset.kiosk = "false"; $("#kiosk-toggle").textContent = message("kiosk"); } });
  let frame = false;
  addEventListener("scroll", () => {
    if (frame) return; frame = true;
    requestAnimationFrame(() => { frame = false; if (navigationTarget) return; const visible = $$("[data-chapter]", activeArticle()).filter(section => section.getBoundingClientRect().top < innerHeight * .45).at(-1); if (visible && visible.dataset.chapter !== chapter) updateChapter(visible.dataset.chapter); });
  }, { passive: true });
  addEventListener("scrollend", () => {
    if (!navigationTarget) return;
    const target = $("[data-chapter='" + navigationTarget + "']", activeArticle());
    const top = target?.getBoundingClientRect().top, padding = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0;
    // An older scroll completion must not cancel a newer chapter request.
    if (top !== undefined && Math.abs(top - padding) < 3) releaseNavigation();
  });
  addEventListener("wheel", releaseNavigation, { passive: true });
  addEventListener("touchstart", releaseNavigation, { passive: true });
  addEventListener("keydown", event => { if (["PageDown", "PageUp", "ArrowDown", "ArrowUp", "Home", "End", " "].includes(event.key)) releaseNavigation(); });
  addEventListener("hashchange", () => { const value = location.hash.slice(1); if (families.includes(value) && value !== chapter) goTo(value, true, false); });
  addEventListener("pagehide", () => stopAll());
  setLanguage(language, false, false);
  requestAnimationFrame(() => {
    if (chapter !== "cover") goTo(chapter, false, false);
    if (inspection) {
      const note = element("aside", message("inspection"), "web-inspection-note"); note.setAttribute("role", "note"); $(".web-language-strip").after(note);
      const state = query.get("reviewState");
      if (state === "expanded") for (const details of $$("details", activeArticle())) details.open = true;
      if (["map", "settings", "share"].includes(state)) $("[data-open-dialog='" + state + "-dialog']")?.click();
      if (state === "source") $("[data-inspect-source]", activeArticle())?.click();
      const id = query.get("review"), target = id && /^[A-Za-z][A-Za-z0-9_-]{0,200}$/.test(id) ? document.getElementById(id) : null;
      if (target instanceof HTMLElement && !target.closest(".web-article[hidden]")) {
        for (let parent = target.parentElement; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true;
        const section = target.closest("[data-chapter]"); if (section) goTo(section.dataset.chapter, false, false);
        target.dataset.reviewFocus = "true"; target.scrollIntoView({ behavior: "instant", block: "center" });
        if (!target.matches("button,input,select,textarea,a[href],[tabindex]")) target.tabIndex = -1;
        target.focus({ preventScroll: true });
      }
    }
  });
  document.body.dataset.readerReady = "true";
})();
