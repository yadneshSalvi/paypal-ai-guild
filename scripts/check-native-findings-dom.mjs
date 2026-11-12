/** Root's removed-trigger/BODY regression, exercised on the actual component.
 * This is a DOM focus proof, not a native browser or accessibility admission. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const rootPath=resolve(dirname(fileURLToPath(import.meta.url)),".."),harness=resolve(process.argv[2]??"missing-independent-dom-harness"),mutant=process.argv[3]??null;
assert.ok(mutant===null||["missing-result-focus","steal-background-focus"].includes(mutant));
const require=createRequire(resolve(rootPath,"package.json")),{JSDOM}=await import(pathToFileURL(resolve(harness,"node_modules/jsdom/lib/api.js")).href);
const dom=new JSDOM('<!doctype html><html><body tabindex="-1"><button id="outside">Continue elsewhere</button><div id="root"></div></body></html>',{url:"http://localhost:4554",pretendToBeVisual:true});
for(const name of ["window","document","HTMLElement","Event","MouseEvent","Node"])globalThis[name]=name==="window"?dom.window:name==="document"?dom.window.document:dom.window[name];
Object.defineProperty(globalThis,"navigator",{configurable:true,value:dom.window.navigator});globalThis.self=dom.window;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const {build}=require("esbuild");await mkdir(resolve(harness,"compiled"),{recursive:true});const compiled=resolve(harness,`compiled/native-findings-${mutant??"qualified"}.mjs`);
await build({stdin:{contents:'export {NativeFindings} from "./src/components/studio/web-audit-cases.tsx";',resolveDir:rootPath,sourcefile:"native-findings-dom-entry.tsx",loader:"tsx"},outfile:compiled,bundle:true,platform:"node",format:"esm",target:"node22",jsx:"automatic",tsconfig:resolve(rootPath,"tsconfig.json"),loader:{".css":"empty"},logLevel:"silent",
 plugins:[{name:"isolated-component-inputs",setup(api){api.onResolve({filter:/^(react(?:\/.*)?|react-dom(?:\/.*)?|lucide-react)$/},args=>({path:require.resolve(args.path),external:true}));if(mutant)api.onLoad({filter:/web-audit-cases\.tsx$/},async args=>{
  let source=await readFile(args.path,"utf8");const before=mutant==="missing-result-focus"?'if (target) target.focus();':'focusRequested.current = focusRequested.current && (document.activeElement === loadingTarget.current || document.activeElement === document.body);';
  assert.equal(source.split(before).length,mutant==="missing-result-focus"?2:3);source=source.replaceAll(before,mutant==="missing-result-focus"?"":"focusRequested.current = true;");return{contents:source,loader:"tsx",resolveDir:dirname(args.path)};
 });}}]});
const React=require("react"),{act}=React,{createRoot}=require("react-dom/client"),{NativeFindings}=await import(pathToFileURL(compiled).href),h=React.createElement,root=createRoot(document.getElementById("root"));
const originalFetch=globalThis.fetch,pending=[],requests=[];
globalThis.fetch=async(url,init)=>new Promise(resolve=>{assert.match(String(url),/^\/api\/web-jobs\/[a-f0-9-]+\/audit\?caseId=[a-f0-9-]+&view=findings$/);requests.push({url:String(url),init});pending.push({url:String(url),init,resolve});});
const report={version:"guild.caption-web-native-findings-dom.v1",at:new Date().toISOString(),mutant,nativeBrowserClaimed:false,originalAuditCalls:0,newAuditCalls:0,checks:[],passed:false};
const frames=async()=>{await act(async()=>{await new Promise(resolve=>setTimeout(resolve,25));});};
const click=async element=>{assert.ok(element);element.focus();await act(async()=>element.click());await frames();};
const settle=async(data,status=200)=>{const request=pending.shift();assert.ok(request);await act(async()=>request.resolve(Response.json(data,{status})));await frames();return request;};
const check=name=>report.checks.push({name,passed:true});
function fixture(){const id=randomUUID(),jobId=randomUUID(),artifactId=randomUUID(),result={locale:"en",sourceDigest:"a".repeat(64),designDigest:"b".repeat(64),bundleDigest:"c".repeat(64),viewport:{width:390,height:844}};
 return{receipt:{id,result},jobId,artifactId,ordinal:1,body:{schemaVersion:"guild.web-native-findings.v1",caseId:id,jobId,locale:"en",sourceDigest:result.sourceDigest,designDigest:result.designDigest,bundleDigest:result.bundleDigest,
  states:[{state:"default",violations:[{id:"synthetic-retained-finding",impact:"moderate",help:"Synthetic original finding",description:"Controlled DOM evidence only.",nodes:[{target:["#original"],html:"<script>synthetic text, never executed</script>",failureSummary:"Synthetic retained explanation"}]}],incomplete:[]},{state:"expanded",violations:[],incomplete:[]}],lighthouse:{audits:{synthetic:{title:"Original synthetic audit",score:1}}}}};}
const render=async f=>{await act(async()=>root.render(h(NativeFindings,{...f,key:f.receipt.id})));await frames();};
try{
 let f=fixture();await render(f);const trigger=document.querySelector("#root button");await click(trigger);assert.equal(trigger.isConnected,false);assert.equal(document.activeElement.getAttribute("role"),"status");await settle(f.body);
 assert.equal(document.activeElement,document.querySelector(".web-native-state h5"));assert.equal(document.activeElement.textContent,"default state");assert.equal(document.querySelector("#root script"),null);assert.match(document.querySelector("pre").textContent,/#original/);
 check("removed Read-every-original trigger transfers focus through loading to the first loaded state heading; raw markup remains text");
 f=fixture();await render(f);await click(document.querySelector("#root button"));const outside=document.getElementById("outside");outside.focus();await settle(f.body);assert.ok(document.activeElement===outside,"A completed original read must not steal focus from the user’s next action.");
 check("a slow original read does not steal focus after the user continues elsewhere");
 f=fixture();await render(f);await click(document.querySelector("#root button"));const firstUrl=pending[0].url;await settle({message:"Synthetic temporary original-read failure"},503);assert.equal(document.activeElement.getAttribute("role"),"alert");
 await click(document.querySelector("#root button"));assert.equal(pending[0].url,firstUrl);await settle({...f.body,locale:"ar"});assert.match(document.querySelector('[role="alert"]').textContent,/exact original browser case/);assert.equal(document.querySelector(".web-native-state"),null);
 await click(document.querySelector("#root button"));assert.equal(pending[0].url,firstUrl);await settle(f.body);assert.equal(document.activeElement,document.querySelector(".web-native-state h5"));
 check("failed reads remain failures; retry keeps the exact original case; wrong-locale/source responses cannot appear as verified findings");
 f=fixture();await render(f);await click(document.querySelector("#root button"));const late=pending.shift();const next=fixture();await render(next);assert.equal(late.init.signal.aborted,true);const newTrigger=document.querySelector("#root button");newTrigger.focus();await act(async()=>late.resolve(Response.json(f.body)));await frames();assert.ok(document.activeElement===newTrigger,"An earlier case must not move focus in the next case.");assert.equal(document.querySelector(".web-native-state"),null);
 check("an unmounted earlier case cannot replace evidence or move focus in the next case");
 assert.ok(requests.every(request=>request.init.cache==="no-store"&&request.init.signal));report.passed=true;
}catch(error){report.error={message:error.message,stack:error.stack};throw error;}
finally{await act(async()=>root.unmount());globalThis.fetch=originalFetch;dom.window.close();const path=resolve(harness,`native-findings-${mutant??"qualified"}-${new Date().toISOString().replaceAll(":","-")}.json`);await writeFile(path,JSON.stringify(report,null,2)+"\n",{mode:0o600});console.log(JSON.stringify({reportPath:path,passed:report.passed,checks:report.checks.length,mutant,nativeBrowserClaimed:false,newAuditCalls:0}));}
