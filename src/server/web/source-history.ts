import type { Pool, PoolClient } from "pg";
import type { ArtifactManifest, Commission, WorkPackage } from "@/contracts/guild";
import { planDigest } from "@/domain/fixture";
import { digest, DomainError } from "@/domain/primitives";
import { captionApprovalAt } from "../captions/authority";

type Db = Pool | PoolClient;
function fail(): never { throw new DomainError("WEB_SOURCE_APPROVAL", "Each original input needs its own retained producing job, approved snapshot and valid signed receipt. Current plan changes do not rewrite historical work or renew its authority.", 422, false); }
export function normalizedWebSourceTerms(pkg: WorkPackage) {
  return { id: pkg.id, kind: pkg.kind, contractVersion: pkg.contractVersion, providerId: pkg.providerId, providerAwardMinor: pkg.providerAwardMinor,
    serviceFeeMinor: pkg.serviceFeeMinor, grossMinor: pkg.grossMinor, dependsOn: pkg.dependsOn, workingHours: pkg.workingHours, inputPolicy: pkg.inputPolicy,
    acceptancePack: { ...pkg.acceptancePack, criteria: pkg.acceptancePack.criteria.map(item => ({ ...item, status: "pending", evidence: null })) } };
}
/** Historical validation reads the snapshot that actually produced this artifact. */
export async function readWebSourceApproval(db: Db, c: Commission, pkg: WorkPackage | null, artifact: ArtifactManifest) {
  if (pkg && artifact.packageId !== pkg.id || artifact.contentHash !== digest(artifact.content)) fail();
  const jobs = (await db.query<{ id: string; state: string; created_at: Date; input: { packageId: string; contractVersion: number; inputBindings?: unknown }; output: { artifactId?: string } }>("SELECT id,state,created_at,input,output FROM guild_jobs WHERE tenant_id=$1 AND commission_id=$2 AND type='produce_package' AND output->>'artifactId'=$3", [c.tenantId, c.id, artifact.id])).rows;
  if (jobs.length !== 1) fail();
  const job = jobs[0]!;
  if (job.state !== "completed" || job.input.packageId !== artifact.packageId || pkg && job.input.contractVersion !== pkg.contractVersion || job.output.artifactId !== artifact.id
    || !Number.isFinite(Date.parse(artifact.createdAt)) || job.created_at.getTime() > Date.parse(artifact.createdAt)) fail();
  const commands = (await db.query<{ command_id: string; payload_hash: string; created_at: Date; result: { ok: boolean; commandId: string; revision: number; jobId: string; commission: Commission } }>("SELECT command_id,payload_hash,result,created_at FROM guild_commands WHERE tenant_id=$1 AND commission_id=$2 AND result->>'jobId'=$3", [c.tenantId, c.id, job.id])).rows;
  if (commands.length !== 1) fail();
  const command = commands[0]!, snapshot = command.result?.commission, original = snapshot?.packages.find(item => item.id === artifact.packageId);
  const expected = pkg ?? original;
  if (!snapshot || !original || !snapshot.approvedPlanDigest || snapshot.id !== c.id || snapshot.tenantId !== c.tenantId || snapshot.mode !== "live" || planDigest(snapshot) !== snapshot.approvedPlanDigest
    || !expected || original.contractVersion !== job.input.contractVersion || digest(normalizedWebSourceTerms(original)) !== digest(normalizedWebSourceTerms(expected)) || command.created_at.getTime() !== job.created_at.getTime()
    || command.result.ok !== true || command.result.commandId !== command.command_id || command.result.revision !== snapshot.revision || command.result.jobId !== job.id
    || command.payload_hash !== digest({ commissionId: c.id, command: { type: "produce_package", packageId: artifact.packageId, commandId: command.command_id, expectedRevision: command.result.revision - 1 } })) fail();
  const approved = await captionApprovalAt(db, c, snapshot.approvedPlanDigest, job.created_at), approvedPkg = approved.command.result.commission.packages.find(item => item.id === artifact.packageId);
  if (!approvedPkg || digest(normalizedWebSourceTerms(approvedPkg)) !== digest(normalizedWebSourceTerms(original))) fail();
  return { job, snapshot, package: approvedPkg, receiptHash: digest({ payload: approved.receipt.payload, signature: approved.receipt.signature }) };
}
