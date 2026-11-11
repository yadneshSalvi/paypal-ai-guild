import { createHash } from "node:crypto";
import { z } from "zod";
import { validateWebAuditResult, webAuditFileSchema, type WebAuditRequest, type WebAuditResult } from "@/domain/web-audits";
import { digest, DomainError } from "@/domain/primitives";
import { validateWebPaletteMeasurement } from "@/domain/web-contrast";

type File = z.infer<typeof webAuditFileSchema>;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const rawHash = z.string().regex(/^[a-f0-9]{64}$/);
const rawIndex = z.object({ version: z.literal("guild.audit-raw-index.v1"), rawHash, byteLength: z.number().int().gt(1024 * 1024).max(64 * 1024 * 1024), parts: z.array(webAuditFileSchema).min(1).max(199) }).strict();
const rawChunk = z.object({ version: z.literal("guild.audit-raw-chunk.v1"), originalPath: webAuditFileSchema.shape.path, index: z.number().int().nonnegative(), count: z.number().int().positive().max(199), rawHash, dataBase64: z.string().min(1) }).strict();
function fail(): never { throw new DomainError("WEB_AUDIT_EVIDENCE_CHANGED", "The complete original browser report, ordered chunks, engine identity or measured result changed. No altered result may clear a web check.", 422, false); }
function decode(bytes: Buffer): Record<string, unknown> {
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}
export function readWebEvidenceJson(reference: File, files: File[], values: Map<string, Buffer>): Record<string, unknown> {
  function bytes(file: File) {
    const checked = webAuditFileSchema.parse(file), value = values.get(checked.path);
    if (!files.some(item => item.path === checked.path && item.contentHash === checked.contentHash && item.byteLength === checked.byteLength) || !value || value.length !== checked.byteLength || hash(value) !== checked.contentHash) fail();
    return value;
  }
  const parsed = decode(bytes(reference));
  if (parsed.version !== "guild.audit-raw-index.v1") return parsed;
  const indexRecord = rawIndex.parse(parsed);
  if (new Set(indexRecord.parts.map(part => part.path)).size !== indexRecord.parts.length) fail();
  const chunks: Buffer[] = [];
  for (const [index, part] of indexRecord.parts.entries()) {
    const value = rawChunk.parse(decode(bytes(part)));
    if (value.index !== index || value.count !== indexRecord.parts.length || value.originalPath !== reference.path || value.rawHash !== indexRecord.rawHash) fail();
    const chunk = Buffer.from(value.dataBase64, "base64");
    if (chunk.toString("base64") !== value.dataBase64 || !chunk.length || chunk.length > 512 * 1024 || index < indexRecord.parts.length - 1 && chunk.length !== 512 * 1024) fail();
    chunks.push(chunk);
  }
  const original = Buffer.concat(chunks);
  if (original.length !== indexRecord.byteLength || hash(original) !== indexRecord.rawHash) fail();
  return decode(original);
}
function localUrl(value: unknown, request: WebAuditRequest) {
  try { const url = new URL(String(value)); return url.protocol === "http:" && url.hostname === "127.0.0.1" && !!url.port && /^\/[a-f0-9]{48}\/index\.html$/.test(url.pathname)
    && url.search === "?lang=" + request.locale && ["cover", "full_bleed", "split", "comparison", "audio", "collection_grid", "timeline", "credits"].includes(url.hash.slice(1)) && !url.username && !url.password; } catch { return false; }
}
export function validateWebEvidence(request: WebAuditRequest, raw: unknown, values: Map<string, Buffer>): WebAuditResult {
  const result = validateWebAuditResult(request, raw);
  if (result.files.length !== values.size || result.files.reduce((sum, item) => sum + item.byteLength, 0) > 64 * 1024 * 1024) fail();
  for (const file of result.files) { const value = values.get(file.path); if (!value || value.length !== file.byteLength || hash(value) !== file.contentHash) fail(); }
  for (const state of result.axe) {
    const data = readWebEvidenceJson(state.file, result.files, values) as { url?: string; testEngine?: { name: string; version: string }; violations?: { impact: string }[]; incomplete?: unknown[] };
    if (data.testEngine?.name !== "axe-core" || data.testEngine.version !== request.capability.axe || !localUrl(data.url, request) || !Array.isArray(data.violations) || !Array.isArray(data.incomplete)
      || data.violations.length !== state.violations || data.incomplete.length !== state.incomplete || data.violations.filter(item => ["serious", "critical"].includes(item.impact)).length !== state.seriousCritical) fail();
  }
  if (result.lighthouse) {
    const data = readWebEvidenceJson(result.lighthouse.file, result.files, values) as { lighthouseVersion?: string; requestedUrl?: string; categories?: { accessibility?: { score?: unknown } }; configSettings?: { screenEmulation?: { width: number; height: number } }; runWarnings?: unknown[]; runtimeError?: unknown };
    const score = typeof data.categories?.accessibility?.score === "number" ? data.categories.accessibility.score : null;
    if (data.lighthouseVersion !== request.capability.lighthouse || score !== result.lighthouse.accessibilityScore || data.configSettings?.screenEmulation?.width !== request.viewport.width || data.configSettings?.screenEmulation?.height !== request.viewport.height
      || !localUrl(data.requestedUrl, request) || digest(data.runWarnings ?? []) !== digest(result.lighthouse.warnings)) fail();
    if (data.runtimeError && !result.errors.some(item => item.code === "LIGHTHOUSE_RUNTIME" && item.message === JSON.stringify(data.runtimeError))) fail();
  }
  if (result.complete) {
    const paletteFile = result.files.find(file => file.path === "palette-contrast.json");
    if (!paletteFile) fail();
  }
  const paletteFile = result.files.find(file => file.path === "palette-contrast.json");
  if (paletteFile) {
    const palette = validateWebPaletteMeasurement(request, readWebEvidenceJson(paletteFile, result.files, values));
    if (Date.parse(palette.observedAt) < Date.parse(result.startedAt) || Date.parse(palette.observedAt) > Date.parse(result.finishedAt)
      || result.interactions.some(item => item.id === "palette_contrast" && item.passed !== palette.passes)) fail();
  }
  if (result.complete) {
    const reference = result.files.find(file => file.path === "network-and-page-errors.json");
    if (!reference) fail();
    const data = readWebEvidenceJson(reference, result.files, values) as { sourceDigest?: string; externalRequests?: unknown[]; pageErrors?: unknown[]; exactLocalRequests?: { path: string; method: string }[] };
    if (data.sourceDigest !== request.sourceDigest || !Array.isArray(data.externalRequests) || !Array.isArray(data.pageErrors) || !Array.isArray(data.exactLocalRequests)
      || data.exactLocalRequests.some(item => !request.bundle.files.some(file => file.path === item.path) || !["GET", "HEAD"].includes(item.method))
      || result.interactions.find(item => item.id === "no_external_resources")?.passed !== (data.externalRequests.length === 0)
      || result.interactions.find(item => item.id === "no_page_errors")?.passed !== (data.pageErrors.length === 0)) fail();
  }
  return result;
}
