import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { ArtifactManifest, Commission } from "@/contracts/guild";
import { webArtifactSchema } from "@/domain/web-audits";
import { webFileSchema, type WebFile } from "@/domain/web-exhibition";
import { digest, DomainError } from "@/domain/primitives";
import { webZipStream } from "@/exhibition/generated/zip";
import { getPool } from "../db";
import type { Session } from "../session";
import type { PrivateBlobGateway } from "../media/blob-store";
import { readWebApprovalHistory } from "./approval-history";
import { readWebBundle, webOriginalReader } from "./bundles";

type Db = Pool | PoolClient;
async function originalArtifact(db: Db, tenantId: string, artifactId: string) {
  const row=(await db.query<{commission_id:string;package_id:string;content_hash:string;manifest:ArtifactManifest}>("SELECT commission_id,package_id,content_hash,manifest FROM guild_artifacts WHERE tenant_id=$1 AND id=$2",[tenantId,artifactId])).rows[0];
  if(!row)throw new DomainError("ARTIFACT_NOT_FOUND","That exhibition is not in this workspace.",404,false);
  const parsed=webArtifactSchema.safeParse(row.manifest.content);
  if(!parsed.success||row.manifest.id!==artifactId||row.manifest.packageId!==row.package_id||row.manifest.contentHash!==row.content_hash||digest(row.manifest.content)!==row.content_hash||digest(parsed.data.sources)!==parsed.data.sourceDigest)
    throw new DomainError("WEB_EXPORT_BINDING","The original exhibition does not match its complete retained manifest.",422,false);
  const c=(await db.query<{snapshot:Commission}>("SELECT snapshot FROM guild_commissions WHERE id=$1 AND tenant_id=$2",[row.commission_id,tenantId])).rows[0]?.snapshot;
  if(!c)throw new DomainError("WEB_EXPORT_BINDING","The original exhibition's commission is unavailable.",422,false);
  return {...row,content:parsed.data,commission:c};
}
export async function ownedWebArtifact(session: Session, artifactId: string, db: Db = getPool()) {
  if (!["owner", "judge", "operator"].includes(session.role)) throw new DomainError("ROLE_REQUIRED", "This original exhibition is available to its owner workspace.", 403, false);
  return originalArtifact(db, session.tenantId, artifactId);
}
/** Original authored bytes are read from their signed record; no rerender or model call. */
async function openOriginalBundle(db: Db, tenantId: string, owned: Awaited<ReturnType<typeof originalArtifact>>, ordinal?: number, storage?: PrivateBlobGateway) {
  const history=await readWebApprovalHistory(db,owned.commission,null,owned.manifest);
  const candidate=owned.content.candidates.find(item=>item.ordinal===(ordinal??owned.content.selectedOrdinal));
  if(!candidate)throw new DomainError("WEB_CANDIDATE_NOT_FOUND","That design is not one of this exact artifact's retained original candidates.",404,false);
  const saved=await readWebBundle(tenantId,candidate.bundleId,db);
  if(saved.row.commission_id!==owned.commission_id||saved.row.package_id!==owned.package_id||saved.row.job_id!==history.job.id||saved.row.contract_version!==history.package.contractVersion
    ||saved.row.ordinal!==candidate.ordinal||digest(saved.manifest)!==digest(candidate.bundle)||saved.manifest.sourceDigest!==owned.content.sourceDigest||saved.manifest.designDigest!==candidate.designDigest)
    throw new DomainError("WEB_EXPORT_BINDING","The portable bundle differs from its exact original artifact and producing agreement.",422,false);
  const original=await webOriginalReader(tenantId,owned.commission_id,owned.content.sources,storage,db);
  const read=async(file:WebFile)=>{
    const bytes=saved.authored.get(file.path)??await original(file);
    if(bytes.length!==file.byteLength||createHash("sha256").update(bytes).digest("hex")!==file.contentHash)throw new DomainError("WEB_EXPORT_BYTES","An original portable file failed its exact byte binding. It was not replaced.",422,false);
    return bytes;
  };
  return {owned,history,candidate,manifest:saved.manifest,authored:saved.authored,read};
}
export async function webExportBundle(session: Session, artifactId: string, ordinal?: number, storage?: PrivateBlobGateway, db: Db = getPool()) {
  return openOriginalBundle(db,session.tenantId,await ownedWebArtifact(session,artifactId,db),ordinal,storage);
}
/** Internal only. A public caller must first lock and verify its publication
 * ledger. Every selector below comes from that immutable edition, never a URL
 * tenant/artifact/ordinal parameter and never a fabricated owner session. */
