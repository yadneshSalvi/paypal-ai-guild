import { createHash } from "node:crypto";
import { digest } from "@/domain/primitives";
import { webRequiredAxeStates, webRequiredInteractions, type WebAuditRequest, type WebAuditResult } from "@/domain/web-audits";
import type { WebAuditCapability, WebAuthority } from "@/domain/web-exhibition";
import { readAuthoredWebAssets, renderWebFiles } from "@/exhibition/generated/render";
import { webFixture } from "./web-fixture";

/** Deliberately synthetic reports for contract tests; never observed browser scores. */
export async function webAuditFixture() {
  const fixture = webFixture(), assets = await readAuthoredWebAssets(), rendered = renderWebFiles(fixture.source, fixture.design, assets);
  const capability: WebAuditCapability = { version: "guild.chromium-web-audit.v1", runnerHash: digest("synthetic audit source"), packageLockHash: digest("synthetic dependency lock"), dependenciesDigest: digest("synthetic dependencies"), browserDistributionDigest: digest("synthetic browser distribution"), nodeExecutableHash: digest("synthetic node"), browserRevision: "1254", operatingSystem: "Synthetic contract fixture; no browser launched", playwright: "1.65.0", axe: "4.14.0", lighthouse: "13.6.0", browserVersion: "158.0.8127.18", browserExecutableHash: digest("synthetic browser executable"), platform: "synthetic", architecture: "synthetic", node: "v22.22.3", qualifiedAt: "2026-11-11T10:00:00.000Z", qualificationDigest: digest("synthetic qualification only"), qualifiedRendererDigest: assets.capability.digest };
  const request: WebAuditRequest = { version: "guild.web-audit-request.v1", mode: "qualification", locale: "en", viewport: { width: 390, height: 844 }, caseId: "baseline-en-390", authorityDigest: digest("synthetic diagnostic-only authority"), rendererDigest: assets.capability.digest, capability, sourceDigest: rendered.bundle.sourceDigest, designDigest: rendered.bundle.designDigest, bundle: rendered.bundle };
  const values = new Map<string, Buffer>(), url = `http://127.0.0.1:1234/${"a".repeat(48)}/index.html?lang=en#cover`;
  function save(path: string, data: unknown) { const bytes = Buffer.from(JSON.stringify(data)); values.set(path, bytes); return { path, byteLength: bytes.length, contentHash: createHash("sha256").update(bytes).digest("hex") }; }
  const axe = webRequiredAxeStates.map(state => ({ state, file: save(`axe-${state}.json`, { testEngine: { name: "axe-core", version: capability.axe }, url, violations: [], incomplete: [], synthetic: true }), violations: 0, seriousCritical: 0, incomplete: 0 }));
  const lighthouse = { file: save("lighthouse.json", { lighthouseVersion: capability.lighthouse, requestedUrl: url, configSettings: { screenEmulation: request.viewport }, categories: { accessibility: { score: .95 } }, runWarnings: [], synthetic: true }), accessibilityScore: .95, warnings: [] };
  save("network-and-page-errors.json", { sourceDigest: request.sourceDigest, externalRequests: [], pageErrors: [], exactLocalRequests: [{ path: "index.html", method: "GET", range: null }] });
  const files = [...values].map(([path, bytes]) => ({ path, byteLength: bytes.length, contentHash: createHash("sha256").update(bytes).digest("hex") }));
  const result: WebAuditResult = { version: "guild.web-audit-result.v1", requestDigest: digest(request), caseId: request.caseId, locale: request.locale, viewport: request.viewport, mode: request.mode, sourceDigest: request.sourceDigest, designDigest: request.designDigest, bundleDigest: rendered.bundle.filesDigest, capabilityDigest: digest(capability), rendererDigest: request.rendererDigest, startedAt: "2026-11-11T10:01:00.000Z", finishedAt: "2026-11-11T10:01:01.000Z", complete: true, axe, lighthouse, interactions: webRequiredInteractions.map(id => ({ id, passed: true, detail: "Synthetic contract fixture only. No browser observation is claimed.", observed: null })), files, errors: [] };
  return { ...fixture, assets, rendered, capability, request, result, values, save };
}
export function webAuthorityFixture(): WebAuthority {
  return { version: "guild.web-authority-ceiling.v1", expiresAt: "2026-11-11T11:45:29.435Z", approval: { id: "a1d1732d-7440-47c9-8461-8618f108deef", actorId: "af63fbba-d0fe-4e87-bba5-79f139f6b94d", planDigest: digest("synthetic original approval"), receiptHash: digest("synthetic approval receipt"), actorExpiresAt: "2026-11-18T11:45:29.435Z", commandId: "fc6fbbe6-57ab-4557-8d40-58a61f332344", snapshotHash: digest("synthetic producing snapshot") }, limits: [{ label: "Original production ceiling", expiresAt: "2026-11-11T11:45:29.435Z" }] };
}
