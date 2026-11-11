const languages = ['en', 'pt', 'es', 'fr', 'ja', 'ar'];
const assert = (condition, message, observed = null) => { if (!condition) throw Object.assign(new Error(message), { observed }); };
const active = page => page.locator('.web-article:not([hidden])');
const focused = locator => locator.evaluate(element => element === document.activeElement);
async function keyActivate(locator) {
  await locator.focus();
  assert(await focused(locator), 'The authored control could not receive focus before keyboard activation.', await locator.evaluate(element => ({ tag: element.tagName, id: element.id, inertAncestor: element.closest('[inert]')?.id ?? null, openDialogs: [...document.querySelectorAll('dialog[open]')].map(dialog => dialog.id) })));
  await locator.press('Enter');
}
async function keySelectBoundary(locator, key) {
  const before = await locator.evaluate(element => ({ index: element.selectedIndex, count: element.options.length }));
  assert(['Home', 'End'].includes(key) && before.count > 1, 'The requested select boundary is unavailable.', before);
  const targetIndex = key === 'Home' ? 0 : before.count - 1;
  assert((await locator.getAttribute('aria-keyshortcuts') ?? '').split(' ').includes(key), 'The select did not declare its authored keyboard shortcut.');
  await locator.focus();
  assert(await focused(locator), 'The native select could not receive keyboard focus.');
  await locator.press(key);
  assert(await locator.evaluate(element => element.selectedIndex) === targetIndex, 'The authored select shortcut did not commit.', { before, targetIndex, key });
}
async function failureState(page) {
  return page.evaluate(() => {
    const current = document.activeElement, rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    return { locale: document.documentElement.lang, url: location.href, viewport: { width: innerWidth, height: innerHeight }, scroll: { x: scrollX, y: scrollY }, documentWidth: document.documentElement.scrollWidth,
      focus: current ? { tag: current.tagName, id: current.id, className: String(current.className), rect: rect(current) } : null,
      dialogs: [...document.querySelectorAll('dialog[open]')].map(dialog => ({ id: dialog.id, rect: rect(dialog) })),
      preferences: { ...document.body.dataset }, chapter: document.querySelector('[data-chapter-progress]')?.textContent,
      audio: [...document.querySelectorAll('.web-article:not([hidden]) [data-player]')].map(player => { const audio = player.querySelector('audio'); return { key: player.dataset.label, time: audio.currentTime, duration: Number.isFinite(audio.duration) ? audio.duration : null, paused: audio.paused, readyState: audio.readyState, networkState: audio.networkState, error: audio.error ? { code: audio.error.code, message: audio.error.message } : null }; }) };
  });
}
async function closeOpenDialog(page) {
  const open = page.locator('dialog[open]');
  if (!await open.count()) return;
  // Failure cleanup uses the same authored Close control. It never awards a
  // failed interaction a pass and leaves the original failure observation intact.
  await keyActivate(open.locator('[data-close]'));
  await open.waitFor({ state: 'hidden', timeout: 1500 });
}
async function escapeTo(page, dialog, invoker) {
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden', timeout: 1500 });
  const id = await invoker.getAttribute('id');
  await page.waitForFunction(expected => document.activeElement?.id === expected, id, { timeout: 1500 });
  assert(await focused(invoker), 'Escape did not return focus to the exact initiating control.');
}

