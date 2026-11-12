"use client";
import { useEffect, useId, useRef, useState } from "react";
import { ArrowUpRight, Check, Download, FileSearch, LoaderCircle, TriangleAlert } from "lucide-react";
import { locales, localeNames, type Locale } from "@/contracts/guild";
import type { WebAuditReceipt } from "@/domain/web-audits";
import { displayedWebOutcome, findingElement, readingCopyUrl, webScoreLabel, webWidths } from "./web-presentation";
import "./web-studio.css";

interface NativeNode { target?: unknown; html?: string; failureSummary?: string; any?: unknown[]; all?: unknown[]; none?: unknown[] }
interface NativeFinding { id?: string; impact?: string | null; description?: string; help?: string; helpUrl?: string; tags?: string[]; nodes?: NativeNode[] }
interface NativeReport {
  schemaVersion: string; caseId: string; jobId: string; locale: Locale; sourceDigest: string; designDigest: string; bundleDigest: string;
  states: { state: string; violations: NativeFinding[]; incomplete: NativeFinding[] }[];
  lighthouse: { lighthouseVersion?: string; audits?: Record<string, { title?: string; description?: string; score?: number | null; scoreDisplayMode?: string; displayValue?: string; explanation?: string; details?: unknown }> } | null;
}
const safeHttps = (url?: string) => { try { const value = new URL(url ?? ""); return value.protocol === "https:" && !value.username && !value.password ? value.href : undefined; } catch { return undefined; } };

