import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { digest, DomainError } from "@/domain/primitives";
import { planDigest } from "@/domain/fixture";
import { webArtifactSchema, webAuditSummary } from "@/domain/web-audits";
import { isolatedPostgres } from "../support/postgres";
const cleanup = await isolatedPostgres("guild_web_lifecycle_test"); after(cleanup);
const { getPool } = await import("@/server/db");
const { executeCommand, getCommission } = await import("@/server/commissions");
const { runNextJob } = await import("@/server/jobs");
const { webContractProposal } = await import("@/server/web/contracts");
const { fullWebFixture } = await import("../support/web-production-fixture");
const { syntheticWebRuntime, syntheticDesignFor, SyntheticWebAudit } = await import("../support/synthetic-web");

test("Ostrava retains a complete failed design, uses original node feedback, stops after the next pass and independently verifies every file/case", async () => {
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw Error("Unstubbed network denied in web lifecycle integration"); };
  try {
    const f = await fullWebFixture({ webProvider: "ostrava" }), runtime = await syntheticWebRuntime(), audit = new SyntheticWebAudit(true, { runtime, storage: f.media });
    let c = await getCommission(f.session, f.commissionId), pkg = c.packages.find(item => item.kind === "web")!;
    await assert.rejects(webContractProposal(getPool(), c, pkg), error => error instanceof DomainError && error.code === "WEB_AUDIT_NOT_QUALIFIED");
    const pack = await webContractProposal(getPool(), c, pkg, runtime);
    const amendment = await executeCommand(f.session, c.id, { type: "amend_web_contract", commandId: randomUUID(), expectedRevision: c.revision, packageId: pkg.id, contractVersion: pkg.contractVersion, acceptancePackDigest: pack.digest, acknowledgeOriginalSources: true, acknowledgePipelineAndLimits: true }, { webRuntime: runtime });
    assert.ok(amendment.ok); assert.equal(amendment.commission.approvedPlanDigest, null);
    const approval = await executeCommand(f.session, c.id, { type: "approve_plan", commandId: randomUUID(), expectedRevision: amendment.revision, planDigest: planDigest(amendment.commission) }, { webRuntime: runtime });
    assert.ok(approval.ok);
    let modelCreates = 0, modelReads = 0;
    const responses = new Map<string, ReturnType<typeof syntheticDesignFor>>();
    globalThis.fetch = async (url, init) => {
      assert.ok(String(url).startsWith("https://api.openai.com/v1/responses"));
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)), input = JSON.parse(body.input[1].content);
        assert.equal(input.sourceDigest, digest(f.source)); assert.equal(input.requiredKeys.length, 13); assert.equal(input.locales.length, 6);
        assert.equal(input.contract.ordinal, modelCreates + 1); assert.ok(input.contract.ordinal <= 2);
        if (modelCreates === 0) assert.equal(input.previous.length, 0);
        else {
          assert.equal(input.previous.length, 1); assert.equal(input.previous[0].findings.length, 18);
          assert.equal(input.previous[0].originalAuditSummary.axe, false);
          assert.match(JSON.stringify(input.previous[0].findings), /#synthetic-design-node/);
          assert.ok(input.previous[0].findings.every((item: { sourceDigest: string; resultHash: string }) => item.sourceDigest === digest(f.source) && /^[a-f0-9]{64}$/.test(item.resultHash)));
        }
        modelCreates++; const design = syntheticDesignFor(f.source); if (modelCreates === 2) design.typography.bodySize = 18;
        const id = "resp_synthetic_web_" + randomUUID().replaceAll("-", ""); responses.set(id, design);
        return Response.json({ id, status: "queued", output: [] });
      }
      assert.equal(init?.method ?? "GET", "GET"); const id = String(url).split("/").at(-1)!, output = responses.get(id); assert.ok(output); modelReads++;
      return Response.json({ id, status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }] });
    };
    process.env.OPENAI_API_KEY = "synthetic-web-model-no-real-network"; process.env.OPENAI_MODEL = "gpt-6.1-sol";
    async function queue(type: "produce_package" | "verify_artifact") {
      c = await getCommission(f.session, c.id); pkg = c.packages.find(item => item.kind === "web")!;
      const common = { commandId: randomUUID(), expectedRevision: c.revision, packageId: pkg.id };
      const result = await executeCommand(f.session, c.id, type === "produce_package" ? { ...common, type } : { ...common, type, artifactId: pkg.artifactIds.at(-1)! }, { webRuntime: runtime });
      assert.ok(result.ok && result.jobId); return result.jobId;
    }
    async function finish(jobId: string) {
      for (let step = 0; step < 1000; step++) {
        await getPool().query("UPDATE guild_jobs SET available_at=now() WHERE id=$1", [jobId]);
        await getPool().query("UPDATE guild_model_runs SET poll_after=now() WHERE job_id=$1", [jobId]);
        const result = await runNextJob(f.session.tenantId, { media: f.media, audit, webRuntime: runtime });
        if (result?.state !== "queued") {
          const detail = (await getPool().query("SELECT error,output FROM guild_jobs WHERE id=$1", [jobId])).rows[0];
          assert.equal(result?.state, "completed", JSON.stringify({ result, detail })); return;
        }
      }
      throw Error("Bounded synthetic web job did not finish");
    }
    await finish(await queue("produce_package"));
    c = await getCommission(f.session, c.id); pkg = c.packages.find(item => item.kind === "web")!;
    const artifact = c.artifacts.find(item => item.id === pkg.artifactIds.at(-1))!, originalHash = artifact.contentHash, content = webArtifactSchema.parse(artifact.content);
    assert.equal(content.candidates.length, 2); assert.equal(content.selectedOrdinal, 2);
    assert.equal(webAuditSummary(content.candidates[0]!.producerAudits).axe, false); assert.equal(webAuditSummary(content.candidates[1]!.producerAudits).axe, true);
    assert.equal(modelCreates, 2); assert.equal(modelReads, 2); assert.equal(audit.calls, 36); assert.equal(audit.duplicateDenials, 1);
    const originalFailedHash = digest(content.candidates[0]);
    await finish(await queue("verify_artifact"));
    c = await getCommission(f.session, c.id); pkg = c.packages.find(item => item.kind === "web")!;
    assert.ok(pkg.acceptancePack.criteria.every(item => item.kind !== "deterministic" || item.status === "passed"), JSON.stringify(pkg.acceptancePack.criteria));
    assert.equal(audit.calls, 54); assert.equal(audit.modes.filter(mode => mode === "independent").length, 18);
    const retained = c.artifacts.find(item => item.id === artifact.id)!;
    assert.equal(retained.contentHash, originalHash); assert.equal(digest(webArtifactSchema.parse(retained.content).candidates[0]), originalFailedHash);
    assert.equal(modelCreates, 2); assert.equal(modelReads, 2); assert.equal(pkg.acceptedAt, null); assert.equal(c.payments.capturedMinor, 0); assert.equal(c.payments.providerPaidMinor, 0);
  } finally { globalThis.fetch = priorFetch; process.env.OPENAI_API_KEY = ""; }
});