/** All actions use the authored controls; no playback events or passing scores are fabricated. */
export async function measureInteractions(page, record, captureAxe, externalRequests, pageErrors, ensureActive = () => {}, capturePalette) {
  const checks = [], language = await page.locator('html').getAttribute('lang');
  async function check(id, action) {
    ensureActive();
    try { const observed = await action(); checks.push({ id, passed: true, detail: 'Observed in the exact isolated browser case.', observed: observed ?? null }); }
    catch (error) {
      ensureActive();
      const observed = { measurement: error?.observed ?? null, state: await failureState(page) };
      let detail = String(error?.message ?? error);
      try { await closeOpenDialog(page); } catch (cleanup) { detail += '\nOriginal failure cleanup also failed: ' + String(cleanup?.message ?? cleanup); }
      checks.push({ id, passed: false, detail: detail.slice(0, 8000), observed });
    }
  }
  await check('source_text', async () => {
    const actual = await active(page).locator('[data-label-key]').evaluateAll(elements => elements.map(element => ({ key: element.dataset.labelKey, title: element.querySelector('[data-exact-title]')?.textContent, body: element.querySelector('[data-exact-body]')?.textContent, transcript: element.querySelector('[data-exact-transcript]')?.textContent })));
    assert(actual.length === record.sources.requiredKeys.length && new Set(actual.map(item => item.key)).size === actual.length, 'The complete label register is missing or aliased.');
    for (const item of actual) {
      const original = record.sources.labels[language][item.key];
      assert(original && item.title === original.title && item.body === original.body && item.transcript === original.transcript, 'Rendered original text changed: ' + item.key);
    }
    assert(await active(page).locator('[data-chapter]').count() === 8, 'The eight authored chapter families are incomplete.');
    return { labels: actual.length, chapters: 8, locale: language };
  });
  await check('original_media_register', async () => {
    const actual = await active(page).locator('[data-player]').evaluateAll(elements => elements.map(element => ({ key: element.dataset.label, hash: element.querySelector('audio')?.dataset.audioHash, path: element.querySelector('audio')?.getAttribute('src'), captions: element.querySelector('a[download$=".vtt"]')?.getAttribute('href') })));
    for (const item of actual) {
      const original = record.sources.labels[language][item.key];
      assert(original && item.hash === original.audio.contentHash && item.path === `assets/audio/${original.audio.mediaId}.mp3` && item.captions === `assets/captions/${original.captions.vtt.mediaId}.vtt`, 'The reader substituted an original recording or caption file.');
    }
    return { exactRecordings: actual.length, originalBytesCheckedBeforeServing: true };
  });
  await check('no_autoplay', async () => {
    const observed = await page.locator('audio').evaluateAll(elements => ({ count: elements.length, playing: elements.filter(audio => !audio.paused || audio.currentTime > 0).length, autoplay: elements.filter(audio => audio.autoplay || audio.hasAttribute('autoplay')).length }));
    assert(observed.playing === 0 && observed.autoplay === 0, 'A recording played before a user action.');
    return observed;
  });
  await check('palette_contrast', async () => {
    const observed = await capturePalette();
    assert(observed.passes, 'The original computed opaque text palette failed a source binding or one of its four unrounded 4.5:1 pair measurements.', observed);
    return observed;
  });
  await check('images_decoded', async () => {
    const photos = await active(page).locator('img.web-image').all(), observations = [];
    for (const image of photos) {
      await image.scrollIntoViewIfNeeded();
      await image.evaluate(async element => { if (!element.complete) await new Promise((resolve, reject) => { element.addEventListener('load', resolve, { once: true }); element.addEventListener('error', reject, { once: true }); }); await element.decode(); });
      const observed = await image.evaluate(element => ({ width: element.naturalWidth, height: element.naturalHeight, alt: element.alt, source: element.getAttribute('src') }));
      assert(observed.width > 0 && observed.height > 0 && observed.alt.trim(), 'A required photograph did not decode with alternative text.'); observations.push(observed);
    }
    return observations;
  });
  await check('document_overflow', async () => {
    const observed = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth,
      outsideViewport: [...document.querySelectorAll('body *')].filter(element => element.getClientRects().length && !element.closest('[hidden]')).flatMap(element => {
        const r = element.getBoundingClientRect(); if (r.left >= -1 && r.right <= innerWidth + 1) return [];
        const style = getComputedStyle(element); let clip = element.parentElement;
        while (clip && !['auto', 'scroll', 'hidden', 'clip'].includes(getComputedStyle(clip).overflowX)) clip = clip.parentElement;
        return [{ tag: element.tagName, id: element.id, className: String(element.className), left: r.left, right: r.right, width: r.width, display: style.display, minWidth: style.minWidth, fontSize: style.fontSize, clippingAncestor: clip ? { tag: clip.tagName, id: clip.id, className: String(clip.className) } : null }];
      }) }));
    assert(observed.document <= observed.viewport + 1 && observed.body <= observed.viewport + 1, 'The reading document overflows its agreed viewport.', observed);
    return observed;
  });
  await check('rtl', async () => {
    const observed = await active(page).evaluate(element => {
      const content = element.querySelector('.web-layout-split .web-label'), children = [...content.children].map(child => { const r = child.getBoundingClientRect(); return { top: r.top, left: r.left, right: r.right, bottom: r.bottom }; });
      return { rootDirection: getComputedStyle(document.documentElement).direction, direction: getComputedStyle(element).direction, headingDirection: getComputedStyle(element.querySelector('h1')).direction, children, width: innerWidth };
    });
    const direction = language === 'ar' ? 'rtl' : 'ltr';
    assert(observed.direction === direction && observed.rootDirection === direction && observed.headingDirection === direction, 'The actual language direction is wrong.');
    const [first, second] = observed.children;
    assert(observed.width <= 700 ? first.top <= second.top : direction === 'rtl' ? first.right >= second.right : first.left <= second.left, 'The visual source order differs from the DOM reading order.');
    return observed;
  });
  // Expand native disclosures through the keyboard so their controls also enter
  // the measured tab sequence and axe evidence, without changing theme colours.
  for (const summary of await active(page).locator('details > summary:visible').all()) {
    if (!(await summary.evaluate(element => element.parentElement.open))) await keyActivate(summary);
  }
  await captureAxe('expanded');
  await check('keyboard_register', async () => {
    const expected = await page.evaluate(() => {
      const elements = [...document.querySelectorAll('a[href],button,input,select,textarea,summary,[tabindex]')].filter(element => element.tabIndex >= 0 && !element.disabled && element.getClientRects().length && getComputedStyle(element).visibility === 'visible' && !element.closest('[hidden]'));
      return elements.map((element, index) => { const key = 'keyboard-' + index; element.dataset.guildAuditTarget = key; return { key, role: element.tagName, name: element.getAttribute('aria-label') ?? element.textContent?.slice(0, 150) ?? '' }; });
    });
    assert(expected.length > 50 && expected.length <= 6000, 'The visible keyboard register is empty or exceeds the bounded case capacity.');
    await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo({ top: 0, behavior: 'instant' }); });
    const seen = new Set();
    for (let index = 0; index < expected.length * 2 + 10 && seen.size < expected.length; index++) {
      await page.keyboard.press('Tab');
      const key = await page.evaluate(() => document.activeElement?.dataset.guildAuditTarget ?? null); if (key) seen.add(key);
    }
    const missing = expected.filter(item => !seen.has(item.key));
    assert(!missing.length, 'Keyboard-unreachable controls: ' + JSON.stringify(missing));
    return { expected: expected.length, reached: seen.size, register: expected };
  });
  await check('dialog_focus', async () => {
    const observations = [], failures = [];
    async function modal(name, invoker, action) {
      try {
        await keyActivate(invoker); const dialog = page.locator('#' + name + '-dialog');
        assert(await dialog.evaluate(element => element.open), name + ' did not open from the keyboard.');
        await action(dialog);
        const controls = await dialog.locator('a[href]:visible,button:visible,input:visible,select:visible,textarea:visible').count();
        const focusPath = [];
        for (let index = 0; index < controls + 3; index++) {
          await page.keyboard.press('Tab');
          focusPath.push(await page.evaluate(() => ({ id: document.activeElement?.id, tag: document.activeElement?.tagName })));
          assert(await dialog.evaluate(element => element.contains(document.activeElement)), 'Focus escaped the native modal.', { name, index, controls, focusPath });
        }
        const rect = await dialog.boundingBox(), size = page.viewportSize();
        assert(rect && rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= size.width + 1 && rect.y + rect.height <= size.height + 1, 'A native dialog exceeds the viewport.', { name, rect, size });
        await escapeTo(page, dialog, invoker);
        observations.push({ name, invokerId: await invoker.getAttribute('id'), controls, rect, focusReturned: true });
      } catch (error) {
        failures.push({ name, message: String(error?.message ?? error), measurement: error?.observed ?? null, state: await failureState(page) });
      } finally { await closeOpenDialog(page); }
    }
    for (const name of ['map', 'settings', 'share']) {
      await modal(name, page.locator(`[data-open-dialog="${name}-dialog"]`), () => captureAxe(name));
    }
    const sourceControls = await active(page).locator('[data-inspect-source]:visible').all();
    for (let index = 0; index < sourceControls.length; index++) {
      const control = sourceControls[index], id = await control.getAttribute('data-inspect-source'), photo = record.sources.photographs.find(item => item.id === id);
      await modal('source', control, async () => {
        const recordText = await page.locator('#source-content').textContent();
        assert(recordText.includes(photo.sourceHash) && recordText.includes(photo.full.contentHash), 'The source inspector shows a different photograph or hash.');
        if (index === 0) await captureAxe('source');
      });
    }
    assert(!failures.length, 'One or more native dialogs failed their original keyboard/geometry check.', { failures, observations });
    return observations;
  });
  await check('original_audio', async () => {
    const observations = [];
    for (const player of await active(page).locator('[data-player]').all()) {
      const play = player.locator('[data-play]'), audio = player.locator('audio'), key = await player.getAttribute('data-label');
      await keyActivate(play);
      await audio.evaluate(element => new Promise((resolve, reject) => { if (!element.paused && element.currentTime > .02) return resolve(); const until = setTimeout(() => reject(new Error('The original recording did not advance.')), 12000); const observe = () => { if (element.currentTime > .02 && !element.paused) { clearTimeout(until); element.removeEventListener('timeupdate', observe); resolve(); } }; element.addEventListener('timeupdate', observe); element.addEventListener('error', () => { clearTimeout(until); reject(new Error('The original recording could not be decoded.')); }, { once: true }); }));
      await keyActivate(play);
      const state = await audio.evaluate(element => ({ duration: element.duration, time: element.currentTime, paused: element.paused, rate: element.playbackRate }));
      assert(state.paused && Number.isFinite(state.duration) && Math.abs(state.duration - record.sources.labels[language][key].audio.durationSeconds) <= .1, 'The original recording cannot pause or differs from its agreed measured duration.');
      const slider = player.locator('[data-seek]'); await slider.focus(); await slider.press('Home'); await slider.press('ArrowRight');
      await audio.evaluate(element => element.seeking ? new Promise(resolve => element.addEventListener('seeked', resolve, { once: true })) : undefined);
      assert(await audio.evaluate(element => element.paused && element.currentTime >= .05), 'Keyboard seeking failed or started playback.');
      const speed = player.locator('[data-speed]'); await keySelectBoundary(speed, 'End');
      assert(await audio.evaluate(element => element.playbackRate === 1.5), 'Keyboard speed selection failed.');
      await keySelectBoundary(speed, 'Home');
      assert(await audio.evaluate(element => element.playbackRate === .75), 'Keyboard first-speed selection failed.');
      // Restore the middle option through the native selection API. The
      // measured keyboard claims above concern the authored Home/End keys.
      await speed.selectOption('1');
      assert(await audio.evaluate(element => element.playbackRate === 1), 'The original playback speed was not restored.');
      observations.push({ key, ...state, speed: { keyboard: ['Home', 'End'], observedRates: [.75, 1.5], restoration: 'native-option-selection', restoredRate: 1 } });
    }
    return observations;
  });
  await check('captions_seek', async () => {
    let observed = 0;
    for (const player of await active(page).locator('[data-player]').all()) {
      const audio = player.locator('audio');
      for (const cue of await player.locator('[data-cue-start]').all()) {
        const start = Number(await cue.getAttribute('data-cue-start')); await keyActivate(cue);
        await audio.evaluate(element => element.seeking ? new Promise(resolve => element.addEventListener('seeked', resolve, { once: true })) : undefined);
        const state = await audio.evaluate(element => ({ time: element.currentTime, paused: element.paused }));
        assert(state.paused && Math.abs(state.time - start) < .15, 'A real caption boundary did not seek exactly, or it triggered autoplay.'); observed++;
      }
      const follow = player.locator('[data-follow]'); await follow.focus(); await follow.press('Space'); assert(await follow.isChecked(), 'Follow captions did not respond to the keyboard.'); await follow.press('Space');
    }
    return { originalCueBoundaries: observed, autoplay: false };
  });
  await check('locale_keyboard', async () => {
    const first = active(page).locator('[data-player]').first(); await keyActivate(first.locator('[data-play]'));
    const tab = page.locator(`[data-language="${language}"]`); await tab.focus(); await tab.press('End');
    assert(await page.locator('html').getAttribute('lang') === 'ar', 'End did not select Arabic.');
    assert(await page.locator('audio').evaluateAll(elements => elements.every(audio => audio.paused && audio.currentTime < .05)), 'Changing language did not stop and reset the previous recordings.');
    await page.keyboard.press('Home'); assert(await page.locator('html').getAttribute('lang') === 'en', 'Home did not select English.');
    for (let index = 1; index <= languages.indexOf(language); index++) await page.keyboard.press('ArrowRight');
    assert(await page.locator('html').getAttribute('lang') === language && await page.locator(`[data-language="${language}"]`).getAttribute('aria-selected') === 'true', 'The native language control lost its selected locale.');
    return { home: 'en', end: 'ar', restored: language, stoppedOriginal: true };
  });
  await check('reader_preferences', async () => {
    const invoker = page.locator('[data-open-dialog="settings-dialog"]'); await keyActivate(invoker);
    for (const name of ['contrast', 'spacious', 'easy']) {
      const control = page.locator(`[data-setting="${name}"]`); await control.focus(); await control.press('Space');
      assert(await page.locator('body').getAttribute(`data-${name}`) === 'true', name + ' did not apply.');
      if (name === 'easy') assert(await active(page).locator('.web-easy-body').first().isVisible() && !(await active(page).locator('.web-original-body').first().isVisible()), 'The easy-read setting did not display the distinct source-linked output.');
      await control.press('Space'); assert(await page.locator('body').getAttribute(`data-${name}`) === 'false', name + ' was not restored.');
    }
    const width = page.locator('[data-setting="width"]'); await keySelectBoundary(width, 'End'); assert(await page.locator('body').getAttribute('data-width') === 'wide', 'Reading width did not change.');
    await keySelectBoundary(width, 'Home'); assert(await page.locator('body').getAttribute('data-width') === 'compact', 'The first reading width did not apply.');
    await width.selectOption(record.design.typography.measure);
    assert(await page.locator('body').getAttribute('data-width') === record.design.typography.measure, 'The original reading width was not restored.');
    const kiosk = page.locator('#kiosk-toggle'); await keyActivate(kiosk); await page.waitForFunction(() => document.body.dataset.kioskBusy === 'false');
    assert(await page.locator('body').getAttribute('data-kiosk') === 'true', 'Kiosk or its disclosed quiet-reading fallback did not open.');
    await keyActivate(kiosk); await page.waitForFunction(() => document.body.dataset.kioskBusy === 'false'); await escapeTo(page, page.locator('#settings-dialog'), invoker);
    await keyActivate(page.locator('[data-open-dialog="share-dialog"]')); await keyActivate(page.locator('#copy-chapter'));
    assert((await page.locator('#share-url').inputValue()).includes('?lang=' + language), 'The chapter share value lost its locale.');
    await page.waitForFunction(() => !!document.querySelector('#share-status')?.textContent.trim(), null, { timeout: 3000 });
    assert((await page.locator('#share-status').textContent()).trim(), 'Copy success or the manual-copy fallback was not disclosed.');
    await escapeTo(page, page.locator('#share-dialog'), page.locator('[data-open-dialog="share-dialog"]'));
    return { settings: ['contrast', 'spacious', 'easy', 'width', 'kiosk'], width: { keyboard: ['Home', 'End'], observedWidths: ['compact', 'wide'], restoration: 'native-option-selection', restoredWidth: record.design.typography.measure }, exactNarrationUnchanged: true };
  });
  await check('chapter_navigation', async () => {
    const invoker = page.locator('[data-open-dialog="map-dialog"]'); await keyActivate(invoker);
    await keyActivate(page.locator('#map-dialog .web-map-list [data-goto-family="timeline"]'));
    assert(!(await page.locator('#map-dialog').evaluate(element => element.open)), 'Chapter navigation left its modal open.');
    assert(await active(page).locator('[data-chapter="timeline"] [data-chapter-heading]').evaluate(element => element === document.activeElement), 'Map navigation did not focus the destination heading.');
    await keyActivate(page.locator('[data-next]'));
    assert(await active(page).locator('[data-chapter="credits"] [data-chapter-heading]').evaluate(element => element === document.activeElement), 'Next chapter did not move focus.');
    await keyActivate(page.locator('[data-previous]'));
    assert(await active(page).locator('[data-chapter="timeline"] [data-chapter-heading]').evaluate(element => element === document.activeElement), 'Previous chapter did not return to the correct heading.');
    await keyActivate(active(page).locator('[data-goto-family="cover"]'));
    assert(await active(page).locator('h1').evaluate(element => element === document.activeElement), 'Restart did not focus the opening.');
    return { map: 'timeline', next: 'credits', previous: 'timeline', restart: 'cover' };
  });
  await check('reduced_motion', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const observed = await page.evaluate(() => ({ requested: matchMedia('(prefers-reduced-motion: reduce)').matches, scroll: getComputedStyle(document.documentElement).scrollBehavior,
      moving: [...document.querySelectorAll('*')].filter(element => element.getClientRects().length && (getComputedStyle(element).animationName !== 'none' && getComputedStyle(element).animationDuration.split(',').some(value => parseFloat(value) > .001) || getComputedStyle(element).transitionDuration.split(',').some(value => parseFloat(value) > .001))).map(element => element.tagName + '.' + element.className) }));
    assert(observed.requested && observed.scroll === 'auto' && !observed.moving.length, 'Nonessential motion remains under reduced-motion preference.');
    return observed;
  });
  await check('no_external_resources', async () => { assert(!externalRequests.length, 'The bundle attempted external resource requests: ' + JSON.stringify(externalRequests)); return { attempted: externalRequests.length }; });
  await check('no_page_errors', async () => { assert(!pageErrors.length, 'The authored reader raised page errors: ' + JSON.stringify(pageErrors)); return { errors: pageErrors }; });
  return checks;
}
