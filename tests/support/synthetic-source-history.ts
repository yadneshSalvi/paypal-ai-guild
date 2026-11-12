import { createHmac, randomUUID } from "node:crypto";
import type { ArtifactManifest, Commission } from "@/contracts/guild";
import { planDigest } from "@/domain/fixture";
import { canonical, digest } from "@/domain/primitives";
import { transaction } from "@/server/db";
import type { Session } from "@/server/session";

/** Explicitly synthetic ancestry for test-authored research/translation. Never
 * called by application routes or workers. No real model work, acceptance,
 * listening review or payment is represented by these coherent test records. */
export async function syntheticSourceHistory(c: Commission, artifact: ArtifactManifest, session: Session) {
  const approved = structuredClone(c), pkg = approved.packages.find(item => item.id === artifact.packageId)!;
  approved.artifacts = approved.artifacts.filter(item => item.id !== artifact.id); pkg.artifactIds = []; pkg.state = "awarded";
  for (const criterion of pkg.acceptancePack.criteria) { criterion.status = "pending"; criterion.evidence = null; }
  const before = c.revision, at = new Date().toISOString(), approvalId = randomUUID(), productionId = randomUUID(), jobId = randomUUID();
  approved.revision = before + 1; approved.approvedPlanDigest = planDigest(approved); approved.state = "producing";
  const production = structuredClone(approved); production.revision++;
  production.packages.find(item => item.id === artifact.packageId)!.state = "producing";
  const payload = { kind: "guild.server_signed_receipt.v1", actor: session.id, commission: c.id, digest: approved.approvedPlanDigest, at };
  const signature = createHmac("sha256", process.env.AUTH_SECRET!).update(canonical(payload)).digest("hex");
  artifact.createdAt = at; artifact.provenance.sourceId = jobId; artifact.provenance.observedAt = at;
  await transaction(async db => {
    await db.query("INSERT INTO guild_approval_receipts(id,tenant_id,commission_id,actor_id,plan_digest,payload,signature,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [randomUUID(), c.tenantId, c.id, session.id, approved.approvedPlanDigest, payload, signature, at]);
    await db.query("INSERT INTO guild_commands(tenant_id,command_id,commission_id,payload_hash,result,created_at) VALUES($1,$2,$3,$4,$5,$6)", [c.tenantId, approvalId, c.id, digest({ commissionId: c.id, command: { type: "approve_plan", commandId: approvalId, expectedRevision: before, planDigest: approved.approvedPlanDigest } }), { ok: true, commandId: approvalId, revision: approved.revision, jobId: null, commission: approved }, at]);
    await db.query("INSERT INTO guild_jobs(id,tenant_id,commission_id,business_key,type,state,input,output,created_at) VALUES($1,$2,$3,$4,'produce_package','completed',$5,$6,$7)", [jobId, c.tenantId, c.id, "synthetic-original:" + artifact.id, { packageId: artifact.packageId, contractVersion: pkg.contractVersion, inputBindings: artifact.content.inputBindings ?? [], syntheticFixture: true }, { artifactId: artifact.id, syntheticFixture: true }, at]);
    await db.query("INSERT INTO guild_commands(tenant_id,command_id,commission_id,payload_hash,result,created_at) VALUES($1,$2,$3,$4,$5,$6)", [c.tenantId, productionId, c.id, digest({ commissionId: c.id, command: { type: "produce_package", commandId: productionId, expectedRevision: approved.revision, packageId: artifact.packageId } }), { ok: true, commandId: productionId, revision: production.revision, jobId, commission: production }, at]);
  });
  c.revision = production.revision;
}
