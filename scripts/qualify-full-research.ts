import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

try { process.loadEnvFile(".env"); } catch { /* Hosted runs supply environment variables. */ }
const { createSession } = await import("../src/server/session");
const { createCommission, executeCommand, getCommission } = await import("../src/server/commissions");
const { getPool } = await import("../src/server/db");
const { planDigest } = await import("../src/domain/fixture");
const { museumSources } = await import("../src/exhibition/museum");
const { runNextJob } = await import("../src/server/jobs");

const runId = randomUUID(), path = `.setup-evidence/full-research-${runId}.json`;
await mkdir(".setup-evidence", { recursive: true });
const { session } = await createSession(); session.role = "operator";
await getPool().query("UPDATE guild_sessions SET role='operator' WHERE id=$1", [session.id]);
let commission = await createCommission(session, {
  commandId: randomUUID(), title: "Full-source research · system qualification", museum: "Harbor Street Maritime Museum",
  objective: "Produce the complete English research corpus for the fictional Harbor Street museum: one welcome and one label for each of all twelve supplied archival photographs. Each body is 80–120 words with source-span evidence. Preserve real archive titles, creators, dates and uncertainty. This system qualification creates actual model output for review, never human acceptance or payment eligibility.",
  capMinor: 64000, languages: ["en", "pt", "es", "fr", "ja", "ar"], sourceIds: museumSources.map(source => source.id),
}, museumSources);
await executeCommand(session, commission.id, { type: "approve_plan", commandId: randomUUID(), expectedRevision: commission.revision, planDigest: planDigest(commission) });
commission = await getCommission(session, commission.id);
const started = await executeCommand(session, commission.id, { type: "produce_package", commandId: randomUUID(), expectedRevision: commission.revision, packageId: "research" });
if (!started.ok) throw new Error("The controlled research job did not enter the durable queue.");
const evidence = { schemaVersion: "guild.full-research-qualification.v1", runId, startedAt: new Date().toISOString(), session, commissionId: commission.id, jobId: started.jobId,
  sourceCount: museumSources.length, requiredLabels: museumSources.length + 1, contractVersion: commission.packages[0]!.acceptancePack.version, contractDigest: commission.packages[0]!.acceptancePack.digest,
  humanReviewed: false, acceptanceRecorded: false, financialWrites: 0 };
await writeFile(path, JSON.stringify(evidence, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ stage: "queued", privateEvidence: path, jobId: started.jobId, sourceCount: museumSources.length, requiredLabels: 13, financialWrites: 0 }));
try {
  const outcome = await runNextJob(session.tenantId);
  commission = await getCommission(session, commission.id);
  const artifact = commission.artifacts.find(item => item.id === commission.packages[0]!.artifactIds.at(-1));
  if (artifact) {
    await executeCommand(session, commission.id, { type: "verify_artifact", commandId: randomUUID(), expectedRevision: commission.revision, packageId: "research", artifactId: artifact.id });
    commission = await getCommission(session, commission.id);
  }
  const checks = commission.packages[0]!.acceptancePack.criteria;
  const models = await getPool().query("SELECT id,model,prompt_version,input_hash,output_hash,provider_response_id,status,latency_ms,usage FROM guild_model_runs WHERE tenant_id=$1 AND job_id=$2 ORDER BY created_at", [session.tenantId, started.jobId]);
  const result = { ...evidence, completedAt: new Date().toISOString(), outcome, artifactId: artifact?.id ?? null, artifactHash: artifact?.contentHash ?? null,
    artifact: artifact ?? null, checks, modelRuns: models.rows, packageState: commission.packages[0]!.state, paymentState: commission.packages[0]!.paymentState, error: commission.jobs.at(-1)?.error ?? null };
  await writeFile(path, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ stage: "finished", outcome, artifactHash: result.artifactHash, modelRuns: models.rows.map(row => ({ model: row.model, status: row.status, latencyMs: row.latency_ms })), checks: checks.map(check => ({ id: check.id, status: check.status, evidence: check.evidence })), packageState: result.packageState, paymentState: result.paymentState, humanReviewed: false, acceptanceRecorded: false, financialWrites: 0, error: result.error }));
  if (!artifact || checks.some(check => check.kind === "deterministic" && check.status !== "passed")) process.exitCode = 1;
} finally { await getPool().end(); }
