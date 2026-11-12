"use client";
import { useEffect, useId, useRef, useState } from "react";
import { ArrowDownToLine, Check, Clock3, Headphones, History, LoaderCircle, Play, Save, TriangleAlert } from "lucide-react";
import { localeNames, type Locale } from "@/contracts/guild";
import type { CaptionReviewDraft, CaptionReviewRevision, CaptionReviewUnit } from "@/domain/caption-review";
import type { CaptionTrackSource } from "@/domain/captions";
import type { CaptionObservationWord } from "@/server/captions/review";
import { Modal } from "./ui";

interface ReviewWorkspace {
  artifactId: string; artifactHash: string; source: CaptionTrackSource; provider: string; recognition: string | null; observedWords: CaptionObservationWord[];
  observationCodes: string[]; rawBodyHash: string; initialUnits: CaptionReviewUnit[]; latestRevision: CaptionReviewRevision | null;
  history: Array<{ id: string; digest: string; parentRevisionId: string | null; author: string; createdAt: string; listeningAttested: boolean }>;
  canAttest: boolean; authorityExpired: boolean; authorityExpiresAt: string | null; nextAction: string;
}
const seconds = (ms: number | null) => ms === null ? "" : (ms / 1000).toFixed(3);
const time = (value: number) => value.toFixed(3);

