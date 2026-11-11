import type { ArtifactManifest, WorkPackage } from "@/contracts/guild";
import { DomainError } from "@/domain/primitives";
import { getPool } from "./db";
import type { Session } from "./session";

/** Owner-scoped export. Credentials, original HTTP headers and model prompts are excluded. */
export async function artifactEvidence(session: Session, artifactId: string) {
  const owned = (await getPool().query<{ commission_id: string; package_id: string; manifest: ArtifactManifest }>("SELECT commission_id,package_id,manifest FROM guild_artifacts WHERE id=$1 AND tenant_id=$2", [artifactId, session.tenantId])).rows[0];
  if (!owned) throw new DomainError("ARTIFACT_NOT_FOUND", "That artifact is not in this workspace.", 404, false);
  const [checks, reports, reviews, amendments, current] = await Promise.all([
    getPool().query("SELECT id,contract_version,artifact_hash,criteria_digest,result,created_at FROM guild_verifications WHERE tenant_id=$1 AND commission_id=$2 AND artifact_id=$3 ORDER BY created_at", [session.tenantId, owned.commission_id, artifactId]),
    getPool().query("SELECT id,state,output,updated_at FROM guild_jobs WHERE tenant_id=$1 AND commission_id=$2 AND type='verify_artifact' AND input->>'artifactId'=$3 AND output IS NOT NULL ORDER BY created_at", [session.tenantId, owned.commission_id, artifactId]),
    getPool().query("SELECT id,contract_version,artifact_hash,criteria_digest,review_kind,findings,disclosures,created_at FROM guild_artifact_reviews WHERE tenant_id=$1 AND commission_id=$2 AND artifact_id=$3 ORDER BY created_at", [session.tenantId, owned.commission_id, artifactId]),
    getPool().query<{ from_version: number; to_version: number; previous_contract: WorkPackage; proposed_contract: WorkPackage; reason: string; created_at: Date }>("SELECT from_version,to_version,previous_contract,proposed_contract,reason,created_at FROM guild_contract_amendments WHERE tenant_id=$1 AND commission_id=$2 AND package_id=$3 ORDER BY created_at", [session.tenantId, owned.commission_id, owned.package_id]),
    getPool().query<{ packages: WorkPackage[] }>("SELECT snapshot->'packages' AS packages FROM guild_commissions WHERE id=$1 AND tenant_id=$2", [owned.commission_id, session.tenantId]),
  ]);
  const contracts = amendments.rows.filter(item => item.previous_contract.artifactIds.includes(artifactId)).map(item => ({ contract: item.previous_contract, retainedBeforeVersion: item.to_version, reason: item.reason, recordedAt: item.created_at.toISOString() }));
  const active = current.rows[0]?.packages.find(item => item.artifactIds.includes(artifactId));
  const correctionAgreements = amendments.rows.flatMap(item => {
    const agreement = item.proposed_contract.narrationCorrection;
    return agreement && (agreement.proposal.history.some(record => record.artifactId === artifactId) || active?.narrationCorrection?.id === agreement.id) ? [agreement] : [];
  });
  return { schemaVersion: "guild.artifact-evidence.v1", artifact: { id: artifactId, packageId: owned.package_id, contentHash: owned.manifest.contentHash, createdAt: owned.manifest.createdAt, provenance: owned.manifest.provenance }, currentContract: active ?? null, earlierContracts: contracts, checkReports: checks.rows, independentReports: reports.rows, automatedReviews: reviews.rows, correctionAgreements, exportedAt: new Date().toISOString(), disclosure: "These records preserve actual checks, original contracts and explicitly attributed reviews. An automated report does not establish human acceptance or payment." };
}
