import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digest } from "@/domain/primitives";
import { configuredWebCapabilities, verifyWebRuntimeIdentity } from "@/server/web/capability";
import { sealHostedWebRuntime, verifyHostedWebConfiguration } from "@/server/web/hosted-config";
import { hostedWebFixture } from "./support/hosted-web";
process.env.AUTH_SECRET = "synthetic-hosted-config-seal-only";

test("server-selected bounded hosted seal verifies Linux metadata without executing a Mac runtime verifier", async () => {
  const fixture = await hostedWebFixture(), original = { file: process.env.GUILD_WEB_AUDIT_RUNTIME, inline: process.env.GUILD_WEB_AUDIT_HOSTED_RUNTIME_JSON, evidence: process.env.GUILD_WEB_AUDIT_EVIDENCE_DIR };
  try {
    delete process.env.GUILD_WEB_AUDIT_RUNTIME; delete process.env.GUILD_WEB_AUDIT_EVIDENCE_DIR;
    process.env.GUILD_WEB_AUDIT_HOSTED_RUNTIME_JSON = JSON.stringify(fixture.configuration);
    const configured = await configuredWebCapabilities(); assert.equal(configured.execution, "hosted"); assert.equal(configured.capability.platform, "linux");
    assert.equal(digest((await verifyWebRuntimeIdentity(fixture.capability)).capability), digest(fixture.capability));
    process.env.GUILD_WEB_AUDIT_RUNTIME = "/ambiguous-second-runtime.json";
    await assert.rejects(configuredWebCapabilities(), /one explicit/);
  } finally {
    for (const [name, value] of [["GUILD_WEB_AUDIT_RUNTIME", original.file], ["GUILD_WEB_AUDIT_HOSTED_RUNTIME_JSON", original.inline], ["GUILD_WEB_AUDIT_EVIDENCE_DIR", original.evidence]]) {
      if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
    }
  }
});

test("changed snapshot, source session, renderer or trusted seal cannot enter new work", async () => {
  const { configuration } = await hostedWebFixture();
  for (const mutate of [
    (copy: typeof configuration) => { copy.metadata.snapshot.id = "snap_substituted"; },
    (copy: typeof configuration) => { copy.metadata.snapshot.sourceSessionId = "foreign-original-session"; },
    (copy: typeof configuration) => { copy.metadata.originalRuntime.capability.qualifiedRendererDigest = digest("changed renderer"); },
    (copy: typeof configuration) => { copy.seal = "f".repeat(64); },
  ]) { const copy = structuredClone(configuration); mutate(copy); assert.throws(() => verifyHostedWebConfiguration(copy)); }
});

test("a compact seal cannot invent omitted original cases, native control detection or approval boundaries", async () => {
  const { configuration } = await hostedWebFixture();
  for (const mutate of [
    (copy: Record<string, any>) => { copy.qualification.cases.pop(); },
    (copy: Record<string, any>) => { copy.qualification.cases[0].passes = false; },
    (copy: Record<string, any>) => { copy.qualification.productionApproval = true; },
    (copy: Record<string, any>) => { copy.qualification.cases[19].violationIds = []; },
    (copy: Record<string, any>) => { copy.originalRuntime.capability.platform = "darwin"; },
  ]) { const metadata = structuredClone(configuration.metadata); mutate(metadata); assert.throws(() => sealHostedWebRuntime(metadata)); }
});

test("snapshot expiry denies new work and preserves verification of an original historical configuration", async () => {
  const { configuration } = await hostedWebFixture(), after = Date.parse(configuration.metadata.snapshot.expiresAt) + 1;
  assert.throws(() => verifyHostedWebConfiguration(configuration, { now: after }), /snapshot expired/);
  assert.deepEqual(verifyHostedWebConfiguration(configuration, { now: after, historical: true }), configuration);
});

test("absolute hosted file remains supported and oversized runtime metadata fails before parsing", async () => {
  const { configuration } = await hostedWebFixture(), directory = await mkdtemp(join(tmpdir(), "guild-hosted-config-"));
  const original = { file: process.env.GUILD_WEB_AUDIT_RUNTIME, inline: process.env.GUILD_WEB_AUDIT_HOSTED_RUNTIME_JSON };
  try {
    delete process.env.GUILD_WEB_AUDIT_HOSTED_RUNTIME_JSON;
    const path = join(directory, "runtime.json"); await writeFile(path, JSON.stringify(configuration)); process.env.GUILD_WEB_AUDIT_RUNTIME = path;
    assert.equal((await configuredWebCapabilities()).execution, "hosted");
    await writeFile(path, Buffer.alloc(1024 * 1024 + 1, 32)); await assert.rejects(configuredWebCapabilities(), /bounded private regular file/);
  } finally {
    if (original.file === undefined) delete process.env.GUILD_WEB_AUDIT_RUNTIME; else process.env.GUILD_WEB_AUDIT_RUNTIME = original.file;
    if (original.inline === undefined) delete process.env.GUILD_WEB_AUDIT_HOSTED_RUNTIME_JSON; else process.env.GUILD_WEB_AUDIT_HOSTED_RUNTIME_JSON = original.inline;
    await rm(directory, { recursive: true, force: true });
  }
});