export function NativeFindings({ receipt, jobId, artifactId, ordinal }: { receipt: WebAuditReceipt; jobId: string; artifactId: string; ordinal: number }) {
  const [wanted, setWanted] = useState(false), [data, setData] = useState<NativeReport | null>(null), [error, setError] = useState<string | null>(null), [retry, setRetry] = useState(0);
  const loadingTarget = useRef<HTMLParagraphElement>(null), resultTarget = useRef<HTMLHeadingElement>(null), introTarget = useRef<HTMLParagraphElement>(null), errorTarget = useRef<HTMLDivElement>(null);
  const focusRequested = useRef(false);
  const { id, result } = receipt;
  useEffect(() => {
    if (!wanted || !focusRequested.current) return;
    const target = data ? resultTarget.current ?? introTarget.current : error ? errorTarget.current : loadingTarget.current;
    if (target) target.focus();
    if (data || error) focusRequested.current = false;
  }, [wanted, data, error]);
  useEffect(() => {
    if (!wanted) return;
    const abort = new AbortController(); setData(null); setError(null);
    fetch(`/api/web-jobs/${jobId}/audit?caseId=${id}&view=findings`, { cache: "no-store", signal: abort.signal }).then(async response => {
      const body = await response.json();
      if (abort.signal.aborted) return;
      if (!response.ok) throw new Error(body.message ?? "The original native findings could not be read.");
      if (body.schemaVersion !== "guild.web-native-findings.v1" || body.caseId !== id || body.jobId !== jobId || body.locale !== result.locale || body.sourceDigest !== result.sourceDigest || body.designDigest !== result.designDigest || body.bundleDigest !== result.bundleDigest) throw new Error("This response does not match the exact original browser case.");
      focusRequested.current = focusRequested.current && (document.activeElement === loadingTarget.current || document.activeElement === document.body);
      setData(body);
    }).catch(reason => { if (!abort.signal.aborted) { focusRequested.current = focusRequested.current && (document.activeElement === loadingTarget.current || document.activeElement === document.body); setError(reason instanceof Error ? reason.message : "The original findings could not be read."); } });
    return () => abort.abort();
  }, [wanted, retry, jobId, id, result.sourceDigest, result.designDigest, result.bundleDigest]);
  if (!wanted) return <button className="button compact" onClick={() => { focusRequested.current = true; setWanted(true); }}><FileSearch size={15}/> Read every original native finding</button>;
  if (error) return <div role="alert" ref={errorTarget} tabIndex={-1}><p className="form-error">{error}</p><button className="button compact" onClick={() => { focusRequested.current = true; setRetry(value => value + 1); }}>Read saved findings again</button></div>;
  if (!data) return <p role="status" ref={loadingTarget} tabIndex={-1}><LoaderCircle size={15} className="spin"/> Reading the saved native JSON…</p>;
  return <div className="web-native-findings"><p className="web-review-note" ref={introTarget} tabIndex={-1}>These are the original reports. Opening a reading copy performs no audit. Its current window may differ from the measured {result.viewport.width} × {result.viewport.height} viewport.</p>
    {data.states.map((state, index) => <section className="web-native-state" key={`${state.state}:${index}`}><h5 ref={index === 0 ? resultTarget : undefined} tabIndex={-1}>{state.state.replaceAll("_", " ")} state</h5><p>{state.violations.length} violations · {state.incomplete.length} incomplete findings</p>{(["violations", "incomplete"] as const).map(kind => state[kind].map((finding, findingIndex) => <details className="web-native-finding" key={`${kind}:${finding.id}:${findingIndex}`}><summary><span>{kind === "incomplete" ? "Manual review" : finding.impact ?? "Unspecified impact"}</span><strong>{finding.help ?? finding.id ?? "Original finding"}</strong></summary><p>{finding.description}</p>{safeHttps(finding.helpUrl) && <a href={safeHttps(finding.helpUrl)} target="_blank" rel="noreferrer">Rule documentation <ArrowUpRight size={13}/></a>}{finding.nodes?.map((node, nodeIndex) => <article key={nodeIndex}><strong>Element {nodeIndex + 1}</strong><pre>{JSON.stringify(node.target, null, 2)}</pre>{node.failureSummary && <p>{node.failureSummary}</p>}<a className="text-button" href={readingCopyUrl(artifactId, ordinal, result.locale, { element: findingElement(node.target), state: state.state })} target="_blank" rel="noreferrer">{findingElement(node.target) ? "Inspect this original element" : "Open the original measured state"}<ArrowUpRight size={14}/></a>{node.html && <details><summary>Original element markup, shown as text</summary><pre>{node.html}</pre></details>}<details><summary>All original rule observations</summary><pre>{JSON.stringify({ any: node.any, all: node.all, none: node.none }, null, 2)}</pre></details></article>)}</details>))}</section>)}
    <details className="web-review-details"><summary>Every original Lighthouse audit</summary>{data.lighthouse ? Object.entries(data.lighthouse.audits ?? {}).map(([key, value]) => <details className="web-native-finding" key={key}><summary><strong>{value.title ?? key}</strong><span>{value.score == null ? value.scoreDisplayMode ?? "Unscored" : `${value.score}`}</span></summary><p>{value.description}</p>{value.displayValue && <p>{value.displayValue}</p>}{value.explanation && <p>{value.explanation}</p>}<pre>{JSON.stringify(value.details ?? null, null, 2)}</pre></details>) : <p>No Lighthouse result was retained. It cannot count as a passing measurement.</p>}</details>
  </div>;
}

