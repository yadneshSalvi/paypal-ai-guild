import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { createSampleCommission } from "../src/domain/fixture";
import { SAMPLE_ENTRY_STORAGE } from "../src/components/studio/sample-entry";

/** Mount the actual Studio admission flow. Other studio views are replaced by
 * inert renderers; these cases make no browser, HTTP, database or provider claim. */
test("Studio opens Samples only through an explicit, recoverable action",async t=>{
  const require=createRequire(new URL("../package.json",import.meta.url)),{JSDOM}=require("jsdom");
  const dom=new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',{url:"http://sample-entry.test/",pretendToBeVisual:true});
  const directory=await mkdtemp(resolve(tmpdir(),"guild-sample-entry-dom-")),bundle=resolve(directory,"studio.mjs");
  const original=new Map<string,PropertyDescriptor|undefined>();
  const globals={window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,MouseEvent:dom.window.MouseEvent,KeyboardEvent:dom.window.KeyboardEvent,Node:dom.window.Node,location:dom.window.location,history:dom.window.history,sessionStorage:dom.window.sessionStorage,crypto:webcrypto,IS_REACT_ACT_ENVIRONMENT:true,requestAnimationFrame:(fn:FrameRequestCallback)=>setTimeout(()=>fn(0),0),addEventListener:dom.window.addEventListener.bind(dom.window),removeEventListener:dom.window.removeEventListener.bind(dom.window)};
  for(const [key,value] of Object.entries(globals)){original.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,value});}
  Object.defineProperty(dom.window,"matchMedia",{value:()=>({matches:false,addEventListener(){},removeEventListener(){}})});dom.window.scrollTo=()=>{};
  await build({stdin:{contents:'export { Studio } from "./src/components/studio/studio.tsx";',resolveDir:process.cwd(),loader:"tsx"},outfile:bundle,bundle:true,platform:"node",format:"esm",jsx:"automatic",tsconfig:resolve("tsconfig.json"),logLevel:"silent",plugins:[{name:"entry-only-render-boundaries",setup(api){
    api.onResolve({filter:/^(react(?:\/.*)?|react-dom(?:\/.*)?)$/},args=>({path:require.resolve(args.path),external:true}));
    api.onResolve({filter:/^(next\/link|\.\/views|\.\/settlement|\.\/production-floor|\.\/ui)$/},args=>({path:args.path,namespace:"inert-studio-views"}));
    api.onLoad({filter:/.*/,namespace:"inert-studio-views"},args=>({loader:"tsx",contents:args.path==="next/link"?'import React from "react";export default function Link({href,children}){return <a href={href}>{children}</a>}':args.path==="./views"?'import React from "react";export function Overview({c}){return <section data-commission={c.id}>Original commission {c.id}</section>}export const Market=Overview,Passport=Overview,Review=Overview,Collection=Overview,Activity=Overview;':args.path==="./settlement"?'export const Settlement=()=>null;':args.path==="./production-floor"?'export const ProductionFloor=()=>null;':'import React from "react";export const Modal=({children})=><div role="dialog">{children}</div>;export const downloadJson=()=>{};'}));
  }}]});
  const React=require("react") as typeof import("react"),{act}=React,{createRoot}=require("react-dom/client") as typeof import("react-dom/client"),{Studio}=await import(pathToFileURL(bundle).href);
  type Call={url:string;method:string;body:Record<string,unknown>|null};let calls:Call[]=[],respond:(call:Call)=>Promise<Response>=async()=>Response.json({message:"Open a workspace"},{status:401});
  const fetchBefore=globalThis.fetch,errorBefore=console.error,errors:string[]=[];let root:ReturnType<typeof createRoot>|null=null;
  console.error=(...values:unknown[])=>{errors.push(values.map(String).join(" "));};
  globalThis.fetch=async(input,init)=>{const call={url:String(input),method:init?.method??"GET",body:init?.body?JSON.parse(String(init.body)):null};calls.push(call);return respond(call);};
  const posts=()=>calls.filter(call=>call.method==="POST"),button=(label:string)=>[...document.querySelectorAll<HTMLButtonElement>("button")].find(item=>(item.getAttribute("aria-label")??item.textContent??"").replace(/\s+/g," ").trim()===label)!;
  async function flush(){await act(async()=>{await new Promise(resolve=>setTimeout(resolve,10));});}
  async function unmount(){if(root){await act(async()=>root!.unmount());root=null;}await flush();}
  async function mount(path="/",clear=true){await unmount();history.replaceState({},"",path);if(clear)sessionStorage.clear();calls=[];root=createRoot(document.getElementById("root")!);await act(async()=>root!.render(React.createElement(React.StrictMode,null,React.createElement(Studio))));await flush();}
  async function click(label:string){const element=button(label);assert.ok(element,"Missing action: "+label);await act(async()=>element.click());await flush();}
  function snapshot(){const commission=createSampleCommission("00000000-0000-4000-8000-000000000001");return {commission,session:{id:"00000000-0000-4000-8000-000000000002",tenantId:commission.tenantId,role:"judge",expiresAt:new Date(Date.now()+3600000).toISOString()},serverTime:new Date().toISOString(),approvalDigest:"a".repeat(64),authorityDeadline:new Date(Date.now()+3600000).toISOString()};}
  try{
    await t.test("anonymous initial mount, StrictMode and refresh are read-only",async()=>{
      respond=async()=>Response.json({message:"Open a workspace"},{status:401});await mount();assert.equal(calls.length,1);assert.equal(calls[0]!.method,"GET");assert.ok(button("Open a Sample commission"));assert.equal(sessionStorage.getItem(SAMPLE_ENTRY_STORAGE),null);
      await click("Refresh workspace");assert.equal(posts().length,0);assert.equal(calls.length,2);assert.equal(sessionStorage.getItem(SAMPLE_ENTRY_STORAGE),null);
    });
    await t.test("same-turn duplicate clicks dispatch one persisted request",async()=>{
      let resolvePost:(response:Response)=>void=()=>{};const workspace=snapshot();respond=async call=>call.method==="GET"?Response.json({message:"Open"},{status:401}):new Promise(resolve=>{assert.ok(sessionStorage.getItem(SAMPLE_ENTRY_STORAGE));resolvePost=resolve;});await mount();const entry=button("Open a Sample commission");
      await act(async()=>{entry.click();entry.click();});assert.equal(posts().length,1);assert.equal(JSON.stringify(posts()[0]!.body),sessionStorage.getItem(SAMPLE_ENTRY_STORAGE));assert.ok([...document.querySelectorAll<HTMLButtonElement>("button")].some(item=>item.disabled&&item.textContent?.includes("Opening the original")));
      await act(async()=>resolvePost(Response.json(workspace,{status:201})));await flush();assert.equal(document.querySelector("[data-commission]")?.getAttribute("data-commission"),workspace.commission.id);assert.equal(new URLSearchParams(location.search).get("commission"),workspace.commission.id);assert.equal(sessionStorage.getItem(SAMPLE_ENTRY_STORAGE),null);assert.equal(posts().length,1);
    });
    await t.test("an authenticated empty workspace offers explicit entry without an automatic POST",async()=>{
      respond=async()=>Response.json({code:"WORKSPACE_EMPTY",message:"No commission yet"},{status:404});await mount();assert.equal(posts().length,0);assert.ok(button("Open a Sample commission"));assert.equal(sessionStorage.getItem(SAMPLE_ENTRY_STORAGE),null);await click("Refresh workspace");assert.equal(posts().length,0);
    });
    await t.test("lost response keeps the exact original request through reload and explicit recovery",async()=>{
      respond=async call=>{if(call.method==="POST")throw Error("Connection ended before response");return Response.json({message:"Open"},{status:401});};await mount();await click("Open a Sample commission");const originalRequest=posts()[0]!.body,retained=sessionStorage.getItem(SAMPLE_ENTRY_STORAGE);assert.ok(retained);assert.ok(button("Recover this Sample"));assert.equal(posts().length,1);
      await mount("/",false);assert.equal(posts().length,0);assert.equal(sessionStorage.getItem(SAMPLE_ENTRY_STORAGE),retained);const workspace=snapshot();respond=async()=>Response.json(workspace);await click("Recover this Sample");assert.deepEqual(posts()[0]!.body,originalRequest);assert.equal(posts().length,1);assert.equal(new URLSearchParams(location.search).get("commission"),workspace.commission.id);
    });
    await t.test("a cookie received before a lost response opens its original workspace without a second POST",async()=>{
      const workspace=snapshot();respond=async()=>Response.json(workspace);await mount();assert.equal(posts().length,0);assert.equal(document.querySelector("[data-commission]")?.getAttribute("data-commission"),workspace.commission.id);assert.equal(button("Open a Sample commission"),undefined);
    });
    await t.test("a saved or previously opened workspace is never replaced when access ends",async()=>{
      respond=async()=>Response.json({message:"Ended"},{status:401});await mount("/?commission=00000000-0000-4000-8000-000000000099");assert.match(document.body.textContent??"",/new sample cannot replace/);assert.equal(button("Open a Sample commission"),undefined);assert.equal(posts().length,0);
      const workspace=snapshot();respond=async()=>Response.json(workspace);await mount();respond=async()=>Response.json({message:"Ended"},{status:401});await click("Refresh workspace");assert.equal(posts().length,0);assert.equal(document.querySelector("[data-commission]")?.getAttribute("data-commission"),workspace.commission.id);assert.match(document.body.textContent??"",/new sample cannot replace/);
    });
    await t.test("corrupt storage blocks replacement and unavailable storage blocks dispatch",async()=>{
      respond=async()=>Response.json({message:"Open"},{status:401});await unmount();sessionStorage.setItem(SAMPLE_ENTRY_STORAGE,"not-json");await mount("/",false);assert.match(document.body.textContent??"",/No new Sample was started/);assert.equal(posts().length,0);assert.equal(button("Open a Sample commission"),undefined);assert.equal(sessionStorage.getItem(SAMPLE_ENTRY_STORAGE),"not-json");
      await mount();const prototype=Object.getPrototypeOf(sessionStorage),set=prototype.setItem;prototype.setItem=()=>{throw Error("storage unavailable");};try{await click("Open a Sample commission");assert.equal(posts().length,0);assert.match(document.body.textContent??"",/No Sample was started/);}finally{prototype.setItem=set;}
    });
    await t.test("an expired original request requires a separate explicit preparation and click",async()=>{
      respond=async call=>call.method==="GET"?Response.json({message:"Open"},{status:401}):Response.json({message:"The original entry expired"},{status:410});await mount();await click("Open a Sample commission");const originalRequest=posts()[0]!.body;assert.ok(button("Recover this Sample").disabled);await click("Prepare a separate Sample");assert.equal(posts().length,1);assert.equal(sessionStorage.getItem(SAMPLE_ENTRY_STORAGE),null);assert.ok(button("Open a Sample commission"));await click("Open a Sample commission");assert.equal(posts().length,2);assert.notEqual(posts()[1]!.body!.requestId,originalRequest!.requestId);
    });
    assert.deepEqual(errors,[]);
  }finally{await unmount();globalThis.fetch=fetchBefore;console.error=errorBefore;dom.window.close();for(const [key,descriptor] of original){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}await rm(directory,{recursive:true});}
});
