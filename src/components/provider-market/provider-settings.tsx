"use client";

import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { providerPolicyInputSchema, providerProfileInputSchema, type MarketProvider, type ProviderPolicy } from "@/contracts/provider-market";
import type { PackageKind } from "@/contracts/guild";
import type { MarketController } from "./controller";
import { awardInput, ownsProvider, parseAward, safeHref, WORK_KINDS } from "./format";
import { Badge, PolicySummary } from "./shared";

type Errors = Record<string, string>;
type ProfileDraft = { displayName: string; ownerDisplayName: string; specialty: string; description: string; portfolioUrl: string };
type PolicyDraft = { minimumAward: string; askingAward: string; maximumConcurrentTasks: string; workingHours: string; allowedKinds: PackageKind[]; correctionAllowance: string; counterofferLimit: string; validUntil: string; contentRules: string };
function profileDraft(provider: MarketProvider): ProfileDraft { return { displayName: provider.displayName, ownerDisplayName: provider.ownerDisplayName, specialty: provider.specialty, description: provider.description, portfolioUrl: provider.portfolioUrl ?? "" }; }
function policyDraft(policy: ProviderPolicy | null, kinds: PackageKind[]): PolicyDraft { return { minimumAward: policy ? awardInput(policy.minimumAwardMinor) : "", askingAward: policy ? awardInput(policy.askingAwardMinor) : "", maximumConcurrentTasks: policy ? String(policy.maximumConcurrentTasks) : "", workingHours: policy ? String(policy.workingHours) : "", allowedKinds: policy?.allowedKinds ?? kinds, correctionAllowance: policy ? String(policy.correctionAllowance) : "", counterofferLimit: policy ? String(policy.counterofferLimit) : "", validUntil: policy?.validUntil.replace(/Z$/, "") ?? "", contentRules: policy?.contentRules ?? "" }; }
function useVersionedDraft<T>(current: T, revision: number) {
  const signature = JSON.stringify(current);
  const [state, setState] = useState({ draft: current, base: signature, revision });
  const dirty = JSON.stringify(state.draft) !== state.base;
  useEffect(() => {
    setState(previous => {
      if (previous.revision === revision && previous.base === signature) return previous;
      if (JSON.stringify(previous.draft) !== previous.base) return previous;
      return { draft: JSON.parse(signature) as T, base: signature, revision };
    });
  }, [revision, signature]);
  return {
    draft: state.draft, revision: state.revision, dirty,
    conflict: dirty && (state.revision !== revision || state.base !== signature),
    update: <K extends keyof T>(field: K, value: T[K]) => setState(previous => ({ ...previous, draft: { ...previous.draft, [field]: value } })),
    reset: () => setState({ draft: current, base: signature, revision }),
    rebase: () => setState(previous => ({ ...previous, base: signature, revision })),
    saved: (value: T, nextRevision: number) => setState({ draft: value, base: JSON.stringify(value), revision: nextRevision }),
  };
}
function Field({ id, name, label, help, error, children }: { id: string; name: string; label: string; help?: string; error?: string; children: ReactNode }) {
  return <div className="pm-field"><label htmlFor={`${id}-${name}`}>{label}</label>{children}{help ? <p className="pm-field-help" id={`${id}-${name}-help`}>{help}</p> : null}{error ? <p className="pm-field-error" id={`${id}-${name}-error`}>{error}</p> : null}</div>;
}
function describedBy(id: string, field: string, errors: Errors, help = false) { return [help ? `${id}-${field}-help` : "", errors[field] ? `${id}-${field}-error` : ""].filter(Boolean).join(" ") || undefined; }
function ErrorSummary({ id, errors }: { id: string; errors: Errors }) { return Object.keys(errors).length ? <div className="pm-validation" role="alert"><strong>Review these fields before saving.</strong><ul>{Object.entries(errors).map(([field, message]) => <li key={field}><a href={`#${id}-${field}`}>{message}</a></li>)}</ul></div> : null; }
function ConflictActions({ kind, revision, onRebase, onReset, children }: { kind: string; revision: number; onRebase: () => void; onReset: () => void; children: ReactNode }) {
  return <div className="pm-conflict" role="alert"><strong>The saved {kind} changed. Your draft is still here.</strong><p>Compare the current saved version below, then choose how to continue.</p><details open><summary>Current saved {kind} · revision {revision}</summary>{children}</details><div className="pm-actions"><button type="button" className="pm-button pm-button--quiet" onClick={onRebase}>Keep my draft on revision {revision}</button><button type="button" className="pm-text-button" onClick={onReset}>Load saved {kind}</button></div></div>;
}

