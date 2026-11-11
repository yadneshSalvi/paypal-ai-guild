import test from "node:test";
import assert from "node:assert/strict";
import { checkEasyRead, type CaptionConcept, type EasyReadFile } from "@/domain/captions";
import { digest } from "@/domain/primitives";

const concepts: CaptionConcept[] = [
  { id: "fact-1", key: "welcome", kind: "fact", text: "The catalogue gives the title.", textHash: digest("The catalogue gives the title."), citations: [{ spanId: "source:title", quote: "A harbour view", spanHash: digest("A harbour view") }] },
  { id: "uncertain-1", key: "welcome", kind: "uncertainty", text: "The people are not named.", textHash: digest("The people are not named."), citations: [] },
];
const sources = { requiredKeys: ["welcome"], concepts };
const file = (): Pick<EasyReadFile, "locale" | "labels"> => ({ locale: "en", labels: { welcome: { title: "Look at the harbour", paragraphs: [{ text: "The record calls this A harbour view. It does not name the people.", conceptIds: ["fact-1", "uncertain-1"], sourceQuotes: [{ spanId: "source:title", quote: "A harbour view" }] }] } } });

test("easy-read presence checks preserve uncertainty and exact source links without claiming semantic review", () => {
  assert.deepEqual(checkEasyRead(file(), sources), { passed: true, failures: [], semanticReviewRequired: true });
  for (const change of [
    (value: ReturnType<typeof file>) => { value.labels.welcome!.paragraphs[0]!.conceptIds.pop(); },
    (value: ReturnType<typeof file>) => { value.labels.welcome!.paragraphs[0]!.conceptIds.push("foreign-concept"); },
    (value: ReturnType<typeof file>) => { value.labels.welcome!.paragraphs[0]!.sourceQuotes[0]!.quote = "A harbor view"; },
    (value: ReturnType<typeof file>) => { value.labels.welcome!.paragraphs[0]!.sourceQuotes[0]!.spanId = "foreign:source"; },
    (value: ReturnType<typeof file>) => { value.labels.extra = structuredClone(value.labels.welcome!); },
    (value: ReturnType<typeof file>) => { value.labels.welcome!.paragraphs[0]!.conceptIds.push("fact-1"); },
  ]) { const value = file(); change(value); const result = checkEasyRead(value, sources); assert.equal(result.passed, false); assert.equal(result.semanticReviewRequired, true); }
});

test("paragraph bounds count visible graphemes and reject markup, controls and placeholders", () => {
  for (const text of ["<script>alert(1)</script>", "{{translate}}", "TODO", "Hello\u202eunknown", "x".repeat(361)]) {
    const value = file(); value.labels.welcome!.paragraphs[0]!.text = text; assert.equal(checkEasyRead(value, sources).passed, false, text.slice(0, 20));
  }
  const value = file(); value.labels.welcome!.paragraphs[0]!.text = "e\u0301".repeat(360);
  assert.equal(checkEasyRead(value, sources).passed, true, "360 graphemes remain within the explicit presence contract; meaning still needs review");
  value.labels.welcome!.title = "<b>Title</b>"; assert.equal(checkEasyRead(value, sources).passed, false);
});
