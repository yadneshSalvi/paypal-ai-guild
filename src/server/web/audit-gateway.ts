import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import type { WebAuditRequest, WebAuditResult } from "@/domain/web-audits";
import type { WebBundle, WebFile } from "@/domain/web-exhibition";
import { validateWebEvidence } from "./audit-evidence";
import { auditEnvironment, verifyWebRuntimeIdentity, webAuditToolRoot } from "./capability";

const exec = promisify(execFile), hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export interface WebAuditGateway {
  run(input: { id: string; tenantId: string; jobId: string; bundleId: string; request: WebAuditRequest; manifest: WebBundle; read(file: WebFile): Promise<Buffer>;
    beforeLaunch(): Promise<void | { workerId: string; originalDeadline: string }>;
    beforeBrowser?(): Promise<void>;
  }): Promise<{ result: WebAuditResult; files: Map<string, Buffer>; afterSave?(): Promise<void> }>;
}
export class WebAuditAttemptError extends Error {
  constructor(public code: string, message: string, public files: Map<string, Buffer> = new Map()) { super(message); }
}
async function retainedFiles(output: string) {
  const files = new Map<string, Buffer>();
  try { for (const path of (await readdir(output)).sort()) if (/^[a-z][a-z0-9-]{0,150}\.json$/.test(path) && !["dispatch.json", "result.json"].includes(path)) {
    const bytes = await readFile(resolve(output, path)); if (bytes.length && bytes.length <= 16 * 1024 * 1024) files.set(path, bytes);
  } } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return files;
}
/** Only an owned, separately pinned browser process is allowed. No IAB access. */
export class LocalWebAuditGateway implements WebAuditGateway {
  async run(input: Parameters<WebAuditGateway["run"]>[0]) {
    const base = process.env.GUILD_WEB_AUDIT_EVIDENCE_DIR;
    if (!base || !isAbsolute(base)) throw new WebAuditAttemptError("WEB_AUDIT_STORAGE_REQUIRED", "An explicit private evidence directory is required for the owned browser worker.");
    const runtime = await verifyWebRuntimeIdentity(input.request.capability);
    const jobDirectory = resolve(base, input.tenantId, input.jobId), bundleDirectory = resolve(jobDirectory, "bundles", input.bundleId), caseDirectory = resolve(jobDirectory, "cases", input.id), output = resolve(caseDirectory, "evidence");
    await mkdir(bundleDirectory, { recursive: true, mode: 0o700 });
    // A cache contains only this job's exact originals. Every case independently
    // rechecks its complete file manifest before serving any cached bytes.
    for (const file of input.manifest.files) {
      const path = resolve(bundleDirectory, file.path); let existing: Buffer | null = null;
      try { existing = await readFile(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (existing) { if (existing.length !== file.byteLength || hash(existing) !== file.contentHash) throw new WebAuditAttemptError("WEB_AUDIT_CACHE_CHANGED", "The exact private bundle cache changed; it was not overwritten."); continue; }
      const bytes = await input.read(file);
      if (bytes.length !== file.byteLength || hash(bytes) !== file.contentHash) throw new WebAuditAttemptError("WEB_ORIGINAL_BYTES_CHANGED", "An original exhibition file failed its byte binding.");
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = path + ".writing-" + randomUUID(), handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      try { await link(temporary, path); } finally { await unlink(temporary); }
    }
    await mkdir(caseDirectory, { recursive: true, mode: 0o700 });
    const requestPath = resolve(caseDirectory, "request.json"), requestText = JSON.stringify(input.request);
    try { await writeFile(requestPath, requestText, { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await readFile(requestPath, "utf8") !== requestText) throw error; }
    // Current authority and the exclusive durable intent are checked after all
    // cache reads and expensive identity checks, immediately before the process.
    await input.beforeLaunch();
    try {
      await exec(process.execPath, [resolve(webAuditToolRoot(), "runner.mjs"), runtime.configPath, requestPath, bundleDirectory, output], { cwd: webAuditToolRoot(), env: auditEnvironment(), timeout: 330000, maxBuffer: 1024 * 1024 });
    } catch { /* A known complete failing case is still retained below. */ }
    const files = await retainedFiles(output); let raw: unknown;
    try { raw = JSON.parse(await readFile(resolve(output, "result.json"), "utf8")); }
    catch { throw new WebAuditAttemptError("WEB_AUDIT_OUTCOME_UNKNOWN", "The original owned browser attempt has no complete result. Partial evidence remains retained; no automatic rerun is permitted.", files); }
    try { return { result: validateWebEvidence(input.request, raw, files), files }; }
    catch { throw new WebAuditAttemptError("WEB_AUDIT_EVIDENCE_CHANGED", "The browser evidence differs from its exact case or native reports. Retain it for review; no replacement browser was dispatched.", files); }
  }
}
