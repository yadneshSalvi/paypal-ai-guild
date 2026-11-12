import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { digest, DomainError } from "@/domain/primitives";
import { webRequiredAxeStates, webRequiredInteractions, type WebAuditResult } from "@/domain/web-audits";
import type { WebAuditCapability, WebDesign, WebSources } from "@/domain/web-exhibition";
import type { WebRuntimeAccess } from "@/server/web/capability";
import type { WebAuditGateway } from "@/server/web/audit-gateway";
import type { PrivateBlobGateway } from "@/server/media/blob-store";
import { runWebAudit } from "@/server/web/audits";
import { getPool } from "@/server/db";
import { webAuditFixture } from "../helpers/web-audit-fixture";
import { webFixture } from "../helpers/web-fixture";
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");

export async function syntheticWebRuntime(): Promise<WebRuntimeAccess> {
  const fixture = await webAuditFixture();
  const value = { configPath: "/synthetic-contract-fixture/no-real-browser-runtime.json", capability: fixture.capability, authored: fixture.assets };
  return { async read() { return value; }, async verify(expected?: WebAuditCapability) { if (expected) assert.equal(digest(expected), digest(value.capability)); return value; } };
}

export function syntheticDesignFor(source: WebSources): WebDesign {
  const design = webFixture().design, keys = source.requiredKeys.filter(key => key !== "welcome"), originalKeys = webFixture().source.requiredKeys.filter(key => key !== "welcome");
  const mapping = new Map(originalKeys.map((key, index) => [key, keys[index]!]));
  for (const chapter of design.chapters) { chapter.labelKeys = chapter.labelKeys.map(key => key === "welcome" ? key : mapping.get(key)!); if (chapter.sourceImageId) chapter.sourceImageId = mapping.get(chapter.sourceImageId)!; }
  return design;
}

/** Synthetic contract transport, not a browser or accessibility measurement. */
export class SyntheticWebAudit implements WebAuditGateway {
  calls = 0; modes: string[] = []; duplicateDenials = 0;
  private raceStarted = false;
  constructor(readonly failFirstProducer = false, readonly race?: { runtime: WebRuntimeAccess; storage: PrivateBlobGateway }) {}
  async run(input: Parameters<WebAuditGateway["run"]>[0]) {
    const { request } = input, original = input.manifest.files.find(file => file.path === "source-record.json")!;
    const bytes = await input.read(original); assert.equal(sha(bytes), original.contentHash); assert.equal(bytes.length, original.byteLength);
    const sourceRecord = JSON.parse(bytes.toString()), design = sourceRecord.design as WebDesign;
    assert.equal(digest(design), request.designDigest); assert.equal(digest(sourceRecord.sources), request.sourceDigest);
    if (this.race && !this.raceStarted) {
      this.raceStarted = true;
      const job = (await getPool().query("SELECT lease_token FROM guild_jobs WHERE id=$1 AND tenant_id=$2", [input.jobId, input.tenantId])).rows[0];
      assert.ok(job?.lease_token);
      let ready!: () => void, release!: () => void;
      const arrived = new Promise<void>(resolve => { ready = resolve; }), released = new Promise<void>(resolve => { release = resolve; });
      const competingGateway: WebAuditGateway = { async run(other) { ready(); await released; await other.beforeLaunch(); throw Error("A duplicate synthetic launch unexpectedly acquired the original intent"); } };
      const competing = runWebAudit({ tenantId: input.tenantId, jobId: input.jobId, leaseToken: job.lease_token, externalCalls: 0, webRuntime: this.race.runtime }, "web", input.bundleId, sourceRecord.sources, request, { storage: this.race.storage, audit: competingGateway })
        .then(() => ({ error: null }), error => ({ error }));
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([arrived, competing.then(result => { throw result.error ?? Error("Competing attempt ended before the claim race"); }), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(Error("Synthetic duplicate did not reach the dispatch barrier")), 10000); })]);
        await input.beforeLaunch(); release();
        const loser = await competing;
        assert.ok(loser.error instanceof DomainError); assert.equal(loser.error.code, "WEB_AUDIT_OUTCOME_UNKNOWN");
        this.duplicateDenials++;
      } finally { if (timeout) clearTimeout(timeout); release(); }
    } else await input.beforeLaunch();
    const intent = (await getPool().query("SELECT state,dispatched_at,request_hash FROM guild_web_audit_cases WHERE tenant_id=$1 AND id=$2", [input.tenantId, input.id])).rows[0];
    assert.equal(intent?.state, "dispatching"); assert.ok(intent.dispatched_at); assert.equal(intent.request_hash, digest(request));
    this.calls++; this.modes.push(request.mode);
    const failed = this.failFirstProducer && request.caseId.startsWith("producer:1:");
    const files = new Map<string, Buffer>(), url = `http://127.0.0.1:1234/${"a".repeat(48)}/index.html?lang=${request.locale}#cover`, startedAt = new Date().toISOString();
    function save(path: string, data: unknown) { const bytes = Buffer.from(JSON.stringify(data)); files.set(path, bytes); return { path, byteLength: bytes.length, contentHash: sha(bytes) }; }
    const axe = webRequiredAxeStates.map(state => {
      const violations = failed && state === "default" ? [{ id: "synthetic-first-design-failure", impact: "serious", help: "Synthetic correction test only", nodes: [{ target: ["#synthetic-design-node"], html: "<div>fixture only</div>", failureSummary: "Deliberately injected fixture finding, not a measured browser defect." }] }] : [];
      return { state, file: save(`axe-${state}.json`, { testEngine: { name: "axe-core", version: request.capability.axe }, url, violations, incomplete: [], synthetic: true }), violations: violations.length, seriousCritical: violations.length, incomplete: 0 };
    });
    const lighthouse = { file: save("lighthouse.json", { lighthouseVersion: request.capability.lighthouse, requestedUrl: url, configSettings: { screenEmulation: request.viewport }, categories: { accessibility: { score: 1, auditRefs: [] } }, audits: {}, runWarnings: [], synthetic: true }), accessibilityScore: 1, warnings: [] };
    const contrastModule = "../../tools/web-audit/contrast.mjs", { createPaletteMeasurement } = await import(contrastModule);
    save("palette-contrast.json", createPaletteMeasurement(request, { design }, { css: design.palette, readerContrast: "false" }, new Date().toISOString()));
    save("network-and-page-errors.json", { sourceDigest: request.sourceDigest, externalRequests: [], pageErrors: [], exactLocalRequests: [{ path: "index.html", method: "GET", range: null }], synthetic: true });
    const result: WebAuditResult = { version: "guild.web-audit-result.v2", requestDigest: digest(request), caseId: request.caseId, locale: request.locale, viewport: request.viewport, mode: request.mode,
      sourceDigest: request.sourceDigest, designDigest: request.designDigest, bundleDigest: request.bundle.filesDigest, capabilityDigest: digest(request.capability), rendererDigest: request.rendererDigest,
      startedAt, finishedAt: new Date().toISOString(), complete: true, axe, lighthouse, interactions: webRequiredInteractions.map(id => ({ id, passed: true, detail: "Synthetic transport fixture only; no browser observation or human review is claimed.", observed: null })),
      files: [...files].map(([path, bytes]) => ({ path, byteLength: bytes.length, contentHash: sha(bytes) })), errors: [] };
    return { result, files };
  }
}
