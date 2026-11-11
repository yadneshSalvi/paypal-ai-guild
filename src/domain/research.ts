import { z } from "zod";
import type { AcceptancePack, SourceAsset } from "@/contracts/guild";
import { digest } from "./primitives";

export type CollectionNote = { id: string; text: string };
const citationSchema = z.object({ spanId: z.string().min(1).max(200), quote: z.string().min(1).max(1600) }).strict();
const segmentSchema = z.object({
  kind: z.enum(["fact", "fictional_context", "invitation", "uncertainty"]),
  text: z.string().min(1).max(1800),
  citations: z.array(citationSchema).max(8),
}).strict();
const draftLabelSchema = z.object({ id: z.string().min(1).max(160), title: z.string().min(1).max(180), segments: z.array(segmentSchema).min(1).max(12) }).strict();
export const researchDraftSchema = z.object({ labels: z.array(draftLabelSchema).min(1).max(31), limitations: z.array(z.string().max(1200)).max(16) }).strict();
export type ResearchDraft = z.infer<typeof researchDraftSchema>;

const spanSchema = z.object({
  id: z.string(), sourceId: z.string(), field: z.string(), text: z.string(),
  textHash: z.string().length(64), sourceUrl: z.string().nullable(),
}).strict();
export type ResearchSourceSpan = z.infer<typeof spanSchema>;
const artifactSchema = z.object({
  schemaVersion: z.literal("guild.research.v2"), inputDigest: z.string().length(64),
  sourceSpans: z.array(spanSchema).max(200),
  labels: z.array(draftLabelSchema.extend({ body: z.string(), sourceIds: z.array(z.string()) })).max(31),
  limitations: z.array(z.string()),
}).passthrough();

/** The text is a snapshot of supplied catalogue metadata, never a model's substitute for it. */
export function researchSourceSpans(assets: SourceAsset[], notes: CollectionNote[]): ResearchSourceSpan[] {
  const spans: ResearchSourceSpan[] = notes.map(note => ({ id: `${note.id}:text`, sourceId: note.id, field: "collection note", text: note.text, textHash: digest(note.text), sourceUrl: null }));
  for (const source of assets) for (const field of ["title", "description", "creator", "date", "rights"] as const) {
    const text = source[field].trim();
    if (text) spans.push({ id: `${source.id}:${field}`, sourceId: source.id, field, text, textHash: digest(text), sourceUrl: source.sourceUrl });
  }
  return spans;
}

export function researchAcceptancePack(assets: SourceAsset[], notes: CollectionNote[]): AcceptancePack {
  const criteria: AcceptancePack["criteria"] = [
    { id: "sources", label: "Labels cite the supplied collection sources", description: "Each photograph label references its own permitted source; every cited source is in this collection.", blocking: true, kind: "deterministic", status: "pending", evidence: null },
    { id: "coverage", label: "One welcome and one label for every photograph", description: "Exact unique label keys; no omitted, duplicated or extra collection items.", blocking: true, kind: "deterministic", status: "pending", evidence: null },
    { id: "length", label: "Every label stays within 80–120 words", description: "The title is separate. Body words are counted using whitespace separation.", blocking: true, kind: "deterministic", status: "pending", evidence: null },
    { id: "source_binding", label: "The agreed source text is preserved", description: "The source-span manifest must match the metadata frozen into this contract.", blocking: true, kind: "deterministic", status: "pending", evidence: null },
    { id: "grounding", label: "Factual passages include exact source quotes", description: "Declared facts and fictional context cite verbatim permitted spans. This checks citation integrity, not whether the quote proves the claim.", blocking: true, kind: "deterministic", status: "pending", evidence: null },
    { id: "meaning", label: "Curator checks meaning and every factual claim", description: "Review whether quotations support each claim, including names and dates, and whether passages marked as invitations or uncertainty conceal unsupported assertions.", blocking: true, kind: "human", status: "pending", evidence: null },
  ];
  return { id: "pack-research", version: "2.0.0", title: "Source-grounded research acceptance contract", correctionAllowance: 1,
    digest: digest({ kind: "research", version: "2.0.0", inputDigest: digest(researchSourceSpans(assets, notes)), criteria, correctionAllowance: 1 }), criteria };
}

