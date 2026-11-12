"use client";
import { useId,useLayoutEffect,useRef } from "react";
import { X,ArrowUpRight,Check,LoaderCircle } from "lucide-react";
import type { CommissionCommand,Provenance,WorkPackage } from "@/contracts/guild";
export type Action=CommissionCommand extends infer C?C extends CommissionCommand?Omit<C,"commandId"|"expectedRevision">:never:never;
export type ActResult={ok:true}|{ok:false;message:string};
export type Act=(action:Action)=>Promise<ActResult>;
export const money=(minor:number)=>new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:minor%100?2:0}).format(minor/100);
export const when=(value:string)=>new Intl.DateTimeFormat("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}).format(new Date(value));
const states:Record<WorkPackage["state"],string>={draft:"Draft contract",bidding:"Taking proposals",awarded:"Contract ready",producing:"In production",submitted:"Ready for checks",verifying:"Checking the work",awaiting_acceptance:"Your review",accepted:"Accepted",correction_requested:"Correction requested",rejected:"Not accepted",withdrawn:"Withdrawn"};
export function State({state}:{state:WorkPackage["state"]}){return <span className={`state state-${state}`}>{state==="accepted"?<Check size={12}/>:state==="producing"?<LoaderCircle className="spin" size={12}/>:<i/>}{states[state]}</span>;}
export function SourceTag({source}:{source:Provenance}){return <span className={`source-tag source-${source.mode}`} title={source.label}>{source.mode==="live"?"Actual artifact":source.mode==="sample"?"Sample":source.mode==="replay"?"Recorded replay":"Modelled"}</span>;}
export function External({href,children}:{href:string;children:React.ReactNode}){return <a href={href} target="_blank" rel="noreferrer">{children}<ArrowUpRight size={14}/></a>;}
const modalStack: HTMLDialogElement[] = [];
function available(element: HTMLElement) {
  if (!element.isConnected || element.matches(":disabled") || element.closest("[hidden],[inert],[aria-hidden='true']")) return false;
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = window.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.contentVisibility === "hidden") return false;
    if (node.tagName === "DETAILS" && !(node as HTMLDetailsElement).open) {
      const summary = [...node.children].find(child => child.tagName === "SUMMARY");
      if (!summary?.contains(element)) return false;
    }
  }
  return true;
}
function modalControls(dialog: HTMLDialogElement) {
  return [...dialog.querySelectorAll<HTMLElement>("a[href],button,input:not([type='hidden']),select,textarea,summary,audio[controls],video[controls],iframe,[contenteditable]:not([contenteditable='false']),[tabindex]")]
    .filter(element => element.tabIndex >= 0 && available(element))
    .filter((element, _index, elements) => {
      if (element.tagName !== "INPUT") return true;
      const radio = element as HTMLInputElement;
      if (radio.type !== "radio" || !radio.name) return true;
      const group = elements.filter((item): item is HTMLInputElement => item.tagName === "INPUT" && (item as HTMLInputElement).type === "radio" && (item as HTMLInputElement).name === radio.name && (item as HTMLInputElement).form === radio.form);
      return radio === (group.find(item => item.checked) ?? group[0]);
    })
    .sort((a,b) => (a.tabIndex > 0 ? a.tabIndex : Infinity) - (b.tabIndex > 0 ? b.tabIndex : Infinity));
}
export function Modal({title,onClose,children,returnFocus}:{title:string;onClose:()=>void;children:React.ReactNode;returnFocus?:()=>HTMLElement|null}){
  const ref = useRef<HTMLDialogElement>(null), titleId = useId(), opener = useRef<HTMLElement | null>(typeof document === "undefined" ? null : document.activeElement as HTMLElement | null);
  const returnFocusRef = useRef(returnFocus); returnFocusRef.current = returnFocus;
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    modalStack.push(dialog); dialog.showModal();
    const top = () => modalStack.at(-1) === dialog && dialog.open;
    let redirecting = false;
    const keepFocus = () => {
      if (!top() || redirecting) return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && dialog.contains(active) && available(active)) return;
      redirecting = true; (modalControls(dialog)[0] ?? dialog).focus(); redirecting = false;
    };
    // Recompute at each key press. Busy and dynamically added/removed controls
    // must never leave a cached last control pointing at BODY or a disabled node.
    const keydown = (event: KeyboardEvent) => {
      if (!top() || event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
      const controls = modalControls(dialog), current = controls.indexOf(document.activeElement as HTMLElement);
      if (!controls.length || current < 0 || event.shiftKey && current === 0 || !event.shiftKey && current === controls.length - 1) {
        event.preventDefault(); (controls[event.shiftKey ? controls.length - 1 : 0] ?? dialog).focus();
      }
    };
    const focusout = () => queueMicrotask(keepFocus);
    document.addEventListener("keydown", keydown, true); document.addEventListener("focusin", keepFocus, true); dialog.addEventListener("focusout", focusout);
    const observer = new window.MutationObserver(keepFocus);
    observer.observe(dialog, { subtree: true, childList: true, attributes: true, attributeFilter: ["disabled","hidden","inert","aria-hidden","style","class","tabindex","open"] });
    (modalControls(dialog)[0] ?? dialog).focus();
    return () => {
      observer.disconnect(); document.removeEventListener("keydown", keydown, true); document.removeEventListener("focusin", keepFocus, true); dialog.removeEventListener("focusout", focusout);
      const index = modalStack.indexOf(dialog); if (index >= 0) modalStack.splice(index,1);
      dialog.close();
      requestAnimationFrame(() => {
        if (dialog.open) return; // React Strict Mode may already have reopened it.
        // Resolve an explicit fallback at close time: successful async actions
        // can disable/remove their trigger. The default opener was captured on
        // opening; async callers capture their trigger before starting work.
        const requested = returnFocusRef.current?.(), target = requested && available(requested) ? requested : opener.current;
        const parent = modalStack.at(-1);
        if (target instanceof HTMLElement && available(target) && (!parent || parent.contains(target))) target.focus();
        else if (parent?.open) (modalControls(parent)[0] ?? parent).focus();
      });
    };
  },[]);
  return <dialog ref={ref} tabIndex={-1} className="modal" aria-labelledby={titleId} onCancel={event=>{event.preventDefault();onClose();}} onClick={e=>{if(e.target===e.currentTarget)onClose();}}><div className="modal-heading"><h2 id={titleId}>{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={20}/></button></div>{children}</dialog>;
}
export function downloadJson(name:string,value:unknown){const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:"application/json"}));const a=document.createElement("a");a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
