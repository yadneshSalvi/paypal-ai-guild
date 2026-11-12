"use client";
import { useEffect, useState } from "react";
import { Download, FileCheck2, LoaderCircle, TriangleAlert } from "lucide-react";
import type { ArtifactManifest } from "@/contracts/guild";
import type { WebArtifact, WebAuditReceipt } from "@/domain/web-audits";
import { WebAuditCases } from "./web-audit-cases";
import { displayedWebOutcome } from "./web-presentation";
import "./web-studio.css";

interface WebReport {
  schemaVersion: string; artifactId: string; artifactHash: string; sourceDigest: string; sourceVerified: boolean; producingApprovalVerified: boolean; producerPipelineVerified: boolean;
  files: { path: string; passed: boolean; evidence: string; contentHash: string; byteLength: number; mediaId: string | null }[];
  cases: WebAuditReceipt[]; evidence: string[]; newModelRequests: number; newRecognitionRequests: number;
}
interface EvidenceIndex { artifact: { id: string; contentHash: string }; independentReports: { id: string; state: string; output?: { report?: WebReport }; updated_at: string }[]; exhibition?: { producingApproval: { verified: boolean; message: string }; originalJobs: { id: string; state: string; type: string; evidenceUrl: string }[] } }
export function WebEvidence({ artifact, reportDigest }: { artifact: ArtifactManifest; reportDigest?: string }) {
  const [data, setData] = useState<EvidenceIndex | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState<string | null>(null), [refresh, setRefresh] = useState(0), [chosen, setChosen] = useState<string | null>(null);
  const content = artifact.content as unknown as WebArtifact;
  useEffect(() => {
    const abort = new AbortController(); setLoading(true); setData(null); setError(null);
    fetch(`/api/artifacts/${artifact.id}/evidence`, { cache: "no-store", signal: abort.signal }).then(async response => {
      const body = await response.json(); if (!response.ok) throw new Error(body.message ?? "The retained exhibition report could not be read.");
      if (body.artifact?.id !== artifact.id || body.artifact.contentHash !== artifact.contentHash) throw new Error("The saved report belongs to a different exhibition artifact.");
      if (!abort.signal.aborted) setData(body);
    }).catch(reason => { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : "The saved evidence could not be read."); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [artifact.id, artifact.contentHash, reportDigest, refresh]);
  const reports = data?.independentReports.filter(item => item.state === "completed" && item.output?.report?.schemaVersion === "guild.web-verification.v1" && item.output.report.artifactHash === artifact.contentHash && item.output.report.sourceDigest === content.sourceDigest) ?? [];
  const selected = reports.find(item => item.id === chosen) ?? reports.at(-1), report = selected?.output?.report;
  return <section className="web-evidence" aria-label="Independent exhibition evidence"><header><FileCheck2 size={29}/><div><p className="eyebrow">THE READING COPY / INDEPENDENTLY CHECKED</p><h3>Evidence you can open.</h3><p>Original files, all six languages and three real viewports. The provider’s earlier self-checks remain separate.</p></div><a className="text-button" href={`/api/artifacts/${artifact.id}/evidence`}><Download size={15}/> Save the complete index</a></header>
    {loading ? <p role="status"><LoaderCircle size={16} className="spin"/> Reading saved original evidence…</p> : error ? <div role="alert"><p className="form-error">{error}</p><button className="button" onClick={() => setRefresh(value => value + 1)}>Read saved evidence again</button></div> : <>
      {data?.exhibition && <p className={data.exhibition.producingApproval.verified ? "web-review-note" : "form-error"}>{data.exhibition.producingApproval.message}</p>}
      {reports.length > 1 && <label className="web-report-picker">Retained independent report <select value={selected?.id ?? ""} onChange={event => setChosen(event.target.value)}>{reports.map((item, index) => <option key={item.id} value={item.id}>Report {index + 1} · {new Date(item.updated_at).toLocaleString()}</option>)}</select></label>}
      {report && selected ? <><div className="web-review-metrics"><div><strong>{report.files.filter(item => item.passed).length}<small> / {content.candidates[content.selectedOrdinal - 1]?.bundle.files.length ?? report.files.length}</small></strong><span>Original file byte checks</span></div><div><strong>{report.cases.filter(item => displayedWebOutcome(item.result).passed).length}<small> / 18</small></strong><span>Cases meet every measured gate</span></div><div><strong>{report.newModelRequests + report.newRecognitionRequests}</strong><span>New model or recognition requests in this report</span></div></div>
        {(!report.sourceVerified || !report.producingApprovalVerified || !report.producerPipelineVerified) && <p className="form-error"><TriangleAlert size={17}/> The exact source, original approval or producer pipeline did not pass. Retain that failure; no successful chain is inferred.</p>}{report.evidence.map((item, index) => <p className="web-review-note" key={index}>{item}</p>)}
        <WebAuditCases receipts={report.cases} jobId={selected.id} artifactId={artifact.id} ordinal={content.selectedOrdinal} mode="independent"/>
        <details className="web-review-details"><summary>Every original portable-file measurement</summary><div className="web-report-scroll" role="region" tabIndex={0} aria-label="Complete original file measurements"><table><thead><tr><th>Original file</th><th>Result</th><th>Original bytes</th><th>Evidence</th></tr></thead><tbody>{content.candidates[content.selectedOrdinal - 1]?.bundle.files.map(file => { const item = report.files.find(check => check.path === file.path); return <tr key={file.path}><td><strong>{file.path}</strong><code>{file.contentHash}</code></td><td>{item?.passed ? "Passed" : item ? "Failed" : "Not measured"}</td><td>{file.byteLength.toLocaleString()}</td><td>{item?.evidence ?? "No independent result is retained; this file remains in the required denominator."}</td></tr>; })}</tbody></table></div></details>
      </> : <div className="web-case-missing"><FileCheck2 size={24}/><div><strong>No complete independent report is saved.</strong><p>The submitted design and producer measurements do not establish an independent pass. Pending, partial and failed original jobs remain below.</p></div></div>}
      {!!data?.exhibition?.originalJobs.length && <details className="web-review-details"><summary>All producing and independent measurement jobs</summary>{data.exhibition.originalJobs.map(job => <article className="web-original-job" key={job.id}><strong>{job.type === "produce_package" ? "Original production" : "Independent measurements"}</strong><span>{job.state.replaceAll("_", " ")}</span><a href={job.evidenceUrl}>Original attempts, known-ID reads and partial reports <Download size={14}/></a></article>)}</details>}
      <p className="web-review-note">Human screen-reader, keyboard, visual, content-order, fluent-language and listening reviews remain separate. Reading these reports creates no acceptance, publication or payment.</p>
    </>}
  </section>;
}
