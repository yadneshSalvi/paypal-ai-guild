"use client";
import { useEffect,useRef } from "react";
import { X,ArrowUpRight,Check,LoaderCircle } from "lucide-react";
import type { CommissionCommand,Provenance,WorkPackage } from "@/contracts/guild";
export type Action=CommissionCommand extends infer C?C extends CommissionCommand?Omit<C,"commandId"|"expectedRevision">:never:never;
export type ActResult={ok:true}|{ok:false;message:string};
export type Act=(action:Action)=>Promise<ActResult>;
export const money=(minor:number)=>new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:minor%100?2:0}).format(minor/100);
export const when=(value:string)=>new Intl.DateTimeFormat("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}).format(new Date(value));
const states:Record<WorkPackage["state"],string>={draft:"Draft contract",bidding:"Taking proposals",awarded:"Ready for production",producing:"In production",submitted:"Ready for checks",verifying:"Checking the work",awaiting_acceptance:"Your review",accepted:"Accepted",correction_requested:"Correction requested",rejected:"Not accepted",withdrawn:"Withdrawn"};
export function State({state}:{state:WorkPackage["state"]}){return <span className={`state state-${state}`}>{state==="accepted"?<Check size={12}/>:state==="producing"?<LoaderCircle className="spin" size={12}/>:<i/>}{states[state]}</span>;}
export function SourceTag({source}:{source:Provenance}){return <span className={`source-tag source-${source.mode}`} title={source.label}>{source.mode==="live"?"Actual artifact":source.mode==="sample"?"Sample":source.mode==="replay"?"Recorded replay":"Modelled"}</span>;}
export function External({href,children}:{href:string;children:React.ReactNode}){return <a href={href} target="_blank" rel="noreferrer">{children}<ArrowUpRight size={14}/></a>;}
export function Modal({title,onClose,children}:{title:string;onClose:()=>void;children:React.ReactNode}){
  const ref=useRef<HTMLDialogElement>(null);
  useEffect(()=>{const previous=document.activeElement;ref.current?.showModal();return()=>{ref.current?.close();if(previous instanceof HTMLElement)previous.focus();};},[]);
  return <dialog ref={ref} className="modal" aria-labelledby="dialog-title" onCancel={onClose} onClick={e=>{if(e.target===e.currentTarget)onClose();}}><div className="modal-heading"><h2 id="dialog-title">{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={20}/></button></div>{children}</dialog>;
}
export function downloadJson(name:string,value:unknown){const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:"application/json"}));const a=document.createElement("a");a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
