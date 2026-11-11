import { Info, Link2 } from "lucide-react";
import type { ArtifactManifest } from "@/contracts/guild";
import type { ResearchDraft, ResearchSourceSpan } from "@/domain/research";
import "./research-artifact.css";

type Label = ResearchDraft["labels"][number] & { body: string; sourceIds: string[] };
function archiveUrl(value: string | null): string | null {
  if (!value) return null;
  try { const url = new URL(value); return url.protocol === "https:" && ["loc.gov", "www.loc.gov"].includes(url.hostname) ? url.href : null; }
  catch { return null; }
}

export function ResearchArtifact({ artifact }: { artifact: ArtifactManifest }) {
  const content = artifact.content;
  const labels = content.labels as Label[];
  const spans = new Map((Array.isArray(content.sourceSpans) ? content.sourceSpans as ResearchSourceSpan[] : []).map(span => [span.id, span]));
  return <div className="research-artifact">
    <p className="eyebrow">COLLECTION LABELS / {labels.length} PIECES</p>
    {labels.map((label, index) => <article key={`${label.id}-${index}`}>
      <span className="label-index">{String(index + 1).padStart(2, "0")} / {label.id}</span>
      <h3>{label.title}</h3><p>{label.body}</p>
      <div className="label-sources"><Link2 size={12}/>{label.sourceIds.join(" · ")}</div>
      {Array.isArray(label.segments) && <details className="research-evidence">
        <summary>Read the source evidence <span>{label.segments.filter(segment => segment.citations.length).length} cited passages</span></summary>
        <p className="research-evidence-note">Check whether each quotation supports the passage. A matching quote alone does not prove the interpretation.</p>
        <ol>{label.segments.map((segment, segmentIndex) => <li key={`${label.id}-passage-${segmentIndex}`}>
          <span className="research-passage-kind">{segment.kind.replaceAll("_", " ")}</span>
          <p>{segment.text}</p>
          {segment.citations.length ? segment.citations.map((citation, citationIndex) => {
            const source = spans.get(citation.spanId), url = archiveUrl(source?.sourceUrl ?? null);
            return <figure key={`${citation.spanId}-${citationIndex}`}>
              <blockquote>{citation.quote}</blockquote>
              <figcaption>{source ? `${source.sourceId} · ${source.field}` : "Unknown source reference"}{url && <a href={url} target="_blank" rel="noreferrer">Open archive record ↗</a>}</figcaption>
            </figure>;
          }) : <small>No factual evidence cited. Review that this is an invitation or a statement of uncertainty.</small>}
        </li>)}</ol>
      </details>}
    </article>)}
    {Array.isArray(content.limitations) && <section className="research-provenance"><div className="artifact-disclosure"><Info size={16}/><p>English labels drawn from the supplied archive metadata and collection notes. The photographs were not visually inspected by this research service. Curator review remains open; translation, media, exhibition delivery and payment belong to their separate records.</p></div><details><summary>Read the provider’s original notes <span>{content.limitations.length} notes retained</span></summary><ul>{[...new Set((content.limitations as unknown[]).filter((note):note is string=>typeof note==="string"))].map((note,index)=><li key={index}>{note}</li>)}</ul></details></section>}
  </div>;
}