export function ProviderProfileEditor({ provider, controller }: { provider: MarketProvider; controller: MarketController }) {
  const id = useId(), editor = useVersionedDraft(profileDraft(provider), provider.enrollment.revision), [errors, setErrors] = useState<Errors>({});
  const snapshot = controller.snapshot, allowed = snapshot ? ownsProvider(snapshot, provider) && provider.enrollment.state !== "revoked" : false;
  const disabledReason = !allowed ? "This session is not bound to an editable profile for this provider." : controller.status !== "ready" ? "Load the current workspace before saving changes." : null;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!allowed || controller.busy || editor.conflict) return;
    const parsed = providerProfileInputSchema.safeParse({ ...editor.draft, portfolioUrl: editor.draft.portfolioUrl.trim() || null });
    const nextErrors: Errors = {};
    if (!parsed.success) for (const issue of parsed.error.issues) nextErrors[String(issue.path[0])] ??= issue.message;
    if (editor.draft.portfolioUrl.trim() && !safeHref(editor.draft.portfolioUrl.trim())?.startsWith("http")) nextErrors.portfolioUrl = "Use a complete https:// or http:// portfolio URL.";
    setErrors(nextErrors); if (!parsed.success || Object.keys(nextErrors).length) return;
    const result = await controller.execute({ type: "update_provider_profile", providerId: provider.id, expectedProfileRevision: editor.revision, profile: parsed.data }, "Save provider profile");
    if (result?.ok) { const saved = result.snapshot.providers.find(item => item.id === provider.id); if (saved) editor.saved(profileDraft(saved), saved.enrollment.revision); }
  }
  const fields: { name: keyof ProfileDraft; label: string; max: number; help?: string; textarea?: boolean }[] = [
    { name: "displayName", label: "Service display name", max: 80 }, { name: "ownerDisplayName", label: "Accountable owner", max: 80, help: "The person or business responsible for this service." },
    { name: "specialty", label: "Specialty", max: 120 }, { name: "description", label: "Service description", max: 1_200, help: "Explain the work and its limitations in 20–1,200 characters.", textarea: true },
    { name: "portfolioUrl", label: "Portfolio URL · optional", max: 500, help: "A public http:// or https:// URL. This does not enroll a service endpoint." },
  ];
  return <section className="pm-settings-panel" id="provider-profile"><div className="pm-panel-heading"><div><p className="pm-eyebrow">01 · Introduce your service</p><h2>Public profile</h2></div><Badge>Revision {provider.enrollment.revision}</Badge></div><p className="pm-muted">Your owner identity and provider access come from the current workspace.</p><form onSubmit={event => void submit(event)} noValidate aria-label="Provider profile"><ErrorSummary id={id} errors={errors}/>{editor.conflict ? <ConflictActions kind="profile" revision={provider.enrollment.revision} onRebase={editor.rebase} onReset={() => { editor.reset(); setErrors({}); }}><dl className="pm-facts">{Object.entries(profileDraft(provider)).map(([key, value]) => <div key={key}><dt>{fields.find(field => field.name === key)?.label ?? key}</dt><dd dir="auto">{value || "Not provided"}</dd></div>)}</dl></ConflictActions> : null}<fieldset disabled={controller.busy || !allowed}><legend className="pm-sr-only">Public profile fields</legend>{fields.map(field => <Field key={field.name} id={id} name={field.name} label={field.label} help={field.help} error={errors[field.name]}>{field.textarea ? <textarea id={`${id}-${field.name}`} name={field.name} dir="auto" value={editor.draft[field.name]} maxLength={field.max} rows={4} onChange={event => editor.update(field.name, event.target.value)} aria-invalid={Boolean(errors[field.name])} aria-describedby={describedBy(id, field.name, errors, Boolean(field.help))}/> : <input id={`${id}-${field.name}`} name={field.name} dir={field.name === "portfolioUrl" ? "ltr" : "auto"} type={field.name === "portfolioUrl" ? "url" : "text"} value={editor.draft[field.name]} maxLength={field.max} onChange={event => editor.update(field.name, event.target.value)} aria-invalid={Boolean(errors[field.name])} aria-describedby={describedBy(id, field.name, errors, Boolean(field.help))}/>}</Field>)}<div className="pm-form-actions"><button className="pm-button pm-button--primary" disabled={editor.conflict}>Save profile</button>{editor.dirty ? <button type="button" className="pm-text-button" onClick={() => { editor.reset(); setErrors({}); }}>Discard profile edits</button> : <span className="pm-muted">Current saved profile</span>}</div></fieldset>{disabledReason ? <p className="pm-disabled-reason">{disabledReason}</p> : null}</form></section>;
}

