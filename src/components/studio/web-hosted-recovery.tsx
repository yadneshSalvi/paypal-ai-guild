"use client";
import { useEffect, useRef, useState } from "react";
import { Download, FileSearch, LoaderCircle } from "lucide-react";

interface OriginalAttempt {
  caseId: string; phase: string; originalDeadline: string; originalDispatchedAt: string;
  originalSessionId: string | null; originalCommandId: string | null; firstUnknownAt: string | null;
  evidenceRetained: boolean; observationSaved: boolean; errors: { code: string; at: string }[];
}
interface Case { id: string; case_key: string; state: string; failure_code: string | null; original_failure_code: string | null }
interface OriginalJobEvidence { schemaVersion: string; job: { id: string }; browserCases: Case[]; hostedAttempts: OriginalAttempt[] }

/** Deliberate evidence view. Fetching its index reads saved rows only; the
 * separate button can collect only that case's already-dispatched result. */
export function WebHostedRecovery({ jobId, updatedAt }: { jobId: string; updatedAt: string }) {
  const [wantedForJob, setWantedForJob] = useState<string | null>(null), [refresh, setRefresh] = useState(0), [data, setData] = useState<OriginalJobEvidence | null>(null);
  const wanted = wantedForJob === jobId;
  const [loading, setLoading] = useState(false), [busyCase, setBusyCase] = useState<string | null>(null), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const currentJob = useRef(jobId), recovery = useRef<AbortController | null>(null);
  const caseElements = useRef(new Map<string, HTMLElement>()), focusAfterRead = useRef<string | null>(null);
  currentJob.current = jobId;
  useEffect(() => {
    setWantedForJob(null); setData(null); setError(null); setNotice(null); setBusyCase(null); setLoading(false);
    return () => { recovery.current?.abort(); recovery.current = null; focusAfterRead.current = null; };
  }, [jobId]);
  useEffect(() => {
    if (!loading && data?.job.id === jobId && focusAfterRead.current) {
      caseElements.current.get(focusAfterRead.current)?.focus(); focusAfterRead.current = null;
    }
  }, [data, loading, jobId]);
  useEffect(() => {
    if (!wanted) return;
    const abort = new AbortController(); setLoading(true); setError(null);
    fetch(`/api/web-jobs/${jobId}/evidence?view=recovery`, { cache: "no-store", signal: abort.signal }).then(async response => {
      const body: OriginalJobEvidence & { message?: string } = await response.json();
      if (!response.ok) throw new Error(body.message ?? "The saved original attempts could not be read.");
      if (body.schemaVersion !== "guild.web-job-evidence.v1" || body.job?.id !== jobId || !Array.isArray(body.hostedAttempts) || !Array.isArray(body.browserCases)) throw new Error("This saved evidence belongs to a different original job.");
      if (!abort.signal.aborted) setData(body);
    }).catch(reason => { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : "The original evidence could not be read."); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [wanted, jobId, updatedAt, refresh]);
  async function readOriginal(caseId: string) {
    if (recovery.current !== null || busyCase !== null || data?.job.id !== jobId || !data.hostedAttempts.some(attempt => attempt.caseId === caseId)) return;
    const abort = new AbortController(); recovery.current = abort;
    const isCurrent = () => !abort.signal.aborted && recovery.current === abort && currentJob.current === jobId;
    setBusyCase(caseId); setError(null); setNotice(null);
    try {
      const response = await fetch(`/api/web-jobs/${jobId}/recover`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ caseId }), signal: abort.signal });
      const body = await response.json();
      if (!isCurrent()) return;
      if (!response.ok) throw new Error(body.message ?? "The original browser result remains held. Read its saved evidence for the current outcome.");
      if (body.version !== "guild.web-hosted-recovery.v1" || body.caseId !== caseId || body.jobId !== jobId || body.receipt?.id !== caseId || body.state !== "received") throw new Error("The recovered observation differs from this exact original case.");
      setNotice("The original report is saved. Its measured findings and any earlier failure remain available for review.");
      focusAfterRead.current = caseId;
      setRefresh(value => value + 1);
    } catch (reason) { if (isCurrent()) setError(reason instanceof Error ? reason.message : "The same original result could not be read completely."); }
    finally { if (isCurrent()) { recovery.current = null; setBusyCase(null); } }
  }
  return <details key={jobId} className="web-review-details" onToggle={event => { if (event.currentTarget.open) setWantedForJob(jobId); }}>
    <summary><FileSearch size={15}/> Read original browser attempts</summary>
    <p>Saved reports remain available after the work deadline. Reading an original result creates no new browser attempt, acceptance or payment.</p>
    {loading && <p role="status"><LoaderCircle size={15} className="spin"/> Reading the saved attempt register…</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {notice && <p className="web-review-note" role="status">{notice}</p>}
    {!loading && data?.job.id === jobId && (data.hostedAttempts.length ? data.hostedAttempts.map(attempt => {
      const original = data.browserCases.find(item => item.id === attempt.caseId), held = original && ["dispatching", "indeterminate"].includes(original.state);
      return <article className="web-original-job" key={attempt.caseId} tabIndex={-1} ref={element => { if (element) caseElements.current.set(attempt.caseId, element); else caseElements.current.delete(attempt.caseId); }} aria-busy={busyCase === attempt.caseId}>
        <strong>{original?.case_key ?? "Original browser case"}</strong><span>{original?.state === "received" ? "Original report saved" : "Original result held"}</span>
        <p>{held ? attempt.originalCommandId ? "The original browser command is known. Its saved result can be read without starting another attempt." : "An original intent is saved, but the browser command has no confirmed identity. Reading can investigate that original attempt while the outcome stays held." : "The original findings remain in the complete report and any earlier failure stays in its history."}</p>
        <div className="web-case-actions"><a href={`/api/web-jobs/${jobId}/audit?caseId=${attempt.caseId}`}><Download size={14}/> Original files and findings</a>{held && <button type="button" className="button compact" disabled={busyCase !== null} onClick={() => void readOriginal(attempt.caseId)}>{busyCase === attempt.caseId ? <><LoaderCircle size={14} className="spin"/> Reading the original result…</> : <>Read this original result <FileSearch size={14}/></>}</button>}</div>
        <details><summary>Exact original worker evidence</summary><dl className="web-fingerprints"><div><dt>Original work deadline</dt><dd>{attempt.originalDeadline}</dd></div><div><dt>Original dispatch intent</dt><dd>{attempt.originalDispatchedAt}</dd></div><div><dt>Original session</dt><dd>{attempt.originalSessionId ?? "Unconfirmed"}</dd></div><div><dt>Original browser command</dt><dd>{attempt.originalCommandId ?? "Unconfirmed"}</dd></div><div><dt>Last retained phase</dt><dd>{attempt.phase.replaceAll("_", " ")}</dd></div></dl>{attempt.errors.map((item, index) => <p key={`${item.at}:${index}`}><time dateTime={item.at}>{item.at}</time> · {item.code}</p>)}</details>
      </article>;
    }) : <p>No hosted browser attempt is recorded for this job. Its other original operations remain in the complete evidence index.</p>)}
    {wanted && <button className="text-button" type="button" disabled={loading || busyCase !== null} onClick={() => setRefresh(value => value + 1)}>Read the saved register again</button>}
  </details>;
}
