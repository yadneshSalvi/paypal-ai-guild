import { createHash, randomUUID } from "node:crypto";
import type { Locale } from "@/contracts/guild";
import { locales } from "@/contracts/guild";
import { digest } from "@/domain/primitives";
import { webSourceSchema, type WebDesign, type WebSources } from "@/domain/web-exhibition";

const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
/** Structural fixtures only. These bytes are never presented as decoded audio. */
export function webFixture() {
  const bytes = new Map<string, Buffer>();
  function media(mediaType: "image/webp" | "audio/mpeg" | "text/vtt", name: string) {
    const mediaId = randomUUID(), value = Buffer.from(`synthetic ${mediaType} bytes: ${name}`);
    bytes.set(mediaId, value);
    return { mediaId, mediaType, contentHash: sha(value), byteLength: value.length };
  }
  const keys = Array.from({ length: 12 }, (_, index) => `photo-${String(index + 1).padStart(2, "0")}`), requiredKeys = ["welcome", ...keys];
  const ancestors = (["research", "translation", "narration", "images", "captions"] as const).map(kind => ({ kind, packageId: kind, contractVersion: 2, artifactId: randomUUID(), artifactHash: digest({ syntheticAncestor: kind }) }));
  const inputBindings = ancestors.filter(item => item.kind !== "narration").map(item => ({ packageId: item.packageId, contractVersion: item.contractVersion, artifactId: item.artifactId, artifactHash: item.artifactHash, reviewId: randomUUID(), reviewKind: "automated_review" as const }));
  const photographs = keys.map((id, index) => ({ id, sourceHash: digest({ syntheticSource: id }), rightsHash: digest({ syntheticRights: id }), title: `Synthetic archival source ${index + 1}`, description: "Structural test metadata; no original provider evidence is implied.", creator: "Synthetic fixture", date: "[1900–1910]", rights: "Synthetic test fixture, not a rights determination.", sourceUrl: `https://www.loc.gov/item/fixture-${id}/`, rightsUrl: "https://www.loc.gov/collections/detroit-publishing-company/about-this-collection/rights-and-access/", alt: Object.fromEntries(locales.map(language => [language, `${language} structural photograph fixture ${index + 1}`])), full: { ...media("image/webp", id), width: 2200, height: 1600 }, thumbnail: { ...media("image/webp", `${id}-thumbnail`), width: 640, height: 465 } }));
  const labels = Object.fromEntries(locales.map(language => [language, Object.fromEntries(requiredKeys.map((key, index) => {
    const title = `${language} · exact source ${index}`, body = `${language} original text for ${key}. The supplied record is retained.`, transcript = `${title}. ${body}`;
    const recording = media("audio/mpeg", `${language}-${key}`), vtt = media("text/vtt", `${language}-${key}`), origin = ancestors.find(item => item.kind === "narration")!;
    return [key, { title, body, transcript, sourceTrackDigest: digest({ language, key }), scriptBytesHash: sha(transcript),
      audio: { ...recording, durationSeconds: 6, origin: { artifactId: origin.artifactId, artifactHash: origin.artifactHash, productionJobId: randomUUID(), contractVersion: 2, contractDigest: digest("synthetic narration contract"), inputBindingsDigest: digest("synthetic narration inputs"), approvalPlanDigest: digest("synthetic approval"), speechRunId: randomUUID(), speechReceiptHash: digest({ syntheticReceipt: language, key }), originalMediaId: recording.mediaId, originalMediaHash: recording.contentHash } },
      captions: { vtt, alignmentRunId: randomUUID(), receiptHash: digest({ syntheticAlignment: language, key }), timingsHash: digest({ syntheticTiming: language, key }), cuesHash: digest({ syntheticCues: language, key }), cues: [{ sourceStart: 0, sourceEnd: title.length + 1, index: 1, start: 0, end: 3, text: `${title}.`, lines: [`${title}.`] }, { sourceStart: title.length + 2, sourceEnd: transcript.length, index: 2, start: 3, end: 6, text: body, lines: [body.slice(0, 35), body.slice(35)] }] },
      easyRead: { title: `${language} · easy source ${index}`, paragraphs: [{ text: `${language} exact easy-read fixture for ${key}.`, conceptIds: [`concept-${key}`], sourceQuotes: [{ spanId: `source-${key}`, quote: `Original registered quotation for ${key}.` }] }] } }];
  }))]));
  const source = webSourceSchema.parse({ schemaVersion: "guild.exhibition-sources.v1", museum: "Synthetic exhibition fixture", provenance: { mode: "sample", label: "Synthetic source/renderer fixture. Structural media bytes are not playable recordings or commissioned output." }, ancestors, inputBindings,
    reviews: inputBindings.map(item => ({ ...item, recordHash: digest(item), verificationId: randomUUID(), verificationHash: digest({ syntheticReport: item }) })), captionSourceDigest: digest("synthetic caption sources"), captionProductionJobId: randomUUID(), captionVerification: { jobId: randomUUID(), outputHash: digest("synthetic caption checks") }, requiredKeys, photographs, labels,
    languageReviews: Object.fromEntries(locales.map(language => [language, { fluentHumanReviewed: false, disclosure: "Synthetic text fixture. No fluent-human review, acceptance or payment is claimed." }])) });
  const groups: [WebDesign["chapters"][number]["family"], string[]][] = [["cover", ["welcome"]], ["full_bleed", keys.slice(0, 1)], ["split", keys.slice(1, 2)], ["collection_grid", keys.slice(2, 5)], ["comparison", keys.slice(5, 7)], ["audio", keys.slice(7, 8)], ["timeline", keys.slice(8)], ["credits", []]];
  const design: WebDesign = { schemaVersion: "guild.exhibition-design.v1", palette: { paper: "#F8F3E7", ink: "#243B31", mutedInk: "#59665A", accent: "#CCB37C", accentInk: "#253B30", dark: "#1C332B", darkInk: "#FAF6E8" }, typography: { heading: "editorial_serif", body: "humanist_sans", bodySize: 17, lineHeight: 1.75, measure: "balanced" }, chapters: groups.map(([family, labelKeys], index) => ({ family, labelKeys, sourceImageId: family === "cover" ? keys[0]! : null, crop: "full_frame", imageSide: "leading", treatment: index === 1 || index === 4 ? "dark" : index === 5 ? "accent" : "paper" })), designNotes: ["Synthetic design fixture for renderer and integrity tests; not observed provider output."] };
  return { source, design, bytes };
}
export function replaceFixtureLabel(source: WebSources, language: Locale, key: string, values: Partial<WebSources["labels"][Locale][string]>) {
  Object.assign(source.labels[language][key]!, values);
}