export function ProviderPolicyEditor({ provider, controller }: { provider: MarketProvider; controller: MarketController }) {
  const id = useId(), editor = useVersionedDraft(policyDraft(provider.policy, provider.kinds), provider.policy?.revision ?? 0), [errors, setErrors] = useState<Errors>({});
  const snapshot = controller.snapshot, allowed = snapshot ? ownsProvider(snapshot, provider) && provider.enrollment.state !== "revoked" : false;
  const numbers = [
    { name: "maximumConcurrentTasks" as const, label: "Maximum concurrent tasks", min: 1, max: 25, help: "Active tasks and reserved work both use capacity." },
    { name: "workingHours" as const, label: "Working duration · business hours", min: 1, max: 240, help: "An offer uses this duration under the museum work calendar." },
    { name: "correctionAllowance" as const, label: "Corrections included", min: 0, max: 3, help: "The agreed number of corrections for each task." },
    { name: "counterofferLimit" as const, label: "Counteroffer limit", min: 0, max: 20, help: "The maximum number allowed under this owner policy." },
  ];
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!allowed || controller.busy || editor.conflict) return;
    const nextErrors: Errors = {}, minimum = parseAward(editor.draft.minimumAward), asking = parseAward(editor.draft.askingAward);
    if (minimum === null) nextErrors.minimumAward = "Enter a minimum award in USD with no more than two decimals.";
    if (asking === null) nextErrors.askingAward = "Enter an asking award in USD with no more than two decimals.";
    if (minimum !== null && asking !== null && asking < minimum) nextErrors.askingAward = "The asking award must meet your minimum award.";
    const numeric: Record<string, number> = {};
    for (const field of numbers) {
      const raw = editor.draft[field.name], value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN; numeric[field.name] = value;
      if (!Number.isInteger(value) || value < field.min || value > field.max) nextErrors[field.name] = `${field.label}: enter a whole number from ${field.min} to ${field.max}.`;
    }
    const expiry = Date.parse(`${editor.draft.validUntil}Z`), validUntil = Number.isFinite(expiry) ? new Date(expiry).toISOString() : "";
    if (!Number.isFinite(Date.parse(validUntil)) || Date.parse(validUntil) <= controller.now) nextErrors.validUntil = "Choose a future expiry in UTC.";
    if (!editor.draft.allowedKinds.length) nextErrors.allowedKinds = "Choose at least one allowed work type.";
    if (!editor.draft.contentRules.trim() || editor.draft.contentRules.trim().length > 1_200) nextErrors.contentRules = "State your content rules in 1–1,200 characters.";
    setErrors(nextErrors); if (Object.keys(nextErrors).length) return;
    const parsed = providerPolicyInputSchema.safeParse({ minimumAwardMinor: minimum, askingAwardMinor: asking, maximumConcurrentTasks: numeric.maximumConcurrentTasks, workingHours: numeric.workingHours, calendarId: "museum-weekdays-v1", allowedKinds: editor.draft.allowedKinds, correctionAllowance: numeric.correctionAllowance, counterofferLimit: numeric.counterofferLimit, validUntil, contentRules: editor.draft.contentRules.trim() });
    if (!parsed.success) { for (const issue of parsed.error.issues) nextErrors[String(issue.path[0])] ??= issue.message; setErrors(nextErrors); return; }
    const result = await controller.execute({ type: "update_provider_policy", providerId: provider.id, expectedPolicyRevision: editor.revision, policy: parsed.data }, "Publish provider owner policy");
    if (result?.ok) { const saved = result.snapshot.providers.find(item => item.id === provider.id); if (saved?.policy) editor.saved(policyDraft(saved.policy, saved.kinds), saved.policy.revision); }
  }
  return <section className="pm-settings-panel" id="provider-policy"><div className="pm-panel-heading"><div><p className="pm-eyebrow">02 · Set your boundaries</p><h2>Owner policy</h2></div><Badge>{provider.policy ? `Revision ${provider.policy.revision}` : "Not yet published"}</Badge></div><p className="pm-muted">Offers bind to the published revision. A policy change is recorded as a new version and checked before later work.</p><form onSubmit={event => void submit(event)} noValidate aria-label="Provider owner policy"><ErrorSummary id={id} errors={errors}/>{editor.conflict ? <ConflictActions kind="policy" revision={provider.policy?.revision ?? 0} onRebase={editor.rebase} onReset={() => { editor.reset(); setErrors({}); }}>{provider.policy ? <PolicySummary policy={provider.policy} now={controller.now}/> : <p>No policy is currently published.</p>}</ConflictActions> : null}<fieldset disabled={controller.busy || !allowed}><legend className="pm-sr-only">Owner policy fields</legend><div className="pm-form-grid">{(["minimumAward", "askingAward"] as const).map(name => <Field key={name} id={id} name={name} label={name === "minimumAward" ? "Minimum provider award · USD" : "Asking provider award · USD"} error={errors[name]}><input id={`${id}-${name}`} name={name} inputMode="decimal" value={editor.draft[name]} onChange={event => editor.update(name, event.target.value)} aria-invalid={Boolean(errors[name])} aria-describedby={describedBy(id, name, errors)}/></Field>)}{numbers.map(field => <Field key={field.name} id={id} name={field.name} label={field.label} help={field.help} error={errors[field.name]}><input id={`${id}-${field.name}`} name={field.name} type="number" min={field.min} max={field.max} step={1} value={editor.draft[field.name]} onChange={event => editor.update(field.name, event.target.value)} aria-invalid={Boolean(errors[field.name])} aria-describedby={describedBy(id, field.name, errors, true)}/></Field>)}</div>
      <Field id={id} name="calendarId" label="Working calendar" help="The museum calendar is fixed for this market. Working hours are distinct from elapsed hours."><input id={`${id}-calendarId`} name="calendarId" value="museum-weekdays-v1" readOnly aria-describedby={`${id}-calendarId-help`}/></Field>
      <fieldset className="pm-work-types" aria-describedby={errors.allowedKinds ? `${id}-allowedKinds-error` : undefined}><legend id={`${id}-allowedKinds`}>Allowed work types</legend>{WORK_KINDS.map(kind => <label className="pm-checkbox" key={kind.value}><input name="allowedKinds" type="checkbox" checked={editor.draft.allowedKinds.includes(kind.value)} onChange={event => editor.update("allowedKinds", event.target.checked ? [...editor.draft.allowedKinds, kind.value] : editor.draft.allowedKinds.filter(value => value !== kind.value))}/><span>{kind.label}</span></label>)}{errors.allowedKinds ? <p className="pm-field-error" id={`${id}-allowedKinds-error`}>{errors.allowedKinds}</p> : null}</fieldset>
      <Field id={id} name="validUntil" label="Policy expires · UTC" help="Use the real policy expiry. A scenario clock never extends a quote or work mandate." error={errors.validUntil}><input id={`${id}-validUntil`} name="validUntil" type="datetime-local" step="1" value={editor.draft.validUntil} onChange={event => editor.update("validUntil", event.target.value)} aria-invalid={Boolean(errors.validUntil)} aria-describedby={describedBy(id, "validUntil", errors, true)}/></Field>
      <Field id={id} name="contentRules" label="Content rules" help="Describe permitted content and restrictions. These rules accompany the owner policy." error={errors.contentRules}><textarea id={`${id}-contentRules`} name="contentRules" dir="auto" rows={4} maxLength={1_200} value={editor.draft.contentRules} onChange={event => editor.update("contentRules", event.target.value)} aria-invalid={Boolean(errors.contentRules)} aria-describedby={describedBy(id, "contentRules", errors, true)}/></Field>
      <div className="pm-form-actions"><button className="pm-button pm-button--primary" disabled={editor.conflict}>{provider.policy ? "Publish new policy revision" : "Publish owner policy"}</button>{editor.dirty ? <button type="button" className="pm-text-button" onClick={() => { editor.reset(); setErrors({}); }}>Discard policy edits</button> : <span className="pm-muted">{provider.policy ? "Current saved policy" : "Complete every field to publish"}</span>}</div></fieldset>{!allowed ? <p className="pm-disabled-reason">Only this provider’s bound owner session can publish a policy.</p> : null}</form></section>;
}
