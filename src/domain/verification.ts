import type { ArtifactManifest, Commission, WorkPackage } from "@/contracts/guild";
import { collectionNotes } from "./fixture";
import { digest } from "./primitives";
import { checkResearch } from "./research";

export function verifyArtifact(commission:Commission,pkg:WorkPackage,artifact:ArtifactManifest):WorkPackage["acceptancePack"] {
  const pack=structuredClone(pkg.acceptancePack);
  const content=artifact.content;
  const integrity=digest(content)===artifact.contentHash;
  const set=(id:string,passed:boolean,evidence:string)=>{const criterion=pack.criteria.find(c=>c.id===id);if(criterion){criterion.status=passed?"passed":"failed";criterion.evidence=evidence;}};
  if(pkg.kind==="research"&&pack.version==="2.0.0"){
    const checks=checkResearch(content,commission.sourceAssets,collectionNotes,pack.digest);
    for(const [id,check] of Object.entries(checks))set(id,integrity&&check.passed,integrity?check.evidence:"The artifact content no longer matches its immutable fingerprint.");
  }else if(pkg.kind==="research"){
    const labels=Array.isArray(content.labels)?content.labels as {id?:unknown;title?:unknown;body?:unknown;sourceIds?:unknown}[]:[];
    const allowed=new Set([...collectionNotes.map(n=>n.id),...commission.sourceAssets.map(s=>s.id)]);
    const citations=labels.length>0&&labels.every(l=>Array.isArray(l.sourceIds)&&l.sourceIds.length>0&&l.sourceIds.every(s=>typeof s==="string"&&allowed.has(s)));
    set("sources",integrity&&citations,`${labels.length} labels checked against ${allowed.size} permitted sources. Citation support still needs curator review.`);
    const required=artifact.provenance.mode==="sample"?["welcome"]:["welcome",...commission.sourceAssets.map(s=>s.id)];
    set("coverage",integrity&&required.every(id=>labels.some(l=>l.id===id)),`${required.filter(id=>labels.some(l=>l.id===id)).length} of ${required.length} agreed labels present.`);
    const counts=labels.map(l=>typeof l.body==="string"?l.body.trim().split(/\s+/u).length:0);
    set("length",integrity&&counts.length>0&&counts.every(n=>n>=80&&n<=120),`Word counts: ${counts.join(", ")}. Agreed range: 80–120.`);
  }else if(pkg.kind==="translation"){
    const translations=content.translations as Record<string,Record<string,unknown>>|undefined;
    const present=translations&&typeof translations==="object";
    set("locales",Boolean(integrity&&present&&commission.languages.every(l=>translations[l])),`${commission.languages.length} agreed locale files required.`);
    const base=Object.keys(translations?.en??{}).sort().join("|");
    set("keys",Boolean(integrity&&base&&commission.languages.every(l=>Object.keys(translations?.[l]??{}).sort().join("|")===base)),"Keys compared across every agreed locale; semantic equivalence is a human review.");
    set("rtl",integrity&&content.arabicDirection==="rtl","Arabic direction metadata must be rtl.");
  }else{
    for(const criterion of pack.criteria.filter(c=>c.kind==="deterministic")){criterion.status="review";criterion.evidence="This acceptance check requires the isolated media/browser worker. It has not run.";}
  }
  for(const criterion of pack.criteria.filter(c=>c.kind!=="deterministic")){criterion.status="review";criterion.evidence="The curator must review this finding before acceptance.";}
  return pack;
}
