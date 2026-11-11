import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { digest } from "@/domain/primitives";
import { validateWebAuditResult, webAuditSummary, webCaseOutcomes, webMeasuredPack } from "@/domain/web-audits";
import { webAcceptancePack, webAuditPolicy, webAuthoritySchema, webSourcesFromPack } from "@/domain/web-exhibition";
import { readWebEvidenceJson, validateWebEvidence } from "@/server/web/audit-evidence";
import { webAuditFixture, webAuthorityFixture } from "./helpers/web-audit-fixture";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const evidenceModule = "../tools/web-audit/evidence.mjs", contractModule = "../tools/web-audit/contract.mjs";
async function temporary<T>(run: (path: string) => Promise<T>) { const path = await mkdtemp(resolve(tmpdir(), "guild-audit-contract-")); try { return await run(path); } finally { await rm(path, { recursive: true, force: true }); } }

test("every request field binds the original browser result; changed source, locale, engine and scope are rejected", async () => {
  const f = await webAuditFixture();
  assert.deepEqual(validateWebEvidence(f.request, f.result, f.values), f.result);
  for (const key of ["sourceDigest", "designDigest", "bundleDigest", "capabilityDigest", "rendererDigest", "requestDigest"] as const) assert.throws(() => validateWebEvidence(f.request, { ...f.result, [key]: "0".repeat(64) }, f.values));
  assert.throws(() => validateWebAuditResult(f.request, { ...f.result, locale: "ar" }));
  assert.throws(() => validateWebAuditResult(f.request, { ...f.result, mode: "independent" }));
  assert.throws(() => validateWebAuditResult(f.request, { ...f.result, viewport: { width: 390, height: 900 } }));
});

test("a 0.9499 score, missing score or serious axe finding never rounds into a passing measurement", async () => {
  const f = await webAuditFixture();
  assert.deepEqual(webCaseOutcomes(f.result), { axe: true, lighthouse: true, palette: true, interaction: true });
  assert.equal(webCaseOutcomes({ ...f.result, lighthouse: { ...f.result.lighthouse!, accessibilityScore: .9499 } }).lighthouse, false);
  assert.equal(webCaseOutcomes({ ...f.result, lighthouse: { ...f.result.lighthouse!, accessibilityScore: null } }).lighthouse, false);
  assert.equal(webCaseOutcomes({ ...f.result, axe: [{ ...f.result.axe[0]!, seriousCritical: 1 }, ...f.result.axe.slice(1)] }).axe, false);
  const failed = { ...f.result, complete: false, errors: [{ code: "MEASUREMENT_LOST", message: "Synthetic retained failure." }] };
  assert.deepEqual(webCaseOutcomes(failed), { axe: false, lighthouse: false, palette: false, interaction: false });
});

test("duplicate, reordered identity and missing native observations cannot masquerade as a complete case", async () => {
  const f = await webAuditFixture();
  assert.throws(() => validateWebAuditResult(f.request, { ...f.result, axe: [f.result.axe[0], f.result.axe[0], ...f.result.axe.slice(2)] }));
  assert.throws(() => validateWebAuditResult(f.request, { ...f.result, interactions: f.result.interactions.slice(1) }));
  assert.throws(() => validateWebAuditResult(f.request, { ...f.result, complete: false, errors: [] }));
  assert.throws(() => validateWebAuditResult(f.request, { ...f.result, files: [...f.result.files, f.result.files[0]] }));
  const changed = new Map(f.values); changed.set("axe-default.json", Buffer.from("{}"));
  assert.throws(() => validateWebEvidence(f.request, f.result, changed));
});

test("complete raw Lighthouse and axe findings are checked independently of their summaries", async () => {
  const f = await webAuditFixture();
  const native = JSON.parse(f.values.get("lighthouse.json")!.toString()); native.categories.accessibility.score = .5;
  const file = f.save("lighthouse.json", native), raw = { ...f.result, files: f.result.files.map(item => item.path === file.path ? file : item), lighthouse: { ...f.result.lighthouse!, file } };
  assert.throws(() => validateWebEvidence(f.request, raw, f.values));
  raw.lighthouse.accessibilityScore = .5;
  assert.equal(webCaseOutcomes(validateWebEvidence(f.request, raw, f.values)).lighthouse, false);
  native.configSettings.screenEmulation.width = 1440;
  const different = f.save("lighthouse.json", native); raw.files = raw.files.map(item => item.path === different.path ? different : item); raw.lighthouse.file = different;
  assert.throws(() => validateWebEvidence(f.request, raw, f.values));
});

test("network/page-error observations cannot be dropped while their interaction is marked passed", async () => {
  const f = await webAuditFixture();
  const file = f.save("network-and-page-errors.json", { sourceDigest: f.request.sourceDigest, externalRequests: [{ url: "https://example.test/attempted" }], pageErrors: [], exactLocalRequests: [] });
  const raw = { ...f.result, files: f.result.files.map(item => item.path === file.path ? file : item) };
  assert.throws(() => validateWebEvidence(f.request, raw, f.values));
  raw.interactions = raw.interactions.map(item => item.id === "no_external_resources" ? { ...item, passed: false } : item);
  assert.equal(webCaseOutcomes(validateWebEvidence(f.request, raw, f.values)).interaction, false);
});

