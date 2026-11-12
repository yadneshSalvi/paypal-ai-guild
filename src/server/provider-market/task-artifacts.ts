import type { ArtifactManifest, Commission, WorkPackage } from "@/contracts/guild";
import { delegationBindingSchema } from "@/contracts/provider-market";
import { marketContractDigest } from "@/domain/provider-market";
import { digest, DomainError } from "@/domain/primitives";
import type { MarketTaskRow } from "./delegation";
import type { MarketDb } from "./registry";

export interface OriginalMarketJob {
  state: string; attempts: number; type: string; input: Record<string, unknown>;
  output: { artifactId?: string } | null; error: string | null; updated_at: Date;
}
/** A job's output ID is only a pointer. It cannot grant access to another
 * package's artifact, even within the same customer's commission. */
export async function boundTaskArtifact(db: MarketDb, task: MarketTaskRow, c: Commission): Promise<{
  job: OriginalMarketJob | null; artifact: ArtifactManifest | null; withheld: boolean; contract: WorkPackage | null;
}> {
  const parsed = delegationBindingSchema.safeParse(task.binding);
  if (!parsed.success || digest(parsed.data) !== task.binding_digest || parsed.data.taskId !== task.id || parsed.data.threadId !== task.thread_id
    || parsed.data.commissionId !== task.commission_id || parsed.data.packageId !== task.package_id || parsed.data.providerId !== task.provider_id
    || c.id !== task.commission_id || c.tenantId !== task.tenant_id) {
    throw new DomainError("MARKET_TASK_BINDING", "This retained task no longer has its exact commission and provider binding.", 422, false);
  }
  const b = parsed.data;
  const thread = (await db.query<{ prepared_contract: WorkPackage | null; selected_terms_digest: string | null; selected_terms: {sourceDigest?: string} | null }>(
    "SELECT prepared_contract,selected_terms_digest,selected_terms FROM guild_market_threads WHERE id=$1 AND tenant_id=$2 AND commission_id=$3 AND provider_id=$4 AND package_id=$5",
    [task.thread_id, task.tenant_id, task.commission_id, task.provider_id, task.package_id])).rows[0];
  const contract = thread?.prepared_contract ?? null;
  const exactContract = !!contract && contract.id === b.packageId && contract.contractVersion === b.contractVersion && contract.providerId === b.providerId
    && marketContractDigest(contract) === b.contractDigest && contract.acceptancePack.digest === b.acceptancePackDigest
    && thread?.selected_terms_digest === b.offerDigest && thread.selected_terms?.sourceDigest === b.sourceDigest;
  const job = task.original_job_id ? (await db.query<OriginalMarketJob>(
    "SELECT state,attempts,type,input,output,error,updated_at FROM guild_jobs WHERE id=$1 AND tenant_id=$2 AND commission_id=$3",
    [task.original_job_id, task.tenant_id, task.commission_id])).rows[0] ?? null : null;
  if (!exactContract || task.original_job_id && (!job || job.type !== "produce_package" || job.input.packageId !== b.packageId
    || job.input.contractVersion !== b.contractVersion || job.input.marketTaskId !== task.id || job.input.marketBindingDigest !== task.binding_digest)) {
    return { job, artifact: null, withheld: true, contract };
  }
  if (!job?.output?.artifactId) return { job, artifact: null, withheld: job?.state === "completed", contract };
  const artifactId = job.output.artifactId;
  const candidate = c.artifacts.find(item => item.id === artifactId && item.packageId === b.packageId);
  if (!candidate) return { job, artifact: null, withheld: true, contract };
  const row = (await db.query<{ id: string; package_id: string; content_hash: string; manifest: ArtifactManifest }>(
    "SELECT id,package_id,content_hash,manifest FROM guild_artifacts WHERE id=$1 AND tenant_id=$2 AND commission_id=$3 AND package_id=$4",
    [candidate.id, task.tenant_id, task.commission_id, b.packageId])).rows[0];
  const exact = row && row.id === candidate.id && row.package_id === candidate.packageId && row.content_hash === candidate.contentHash
    && row.manifest.id === candidate.id && row.manifest.packageId === b.packageId && row.manifest.contentHash === row.content_hash
    && digest(row.manifest.content) === row.content_hash && digest(row.manifest) === digest(candidate);
  return { job, artifact: exact ? row.manifest : null, withheld: !exact, contract };
}
