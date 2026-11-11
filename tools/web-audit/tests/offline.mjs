import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseHTML } from 'linkedom';
import { unzipSync } from 'fflate';

// This independent parser checks structure and ZIP interoperability. It does not
// run a browser, decode fixture audio, measure contrast or award audit scores.
const [zipPath, manifestPath] = process.argv.slice(2);
if (!zipPath || !manifestPath) throw new Error('Pass the structural fixture ZIP and exact bundle manifest. No browser is launched.');
const archive = new Uint8Array(await readFile(zipPath));
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const files = unzipSync(archive);
assert.deepEqual(Object.keys(files).sort(), manifest.files.map(file => file.path).sort());
for (const file of manifest.files) {
  assert.equal(files[file.path].byteLength, file.byteLength);
  assert.equal(createHash('sha256').update(files[file.path]).digest('hex'), file.contentHash);
}
const { document } = parseHTML(new TextDecoder().decode(files['index.html']));
assert.equal(document.querySelectorAll('article[role=tabpanel]').length, 6);
assert.equal(document.querySelectorAll('section[data-chapter]').length, 48);
assert.equal(document.querySelectorAll('[data-label-key]').length, 78);
assert.equal(document.querySelectorAll('audio').length, 78);
assert.equal(document.querySelectorAll('audio[autoplay]').length, 0);
assert.equal(document.querySelectorAll('script').length, 2);
assert.equal(document.querySelectorAll('style').length, 2);
assert.equal(document.querySelectorAll('[onerror],[onclick],iframe,object,embed').length, 0);
assert.match(document.querySelector('.web-sample-note').textContent, /Structural media bytes are not playable/);
for (const article of document.querySelectorAll('article')) {
  assert.equal(article.getAttribute('dir'), article.getAttribute('lang') === 'ar' ? 'rtl' : 'ltr');
  for (const section of article.querySelectorAll('[data-chapter]')) assert.ok(section.querySelector('[data-chapter-heading]'));
  const full = article.querySelector('.web-layout-full_bleed .web-label');
  assert.deepEqual([...full.children].map(item => [...item.classList][0]), ['full-bleed-intro', 'web-figure', 'web-listening']);
}
const ids = [...document.querySelectorAll('[id]')].map(item => item.id);
assert.equal(new Set(ids).size, ids.length);
for (const control of document.querySelectorAll('[aria-labelledby],[aria-controls],label[for]')) {
  const target = control.getAttribute('aria-labelledby') ?? control.getAttribute('aria-controls') ?? control.getAttribute('for');
  for (const id of target.split(' ')) assert.ok(document.getElementById(id), `Missing accessible target ${id}`);
}
for (const element of document.querySelectorAll('[src],[href]')) {
  const value = element.getAttribute('src') ?? element.getAttribute('href');
  if (value.startsWith('#')) continue;
  assert.ok(files[value], `Every resource is an exact archived file: ${value}`);
}
const source = JSON.parse(new TextDecoder().decode(files['source-record.json']));
for (const language of ['en', 'pt', 'es', 'fr', 'ja', 'ar']) for (const key of source.sources.requiredKeys) {
  const label = document.querySelector(`article[lang="${language}"] [data-label-key="${key}"]`);
  const original = source.sources.labels[language][key];
  assert.equal(label.querySelector('[data-exact-title]').textContent, original.title);
  assert.equal(label.querySelector('[data-exact-body]').textContent, original.body);
  assert.equal(label.querySelector('[data-exact-transcript]').textContent, original.transcript);
}
process.stdout.write(JSON.stringify({ kind: 'structural-parser-and-zip-only', files: manifest.files.length, locales: 6, labels: 78, layouts: 48, browserAudit: false, audioDecoded: false, acceptance: false }) + '\n');
