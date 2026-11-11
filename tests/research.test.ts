import test from "node:test";
import assert from "node:assert/strict";
import type { SourceAsset } from "../src/contracts/guild";
import { checkResearch, materializeResearch, researchAcceptancePack, researchSourceSpans, type ResearchDraft } from "../src/domain/research";
import { createSampleCommission, collectionNotes } from "../src/domain/fixture";
import { verifyArtifact } from "../src/domain/verification";
import { digest } from "../src/domain/primitives";

const source: SourceAsset = { id: "fixture-photo", title: "A harbour photograph", description: "A catalogue fixture for testing source integrity.", creator: "Unknown", date: "1900", rights: "Test fixture only", rightsUrl: "https://www.loc.gov/", sourceUrl: "https://www.loc.gov/item/fixture/", imagePath: "/fixture.jpg", thumbnailPath: "/fixture.jpg", contentHash: digest("fixture image"), alt: "Test fixture", provenance: { mode: "sample", label: "Unit fixture", sourceId: null, observedAt: null, sandbox: false } };
const notes = [{ id: "note-purpose", text: "This museum is fictional." }];
const invitation = Array.from({ length: 9 }, () => "Look slowly and consider what the record leaves unknown.").join(" ");
function fixture() {
  const spans = researchSourceSpans([source], notes), pack = researchAcceptancePack([source], notes);
  const draft: ResearchDraft = { labels: [
    { id: "welcome", title: "An invitation", segments: [{ kind: "fictional_context", text: "This museum is fictional.", citations: [{ spanId: "note-purpose:text", quote: notes[0]!.text }] }, { kind: "invitation", text: invitation, citations: [] }] },
    { id: source.id, title: "Read the record", segments: [{ kind: "fact", text: "The archive dates this photograph to 1900.", citations: [{ spanId: `${source.id}:date`, quote: "1900" }] }, { kind: "invitation", text: invitation, citations: [] }] },
  ], limitations: ["Synthetic verifier fixture; no real provider output or human review."] };
  const content = materializeResearch(draft, spans);
  return { content, draft, spans, pack };
}

test("source-grounded checks preserve an exact corpus without claiming semantic or human review", () => {
  const f = fixture(), checks = checkResearch(f.content, [source], notes, f.pack.digest);
  assert.ok(Object.values(checks).every(check => check.passed));
  assert.match(checks.grounding!.evidence, /Semantic support.*curator review/);
  assert.equal(f.pack.criteria.find(check => check.id === "meaning")!.status, "pending");
});
test("an extra, duplicated or missing label fails exact coverage", () => {
  for (const change of [(labels: ResearchDraft["labels"]) => labels.push(labels[0]!), (labels: ResearchDraft["labels"]) => labels.pop(), (labels: ResearchDraft["labels"]) => { labels[1]!.id = "injected-extra"; }]) {
    const f = fixture(); change(f.draft.labels);
    assert.equal(checkResearch(materializeResearch(f.draft, f.spans), [source], notes, f.pack.digest).coverage!.passed, false);
  }
});
test("invented quotation, missing factual citation and inferred exact year fail grounding", () => {
  for (const change of [
    (draft: ResearchDraft) => { draft.labels[1]!.segments[0]!.citations[0]!.quote = "1901"; },
    (draft: ResearchDraft) => { draft.labels[1]!.segments[0]!.citations = []; },
    (draft: ResearchDraft) => { draft.labels[1]!.segments[0]!.text = "The archive dates this photograph to 1901."; },
    (draft: ResearchDraft) => { draft.labels[1]!.segments[0]!.citations[0]!.spanId = "other-tenant:date"; },
  ]) {
    const f = fixture(); change(f.draft);
    assert.equal(checkResearch(materializeResearch(f.draft, f.spans), [source], notes, f.pack.digest).grounding!.passed, false);
  }
});
test("rewritten source text cannot preserve an approved source-bound contract", () => {
  const f = fixture(), changed = { ...source, date: "1901" };
  assert.notEqual(researchAcceptancePack([changed], notes).digest, f.pack.digest);
  assert.equal(checkResearch(f.content, [changed], notes, f.pack.digest).source_binding!.passed, false);
  const forged = structuredClone(f.content); (forged.sourceSpans as { text: string }[])[0]!.text = "Forged source";
  assert.equal(checkResearch(forged, [source], notes, f.pack.digest).source_binding!.passed, false);
});
test("body or citation-identity substitution cannot borrow a valid source-span report", () => {
  const f = fixture(), labels = f.content.labels as { body: string; sourceIds: string[] }[];
  labels[1]!.body += " A new unsupported claim.";
  const changed = checkResearch(f.content, [source], notes, f.pack.digest);
  assert.equal(changed.grounding!.passed, false); assert.equal(changed.length!.passed, false);
  const g = fixture(); (g.content.labels as { sourceIds: string[] }[])[1]!.sourceIds = ["note-purpose"];
  const moved = checkResearch(g.content, [source], notes, g.pack.digest);
  assert.equal(moved.sources!.passed, false); assert.equal(moved.grounding!.passed, false);
});
test("version two verification remains artifact-bound and leaves the curator criterion open", () => {
  const c = createSampleCommission("fixture-tenant", [source]), pkg = c.packages[0]!, artifact = c.artifacts[0]!;
  pkg.acceptancePack = researchAcceptancePack(c.sourceAssets, collectionNotes);
  const f = fixture(), draft = f.draft;
  draft.labels[0]!.segments[0] = { kind: "fictional_context", text: "Harbor Street Maritime Museum is a fictional volunteer-run museum.", citations: [{ spanId: "note-purpose:text", quote: "Harbor Street Maritime Museum is a fictional volunteer-run museum" }] };
  artifact.content = materializeResearch(draft, researchSourceSpans(c.sourceAssets, collectionNotes)); artifact.contentHash = digest(artifact.content);
  const report = verifyArtifact(c, pkg, artifact);
  assert.ok(report.criteria.filter(check => check.kind === "deterministic").every(check => check.status === "passed"));
  assert.equal(report.criteria.find(check => check.id === "meaning")!.status, "review");
  artifact.contentHash = digest("different artifact");
  assert.ok(verifyArtifact(c, pkg, artifact).criteria.filter(check => check.kind === "deterministic").every(check => check.status === "failed"));
});
