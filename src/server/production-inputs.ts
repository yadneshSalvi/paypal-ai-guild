import { z } from "zod";
import type { Pool, PoolClient } from "pg";
import type { AcceptancePack, ArtifactInputBinding, ArtifactManifest, Commission, WorkPackage } from "@/contracts/guild";
import { digest, DomainError } from "@/domain/primitives";

const bindingSchema = z.object({ packageId: z.string(), contractVersion: z.number().int().positive(), artifactId: z.string().uuid(), artifactHash: z.string().regex(/^[a-f0-9]{64}$/), reviewKind: z.enum(["curator_acceptance", "automated_review"]), reviewId: z.string().uuid() }).strict();
type Db = Pool | PoolClient;

async function artifact(db: Db, commission: Commission, upstream: WorkPackage, id: string, hash: string): Promise<ArtifactManifest | null> {
  const row = (await db.query<{ manifest: ArtifactManifest }>("SELECT manifest FROM guild_artifacts WHERE id=$1 AND tenant_id=$2 AND commission_id=$3 AND package_id=$4 AND content_hash=$5", [id, commission.tenantId, commission.id, upstream.id, hash])).rows[0];
  return row && upstream.artifactIds.includes(id) && row.manifest.contentHash === hash && digest(row.manifest.content) === hash && (commission.mode !== "live" || row.manifest.provenance.mode === "live") ? row.manifest : null;
}

/** Accepted inputs are preferred. A draft is permitted only by the explicit amended contract. */
export async function resolveProductionInputs(db: Db, commission: Commission, pkg: WorkPackage, acceptedOnly = false): Promise<{ bindings: ArtifactInputBinding[]; artifacts: ArtifactManifest[] }> {
  const bindings: ArtifactInputBinding[] = [], artifacts: ArtifactManifest[] = [];
  for (const packageId of pkg.dependsOn) {
    const upstream = commission.packages.find(item => item.id === packageId);
    if (!upstream) throw new DomainError("INPUT_CONTRACT_MISSING", "An agreed upstream contract is unavailable.", 422);
    const accepted = upstream.state === "accepted" ? (await db.query<{ id: string; artifact_id: string; artifact_hash: string }>("SELECT id,artifact_id,artifact_hash FROM guild_acceptance_decisions WHERE tenant_id=$1 AND commission_id=$2 AND package_id=$3 AND contract_version=$4 AND criteria_digest=$5 AND decision='accepted' AND review_disclosures->>'humanReviewed'='true' ORDER BY created_at DESC LIMIT 1", [commission.tenantId, commission.id, upstream.id, upstream.contractVersion, upstream.acceptancePack.digest])).rows[0] : null;
    if (accepted) {
      const source = await artifact(db, commission, upstream, accepted.artifact_id, accepted.artifact_hash);
      if (source) { bindings.push({ packageId, contractVersion: upstream.contractVersion, artifactId: source.id, artifactHash: source.contentHash, reviewKind: "curator_acceptance", reviewId: accepted.id }); artifacts.push(source); continue; }
    }
    if (!acceptedOnly && pkg.inputPolicy === "reviewed_drafts" && ["awaiting_acceptance", "accepted"].includes(upstream.state)) {
      const latest = upstream.artifactIds.at(-1);
      const reviewed = (await db.query<{ id: string; artifact_id: string; artifact_hash: string; result: AcceptancePack }>("SELECT r.id,r.artifact_id,r.artifact_hash,v.result FROM guild_artifact_reviews r JOIN guild_verifications v ON v.tenant_id=r.tenant_id AND v.commission_id=r.commission_id AND v.package_id=r.package_id AND v.contract_version=r.contract_version AND v.artifact_id=r.artifact_id AND v.artifact_hash=r.artifact_hash AND v.criteria_digest=r.criteria_digest WHERE r.tenant_id=$1 AND r.commission_id=$2 AND r.package_id=$3 AND r.contract_version=$4 AND r.artifact_id=$5 AND r.review_kind='automated' AND r.disclosures->>'humanReviewed'='false' ORDER BY r.created_at DESC LIMIT 1", [commission.tenantId, commission.id, upstream.id, upstream.contractVersion, latest ?? null])).rows[0];
      if (reviewed && reviewed.result.digest === upstream.acceptancePack.digest && reviewed.result.criteria.some(item => item.blocking && item.kind === "deterministic") && reviewed.result.criteria.every(item => !item.blocking || item.kind !== "deterministic" || item.status === "passed")) {
        const source = await artifact(db, commission, upstream, reviewed.artifact_id, reviewed.artifact_hash);
        if (source) { bindings.push({ packageId, contractVersion: upstream.contractVersion, artifactId: source.id, artifactHash: source.contentHash, reviewKind: "automated_review", reviewId: reviewed.id }); artifacts.push(source); continue; }
      }
    }
    throw new DomainError(acceptedOnly ? "INPUT_ACCEPTANCE_REQUIRED" : "DEPENDENCIES_PENDING", acceptedOnly ? "Curator acceptance is still required for the exact upstream drafts used by this submission. Automated review does not satisfy that gate." : pkg.inputPolicy === "reviewed_drafts" ? "Each upstream draft needs passing saved checks and an explicitly automated review, or curator acceptance, before this contract can begin." : "Accept the prerequisite artifacts before this provider starts. A different draft policy requires an explicit contract amendment.", 422);
  }
  return { bindings, artifacts };
}

export async function validateProductionInputs(db: Db, commission: Commission, pkg: WorkPackage, raw: unknown): Promise<ArtifactManifest[]> {
  const parsed = z.array(bindingSchema).max(6).safeParse(raw ?? []);
  if (!parsed.success || parsed.data.length !== pkg.dependsOn.length || new Set(parsed.data.map(item => item.packageId)).size !== pkg.dependsOn.length) throw new DomainError("INPUT_BINDING_CHANGED", "The saved producing job does not bind every agreed source artifact.", 422, false);
  const current = await resolveProductionInputs(db, commission, pkg);
  if (!current.bindings.every(binding => parsed.data.some(saved => saved.packageId === binding.packageId && saved.contractVersion === binding.contractVersion && saved.artifactId === binding.artifactId && saved.artifactHash === binding.artifactHash))) throw new DomainError("INPUT_BINDING_CHANGED", "An upstream artifact or contract changed after this job was commissioned. Its original draft remains saved; no replacement input was substituted.", 422, false);
  return current.artifacts;
}

export async function assertAcceptedProductionInputs(db: Db, commission: Commission, pkg: WorkPackage, submission: ArtifactManifest): Promise<void> {
  if (pkg.inputPolicy !== "reviewed_drafts") return;
  const current = await resolveProductionInputs(db, commission, pkg, true), parsed = z.array(bindingSchema).max(6).safeParse(submission.content.inputBindings);
  if (!parsed.success || parsed.data.length !== current.bindings.length || !current.bindings.every(binding => parsed.data.some(saved => saved.packageId === binding.packageId && saved.contractVersion === binding.contractVersion && saved.artifactId === binding.artifactId && saved.artifactHash === binding.artifactHash))) throw new DomainError("INPUT_BINDING_CHANGED", "This downstream submission was made from different source drafts. The accepted upstream artifacts must match its exact saved lineage.", 422, false);
}
