import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { sampleEntryRequestSchema } from "../src/contracts/sample-entry";
import { sampleEntryIdentity } from "../src/server/sample-entry";
import { clearSampleEntry, prepareSampleEntry, retainedSampleEntry, SAMPLE_ENTRY_STORAGE } from "../src/components/studio/sample-entry";

const key="synthetic-sample-entry-unit-key-at-least-24-characters";
const request=()=>({version:"guild.sample-entry.v1" as const,intent:"open_sample" as const,requestId:randomUUID(),proof:randomBytes(32).toString("base64url"),requestedAt:new Date().toISOString()});
function storage(){const data=new Map<string,string>();return {data,getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value);},removeItem:(key:string)=>{data.delete(key);}};}

test("an explicit original admission has stable session, tenant and signed cookie identities",()=>{
  const input=request(),first=sampleEntryIdentity(input,key),recovered=sampleEntryIdentity(JSON.parse(JSON.stringify(input)),key);
  assert.deepEqual(first,recovered);assert.notEqual(first.id,first.tenantId);
  const [token,signature]=first.cookie.split(".");assert.equal(signature,createHmac("sha256",key).update(token!).digest("hex"));assert.equal(first.tokenHash,createHash("sha256").update(token!).digest("hex"));
  for(const patch of [{proof:randomBytes(32).toString("base64url")},{requestedAt:new Date(Date.parse(input.requestedAt)+1).toISOString()}]){
    const changed=sampleEntryIdentity({...input,...patch},key);assert.equal(changed.id,first.id);assert.equal(changed.tenantId,first.tenantId);assert.notEqual(changed.tokenHash,first.tokenHash);
  }
  assert.notEqual(sampleEntryIdentity({...input,requestId:randomUUID()},key).id,first.id);
});
test("entry accepts no caller role, tenant, duration or substitute intent",()=>{
  for(const extra of [{role:"owner"},{tenantId:randomUUID()},{expiresAt:new Date().toISOString()},{duration:8},{intent:"refresh"},{version:"guild.sample-entry.v2"},{proof:"short"}]) assert.equal(sampleEntryRequestSchema.safeParse({...request(),...extra}).success,false);
  assert.throws(()=>sampleEntryIdentity(request(),"short"),/not configured/);
});
test("the tab persists the original request before dispatch and keeps unrelated storage",()=>{
  const tab=storage();tab.setItem("other-project","preserved");const first=prepareSampleEntry(tab);assert.deepEqual(retainedSampleEntry(tab),first);assert.deepEqual(prepareSampleEntry(tab),first);
  clearSampleEntry(tab,randomUUID());assert.deepEqual(retainedSampleEntry(tab),first);
  clearSampleEntry(tab,first.requestId);assert.equal(retainedSampleEntry(tab),null);assert.equal(tab.getItem("other-project"),"preserved");assert.notEqual(prepareSampleEntry(tab).requestId,first.requestId);
});
test("unreadable or unavailable storage refuses implicit replacement",()=>{
  const tab=storage();for(const saved of ["not-json",JSON.stringify({...request(),role:"owner"})]){tab.setItem(SAMPLE_ENTRY_STORAGE,saved);assert.throws(()=>prepareSampleEntry(tab),/No new Sample/);assert.equal(tab.getItem(SAMPLE_ENTRY_STORAGE),saved);}
  assert.throws(()=>prepareSampleEntry({getItem:()=>{throw Error("blocked");},setItem:()=>{throw Error("must not run");}}),/No new Sample/);
  assert.throws(()=>prepareSampleEntry({getItem:()=>null,setItem:()=>{throw Error("quota");}}),/No Sample was started/);
});
