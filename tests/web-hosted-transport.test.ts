import test from "node:test";
import assert from "node:assert/strict";
import { Sandbox } from "@vercel/sandbox";
import { HostedTransportUncertain, singleAttemptSandboxFetch } from "../src/server/web/hosted-transport";

for (const status of [429,500,502,503]) test(`installed SDK sends one original create on HTTP${status}`, async () => {
  let calls=0;
  const transport=singleAttemptSandboxFetch(async(_input, init)=>{
    calls++;
    assert.equal(init?.method,"POST");
    return new Response(JSON.stringify({error:{message:"controlled uncertain create"}}),{status,headers:{"Content-Type":"application/json","Retry-After":"0"}});
  });
  await assert.rejects(()=>Sandbox.create({token:"controlled-token",teamId:"team_controlled",projectId:"prj_controlled",name:"guild-original-control",persistent:false,timeout:600000,source:{type:"snapshot",snapshotId:"snap_controlled"},networkPolicy:"deny-all",fetch:transport}),error=>error instanceof HostedTransportUncertain && error.originalStatus===status);
  assert.equal(calls,1);
});

test("installed SDK does not retry a lost original create response",async()=>{
  let calls=0;
  await assert.rejects(()=>Sandbox.create({token:"controlled-token",teamId:"team_controlled",projectId:"prj_controlled",name:"guild-original-lost",persistent:false,timeout:600000,networkPolicy:"deny-all",fetch:singleAttemptSandboxFetch(async()=>{calls++;throw new TypeError("controlled lost response with private transport detail");})}),error=>error instanceof HostedTransportUncertain && error.originalStatus===null && !error.message.includes("private transport detail"));
  assert.equal(calls,1);
});

test("read failures remain observable and ordinary refusals are preserved",async()=>{
  const transport=singleAttemptSandboxFetch(async()=>new Response("controlled refusal",{status:403}));
  const response=await transport("https://api.vercel.com/v2/sandboxes",{method:"POST"});
  assert.equal(response.status,403);
  assert.equal(await response.text(),"controlled refusal");
  const failedRead=singleAttemptSandboxFetch(async()=>{throw new TypeError("controlled read failure");});
  await assert.rejects(()=>failedRead("https://api.vercel.com/v2/sandboxes/original",{method:"GET"}),TypeError);
});
