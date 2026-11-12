import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { webAuditCapabilitySchema, type WebAuditCapability } from "@/domain/web-exhibition";
import { digest, DomainError } from "@/domain/primitives";
import { readAuthoredWebAssets, type AuthoredWebAssets } from "@/exhibition/generated/render";
import { verifyHostedWebConfiguration, type HostedWebConfiguration } from "./hosted-config";

const exec = promisify(execFile), hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const codeFiles = ["identity.mjs", "server.mjs", "evidence.mjs", "contract.mjs", "contrast.mjs", "interactions.mjs", "runner.mjs", "qualify.mjs", "policy.json", "package.json"];
export function webAuditToolRoot() { return resolve(process.cwd(), "tools/web-audit"); }
export function auditEnvironment(): NodeJS.ProcessEnv { return { NODE_ENV: "production", PATH: process.env.PATH ?? "", TMPDIR: process.env.TMPDIR ?? "/tmp", LANG: "en_US.UTF-8" }; }
function unavailable(message: string): never { throw new DomainError("WEB_AUDIT_NOT_QUALIFIED", message, 422, false); }
export interface ConfiguredWebRuntime {
  configPath: string; capability: WebAuditCapability; authored: AuthoredWebAssets;
  execution?: "local" | "hosted"; hosted?: HostedWebConfiguration;
}
export async function readBoundedWebRuntimeJson(path: string) {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 1024 * 1024) unavailable("The browser runtime metadata must be a bounded private regular file.");
    const bytes = Buffer.alloc(stat.size + 1), result = await file.read(bytes, 0, bytes.length, 0);
    if (result.bytesRead !== stat.size) unavailable("The browser runtime metadata changed while it was read.");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, result.bytesRead)));
  } finally { await file.close(); }
}
export async function configuredWebCapabilities(): Promise<ConfiguredWebRuntime> {
  const inline = process.env.GUILD_WEB_AUDIT_HOSTED_RUNTIME_JSON;
  const filePath = process.env.GUILD_WEB_AUDIT_RUNTIME;
  if (inline && filePath) unavailable("Select one explicit server-side browser runtime configuration before new work.");
  if (!inline && (!filePath || !isAbsolute(filePath))) unavailable("A separately qualified, pinned browser audit runtime is required before the web agreement can be prepared. Saved sources remain readable.");
  const configPath = filePath ?? "server:hosted-web-runtime";
  try {
    if (inline && Buffer.byteLength(inline) > 1024 * 1024) unavailable("The sealed hosted runtime metadata exceeds its bounded size.");
    const config = inline ? JSON.parse(inline) : await readBoundedWebRuntimeJson(configPath);
    if (inline && config.version !== "guild.web-audit-hosted-runtime.v1") unavailable("Inline server configuration accepts only the separately sealed hosted runtime.");
    const hosted = config.version === "guild.web-audit-hosted-runtime.v1" ? verifyHostedWebConfiguration(config) : undefined;
    const capability = webAuditCapabilitySchema.parse(hosted?.metadata.originalRuntime.capability ?? config.capability);
    if (!hosted) {
      if (!process.env.GUILD_WEB_AUDIT_EVIDENCE_DIR || !isAbsolute(process.env.GUILD_WEB_AUDIT_EVIDENCE_DIR)) unavailable("The owned local browser worker needs an explicit private evidence directory before new work. Saved exhibitions remain readable.");
      if (config.version !== "guild.web-audit-runtime.v2" || config.state !== "qualified" || !isAbsolute(config.qualificationPath)) unavailable("The browser diagnostic is incomplete; it is not a qualified web producer.");
      const qualification = await readBoundedWebRuntimeJson(config.qualificationPath);
      const { qualifiedAt: _at, qualificationDigest: _proof, qualifiedRendererDigest: _renderer, ...engine } = capability;
      if (digest(qualification) !== capability.qualificationDigest || qualification.passed !== true || qualification.baselineCases !== 18 || qualification.detectedMutations !== 2
        || qualification.engineDigest !== digest(engine) || qualification.rendererDigest !== capability.qualifiedRendererDigest) unavailable("The complete retained browser qualification differs from its declared runtime.");
    }
    const code = [];
    for (const path of codeFiles) code.push({ path, sha256: hash(await readFile(resolve(webAuditToolRoot(), path))) });
    if (digest(code) !== capability.runnerHash || hash(await readFile(resolve(webAuditToolRoot(), "package-lock.json"))) !== capability.packageLockHash) unavailable("The authored audit runner or pinned dependency lock changed after qualification.");
    const authored = await readAuthoredWebAssets();
    if (authored.capability.digest !== capability.qualifiedRendererDigest) unavailable("The current authored reader differs from the exact renderer that completed browser qualification.");
    return { configPath, capability, authored, execution: hosted ? "hosted" : "local", ...(hosted ? { hosted } : {}) };
  } catch (error) { if (error instanceof DomainError) throw error; unavailable("The exact browser qualification files are unavailable or invalid. No alternate browser or substituted audit is permitted."); }
}
/** Full binary, distribution and dependency identity check; this command launches no browser. */
export async function verifyWebRuntimeIdentity(expected?: WebAuditCapability) {
  const configured = await configuredWebCapabilities();
  if (expected && digest(configured.capability) !== digest(expected)) unavailable("The configured browser runtime differs from the exact agreed audit capability.");
  // A Mac or function host cannot verify Linux binaries. The local trusted seal
  // admits metadata only; HostedWebAuditGateway performs the complete remote
  // read-only verification before dispatching its one original browser command.
  if (configured.execution === "hosted") return configured;
  try {
    const observed = await exec(process.execPath, [resolve(webAuditToolRoot(), "qualify.mjs"), "verify", configured.configPath], { cwd: webAuditToolRoot(), env: auditEnvironment(), timeout: 120000, maxBuffer: 1024 * 1024 });
    const capability = webAuditCapabilitySchema.parse(JSON.parse(observed.stdout).capability);
    if (digest(capability) !== digest(configured.capability) || expected && digest(capability) !== digest(expected)) unavailable("The current browser distribution, dependencies or platform no longer match the exact agreed audit capability.");
    return configured;
  } catch (error) { if (error instanceof DomainError) throw error; unavailable("The pinned browser runtime failed its exact identity check. No browser or provider fallback was dispatched."); }
}
/** Server-side composition port, like the media/browser gateways. HTTP inputs
 * never select or configure this dependency; routes use the installed runtime. */
export interface WebRuntimeAccess {
  read(): Promise<ConfiguredWebRuntime>;
  verify(expected?: WebAuditCapability): Promise<ConfiguredWebRuntime>;
}
export const installedWebRuntime: WebRuntimeAccess = { read: configuredWebCapabilities, verify: verifyWebRuntimeIdentity };
