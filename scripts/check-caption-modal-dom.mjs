/** Actual React regressions. Native focus, geometry, audio and screen-reader
 * acceptance remain root QA; all fetch responses here are isolated DOM data. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootPath=resolve(dirname(fileURLToPath(import.meta.url)),".."),harness=resolve(process.argv[2]??"missing-dom-harness"),mutant=process.argv[3]??null;
assert.ok(mutant===null||["missing-tab-wrap","stale-controls","hidden-controls","duplicate-save","stale-save-response"].includes(mutant));
const require=createRequire(resolve(rootPath,"package.json")),{JSDOM}=await import(pathToFileURL(resolve(harness,"node_modules/jsdom/lib/api.js")).href);
const dom=new JSDOM('<!doctype html><html><body tabindex="-1"><div id="root"></div></body></html>',{url:"http://localhost:4554",pretendToBeVisual:true});
for(const name of ["window","document","HTMLElement","HTMLDialogElement","HTMLInputElement","HTMLTextAreaElement","HTMLSelectElement","Event","MouseEvent","KeyboardEvent","CustomEvent","Node"])globalThis[name]=name==="window"?dom.window:name==="document"?dom.window.document:dom.window[name];
Object.defineProperty(globalThis,"navigator",{configurable:true,value:dom.window.navigator});globalThis.self=dom.window;
globalThis.requestAnimationFrame=dom.window.requestAnimationFrame.bind(dom.window);globalThis.cancelAnimationFrame=dom.window.cancelAnimationFrame.bind(dom.window);globalThis.IS_REACT_ACT_ENVIRONMENT=true;
dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;this.querySelector("button,input,select,textarea,[tabindex]")?.focus();};
dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;};
const {build}=require("esbuild");await mkdir(resolve(harness,"compiled"),{recursive:true});
const compiled=resolve(harness,`compiled/caption-modal-${mutant??"qualified"}.mjs`);
await build({stdin:{contents:'export {Modal} from "./src/components/studio/ui.tsx"; export {CaptionReviewEditor} from "./src/components/studio/caption-review-editor.tsx";',resolveDir:rootPath,sourcefile:"caption-modal-dom-entry.tsx",loader:"tsx"},outfile:compiled,
 bundle:true,platform:"node",format:"esm",target:"node22",jsx:"automatic",tsconfig:resolve(rootPath,"tsconfig.json"),loader:{".css":"empty"},logLevel:"silent",
 plugins:[{name:"isolated-dom-inputs",setup(api){
  api.onResolve({filter:/^(react(?:\/.*)?|react-dom(?:\/.*)?|lucide-react)$/},args=>({path:require.resolve(args.path),external:true}));
  if(mutant)api.onLoad({filter:mutant.includes("save")?/caption-review-editor\.tsx$/:/\/ui\.tsx$/},async args=>{
   let source=await readFile(args.path,"utf8");const changes={
    "missing-tab-wrap":[['document.addEventListener("keydown", keydown, true);','']],
    "stale-controls":[['const keydown = (event: KeyboardEvent) => {','const frozenControls = modalControls(dialog); const keydown = (event: KeyboardEvent) => {'],['const controls = modalControls(dialog), current =','const controls = frozenControls, current =']],
    "hidden-controls":[['.filter(element => element.tabIndex >= 0 && available(element))','.filter(element => element.tabIndex >= 0)']],
    "duplicate-save":[['if (!workspace || !draft || pending.current || refreshRequired) return;','if (!workspace || !draft || refreshRequired) return;']],
    "stale-save-response":[['const active = () => pending.current === operation && !operation.abort.signal.aborted && currentIdentity.current === operation.identity;','const active = () => true;']],
   };
   for(const [before,after]of changes[mutant]){assert.equal(source.split(before).length,2,"Mutants change one exact compiled input, never application source.");source=source.replace(before,after);}
   return{contents:source,loader:"tsx",resolveDir:dirname(args.path)};
  });
 }}]});
const React=require("react"),{act}=React,{createRoot}=require("react-dom/client"),{Modal,CaptionReviewEditor}=await import(pathToFileURL(compiled).href),h=React.createElement;
const root=createRoot(document.getElementById("root")),report={version:"guild.caption-web-modal-dom.v1",at:new Date().toISOString(),runtime:"jsdom@26.1.0 + actual React; native dialog presentation shim",mutant,nativeBrowserClaimed:false,realHumanDeclarations:0,providerCalls:0,checks:[],passed:false};
const frames=async()=>{await act(async()=>{await new Promise(resolve=>setTimeout(resolve,40));});};
const click=async element=>{assert.ok(element);await act(async()=>{element.click();});};
const key=async(element,shiftKey=false)=>{const event=new dom.window.KeyboardEvent("keydown",{key:"Tab",shiftKey,bubbles:true,cancelable:true});await act(async()=>{element.dispatchEvent(event);});return event;};
const escape=async dialog=>{const event=new dom.window.Event("cancel",{cancelable:true});await act(async()=>{if(dialog.dispatchEvent(event))dialog.open=false;});await frames();return event;};
const button=text=>[...document.querySelectorAll("button")].find(item=>item.textContent.trim()===text);
const check=name=>report.checks.push({name,passed:true});
const originalFetch=globalThis.fetch,pendingGets=[],pendingPosts=[];let reviewEvents=0,dirtyValues=[];
globalThis.fetch=async(url,init={})=>new Promise(resolve=>{assert.match(String(url),/^\/api\/artifacts\/[a-f0-9-]+\/caption-review/);(init.method==="POST"?pendingPosts:pendingGets).push({url:String(url),init,body:init.body?JSON.parse(init.body):null,resolve});});
const receive=async(queue,data,status=200)=>{const item=queue.shift();assert.ok(item);await act(async()=>{item.resolve(Response.json(data,{status}));});await frames();return item;};
const input=async(element,value)=>{assert.ok(element);await act(async()=>{const prototype=element instanceof dom.window.HTMLTextAreaElement?dom.window.HTMLTextAreaElement.prototype:element instanceof dom.window.HTMLSelectElement?dom.window.HTMLSelectElement.prototype:dom.window.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,"value").set.call(element,value);element.dispatchEvent(new dom.window.Event(element.tagName==="SELECT"?"change":"input",{bubbles:true}));});};
window.addEventListener("guild:caption-review-saved",()=>reviewEvents++);
let controls={};
function ModalExample(){
 const[open,setOpen]=React.useState(false),[phase,setPhase]=React.useState(0),[busy,setBusy]=React.useState(false),[fallback,setFallback]=React.useState(1),[disabled,setDisabled]=React.useState(false);
 controls={setOpen,setPhase,setBusy,setFallback,setDisabled};
 return h(React.Fragment,null,h("button",{id:"ordinary-opener",disabled,onClick:()=>setOpen(true)},"Open ordinary dialog"),h("button",{id:"outside"},"Outside"),h("h2",{id:`fallback-${fallback}`,"data-current-fallback":true,tabIndex:-1},"Current fallback"),
  open&&h(Modal,{title:"A complete focus boundary",onClose:()=>{if(!busy)setOpen(false);},...(phase===4?{returnFocus:()=>document.querySelector("[data-current-fallback]")}:{})},
   phase!==3&&h(React.Fragment,null,h("input",{id:"first-input","aria-label":"First input"}),h("button",{id:"middle"},"Middle"),h("fieldset",{disabled:true},h("button",{id:"disabled-field"},"Disabled field")),
    h("div",{hidden:true},h("button",{id:"hidden-parent"},"Hidden parent")),h("div",{style:{display:"none"}},h("button",{id:"display-none"},"Display none")),h("div",{"aria-hidden":"true"},h("button",{id:"aria-hidden"},"Hidden accessibility tree")),
    h("div",{inert:true},h("button",{id:"inert"},"Inert")),h("details",null,h("summary",null,"Closed detail"),h("button",{id:"closed-detail"},"Closed contents")),
    h("button",{id:"last",disabled:phase===1},"Last enabled action"),phase>=1&&h("button",{id:"dynamic"},"Dynamic last action"),h("button",{disabled:true,id:"disabled-last"},"Disabled last"),h("button",{style:{visibility:"hidden"},id:"invisible-last"},"Invisible last"))));
}
const makeScope=locale=>({artifactId:randomUUID(),artifactHash:(locale==="ar"?"b":"a").repeat(64),source:{locale,key:"welcome",mediaId:randomUUID(),text:locale==="ar"?"عنوان كلمات.":"Title words.",durationSeconds:4,title:locale==="ar"?"عنوان":"Title"}});
function workspace(scope,latest=true){
 const draft={disposition:"timing_review",note:"Synthetic DOM draft only; no person listened.",units:[{sourceStart:0,sourceEnd:6,heard:"heard",startMs:0,endMs:1000,origin:"manual",providerWordIndex:null},{sourceStart:6,sourceEnd:scope.source.text.length,heard:"heard",startMs:1100,endMs:2000,origin:"manual",providerWordIndex:null}]};
 const revision={id:randomUUID(),digest:"d".repeat(64),artifactId:scope.artifactId,artifactHash:scope.artifactHash,locale:scope.source.locale,key:scope.source.key,parentRevisionId:null,draft,attestation:null,actorRole:"owner",createdAt:new Date().toISOString(),evaluation:{status:"ready-for-review",codes:[],cues:[{index:1,start:0,end:2,sourceStart:0,sourceEnd:scope.source.text.length,text:scope.source.text,lines:[scope.source.text]}],vtt:"WEBVTT\n",coveredUnits:2,totalUnits:2}};
 return{artifactId:scope.artifactId,artifactHash:scope.artifactHash,source:scope.source,provider:"Synthetic DOM observation",recognition:scope.source.text,observedWords:[],observationCodes:[],rawBodyHash:"e".repeat(64),initialUnits:draft.units,latestRevision:latest?revision:null,
  history:latest?[{id:revision.id,digest:revision.digest,parentRevisionId:null,author:"SYNTHETIC fixture",createdAt:revision.createdAt,listeningAttested:false}]:[],canAttest:true,authorityExpired:false,authorityExpiresAt:new Date(Date.now()+3600_000).toISOString(),nextAction:"Synthetic DOM only; no API write or human participation."};
}
async function editor(scope){await act(async()=>{root.render(h(CaptionReviewEditor,{...scope,position:0,playRange:()=>{},onDirty:value=>dirtyValues.push(value)}));});}
function savedRevision(ws,request,attest=false){return{...ws.latestRevision,id:randomUUID(),artifactId:ws.artifactId,artifactHash:ws.artifactHash,locale:ws.source.locale,key:ws.source.key,requestId:request.requestId,parentRevisionId:request.parentRevisionId,draft:request.draft??ws.latestRevision.draft,
 attestation:attest?{reviewerName:request.reviewerName,statement:"SYNTHETIC DOM response. No person listened.",humanDeclaredListening:true,fluentReviewed:false}:null,createdAt:new Date().toISOString()};}

try{
 await act(async()=>{root.render(h(ModalExample));});
 const opener=document.getElementById("ordinary-opener");opener.focus();await click(opener);
 let dialog=document.querySelector("dialog"),close=dialog.querySelector('[aria-label="Close dialog"]');assert.equal(document.activeElement,close);
 document.getElementById("last").focus();assert.equal((await key(document.activeElement)).defaultPrevented,true);assert.equal(document.activeElement,close);
 assert.equal((await key(close,true)).defaultPrevented,true);assert.equal(document.activeElement.id,"last");
 check("first control and both Tab boundaries exclude hidden, inert, disabled and closed-detail descendants");
 await act(async()=>controls.setPhase(1));await frames();document.getElementById("dynamic").focus();assert.equal((await key(document.activeElement)).defaultPrevented,true);assert.equal(document.activeElement,close);await key(close,true);assert.equal(document.activeElement.id,"dynamic");
 document.body.focus();assert.ok(dialog.contains(document.activeElement));document.getElementById("dynamic").focus();await act(async()=>controls.setPhase(0));await frames();assert.equal(document.activeElement,close);
 document.getElementById("last").focus();await act(async()=>{document.getElementById("last").disabled=true;});await frames();assert.equal(document.activeElement,close);
 await act(async()=>controls.setPhase(3));close.disabled=true;await frames();assert.equal(document.activeElement,dialog);assert.equal((await key(dialog)).defaultPrevented,true);assert.equal(document.activeElement,dialog);close.disabled=false;await key(dialog);assert.equal(document.activeElement,close);
 check("dynamic controls, removed/disabled focus, outside focus loss and an empty focus set keep the dialog boundary");
 await act(async()=>controls.setBusy(true));assert.equal((await escape(dialog)).defaultPrevented,true);assert.ok(document.querySelector("dialog")?.open);await act(async()=>controls.setBusy(false));await escape(dialog);assert.equal(document.querySelector("dialog"),null);assert.equal(document.activeElement,opener);
 opener.focus();await act(async()=>{controls.setPhase(4);controls.setOpen(true);});dialog=document.querySelector("dialog");await act(async()=>{controls.setDisabled(true);controls.setFallback(2);});await frames();await act(async()=>controls.setOpen(false));await frames();assert.equal(document.activeElement.id,"fallback-2");
 check("busy cancel prevents native close; ordinary Escape and async success restore exact default or close-time fallback focus");

 const a=makeScope("en"),wa=workspace(a),b=makeScope("ar"),wb=workspace(b);await editor(a);assert.equal(pendingGets.length,1);await editor(b);assert.equal(pendingGets.length,2);
 const old=pendingGets.shift();assert.equal(old.init.signal.aborted,true);await receive(pendingGets,wb);await act(async()=>old.resolve(Response.json(wa)));await frames();assert.ok(document.querySelector('[aria-label="العربية caption review and correction"]'));assert.equal(document.querySelector('[aria-label="English caption review and correction"]'),null);
 check("late GET for an earlier artifact/locale cannot replace the current original recording");
 await input(document.querySelector(".caption-review-form textarea"),"Synthetic edited draft for duplicate-request and response identity checks.");const save=button("Save measured draft");assert.ok(save&&!save.disabled);await act(async()=>{save.click();save.click();});assert.equal(pendingPosts.length,1,"Same-tick activation owns one pending save.");
 const bad=pendingPosts[0],badRevision=savedRevision(wb,bad.body);badRevision.artifactId=randomUUID();await receive(pendingPosts,{revision:badRevision});assert.match(document.querySelector('[role="alert"]').textContent,/does not identify this exact/);assert.equal(reviewEvents,0);assert.ok(dirtyValues.at(-1));
 await click(button("Save measured draft"));assert.deepEqual(pendingPosts[0].body,bad.body,"Unchanged unknown request keeps exact operation and payload.");const acceptedDraft=savedRevision(wb,pendingPosts[0].body);await receive(pendingPosts,{revision:acceptedDraft});assert.equal(reviewEvents,1);assert.equal(dirtyValues.at(-1),false);
 check("one save dispatch, foreign response refusal, exact unknown retry identity and confirmed draft state");
 let trigger=button("Record my listening review");trigger.focus();await click(trigger);dialog=document.querySelector("dialog");close=dialog.querySelector('[aria-label="Close dialog"]');const keep=button("Keep listening");keep.focus();assert.equal((await key(keep)).defaultPrevented,true);assert.equal(document.activeElement,close);
 await input(dialog.querySelector('input:not([type="checkbox"])'),"SYNTHETIC DOM ACTOR — no person listened");for(const item of dialog.querySelectorAll('input[type="checkbox"]'))await click(item);
 const declare=button("Save my declaration");assert.ok(!declare.disabled);declare.focus();await key(declare);assert.equal(document.activeElement,close);await key(close,true);assert.equal(document.activeElement,declare);await click(declare);assert.equal(pendingPosts.length,1);assert.equal((await escape(dialog)).defaultPrevented,true);assert.ok(document.querySelector("dialog")?.open);
 await receive(pendingPosts,{message:"A newer synthetic revision is retained."},409);assert.match(dialog.querySelector('[role="alert"]').textContent,/read saved history/);await click(button("Close and review saved history"));await frames();assert.equal(document.querySelector("dialog"),null);assert.equal(document.activeElement.textContent,"A careful word at a time.");
 await click(button("Read saved history · discard local edits"));const newer={...wb,latestRevision:acceptedDraft,history:[...wb.history,{id:acceptedDraft.id,digest:acceptedDraft.digest,parentRevisionId:acceptedDraft.parentRevisionId,author:"SYNTHETIC DOM actor",createdAt:acceptedDraft.createdAt,listeningAttested:false}]};await receive(pendingGets,newer);
 trigger=button("Record my listening review");trigger.focus();await click(trigger);dialog=document.querySelector("dialog");assert.ok([...dialog.querySelectorAll('input[type="checkbox"]')].every(item=>!item.checked));await input(dialog.querySelector('input:not([type="checkbox"])'),"SYNTHETIC DOM ACTOR — no person listened");for(const item of dialog.querySelectorAll('input[type="checkbox"]'))await click(item);
 await click(button("Save my declaration"));const declarationRequest=pendingPosts[0];assert.equal(declarationRequest.body.parentRevisionId,acceptedDraft.id);await receive(pendingPosts,{revision:savedRevision(newer,declarationRequest.body,true)});assert.equal(document.querySelector("dialog"),null);assert.equal(document.activeElement.textContent,"A careful word at a time.");assert.equal(reviewEvents,2);
 check("caption modal dynamic Tab, busy Escape, explicit stale409/history recovery, unchecked declarations and successful return focus");
 await editor(a);await receive(pendingGets,wa);await input(document.querySelector(".caption-review-form textarea"),"Synthetic in-flight request for late-identity regression only.");await click(button("Save measured draft"));assert.equal(pendingPosts.length,1);const late=pendingPosts.shift();
 const leave=new dom.window.Event("guild:caption-review-leave",{cancelable:true});let canLeave;await act(async()=>{canLeave=window.dispatchEvent(leave);});assert.equal(canLeave,false,"Pending saves protect navigation.");await editor(b);assert.equal(late.init.signal.aborted,true);await receive(pendingGets,wb);const before=reviewEvents;
 await act(async()=>late.resolve(Response.json({revision:savedRevision(wa,late.body)})));await frames();assert.equal(reviewEvents,before);assert.ok(document.querySelector('[aria-label="العربية caption review and correction"]'));assert.equal(button("Save measured draft").disabled,true);
 check("late POST has no state/global refresh effect; pending/dirty navigation and the next recording remain intact");
 report.passed=true;
}catch(error){report.error={message:error.message,stack:error.stack};throw error;}
finally{
 await act(async()=>root.unmount());await frames();globalThis.fetch=originalFetch;dom.window.close();const path=resolve(harness,`caption-modal-${mutant??"qualified"}-${new Date().toISOString().replaceAll(":","-")}.json`);await writeFile(path,JSON.stringify(report,null,2)+"\n",{mode:0o600});console.log(JSON.stringify({reportPath:path,passed:report.passed,checks:report.checks.length,mutant,nativeBrowserClaimed:false,realHumanDeclarations:0}));
}