export function materializeResearch(draft: ResearchDraft, spans: ResearchSourceSpan[]): Record<string, unknown> {
  const byId = new Map(spans.map(span => [span.id, span]));
  const labels = draft.labels.map(label => ({ ...label, body: label.segments.map(segment => segment.text.trim()).join(" "),
    sourceIds: [...new Set(label.segments.flatMap(segment => segment.citations.flatMap(citation => {
      const span = byId.get(citation.spanId); return span ? [span.sourceId] : [];
    })))],
  }));
  return { schemaVersion: "guild.research.v2", inputDigest: digest(spans), sourceSpans: spans, labels, limitations: draft.limitations };
}

export interface ResearchCheck { passed: boolean; evidence: string }
export function checkResearch(content: Record<string, unknown>, assets: SourceAsset[], notes: CollectionNote[], packDigest: string): Record<string, ResearchCheck> {
  const parsed = artifactSchema.safeParse(content);
  const failure = { passed: false, evidence: "The submission does not match the agreed source-grounded research format." };
  if (!parsed.success) return Object.fromEntries(["sources", "coverage", "length", "source_binding", "grounding"].map(key => [key, failure]));
  const artifact = parsed.data, expected = researchSourceSpans(assets, notes), expectedPack = researchAcceptancePack(assets, notes);
  const byId = new Map(expected.map(span => [span.id, span])), permitted = new Set(expected.map(span => span.sourceId));
  const required = ["welcome", ...assets.map(source => source.id)], actual = artifact.labels.map(label => label.id);
  const counts = artifact.labels.map(label => label.body.trim().split(/\s+/u).filter(Boolean).length);
  const sourceBinding = packDigest === expectedPack.digest && artifact.inputDigest === digest(expected) && digest(artifact.sourceSpans) === digest(expected);
  const bodyBinding = artifact.labels.every(label => label.body === label.segments.map(segment => segment.text.trim()).join(" "));
  const citations = artifact.labels.every(label => label.sourceIds.length > 0 && label.sourceIds.every(id => permitted.has(id)) && (label.id === "welcome" || label.sourceIds.includes(label.id)));
  let factualSegments = 0, quotedSpans = 0;
  const grounded = artifact.labels.every(label => {
    if (!label.segments.some(segment => segment.kind === "fact" || segment.kind === "fictional_context")) return false;
    const derivedSources = [...new Set(label.segments.flatMap(segment => segment.citations.flatMap(citation => byId.has(citation.spanId) ? [byId.get(citation.spanId)!.sourceId] : [])))];
    if (digest(derivedSources) !== digest(label.sourceIds)) return false;
    return label.segments.every(segment => {
      const factual = segment.kind === "fact" || segment.kind === "fictional_context";
      if (factual) { factualSegments++; if (!segment.citations.length) return false; }
      const valid = segment.citations.every(citation => {
        const span = byId.get(citation.spanId);
        if (!span || citation.quote.length < Math.min(8, span.text.length) || !span.text.includes(citation.quote)) return false;
        quotedSpans++; return true;
      });
      if (!valid) return false;
      // An exact number cannot be inferred from a broad date range or unrelated source field.
      const numerals = factual ? segment.text.match(/\b\d+\b/gu) ?? [] : [];
      const quotedNumbers = new Set(segment.citations.flatMap(citation => citation.quote.match(/\b\d+\b/gu) ?? []));
      return numerals.every(number => quotedNumbers.has(number));
    });
  });
  return {
    sources: { passed: citations, evidence: `${artifact.labels.length} labels checked for permitted source references and their own photograph source.` },
    coverage: { passed: actual.length === required.length && new Set(actual).size === required.length && required.every(id => actual.includes(id)), evidence: `${new Set(actual.filter(id => required.includes(id))).size} of ${required.length} exact label keys; ${actual.length} submissions.` },
    length: { passed: bodyBinding && counts.length === required.length && counts.every(count => count >= 80 && count <= 120), evidence: `Body word counts: ${counts.join(", ")}. Agreed range: 80–120; titles excluded.` },
    source_binding: { passed: sourceBinding, evidence: sourceBinding ? `${expected.length} source spans match the metadata frozen into this contract.` : "The submission or current source text differs from the contract's source manifest." },
    grounding: { passed: bodyBinding && grounded, evidence: `${factualSegments} declared factual/context passages and ${quotedSpans} exact quote references checked. Semantic support and undisclosed claims still require curator review.` },
  };
}
