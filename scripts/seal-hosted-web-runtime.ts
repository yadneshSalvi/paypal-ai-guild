import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { digest, DomainError } from "../src/domain/primitives";
import { readBoundedWebRuntimeJson } from "../src/server/web/capability";
import { hostedWebMetadataSchema, sealHostedWebRuntime } from "../src/server/web/hosted-config";

/** Local operator utility only. It performs no control-plane request, browser,
 * provider, database or deployment operation. The operator must already have
 * independently verified and retained the complete original native evidence. */
async function main() {
  const flags = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index += 2) {
    const flag = process.argv[index], value = process.argv[index + 1];
    if (!flag?.startsWith("--") || !value || flags.has(flag)) throw new Error("flags"); flags.set(flag, value);
  }
  const required = ["--runtime", "--qualification", "--snapshot-metadata", "--archive", "--team", "--project", "--output"];
  if (flags.size !== required.length || required.some(flag => !flags.has(flag))) throw new Error("flags");
  const path = (flag: string) => { const value = flags.get(flag)!; if (!isAbsolute(value)) throw new Error("absolute paths required"); return resolve(value); };
  const archivePath = path("--archive"), archiveStat = await stat(archivePath);
  if (!archiveStat.isFile() || archiveStat.size < 1 || archiveStat.size > 64 * 1024 * 1024) throw new Error("archive bounds");
  const archiveHash = createHash("sha256"); let bytes = 0;
  for await (const part of createReadStream(archivePath)) { bytes += part.length; if (bytes > archiveStat.size) throw new Error("archive changed"); archiveHash.update(part); }
  if (bytes !== archiveStat.size) throw new Error("archive changed");
  const snapshot = z.object({ id: z.string(), sourceSessionId: z.string(), createdAt: z.string(), expiresAt: z.string(), region: z.literal("iad1") }).strict().parse(await readBoundedWebRuntimeJson(path("--snapshot-metadata")));
  const metadata = hostedWebMetadataSchema.parse({ version: "guild.web-hosted-snapshot.v1", snapshot, controlPlane: { teamId: flags.get("--team"), projectId: flags.get("--project") },
    originalRuntime: await readBoundedWebRuntimeJson(path("--runtime")), qualification: await readBoundedWebRuntimeJson(path("--qualification")),
    originalEvidenceArchive: { sha256: archiveHash.digest("hex"), byteLength: bytes }, networkPolicy: "deny-all", ports: [], vcpus: 2, timeoutMs: 600000 });
  const configuration = sealHostedWebRuntime(metadata);
  if (Date.parse(snapshot.expiresAt) <= Date.now()) throw new DomainError("WEB_HOSTED_SNAPSHOT_EXPIRED", "The original snapshot expired. No new runtime seal was written.", 422, false);
  await writeFile(path("--output"), JSON.stringify(configuration) + "\n", { flag: "wx", mode: 0o600 });
  process.stdout.write(JSON.stringify({ configurationDigest: digest(configuration), qualificationDigest: configuration.metadata.originalRuntime.capability.qualificationDigest,
    snapshotExpiresAt: snapshot.expiresAt, productionApproval: false, browserLaunched: false, controlPlaneRequests: 0 }) + "\n");
}
main().catch(error => {
  // Never echo raw input objects, token-bearing environment or parse errors.
  process.stderr.write(error instanceof DomainError ? `${error.code}: ${error.message}\n` : "HOSTED_CONFIG_SEAL_FAILED: Supply the exact bounded original metadata, retained archive, server seal key and a new absolute output path. No provider or browser operation was performed.\n");
  process.exitCode = 1;
});
