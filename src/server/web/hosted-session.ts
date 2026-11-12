import { Readable } from "node:stream";
import { getVercelOidcToken } from "@vercel/oidc";
import { Sandbox, Snapshot, type Session } from "@vercel/sandbox";
import { z } from "zod";
import { digest, DomainError } from "@/domain/primitives";
import type { HostedWebConfiguration } from "./hosted-config";
import { singleAttemptSandboxFetch } from "./hosted-transport";
import type { HostedAttemptRecord } from "./hosted-store";

export type HostedCommandSpec = NonNullable<HostedAttemptRecord["commandSpecs"]["verify"]>;
export interface HostedCommandIdentity { id: string; startedAt: number; cwd: string; exitCode: number | null }
export interface HostedCommandOutput extends HostedCommandIdentity { stdout: string }
export interface HostedSessionIdentity {
  name: string; persistent: boolean; sessionId: string; createdAt: string; status: NonNullable<HostedAttemptRecord["sessionReceipt"]>["status"];
  snapshotId: string | undefined; networkPolicy: unknown; ports: number[]; vcpus: number; timeoutMs: number; region: string;
}
export interface HostedSessionAccess {
  readonly identity: HostedSessionIdentity;
  run(spec: HostedCommandSpec, onStart: (command: HostedCommandIdentity) => Promise<void>): Promise<HostedCommandOutput>;
  command(id: string): Promise<HostedCommandIdentity>;
  upload(files: { path: string; content: Buffer; mode: number }[]): Promise<void>;
  read(path: string, maximumBytes: number): Promise<Buffer | null>;
  stop(): Promise<void>;
}
export interface HostedSandboxDriver {
  snapshot(configuration: HostedWebConfiguration): Promise<{ id: string; sourceSessionId: string; status: string; createdAt: string; expiresAt: string | null; regions: string[] }>;
  create(name: string, configuration: HostedWebConfiguration): Promise<HostedSessionAccess>;
  get(name: string, configuration: HostedWebConfiguration): Promise<HostedSessionAccess>;
}
function fail(code: string, message: string): never { throw new DomainError(code, message, 422, false); }
export function assertOriginalHostedSession(session: HostedSessionAccess, record: HostedAttemptRecord, options: { readOnly?: boolean; unbound?: boolean } = {}) {
  const value = session.identity, metadata = record.configuration.metadata;
  if (value.name !== record.binding.remoteName || value.persistent !== false || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.sessionId)
    || value.sessionId === metadata.snapshot.sourceSessionId
    || !options.unbound && value.sessionId !== record.session?.id || record.session && (value.sessionId !== record.session.id || value.createdAt !== record.session.createdAt)
    || value.snapshotId !== record.binding.snapshotId || value.snapshotId !== metadata.snapshot.id || value.networkPolicy !== "deny-all" || value.ports.length !== 0
    || value.vcpus !== 2 || value.timeoutMs !== metadata.timeoutMs || value.region !== metadata.snapshot.region
    || !Number.isFinite(Date.parse(value.createdAt)) || Date.parse(value.createdAt) < Date.parse(record.binding.originalDispatchedAt) - 30000)
    fail("WEB_HOSTED_IDENTITY_CHANGED", "The original worker name, immutable snapshot, session, network policy, ports or resources changed. No later session can replace it.");
  if (!options.readOnly && value.status !== "running") fail("WEB_HOSTED_SESSION_STOPPED", "The original hosted session is no longer running. It will not be resumed or replaced; only retained original evidence may be read.");
  return session;
}
export function assertHostedSnapshot(observed: Awaited<ReturnType<HostedSandboxDriver["snapshot"]>>, configuration: HostedWebConfiguration, now = Date.now()) {
  const expected = configuration.metadata.snapshot;
  if (observed.id !== expected.id || observed.sourceSessionId !== expected.sourceSessionId || observed.createdAt !== expected.createdAt
    || observed.expiresAt !== expected.expiresAt || observed.status !== "created" || !observed.regions.includes(expected.region))
    fail("WEB_HOSTED_SNAPSHOT_CHANGED", "The hosted snapshot differs from its exact qualified original session or sealed identity. No alternate runtime was created.");
  if (Date.parse(expected.expiresAt) <= now) fail("WEB_HOSTED_SNAPSHOT_EXPIRED", "The exact qualified hosted snapshot expired. New browser work needs a separately qualified runtime and reviewed agreement.");
}
async function credentials(configuration: HostedWebConfiguration) {
  const { teamId, projectId } = configuration.metadata.controlPlane;
  const explicit = process.env.GUILD_WEB_SANDBOX_TOKEN;
  if (explicit) return { token: explicit, teamId, projectId };
  try {
    // This is the same public OIDC helper the SDK uses. The supplied scope is
    // server-selected and token material stays solely in the control plane.
    const token = await getVercelOidcToken({ team: teamId, project: projectId });
    const payload = z.object({ owner_id: z.string(), project_id: z.string(), exp: z.number() }).parse(JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")));
    if (payload.owner_id !== teamId || payload.project_id !== projectId || payload.exp * 1000 <= Date.now()) throw new Error("scope");
    // The provider authenticates the token; decoding here additionally prevents
    // sending the operation under a different configured project/team scope.
    return { token, teamId, projectId };
  } catch { fail("WEB_HOSTED_AUTH_REQUIRED", "Connect this server's configured Vercel project using hosting OIDC or an explicit server-only Sandbox token. Original stored reports remain readable."); }
}
class SdkHostedSession implements HostedSessionAccess {
  readonly identity: HostedSessionIdentity;
  constructor(sandbox: Sandbox, private readonly session: Session) {
    this.identity = { name: sandbox.name, persistent: sandbox.persistent, sessionId: session.sessionId, createdAt: session.createdAt.toISOString(), status: session.status,
      snapshotId: session.sourceSnapshotId, networkPolicy: session.networkPolicy, ports: session.routes.map(route => route.port), vcpus: session.vcpus, timeoutMs: session.timeout, region: session.region };
  }
  async run(spec: HostedCommandSpec, onStart: (command: HostedCommandIdentity) => Promise<void>) {
    const value = await this.session.runCommand({ ...spec, detached: false, signal: AbortSignal.timeout(spec.timeoutMs + 10000),
      onStart: command => onStart({ id: command.cmdId, startedAt: command.startedAt, cwd: command.cwd, exitCode: command.exitCode }) });
    const stdout = await value.stdout();
    if (Buffer.byteLength(stdout) > 1024 * 1024) fail("WEB_HOSTED_OUTPUT_TOO_LARGE", "The original hosted command exceeded its bounded metadata output. No replacement command was sent.");
    return { id: value.cmdId, startedAt: value.startedAt, cwd: value.cwd, exitCode: value.exitCode, stdout };
  }
  async command(id: string) {
    const command = await this.session.getCommand(id, { signal: AbortSignal.timeout(30000) });
    return { id: command.cmdId, startedAt: command.startedAt, cwd: command.cwd, exitCode: command.exitCode };
  }
  async upload(files: { path: string; content: Buffer; mode: number }[]) {
    await this.session.writeFiles(files, { signal: AbortSignal.timeout(60000) });
  }
  async read(path: string, maximumBytes: number) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 16 * 1024 * 1024) throw new Error("Invalid bounded hosted read");
    const value = await this.session.readFile({ path }, { signal: AbortSignal.timeout(30000) });
    if (!value) return null;
    const stream = value as Readable, buffers: Buffer[] = []; let size = 0;
    try {
      for await (const part of stream) {
        const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part as Uint8Array); size += bytes.length;
        if (size > maximumBytes) fail("WEB_HOSTED_FILE_TOO_LARGE", "The original hosted file exceeded its exact bounded evidence size.");
        buffers.push(bytes);
      }
    } finally { stream.destroy(); }
    return Buffer.concat(buffers, size);
  }
  async stop() { await this.session.stop({ signal: AbortSignal.timeout(30000) }); }
}
/** Only Sandbox.create/get and currentSession are used on Sandbox instances.
 * Every filesystem, command and stop operation goes directly to that original
 * Session. None can invoke Sandbox's automatic resume/redelivery wrapper. */
