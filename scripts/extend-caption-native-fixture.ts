/** Clearly fictional later drafts for root UI QA. No declaration is submitted,
 * no accepted artifact is modified, and no original deadline is renewed. */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadComposedCaptionFixture } from "../tests/support/load-composed-caption-fixture";
import { syntheticCaptionRevision } from "../tests/support/synthetic-caption-review";
import { deepgramCaptionArtifactSchema } from "../src/domain/deepgram-captions";
import { digest } from "../src/domain/primitives";
const f=await loadComposedCaptionFixture(process.argv[2]??"missing-native-fixture","native"),{getPool}=await import("../src/server/db"),pool=getPool();
try{
 const row=(await pool.query("SELECT manifest FROM guild_artifacts WHERE tenant_id=$1 AND id=$2",[f.owner.tenantId,f.captionReview.originalArtifactId])).rows[0],artifact=row.manifest,content=deepgramCaptionArtifactSchema.parse(artifact.content);
 const old=(await pool.query("SELECT snapshot FROM guild_commissions WHERE id=$1 AND tenant_id=$2",[f.commissionId,f.owner.tenantId])).rows[0].snapshot;
 const originalIdentity=digest({artifacts:old.artifacts,packages:old.packages.map((pkg:Record<string,unknown>)=>({id:pkg.id,acceptedAt:pkg.acceptedAt,acceptedBy:pkg.acceptedBy,acceptancePack:pkg.acceptancePack})),payments:old.payments});
 const extensions=[];
 for(const [locale,uncertain]of [["en",false],["ja",true]]as const){
  const source=content.sources.tracks.find(item=>item.locale===locale&&item.key==="welcome")!,ref=f.captionReview.declarations.find(item=>item.locale===locale&&item.key==="welcome")!;
  const parent=(await pool.query("SELECT revision FROM guild_caption_review_revisions WHERE tenant_id=$1 AND id=$2",[f.owner.tenantId,ref.id])).rows[0].revision;
  assert.ok(parent.attestation);assert.equal((await pool.query("SELECT count(*)::int AS n FROM guild_caption_review_revisions WHERE parent_revision_id=$1",[parent.id])).rows[0].n,0,"Never replace an existing later draft.");
  const draft=structuredClone(parent.draft);
  draft.note=uncertain?"SYNTHETIC later uncertain draft for native UI QA. This is not the agreed or accepted revision; no person listened.":"SYNTHETIC later complete draft for keyboard/dialog QA. Leave all personal declarations unchecked. This draft is not the accepted edition; no person listened.";
  if(uncertain){draft.disposition="uncertain";draft.units[0]={...draft.units[0],heard:"uncertain",startMs:null,endMs:null,origin:"unassigned",providerWordIndex:null};}
  const revision=await syntheticCaptionRevision(f.owner.tenantId,f.commissionId,artifact,source,f.owner,draft,parent);
  assert.equal(revision.attestation,null);assert.equal(revision.evaluation.status,uncertain?"incomplete":"ready-for-review");
  extensions.push({locale,key:source.key,id:revision.id,digest:revision.digest,originalAcceptedRevisionId:parent.id,kind:uncertain?"uncertain null-timing draft":"complete unattested draft for modal QA",cues:revision.evaluation.cues.length});
 }
 const after=(await pool.query("SELECT snapshot FROM guild_commissions WHERE id=$1 AND tenant_id=$2",[f.commissionId,f.owner.tenantId])).rows[0].snapshot;
 assert.equal(digest({artifacts:after.artifacts,packages:after.packages.map((pkg:Record<string,unknown>)=>({id:pkg.id,acceptedAt:pkg.acceptedAt,acceptedBy:pkg.acceptedBy,acceptancePack:pkg.acceptancePack})),payments:after.payments}),originalIdentity);
 const result={version:"guild.synthetic-caption-native-review-extensions.v1",disclosure:f.disclosure,extensions,artifactAndAcceptanceAndPaymentBytesUnchanged:true,originalAuthorityExpiresAt:f.captionReview.authorityExpiresAt,providerCalls:0,newListeningDeclarations:0};
 const target=resolve(dirname(f.fixturePath),"review-fixture-extensions.json");await writeFile(target,JSON.stringify(result,null,2)+"\n",{flag:"wx",mode:0o600});console.log(JSON.stringify({target,extensions,originalArtifactsUnchanged:true,newListeningDeclarations:0}));
}finally{await pool.end();}