export function WebAuditCases({ receipts, jobId, artifactId, ordinal, mode }: { receipts: WebAuditReceipt[]; jobId: string; artifactId: string; ordinal: number; mode: "producer" | "independent" }) {
  const [locale, setLocale] = useState<Locale>("en"), id = useId();
  const passed = receipts.filter(item => displayedWebOutcome(item.result).passed).length;
  return <section className="web-audit-cases" aria-label={`${mode === "producer" ? "Producer" : "Independent"} browser cases`}><header><div><p className="eyebrow">{mode === "producer" ? "THE PROVIDER’S OWN MEASUREMENTS" : "THE INDEPENDENT MEASUREMENTS"}</p><h4>{passed} of 18 browser cases meet all measured gates.</h4><p>{receipts.length} original reports retained. Missing, incomplete and failed cases stay in the denominator. Native incomplete findings remain for manual review.</p></div><a href={`/api/web-jobs/${jobId}/evidence`} className="text-button"><Download size={15}/> Every original operation</a></header>
    <div className="web-language-tabs" role="tablist" aria-label={`${mode} report language`}>{locales.map((item, index) => <button key={item} id={`${id}-${item}`} role="tab" aria-selected={locale === item} aria-controls={`${id}-panel`} tabIndex={locale === item ? 0 : -1} onClick={() => setLocale(item)} onKeyDown={event => { if (["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) { event.preventDefault(); const next = locales[event.key === "Home" ? 0 : event.key === "End" ? 5 : (index + (event.key === "ArrowRight" ? 1 : 5)) % 6]!; setLocale(next); document.getElementById(`${id}-${next}`)?.focus(); } }}>{localeNames[item]}</button>)}</div>
    <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${locale}`}>{webWidths.map(width => {
      const rows = receipts.filter(item => item.result.locale === locale && item.result.viewport.width === width);
      if (!rows.length) return <div className="web-case-missing" key={width}><TriangleAlert size={18}/><div><strong>{localeNames[locale]} · {width} pixels</strong><p>No complete original receipt is available for this required case. Inspect retained job operations for a pending, partial or failed attempt.</p></div></div>;
      return <div key={width}>{rows.length !== 1 && <p className="form-error">Multiple receipts exist for this case. No unique complete coverage is inferred.</p>}{rows.map(receipt => {
        const result = receipt.result, verdict = displayedWebOutcome(result), serious = result.axe.reduce((n, item) => n + item.seriousCritical, 0), incomplete = result.axe.reduce((n, item) => n + item.incomplete, 0);
        return <details className="web-case" key={receipt.id}><summary><span className={verdict.passed ? "web-verdict-pass" : "web-verdict-review"}>{verdict.passed ? <Check size={16}/> : <TriangleAlert size={16}/>}</span><strong>{localeNames[locale]} · {width} × {result.viewport.height}</strong><span>{webScoreLabel(result.lighthouse?.accessibilityScore)}</span><small>{verdict.passed ? "Measured gates pass" : verdict.complete ? "Needs correction" : "Incomplete evidence"}</small></summary><div className="web-case-body"><dl className="web-case-metrics"><div><dt>Serious / critical axe findings</dt><dd>{serious}</dd></div><div><dt>Incomplete axe findings</dt><dd>{incomplete}</dd></div><div><dt>Interaction observations</dt><dd>{result.interactions.filter(item => item.passed).length} / {result.interactions.length}</dd></div><div><dt>Native score fraction</dt><dd><code>{result.lighthouse?.accessibilityScore ?? "No score"}</code><small>Required ≥ 0.95, without rounding</small></dd></div></dl>
          {result.errors.map((error, index) => <p className="form-error" key={index}><strong>{error.code}</strong> · {error.message}</p>)}{result.lighthouse?.warnings.map((warning, index) => <p className="web-review-note" key={index}>{warning}</p>)}
          <div className="web-case-actions"><a className="text-button" href={`/api/web-jobs/${jobId}/audit?caseId=${receipt.id}`}><Download size={14}/> Original JSON, hashes &amp; files</a><a className="text-button" href={readingCopyUrl(artifactId, ordinal, locale)} target="_blank" rel="noreferrer">Read this original design <ArrowUpRight size={14}/></a></div>
          <details className="web-review-details"><summary>Every measured interaction and observation</summary>{result.interactions.map((item, index) => <article className="web-interaction" key={`${item.id}:${index}`}><h5 className={item.passed ? "web-verdict-pass" : "web-verdict-review"}>{item.passed ? <Check size={14}/> : <TriangleAlert size={14}/>} {item.id.replaceAll("_", " ")}</h5><p>{item.detail}</p><pre>{JSON.stringify(item.observed, null, 2)}</pre></article>)}</details>
          <NativeFindings receipt={receipt} jobId={jobId} artifactId={artifactId} ordinal={ordinal}/><p className="web-fingerprint">Case {receipt.id} · result SHA-256 {receipt.resultHash}</p>
        </div></details>;
      })}</div>;
    })}</div><p className="web-review-note">{mode === "producer" ? "Producer self-checks inform this bounded design pipeline. Separate independent checks are still required." : "Automated measurements do not establish human screen-reader, visual, fluent-language or listening review."}</p></section>;
}