export class VercelHostedSandboxDriver implements HostedSandboxDriver {
  private readonly transport: typeof fetch;
  constructor(transport: typeof fetch = fetch, private readonly authenticate = credentials) { this.transport = singleAttemptSandboxFetch(transport); }
  private scopedTransport(configuration: HostedWebConfiguration): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const { teamId, projectId } = configuration.metadata.controlPlane;
      const authorization = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("authorization") ?? "";
      const token = authorization.replace(/^Bearer /, "");
      // SDK3.9.1 creates snapshot-backed sandboxes through v3; session and
      // snapshot reads/commands use v2. Both stay on the same control plane.
      let mismatched = url.origin !== "https://vercel.com" || !/^\/api\/v[23]\/sandboxes(?:\/|$)/.test(url.pathname) || url.searchParams.get("teamId") !== teamId;
      if (token.split(".").length === 3) {
        try {
          const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
          mismatched ||= claims.owner_id !== teamId || claims.project_id !== projectId;
        } catch { mismatched = true; }
      }
      if (mismatched) {
        const error = new Error("The hosted control-plane scope changed before the original request. No request was sent.");
        error.name = "AbortError"; throw error;
      }
      return this.transport(input, init);
    }) as typeof fetch;
  }
  async snapshot(configuration: HostedWebConfiguration) {
    const value = await Snapshot.get({ snapshotId: configuration.metadata.snapshot.id, ...await this.authenticate(configuration), fetch: this.scopedTransport(configuration), signal: AbortSignal.timeout(30000) });
    return { id: value.snapshotId, sourceSessionId: value.sourceSessionId, status: value.status, createdAt: value.createdAt.toISOString(), expiresAt: value.expiresAt?.toISOString() ?? null, regions: value.regions };
  }
  async create(name: string, configuration: HostedWebConfiguration) {
    const value = await Sandbox.create({ ...await this.authenticate(configuration), fetch: this.scopedTransport(configuration), name, persistent: false, source: { type: "snapshot", snapshotId: configuration.metadata.snapshot.id },
      resources: { vcpus: 2 }, timeout: 600000, region: configuration.metadata.snapshot.region, networkPolicy: "deny-all", ports: [], env: {}, signal: AbortSignal.timeout(60000) });
    return new SdkHostedSession(value, value.currentSession());
  }
  async get(name: string, configuration: HostedWebConfiguration) {
    const value = await Sandbox.get({ ...await this.authenticate(configuration), fetch: this.scopedTransport(configuration), name, resume: false, signal: AbortSignal.timeout(30000) });
    return new SdkHostedSession(value, value.currentSession());
  }
}
export const hostedCommandDigest = (spec: HostedCommandSpec) => digest(spec);