test("all 18 distinct locale/viewport cases are required and automated results leave human experience pending", async () => {
  const f = await webAuditFixture();
  const receipts = webAuditPolicy.locales.flatMap(locale => webAuditPolicy.viewports.map(viewport => {
    const result = { ...f.result, locale: locale as typeof f.result.locale, viewport, caseId: `${locale}:${viewport.width}` };
    return { id: randomUUID(), requestDigest: result.requestDigest, resultHash: digest(result), result };
  }));
  assert.equal(webAuditSummary(receipts).complete, true);
  assert.equal(webAuditSummary(receipts.slice(1)).complete, false);
  assert.equal(webAuditSummary([...receipts.slice(1), receipts[1]!]).complete, false);
  const pack = webAcceptancePack(f.source, webAuthorityFixture(), f.capability, f.assets.capability);
  const checked = webMeasuredPack(pack, true, true, receipts);
  assert.equal(checked.criteria.find(item => item.id === "experience")!.status, "pending");
  assert.equal(checked.criteria.filter(item => item.kind === "deterministic" && item.status === "passed").length, 6);
  assert.deepEqual(webSourcesFromPack(checked), f.source);
});

test("the earliest original authority is immutable and altered criteria cannot reuse the old pack digest", async () => {
  const f = await webAuditFixture(), authority = webAuthorityFixture();
  assert.equal(webAuthoritySchema.safeParse({ ...authority, expiresAt: authority.approval.actorExpiresAt }).success, false);
  const pack = webAcceptancePack(f.source, authority, f.capability, f.assets.capability), changed = structuredClone(pack);
  changed.criteria.find(item => item.id === "lighthouse")!.blocking = false;
  assert.throws(() => webSourcesFromPack(changed));
  changed.criteria = pack.criteria; changed.parameters!.audit = { ...webAuditPolicy, minimumLighthouseAccessibilityScore: .9 };
  assert.throws(() => webSourcesFromPack(changed));
});

test("chunked native reports preserve all bytes and reject reordered chunks, invalid UTF-8 and traversal references", async () => temporary(async directory => {
  const { evidenceWriter, readEvidenceJson } = await import(evidenceModule), writer = evidenceWriter(directory);
  const original = { native: "Synthetic large report", text: "日本語 العربية ".repeat(100000) }, file = await writer.json("large-report.json", original);
  const values = new Map<string, Buffer>(); for (const item of writer.files) values.set(item.path, await readFile(resolve(directory, item.path)));
  assert.deepEqual(readWebEvidenceJson(file, writer.files, values), original);
  assert.deepEqual(await readEvidenceJson(directory, file, writer.files), original);
  const index = JSON.parse(values.get(file.path)!.toString()); index.parts.reverse();
  const bytes = Buffer.from(JSON.stringify(index)), changed = { ...file, contentHash: hash(bytes), byteLength: bytes.length };
  values.set(file.path, bytes);
  assert.throws(() => readWebEvidenceJson(changed, writer.files.map((item: { path: string }) => item.path === file.path ? changed : item), values));
  const invalid = Buffer.from([0x7b,0x22,0x78,0x22,0x3a,0x22,0xff,0x22,0x7d]), bad = { path: "invalid.json", contentHash: hash(invalid), byteLength: invalid.length };
  assert.throws(() => readWebEvidenceJson(bad, [bad], new Map([[bad.path, invalid]])));
  await assert.rejects(() => readEvidenceJson(directory, { ...file, path: "../outside.json" }, writer.files));
}));

test("an oversized native report retains a bounded explicit failure rather than a truncated passing report", async () => temporary(async directory => {
  const { evidenceWriter } = await import(evidenceModule), writer = evidenceWriter(directory, 8192);
  await assert.rejects(() => writer.json("native-report.json", { synthetic: true, text: "x".repeat(100000) }), /AUDIT_EVIDENCE_LIMIT/);
  assert.equal(writer.files.length, 1); assert(writer.files[0].path.endsWith("-retention-failure.json"));
  assert(writer.files.reduce((sum: number, item: { byteLength: number }) => sum + item.byteLength, 0) <= 8192);
  const marker = JSON.parse(await readFile(resolve(directory, writer.files[0].path), "utf8"));
  assert.equal(marker.complete, false); assert.equal(marker.originalReportRetained, false);
  const f = await webAuditFixture(), result = { ...f.result, complete: false, axe: [], lighthouse: null, interactions: [], files: writer.files, errors: [{ code: "BROWSER_CASE_INCOMPLETE", message: "AUDIT_EVIDENCE_LIMIT" }] };
  const values = new Map<string, Buffer>([[writer.files[0].path, await readFile(resolve(directory, writer.files[0].path))]]);
  assert.equal(validateWebEvidence(f.request, result, values).complete, false);
}));

test("the independent qualification reader validates exact original requests and all native files without launching a browser", async () => temporary(async directory => {
  const { inspectResult, qualificationRequest } = await import(contractModule), f = await webAuditFixture();
  for (const [path, bytes] of f.values) await writeFile(resolve(directory, path), bytes);
  await writeFile(resolve(directory, "dispatch.json"), JSON.stringify({ version: "guild.local-browser-dispatch.v1", pid: 123, requestDigest: digest(f.request), startedAt: f.result.startedAt }));
  await writeFile(resolve(directory, "result.json"), JSON.stringify(f.result));
  assert.equal((await inspectResult(f.request, f.result, directory, webAuditPolicy)).passes, true);
  await assert.rejects(() => inspectResult({ ...f.request, authorityDigest: "0".repeat(64) }, f.result, directory, webAuditPolicy));
  await writeFile(resolve(directory, "omitted-native.json"), "{}");
  await assert.rejects(() => inspectResult(f.request, f.result, directory, webAuditPolicy), /omitted files/);
  const config = { inputDigest: digest("sample set"), capability: f.capability };
  const original = qualificationRequest(config, { id: "baseline-en-390", locale: "en", viewport: f.request.viewport, entry: { bundle: f.rendered.bundle } });
  assert.notEqual(digest(original), digest({ ...original, authorityDigest: "1".repeat(64) }));
}));
