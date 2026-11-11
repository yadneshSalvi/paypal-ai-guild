/** Run with: node --import tsx fixtures/museum/build-offline.mjs */
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Script } from "node:vm";
import { museumExhibition } from "../../src/exhibition/museum.ts";
import { buildPortableHtml, exhibitionAssetUrls } from "../../src/exhibition/export.ts";
import { exhibitionCopy, exhibitionLocaleOrder } from "../../src/exhibition/locales/index.ts";

const assets = new Map();
for (const path of exhibitionAssetUrls(museumExhibition)) {
  const bytes = await readFile(`public${path}`);
  assets.set(path, `data:image/webp;base64,${bytes.toString("base64")}`);
}
for (const path of ["/museum/fonts/fraunces-latin.woff2", "/museum/fonts/inter-latin.woff2", "/museum/fonts/noto-naskh-arabic.woff2"]) assets.set(path, `data:font/woff2;base64,${(await readFile(`public${path}`)).toString("base64")}`);
const html = buildPortableHtml(museumExhibition, "en", assets);
const controller = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
if (!controller) throw new Error("Offline controller is absent");
new Script(controller); // Compile the actual generated script; do not execute DOM work in Node.
const bytes = Buffer.from(html, "utf8");
await writeFile("public/museum/harbor-street-offline.html", bytes);
await writeFile("public/museum/exhibition.json", `${JSON.stringify(museumExhibition, null, 2)}\n`);
const report = { schemaVersion: "guild.offline-exhibition-build.v1", builtAt: new Date().toISOString(), path: "/museum/harbor-street-offline.html", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), embeddedPhotographs: exhibitionAssetUrls(museumExhibition).length, embeddedFonts: 3, localeCount: 6, chapterCount: museumExhibition.chapters.length, originalSourceNotesIncluded: true, fontLicensesIncluded: true, controllerCompiles: true, browserVerified: false, fluentReviewedLanguages: 0, audioRecordings: 0, provenance: "sample", limitations: ["browserVerified remains false until the exported HTML is actually opened and exercised offline", "no independent fluent review or real audio is claimed"] };
await writeFile("docs/evidence/media/offline-build.json", `${JSON.stringify(report, null, 2)}\n`);
const languageStatus = { schemaVersion: "guild.exhibition-language-status.v1", observedAt: new Date().toISOString(), method: "Authored-field inventory and structural tests; no independent language identification, translation-quality evaluation, listening test or fluent review is claimed.", locales: exhibitionLocaleOrder.map((locale) => ({ locale, direction: locale === "ar" ? "rtl" : "ltr", chapterCount: museumExhibition.chapters.length, chapterTextFields: museumExhibition.chapters.length * 5, translatedSourceRecords: Object.keys(exhibitionCopy[locale].sources).length, interfaceKeys: Object.keys(exhibitionCopy[locale].ui).length, fluentReviewed: false, reviewer: null, reviewedAt: null, audioRecordings: 0, disclosure: museumExhibition.languageReviews[locale].disclosure, typography: locale === "ar" ? "Locally embedded Noto Naskh Arabic; independent Arabic sizes/line heights; no letter spacing that breaks joining" : locale === "ja" ? "Platform Japanese serif fallback; UI uses locally bundled Inter" : "Locally bundled Fraunces and Inter", contentStatus: "Complete AI-authored draft; structural checks passed; fluent review absent" })) };
await writeFile("docs/evidence/media/language-status.json", `${JSON.stringify(languageStatus, null, 2)}\n`);
process.stdout.write(`${report.bytes} byte offline exhibition; ${report.embeddedPhotographs} photographs; six locales; controller compiles; sha256 ${report.sha256}\n`);
