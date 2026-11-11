import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { locales, type Locale } from "@/contracts/guild";
import { digest } from "@/domain/primitives";
import { webBundleDigest, webSourceSchema, type WebBundle, type WebLabel } from "@/domain/web-exhibition";
import { readAuthoredWebAssets, renderWebFiles } from "@/exhibition/generated/render";
import { renderNarration } from "@/server/media/audio-processing";
import { webFixture } from "./web-fixture";

const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const copy: Record<Locale, { welcome: string; title: string; sentences: [string, string]; alt: string }> = {
  en: { welcome: "A gallery of examples", title: "Sample shape", sentences: ["This is a synthetic shape.", "Audio is a short test tone."], alt: "Synthetic geometric shape used to test the reader" },
  pt: { welcome: "Uma galeria de exemplos", title: "Forma de exemplo", sentences: ["Esta forma é um exemplo.", "O áudio é um tom de teste."], alt: "Forma geométrica sintética para testar o leitor" },
  es: { welcome: "Una galería de ejemplos", title: "Forma de ejemplo", sentences: ["Esta forma es un ejemplo.", "El audio es un tono de prueba."], alt: "Forma geométrica sintética para probar el lector" },
  fr: { welcome: "Une galerie d’exemples", title: "Forme d’exemple", sentences: ["Cette forme est un exemple.", "Le son est un signal de test."], alt: "Forme géométrique synthétique pour tester le lecteur" },
  ja: { welcome: "見本のギャラリー", title: "見本の形", sentences: ["これは見本の形です。", "音声は試験用の音です。"], alt: "閲覧機能を確認するための幾何学模様" },
  ar: { welcome: "معرض الأمثلة", title: "شكل تجريبي", sentences: ["هذا شكل تجريبي.", "الصوت نغمة اختبار."], alt: "شكل هندسي تجريبي لاختبار القارئ" },
};
const stamp = (seconds: number) => `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(Math.floor(seconds) % 60).padStart(2, "0")}.${String(Math.round(seconds * 1000) % 1000).padStart(3, "0")}`;
async function main() {
  const output = process.argv[2];
  if (!output || !isAbsolute(output)) throw new Error("Choose one new absolute directory for the disclosed Sample qualification set. Existing evidence is never overwritten.");
  const outputDirectory = resolve(output);
  await mkdir(output, { recursive: false, mode: 0o700 });
  const fixture = webFixture(), assets = await readAuthoredWebAssets();
  fixture.source.museum = "Guild · Sample reading room";
  fixture.source.provenance = { mode: "sample", label: "Sample browser-engine qualification only. Synthetic geometric images, authored multilingual test text and generated test tones; no actual narration, timestamp alignment, commissioned output, human review, acceptance or payment is claimed." };
  for (const [index, photograph] of fixture.source.photographs.entries()) {
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="2200" height="1600" viewBox="0 0 2200 1600"><rect width="2200" height="1600" fill="#e9dfc8"/><path d="M0 1300L${300 + index * 60} 430L${1500 + index * 35} 1600H0Z" fill="#3e5746"/><circle cx="${1400 - index * 30}" cy="${530 + index * 35}" r="320" fill="#aa793f"/><rect x="1450" y="800" width="440" height="430" rx="22" fill="#253b31"/><text x="110" y="190" font-family="sans-serif" font-size="92" fill="#253b31">SAMPLE ${String(index + 1).padStart(2, "0")}</text><text x="110" y="1510" font-family="sans-serif" font-size="44" fill="#f8f3e7">Synthetic geometry · browser qualification only</text></svg>`);
    const full = await sharp(svg).webp({ quality: 88 }).toBuffer(), thumbnail = await sharp(full).resize(640, 465, { fit: "fill" }).webp({ quality: 85 }).toBuffer();
    for (const [kind, bytes] of [["full", full], ["thumbnail", thumbnail]] as const) {
      fixture.bytes.set(photograph[kind].mediaId, bytes); photograph[kind].contentHash = sha(bytes); photograph[kind].byteLength = bytes.length;
    }
    photograph.sourceHash = sha(svg); photograph.rightsHash = digest({ kind: "synthetic-fixture-rights", sourceHash: photograph.sourceHash, author: "Guild test fixture" });
    photograph.title = `Sample geometry ${index + 1}`; photograph.description = "A geometric image authored for browser qualification. This is not an archival photograph."; photograph.creator = "Guild synthetic fixture";
    photograph.date = "Synthetic fixture"; photograph.rights = "Authored synthetic test image. No third-party archival rights claim."; photograph.sourceUrl = `https://example.invalid/guild-sample/${photograph.id}`; photograph.rightsUrl = "https://example.invalid/guild-sample/rights";
    photograph.alt = Object.fromEntries(locales.map(locale => [locale, `${copy[locale].alt} ${index + 1}`])) as typeof photograph.alt;
  }
  let sequence = 0;
  const measurements = [];
  for (const locale of locales) for (const [index, key] of fixture.source.requiredKeys.entries()) {
    const label = fixture.source.labels[locale][key]!, text = copy[locale], title = key === "welcome" ? text.welcome : `${text.title} ${index}`, body = text.sentences.join(locale === "ja" ? "" : " "), transcript = title + "\n\n" + body;
    label.title = title; label.body = body; label.transcript = transcript; label.scriptBytesHash = sha(transcript);
    const pcm = Buffer.alloc(6 * 48000), frequency = 220 + sequence++ * 3;
    for (let frame = 0; frame < pcm.length / 2; frame++) { const envelope = Math.min(1, frame / 480, (pcm.length / 2 - frame) / 480); pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * frequency * frame / 24000) * 3000 * envelope), frame * 2); }
    const recording = await renderNarration(pcm);
    fixture.bytes.set(label.audio.mediaId, recording.bytes); label.audio.contentHash = sha(recording.bytes); label.audio.byteLength = recording.bytes.length; label.audio.durationSeconds = recording.measurement.durationSeconds; label.audio.origin.originalMediaHash = label.audio.contentHash;
    const texts = [title, ...text.sentences], cues: WebLabel["captions"]["cues"] = [];
    let offset = 0;
    for (const [cueIndex, line] of texts.entries()) { const start = transcript.indexOf(line, offset); if (start < 0) throw new Error("The exact synthetic cue is missing from its authored test text."); offset = start + line.length; cues.push({ index: cueIndex + 1, start: cueIndex * 2, end: cueIndex * 2 + 2, text: line, lines: [line], sourceStart: start, sourceEnd: offset }); }
    const vtt = Buffer.from("WEBVTT\n\n" + cues.map(cue => `${cue.index}\n${stamp(cue.start)} --> ${stamp(cue.end)}\n${cue.text}`).join("\n\n") + "\n");
    fixture.bytes.set(label.captions.vtt.mediaId, vtt); label.captions.vtt.contentHash = sha(vtt); label.captions.vtt.byteLength = vtt.length; label.captions.cues = cues; label.captions.cuesHash = digest(cues); label.captions.timingsHash = digest({ syntheticBoundaries: cues, forcedAlignmentClaimed: false });
    label.captions.receiptHash = digest({ syntheticOnly: true, label: `${locale}/${key}`, textHash: label.scriptBytesHash, cuesHash: label.captions.cuesHash }); label.sourceTrackDigest = digest({ syntheticOnly: true, locale, key, textHash: label.scriptBytesHash, audioHash: label.audio.contentHash });
    label.easyRead = { title, paragraphs: [{ text: text.sentences[0], conceptIds: [`concept-${key}`], sourceQuotes: [{ spanId: `source-${key}`, quote: text.sentences[0] }] }] };
    measurements.push({ locale, key, mediaId: label.audio.mediaId, contentHash: label.audio.contentHash, durationSeconds: recording.measurement.durationSeconds, decodedFrames: recording.measurement.decodedFrames, syntheticToneHz: frequency, speechGenerated: false });
  }
  webSourceSchema.parse(fixture.source);
  const baseline = renderWebFiles(fixture.source, fixture.design, assets), contrastDesign = structuredClone(fixture.design);
  contrastDesign.palette.ink = contrastDesign.palette.paper; contrastDesign.palette.mutedInk = contrastDesign.palette.paper; contrastDesign.palette.darkInk = contrastDesign.palette.dark; contrastDesign.palette.accentInk = contrastDesign.palette.accent;
  contrastDesign.designNotes = ["Explicit contrast mutation for the diagnostic verifier qualification; never a production provider response."];
  const contrast = renderWebFiles(fixture.source, contrastDesign, assets), missingAlt = { bundle: structuredClone(baseline.bundle), authored: new Map(baseline.authored) };
  const original = missingAlt.authored.get("index.html")!.toString(), changed = original.replace(/(<img class="web-image"[^>]*?) alt="[^"]*"/, "$1");
  if (original === changed) throw new Error("The explicit missing-alt mutation did not change exactly the first synthetic image.");
  missingAlt.authored.set("index.html", Buffer.from(changed));
  const entry = missingAlt.bundle.files.find(file => file.path === "index.html")!; entry.byteLength = Buffer.byteLength(changed); entry.contentHash = sha(changed);
  missingAlt.bundle.totalBytes = missingAlt.bundle.files.reduce((sum, file) => sum + file.byteLength, 0); missingAlt.bundle.filesDigest = webBundleDigest(missingAlt.bundle.files);
  async function save(name: string, rendered: { bundle: WebBundle; authored: Map<string, Buffer> }) {
    const directory = resolve(outputDirectory, name); await mkdir(directory, { mode: 0o700 });
    for (const file of rendered.bundle.files) { const path = resolve(directory, file.path), bytes = rendered.authored.get(file.path) ?? fixture.bytes.get(file.mediaId!); if (!bytes || bytes.length !== file.byteLength || sha(bytes) !== file.contentHash) throw new Error("A synthetic input differs from its exact file manifest."); await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, bytes, { flag: "wx", mode: 0o600 }); }
    return { directory, bundle: rendered.bundle };
  }
  const set = { version: "guild.web-qualification-set.v1", baseline: await save("baseline", baseline), mutations: [
    { id: "contrast", description: "Explicit same-foreground/background tokens; the source-bound original-palette contrast gate must fail, with native axe findings retained separately.", ...await save("mutation-contrast", contrast) },
    { id: "missing-alt", description: "Explicit removal of the first synthetic image alternative; native image-alt detection is required.", ...await save("mutation-missing-alt", missingAlt) },
  ] };
  await writeFile(resolve(output, "qualification-set.json"), JSON.stringify(set, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await writeFile(resolve(output, "synthetic-media-measurements.json"), JSON.stringify({ version: "guild.synthetic-browser-inputs.v1", sourceDigest: digest(fixture.source), renderer: assets.capability, measurements, fileCountPerBundle: baseline.bundle.files.length, audioMode: "78 distinct generated test tones; no speech or alignment quality claim", providerCalls: 0, browserLaunched: false, acceptance: false, payment: false }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  process.stdout.write(JSON.stringify({ inputDigest: digest(set), sourceDigest: digest(fixture.source), rendererDigest: assets.capability.digest, cases: 20, syntheticTones: measurements.length, filesPerBundle: baseline.bundle.files.length, providerCalls: 0, browserLaunched: false }) + "\n");
}
void main();