export async function readBoundOriginalWebBundle(db: Db, binding: { tenantId: string; commissionId: string; artifactId: string; artifactHash: string; artifactManifestHash: string; ordinal: number; bundleId: string; bundleManifestHash: string }, storage?: PrivateBlobGateway) {
  const owned=await originalArtifact(db,binding.tenantId,binding.artifactId);
  if(owned.commission_id!==binding.commissionId||owned.content_hash!==binding.artifactHash||digest(owned.manifest)!==binding.artifactManifestHash||owned.content.selectedOrdinal!==binding.ordinal)
    throw new DomainError("WEB_PUBLICATION_BINDING","The published edition differs from its exact original artifact.",422,false);
  const bundle=await openOriginalBundle(db,binding.tenantId,owned,binding.ordinal,storage);
  if(bundle.candidate.bundleId!==binding.bundleId||digest(bundle.manifest)!==binding.bundleManifestHash)
    throw new DomainError("WEB_PUBLICATION_BINDING","The published edition differs from its selected original bundle.",422,false);
  return bundle;
}
export async function webPortableZip(session: Session, artifactId: string, ordinal?: number, storage?: PrivateBlobGateway) {
  const bundle=await webExportBundle(session,artifactId,ordinal,storage);
  return {stream:webZipStream(bundle.manifest,bundle.read),filename:`guild-exhibition-${artifactId}-design-${bundle.candidate.ordinal}.zip`,manifest:bundle.manifest};
}
export function webFileResponse(file: WebFile, bytes: Buffer, request: Request, cache="private, no-store") {
  webFileSchema.parse(file);
  if(bytes.length!==file.byteLength||createHash("sha256").update(bytes).digest("hex")!==file.contentHash)throw new DomainError("WEB_EXPORT_BYTES","The exact original file does not match its manifest.",422,false);
  const headers:Record<string,string>={"Content-Type":file.mediaType+(file.mediaType.startsWith("text/")||["application/javascript","application/json"].includes(file.mediaType)?"; charset=utf-8":""),"Cache-Control":cache,"X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer","Content-Disposition":`inline; filename="${file.path.split("/").at(-1)}"`,"Accept-Ranges":"bytes",ETag:`"sha256-${file.contentHash}"`};
  if(file.mediaType==="text/html"){headers["Content-Security-Policy"]="frame-ancestors 'self'; base-uri 'none'; object-src 'none'; form-action 'none'";headers["X-Frame-Options"]="SAMEORIGIN";}
  if(request.headers.get("if-none-match")===headers.ETag)return new Response(null,{status:304,headers});
  const range=request.headers.get("range");
  if(range){
    const match=/^bytes=(\d*)-(\d*)$/.exec(range),suffix=match&&!match[1]&&match[2]?Number(match[2]):null;
    const start=suffix!==null?Math.max(0,bytes.length-suffix):Number(match?.[1]??NaN),end=suffix!==null||!match?.[2]?bytes.length-1:Math.min(bytes.length-1,Number(match[2]));
    if(!match||!match[1]&&!match[2]||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||suffix!==null&&(!Number.isSafeInteger(suffix)||suffix<=0)||start<0||start>=bytes.length||end<start)
      return new Response(null,{status:416,headers:{...headers,"Content-Range":`bytes */${bytes.length}`}});
    return new Response(new Uint8Array(bytes.subarray(start,end+1)),{status:206,headers:{...headers,"Content-Range":`bytes ${start}-${end}/${bytes.length}`,"Content-Length":String(end-start+1)}});
  }
  return new Response(new Uint8Array(bytes),{headers:{...headers,"Content-Length":String(bytes.length)}});
}
