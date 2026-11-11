import test from "node:test";
import assert from "node:assert/strict";
import { createSampleCommission,providerDefinitions } from "../src/domain/fixture";
import { checkAuthority,reserveInSnapshot,validateChild,negotiateOffer } from "../src/domain/authority";
import { assertAcceptable,assertEarnedCapture } from "../src/domain/acceptance";
import { verifyArtifact } from "../src/domain/verification";
import { digest,DomainError } from "../src/domain/primitives";
import { commissionCommandSchema } from "../src/contracts/guild";
const commission=()=>{const c=createSampleCommission("domain-test");for(const m of c.mandates)m.status="active";return c;};
const request=()=>({mandateId:"passport-localization",amountMinor:6000,kind:"translation" as const,providerId:"tessellate",purpose:"An accessible six-language maritime exhibition",now:new Date().toISOString()});
const code=(expected:string)=>(error:unknown)=>error instanceof DomainError&&error.code===expected;

test("authority checks every ancestor and reserves both levels",()=>{const c=commission();assert.equal(checkAuthority(c.mandates,request()).allowed,true);reserveInSnapshot(c.mandates,request());assert.equal(c.mandates[0]!.reservedMinor,6000);assert.equal(c.mandates[1]!.reservedMinor,6000);});
test("parallel commitments cannot fit by checking only the child cap",()=>{const c=commission();c.mandates[0]!.reservedMinor=60000;assert.equal(checkAuthority(c.mandates,request()).ruleId,"PASSPORT.CAP");});
test("revoked root closes children without erasing accepted commitments",()=>{const c=commission();c.mandates[0]!.committedMinor=9800;c.mandates[0]!.status="revoked";assert.equal(checkAuthority(c.mandates,request()).ruleId,"PASSPORT.INACTIVE");assert.equal(c.mandates[0]!.committedMinor,9800);});
test("scope, provider, purpose, expiry and stale parent fail closed",()=>{for(const [change,rule] of [
  [(c:ReturnType<typeof commission>)=>{c.mandates[1]!.allowedKinds=["narration"];},"PASSPORT.CATEGORY"],
  [(c:ReturnType<typeof commission>)=>{c.mandates[1]!.allowedProviders=["quill"];},"PASSPORT.PROVIDER"],
  [(c:ReturnType<typeof commission>)=>{c.mandates[0]!.purpose="Other";},"PASSPORT.PURPOSE"],
  [(c:ReturnType<typeof commission>)=>{c.mandates[0]!.expiresAt="invalid";},"PASSPORT.EXPIRED"],
  [(c:ReturnType<typeof commission>)=>{c.mandates[0]!.revision++;},"PASSPORT.STALE_PARENT"],
 ] as const){const c=commission();change(c);assert.equal(checkAuthority(c.mandates,request()).ruleId,rule);}});
test("child cannot extend expiry or broaden allowed categories",()=>{const c=commission();const child=structuredClone(c.mandates[1]!);child.expiresAt=new Date(Date.now()+9*86400000).toISOString();assert.throws(()=>validateChild(c.mandates[0]!,child),code("CHILD_BROADENS_AUTHORITY"));child.expiresAt=c.mandates[0]!.expiresAt;child.capMinor=64001;assert.throws(()=>validateChild(c.mandates[0]!,child),code("CHILD_BROADENS_AUTHORITY"));});
test("money is integer cents, never a float or negative reservation",()=>{const c=commission();for(const n of [-1,0.1,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>reserveInSnapshot(c.mandates,{...request(),amountMinor:n}),code("INVALID_MONEY"));});
test("negotiation respects independent owner floor and buyer cap",()=>{const provider=providerDefinitions.find(p=>p.id==="formwork")!;assert.deepEqual(negotiateOffer(provider,11000,14000),{accepted:false,counterMinor:12000,reason:"The provider's owner mandate sets a 12000-cent floor."});assert.equal(negotiateOffer(provider,12000,14000).accepted,true);assert.equal(negotiateOffer(provider,11000,11500).counterMinor,null);});
test("real deterministic research checks pass the supplied sample, never imply a human review",()=>{const c=commission(),pkg=c.packages[0]!,artifact=c.artifacts[0]!;const pack=verifyArtifact(c,pkg,artifact);assert.equal(pack.criteria.filter(x=>x.kind==="deterministic").every(x=>x.status==="passed"),true);assert.equal(pack.criteria.find(x=>x.kind==="human")!.status,"review");});
test("tampered content and invented sources fail checks",()=>{const c=commission(),pkg=c.packages[0]!,artifact=structuredClone(c.artifacts[0]!);(artifact.content.labels as {sourceIds:string[]}[])[0]!.sourceIds=["untrusted-instruction"];const pack=verifyArtifact(c,pkg,artifact);assert.equal(pack.criteria.find(x=>x.id==="sources")!.status,"failed");assert.equal(pack.criteria.find(x=>x.id==="length")!.status,"failed");});
test("acceptance is contract and artifact bound; sample work never earns a charge",()=>{const c=commission(),p=c.packages[0]!,a=c.artifacts[0]!;assert.throws(()=>assertAcceptable(p,a,2),code("CONTRACT_CHANGED"));assert.throws(()=>assertAcceptable(p,a,1),code("VERIFICATION_REQUIRED"));p.acceptancePack=verifyArtifact(c,p,a);p.state="awaiting_acceptance";assert.doesNotThrow(()=>assertAcceptable(p,a,1));p.state="accepted";p.acceptedAt=new Date().toISOString();p.acceptedBy="curator";assert.throws(()=>assertEarnedCapture(p,9800),code("SAMPLE_NOT_PAYABLE"));});
test("canonical digest ignores object order and strict command rejects money authority injection",()=>{assert.equal(digest({b:2,a:1}),digest({a:1,b:2}));assert.equal(commissionCommandSchema.safeParse({type:"pause",commandId:crypto.randomUUID(),expectedRevision:0,amountMinor:64000}).success,false);});