export function CaptionReviewEditor({ artifactId, artifactHash, source, position, playRange, onDirty }: {
  artifactId: string; artifactHash: string; source: CaptionTrackSource; position: number; playRange: (start: number, end: number) => void; onDirty: (value: boolean) => void;
}) {
  const [workspace, setWorkspace] = useState<ReviewWorkspace | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<CaptionReviewDraft | null>(null), [dirty, setDirty] = useState(false), [saving, setSaving] = useState(false), [refresh, setRefresh] = useState(0), [notice, setNotice] = useState<string | null>(null);
  const [page, setPage] = useState(0), [attest, setAttest] = useState(false), [reviewerName, setReviewerName] = useState(""), [listened, setListened] = useState(false), [heard, setHeard] = useState(false), [timings, setTimings] = useState(false), [limits, setLimits] = useState(false);
  const [showObservations, setShowObservations] = useState(false), [refreshRequired, setRefreshRequired] = useState(false), id = useId(), attestTrigger = useRef<HTMLButtonElement>(null), reviewHeading = useRef<HTMLHeadingElement>(null);
  const intent = useRef<{ values: string; requestId: string } | null>(null), pending = useRef<{ abort: AbortController; identity: string } | null>(null);
  const query = `locale=${source.locale}&key=${encodeURIComponent(source.key)}`, endpoint = `/api/artifacts/${artifactId}/caption-review`;
  const identity = `${artifactId}:${artifactHash}:${source.locale}:${source.key}:${source.mediaId}`, currentIdentity = useRef(identity); currentIdentity.current = identity;
  useEffect(() => {
    const abort = new AbortController(); setLoading(true); setSaving(false); setAttest(false); setNotice(null); setError(null);
    fetch(`${endpoint}?${query}`, { cache: "no-store", signal: abort.signal }).then(async response => {
      const data = await response.json(); if (!response.ok) throw new Error(data.message ?? "This original track’s review evidence could not be read.");
      if (abort.signal.aborted) return;
      const value = data as ReviewWorkspace;
      if (value.artifactId !== artifactId || value.artifactHash !== artifactHash || value.source.mediaId !== source.mediaId || value.source.locale !== source.locale || value.source.key !== source.key) throw new Error("The exact artifact or original recording changed. Reopen its retained evidence.");
      setWorkspace(value); setDraft(value.latestRevision?.draft ?? { units: value.initialUnits, disposition: value.observationCodes.includes("TRANSCRIPT_MISMATCH") ? "recognition_difference" : "timing_review", note: "" });
      setDirty(false); setPage(0); setRefreshRequired(false); intent.current = null;
    }).catch(reason => { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : "The retained review is unavailable."); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => { abort.abort(); pending.current?.abort.abort(); pending.current = null; };
  }, [endpoint, query, artifactHash, source.mediaId, refresh]);
  useEffect(() => { onDirty(dirty || saving); return () => onDirty(false); }, [dirty, saving, onDirty]);
  useEffect(() => {
    if (!dirty && !saving) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const localGuard = (event: Event) => { event.preventDefault(); setError(saving ? "Wait for this exact save to finish before changing the view or commission." : "Save or discard this measured draft before changing the view or commission."); };
    window.addEventListener("beforeunload", guard); window.addEventListener("guild:caption-review-leave", localGuard);
    return () => { window.removeEventListener("beforeunload", guard); window.removeEventListener("guild:caption-review-leave", localGuard); };
  }, [dirty, saving]);

  function edit(next: CaptionReviewDraft) { if (pending.current) return; setDraft(next); setDirty(true); setNotice(null); intent.current = null; }
  function updateUnit(index: number, patch: Partial<CaptionReviewUnit>) {
    if (!draft) return;
    const units = draft.units.map((unit, i) => i === index ? { ...unit, ...patch, origin: "manual" as const, providerWordIndex: null } : unit);
    edit({ ...draft, units });
  }
  async function submit(action: "save" | "attest") {
    if (!workspace || !draft || pending.current || refreshRequired) return;
    const operation = { abort: new AbortController(), identity }; pending.current = operation;
    setSaving(true); setError(null); setNotice(null);
    const common = { action, parentRevisionId: workspace.latestRevision?.id ?? null, locale: source.locale, key: source.key, artifactHash };
    const values = action === "save" ? { ...common, draft } : { ...common, reviewerName, completeRecordingListened: listened, completeSourceHeard: heard, everyTimingChecked: timings, acknowledgeNotFluentReview: limits };
    const fingerprint = JSON.stringify(values);
    if (intent.current?.values !== fingerprint) intent.current = { values: fingerprint, requestId: crypto.randomUUID() };
    const body = { ...values, requestId: intent.current.requestId };
    const active = () => pending.current === operation && !operation.abort.signal.aborted && currentIdentity.current === operation.identity;
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: operation.abort.signal });
      const result = await response.json(); if (!active()) return;
      if (!response.ok) {
        if (response.status === 409) { setRefreshRequired(true); throw new Error((result.message ?? "A newer review is retained.") + " Close this dialog and read saved history before reviewing or saving again."); }
        throw new Error(result.message ?? "The review was not confirmed. Read saved history before retrying.");
      }
      const revision = result.revision as CaptionReviewRevision;
      if (revision.artifactId !== artifactId || revision.artifactHash !== artifactHash || revision.locale !== source.locale || revision.key !== source.key
        || revision.requestId !== body.requestId || revision.parentRevisionId !== common.parentRevisionId || (action === "attest") !== !!revision.attestation)
        throw new Error("The save response does not identify this exact original recording and request. Read retained history before continuing.");
      setWorkspace({ ...workspace, latestRevision: revision, history: [...workspace.history, { id: revision.id, digest: revision.digest, parentRevisionId: revision.parentRevisionId, author: revision.attestation?.reviewerName ?? revision.actorRole, createdAt: revision.createdAt, listeningAttested: !!revision.attestation }] });
      setDraft(revision.draft); setDirty(false); intent.current = null; setAttest(false);
      setNotice(action === "attest" ? "Your listening declaration is saved against this exact draft. Fluent review and curator acceptance remain separate." : "Draft saved. Original source, audio and provider observations remain unchanged. Listening review is still a separate step.");
      window.dispatchEvent(new CustomEvent("guild:caption-review-saved"));
    } catch (reason) { if (active()) setError(reason instanceof Error ? reason.message : "The save outcome is unknown. Read the saved history before retrying."); }
    finally { if (active()) { pending.current = null; setSaving(false); } }
  }
  const revision = workspace?.latestRevision, pageSize = 24, pageCount = Math.max(1, Math.ceil((draft?.units.length ?? 0) / pageSize));
  const canAttest = !!workspace?.canAttest && !!revision && !revision.attestation && revision.evaluation.status === "ready-for-review" && !dirty && !refreshRequired;
  const exportUrl = revision ? `${endpoint}?${query}&revisionId=${revision.id}` : "";
  if (loading) return <section className="caption-review-editor" aria-label="Caption review workbench"><p role="status"><LoaderCircle className="spin" size={16}/> Opening the original words and review history…</p></section>;
  if (!workspace || !draft) return <section className="caption-review-editor"><p role="alert" className="form-error">{error ?? "The exact original evidence is unavailable."}</p><button className="button" onClick={() => setRefresh(value => value + 1)}>Read original evidence again</button></section>;
  return <section className="caption-review-editor" aria-label={`${localeNames[source.locale]} caption review and correction`}>
    <header className="caption-review-title"><Headphones size={23}/><div><p className="eyebrow">LISTENING DESK / {localeNames[source.locale]}</p><h5 ref={reviewHeading} tabIndex={-1}>A careful word at a time.</h5><p>Keep the source intact. Compare what recognition heard, then record only the boundaries you can hear.</p></div></header>
    <div className={`caption-review-next ${workspace.authorityExpired ? "caption-review-expired" : ""}`}><Clock3 size={18}/><p>{workspace.nextAction}</p></div>
    <div className="caption-comparison"><article><span className="eyebrow">THE COMPLETE AGREED SOURCE</span><p lang={source.locale} dir={source.locale === "ar" ? "rtl" : "ltr"}>{source.text}</p></article><article><span className="eyebrow">THE ORIGINAL RECOGNITION</span><small>{workspace.provider}</small><p lang={source.locale} dir={source.locale === "ar" ? "rtl" : "ltr"}>{workspace.recognition ?? "No usable transcript was returned in the original response."}</p></article></div>
    <p className="caption-listening-note">Different spelling, diacritics or a missing heading in recognition does not establish what the recording says. Listen before classifying the disagreement. The original text cannot be edited here.</p>
    {workspace.observationCodes.length > 0 && <details className="caption-details"><summary><TriangleAlert size={14}/> Why automatic mapping is held</summary><p><code>{workspace.observationCodes.slice(0, 20).join(" · ")}</code></p><p>These are retained automatic findings. A human correction remains a separate, attributed record.</p></details>}
    <details className="caption-details" onToggle={event => setShowObservations(event.currentTarget.open)}><summary>Hear recognized words · inspect original and rounded timing</summary><p>Raw boundaries remain exactly as observed. Rounded values are displayed in milliseconds. They do not repair an overlap or supply a missing word. For historical Whisper, this is a display conversion, not a change to its original precision policy.</p>
      {showObservations && <div className="caption-observation-scroll" role="region" aria-label="Original word observations" tabIndex={0}><table><thead><tr><th>Recognition word</th><th>Original seconds</th><th>Rounded seconds</th><th>Listen</th></tr></thead><tbody>{workspace.observedWords.map((word, index) => <tr key={index}><td><span lang={source.locale} dir={source.locale === "ar" ? "rtl" : "ltr"}>{word.word}</span><small>Observation {index + 1}</small></td><td><code>{String(word.rawStart)} → {String(word.rawEnd)}</code></td><td><code>{seconds(word.startMs)} → {seconds(word.endMs)}</code><small>Δ {Math.max(Math.abs(word.startMs / 1000 - word.rawStart), Math.abs(word.endMs / 1000 - word.rawEnd)).toFixed(6)}s</small></td><td><button className="caption-word-play" disabled={word.rawStart < 0 || word.rawEnd <= word.rawStart || word.rawEnd > source.durationSeconds} aria-label={`Play original observation ${index + 1}: ${word.word}`} onClick={() => playRange(word.rawStart, word.rawEnd)}><Play size={13}/> Hear</button></td></tr>)}</tbody></table>{!workspace.observedWords.length && <p>No complete word observations are available. The original response download retains the actual bytes.</p>}</div>}
    </details>
    <fieldset className="caption-review-form" disabled={saving || refreshRequired}><label htmlFor={`${id}-disposition`}>What needs attention?</label><select id={`${id}-disposition`} value={draft.disposition} onChange={event => edit({ ...draft, disposition: event.target.value as CaptionReviewDraft["disposition"] })}>
      <option value="timing_review">Check timing against the original recording</option><option value="recognition_difference">Recognition differs; complete source is audible</option><option value="source_audio_disagreement">Some original source wording is not audible</option><option value="uncertain">The source and recording still need review</option>
    </select><p className="caption-listening-note">“Not heard” and “uncertain” keep a source unit untimed. A new recording or source amendment needs a separate agreement; this desk cannot rewrite either.</p>
    <div className="caption-review-toolbar"><strong>{draft.units.filter(unit => unit.heard === "heard" && unit.startMs !== null && unit.endMs !== null).length}<small> / {draft.units.length} units have entered timing</small></strong><span>Playhead <code>{time(position)}s</code></span></div>
    <ol className="caption-measured-units" start={page * pageSize + 1}>{draft.units.slice(page * pageSize, (page + 1) * pageSize).map((unit, offset) => {
      const index = page * pageSize + offset, text = source.text.slice(unit.sourceStart, unit.sourceEnd).trim();
      return <li key={`${unit.sourceStart}:${unit.sourceEnd}`} className={unit.heard === "not_heard" ? "caption-unit-unheard" : ""}><div className="caption-unit-heading"><span className="caption-unit-no">{String(index + 1).padStart(2, "0")}</span><strong lang={source.locale} dir={source.locale === "ar" ? "rtl" : "ltr"}>{text}</strong><small>{unit.origin === "deepgram" ? "Original provider timing" : unit.origin === "manual" ? "Manually entered" : "No timing supplied"}</small></div>
        <div className="caption-unit-controls"><label>Heard in the recording<select aria-label={`Source unit ${index + 1}: heard status`} value={unit.heard} onChange={event => { const heard = event.target.value as CaptionReviewUnit["heard"]; updateUnit(index, { heard, ...(heard === "heard" ? {} : { startMs: null, endMs: null }) }); }}><option value="uncertain">Uncertain</option><option value="heard">Heard</option><option value="not_heard">Not heard</option></select></label>
          <label>Start · seconds<div className="caption-timing-input"><input aria-label={`Source unit ${index + 1}: start seconds`} type="number" inputMode="decimal" step="0.001" min="0" max={source.durationSeconds} value={seconds(unit.startMs)} disabled={unit.heard !== "heard"} onChange={event => updateUnit(index, { startMs: event.target.value === "" ? null : Math.round(Number(event.target.value) * 1000) })}/><button disabled={unit.heard !== "heard"} type="button" title="Use current audio playhead" aria-label={`Set source unit ${index + 1} start from playhead`} onClick={() => updateUnit(index, { startMs: Math.round(position * 1000) })}>Set</button></div></label>
          <label>End · seconds<div className="caption-timing-input"><input aria-label={`Source unit ${index + 1}: end seconds`} type="number" inputMode="decimal" step="0.001" min="0.001" max={source.durationSeconds} value={seconds(unit.endMs)} disabled={unit.heard !== "heard"} onChange={event => updateUnit(index, { endMs: event.target.value === "" ? null : Math.round(Number(event.target.value) * 1000) })}/><button disabled={unit.heard !== "heard" || position <= 0} type="button" title="Use current audio playhead" aria-label={`Set source unit ${index + 1} end from playhead`} onClick={() => updateUnit(index, { endMs: Math.round(position * 1000) })}>Set</button></div></label>
          <button className="caption-word-play" disabled={unit.startMs === null || unit.endMs === null || unit.endMs <= unit.startMs || unit.endMs / 1000 > source.durationSeconds} onClick={() => playRange(unit.startMs! / 1000, unit.endMs! / 1000)} aria-label={`Play entered source unit ${index + 1}: ${text}`}><Play size={14}/> Hear span</button>
        </div></li>;
    })}</ol>
    {pageCount > 1 && <nav className="caption-review-pages" aria-label="Measured source units"><button className="button" disabled={!page} onClick={() => setPage(value => value - 1)}>Earlier words</button><span>Page {page + 1} of {pageCount}</span><button className="button" disabled={page + 1 >= pageCount} onClick={() => setPage(value => value + 1)}>Next words</button></nav>}
    <label htmlFor={`${id}-note`}>What did you hear or change?</label><textarea id={`${id}-note`} rows={3} minLength={10} maxLength={3000} value={draft.note} onChange={event => edit({ ...draft, note: event.target.value })} placeholder="Describe the original observation, what you heard, and which boundaries you measured…"/>
    <div className="caption-review-save"><button className="button primary" disabled={saving || draft.note.trim().length < 10 || !!revision && !dirty} onClick={() => void submit("save")}><Save size={15}/>{saving ? "Saving the exact revision…" : "Save measured draft"}</button>{dirty && <button className="text-button" disabled={saving} onClick={() => { setDirty(false); setRefresh(value => value + 1); }}>Discard unsaved edits</button>}<small>{dirty ? "Unsaved changes stay on this recording until you save or discard." : "Original evidence is preserved. Every save appends a revision."}</small></div>
    </fieldset>
    {error && <div className="caption-review-error" role="alert"><p>{error}</p><button className="button" disabled={saving} onClick={() => { setDirty(false); setRefresh(value => value + 1); }}>Read saved history · discard local edits</button></div>}
    {notice && <p className="caption-review-notice" role="status"><Check size={17}/>{notice}</p>}
    {revision && <div className="caption-saved-review"><div><p className="eyebrow">SAVED REVISION / {revision.id.slice(0, 8)}</p><strong>{dirty ? "The saved revision is unchanged by your local edits." : revision.attestation ? `Listening declaration by ${revision.attestation.reviewerName}` : revision.evaluation.status === "ready-for-review" ? "Complete timing draft. Listening review is next." : "Keep the unresolved wording and timing visible."}</strong><p>{revision.evaluation.coveredUnits}/{revision.evaluation.totalUnits} source units entered · {revision.evaluation.cues.length} valid cues in this saved revision.</p>{revision.evaluation.codes.length > 0 && <code>{revision.evaluation.codes.join(" · ")}</code>}</div><div className="caption-downloads"><a href={`${exportUrl}&download=json`}><ArrowDownToLine size={14}/> Attributed JSON</a>{revision.evaluation.vtt && <a href={`${exportUrl}&download=vtt`}><ArrowDownToLine size={14}/> Review candidate VTT</a>}</div>
      {workspace.canAttest ? <button ref={attestTrigger} className="button" disabled={!canAttest || saving} onClick={() => { setAttest(true); setReviewerName(""); setListened(false); setHeard(false); setTimings(false); setLimits(false); setError(null); intent.current = null; }}><Headphones size={16}/> Record my listening review</button> : <p className="caption-disclosure">This system-operator workspace may save annotated drafts. A human owner must perform and record the listening review.</p>}
    </div>}
    {revision?.evaluation.vtt && <details className="caption-details"><summary><Play size={14}/> Preview the saved draft cues with original audio</summary><p>These are review candidates from saved revision {revision.id.slice(0, 8)}. Playback does not record a listening declaration or replace the submitted artifact.</p><ol className="caption-cues">{revision.evaluation.cues.map(cue=><li key={cue.index}><button aria-label={`Hear saved draft cue ${cue.index}: ${cue.text}`} onClick={()=>playRange(cue.start,cue.end)}><span className="caption-cue-clock">{time(cue.start)}<small>{time(cue.end)}</small></span><span lang={source.locale} dir={source.locale==="ar"?"rtl":"ltr"}>{cue.lines.map((line,index)=><span key={index}>{line}</span>)}</span></button></li>)}</ol></details>}
    {workspace.history.length > 0 && <details className="caption-details"><summary><History size={15}/> {workspace.history.length} retained revisions</summary><ol className="caption-review-history">{workspace.history.map(item => <li key={item.id}><strong>{item.listeningAttested ? "Listening declaration" : "Measured draft"} · {item.author}</strong><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time><a href={`${endpoint}?${query}&revisionId=${item.id}&download=json`}>Original revision {item.id.slice(0, 8)}</a></li>)}</ol></details>}
    <p className="caption-disclosure">A saved draft is not listening review. A declaration records what its named author attests; software cannot prove they listened. No fluent-language review, final acceptance or payment is created here.</p>
    {attest && revision && <Modal title="Attach your name to this listening review." returnFocus={() => attestTrigger.current && !attestTrigger.current.disabled ? attestTrigger.current : reviewHeading.current} onClose={() => { if (!pending.current) setAttest(false); }}><fieldset disabled={saving || refreshRequired} className="caption-listening-declaration"><p>You are reviewing the complete <strong>{localeNames[source.locale]}</strong> recording and the exact saved draft <code>{revision.id.slice(0, 8)}</code>: {revision.evaluation.totalUnits} source units, {revision.evaluation.cues.length} cues, {time(source.durationSeconds)} seconds.</p><label>Your name<input value={reviewerName} onChange={event => setReviewerName(event.target.value)} maxLength={160} autoComplete="name"/></label><label className="checkbox-label"><input type="checkbox" checked={listened} onChange={event => setListened(event.target.checked)}/><span>I personally listened to the complete unchanged original recording.</span></label><label className="checkbox-label"><input type="checkbox" checked={heard} onChange={event => setHeard(event.target.checked)}/><span>I heard every part of the complete source, including the heading. No source wording is missing or uncertain.</span></label><label className="checkbox-label"><input type="checkbox" checked={timings} onChange={event => setTimings(event.target.checked)}/><span>I checked every submitted timing against the recording. Manually entered measurements are my corrections, not provider timestamps.</span></label><label className="checkbox-label"><input type="checkbox" checked={limits} onChange={event => setLimits(event.target.checked)}/><span>This declaration does not claim fluent-language review or automatic alignment qualification. Curator acceptance of meaning and the source remains separate.</span></label><p className="caption-disclosure">Record this only for listening you actually performed. A system or AI annotation cannot stand in for a person.</p><div className="dialog-actions"><button className="button" onClick={() => setAttest(false)}>Keep listening</button><button className="button primary" disabled={saving || !canAttest || reviewerName.trim().length < 2 || !listened || !heard || !timings || !limits} onClick={() => void submit("attest")}>{saving ? "Saving the exact declaration…" : "Save my declaration"} <Check size={16}/></button></div></fieldset>{error && <div className="caption-review-error" role="alert"><p>{error}</p>{refreshRequired && <button className="button" onClick={() => setAttest(false)}>Close and review saved history</button>}</div>}</Modal>}
  </section>;
}
