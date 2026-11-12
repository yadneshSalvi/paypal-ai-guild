import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { captionRuntimePageCacheAudit, verifyCaptionCompositionFreeze } from "../scripts/verify-composed-caption-freeze.mjs";

const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
async function evidence(directory: string) {
  const proofDirectory = "freeze-attempt-1", proofFiles = [], archives = [], hashes: Record<string, string> = {};
  const manifests = { "source-manifest.json": "sourceManifestSha256", "dependency-manifest.json": "dependencyManifestSha256", "build-manifest.json": "buildManifestSha256",
    "secret-scan.json": "secretScanSha256", "isolation.json": "isolationSha256", "verification-manifest.json": "verificationManifestSha256" };
  await mkdir(resolve(directory, proofDirectory));
  for (const [name, property] of Object.entries(manifests)) {
    const bytes = Buffer.from(JSON.stringify({ proof: name })), path = proofDirectory + "/" + name;
    await writeFile(resolve(directory, path), bytes, { mode: 0o600 }); hashes[property] = sha(bytes);
    proofFiles.push({ path, bytes: bytes.length, sha256: sha(bytes), mode: 0o600 });
  }
  for (const name of ["composed-caption-source.tar.gz", "composed-caption-delta.tar.gz"]) {
    const bytes = Buffer.from("Retained bounded test archive: " + name), path = proofDirectory + "/" + name;
    await writeFile(resolve(directory, path), bytes, { mode: 0o600 });
    proofFiles.push({ path, bytes: bytes.length, sha256: sha(bytes), mode: 0o600 });
    archives.push({ path: resolve(directory, path), bytes: bytes.length, sha256: sha(bytes), mode: 0o600 });
  }
  return { evidenceRoot: directory, proofDirectory, proofFiles, archives, ...hashes };
}
test("frozen inputs reject edits and extra membership while measured generated page caches remain separate", async () => {
  const directory = await realpath(await mkdtemp(resolve(tmpdir(), "guild-caption-freeze-test-"))), root = resolve(directory, "candidate"), frozen = resolve(directory, "freeze.json");
  const contents = { "source.ts": "export const qualified = true;\n", "node_modules/owned/index.js": "module.exports = {};\n", ".next/BUILD_ID": "test-build", ".next/server/app/page.js": "qualified compiled route\n" };
  try {
    const files = [];
    for (const [path, value] of Object.entries(contents)) { await mkdir(dirname(resolve(root, path)), { recursive: true }); await writeFile(resolve(root, path), value, { mode: 0o600 }); files.push({ path, sha256: sha(value), mode: 0o600 }); }
    const fixture = resolve(directory, "fixture.json"); await writeFile(fixture, "{}\n", { mode: 0o600 });
    const freeze = { version: "guild.caption-web-composition-freeze.v1", sourceRoot: root, buildId: "test-build", node: { version: process.version, sha256: sha(await readFile(process.execPath)) }, files, symlinks: [],
      fixtures: [{ path: fixture, sha256: sha("{}\n") }], privateFiles: [{ path: "fixture.json", bytes: 3, sha256: sha("{}\n"), mode: 0o600 }], excludedSourceDirectories: ["node_modules", ".next"],
      excludedRuntimePaths: [".next/cache/", ".next/diagnostics/", ".next/server/route-cache/"], ...await evidence(directory) };
    await writeFile(frozen, JSON.stringify(freeze));
    const baseline = verifyCaptionCompositionFreeze(root, frozen, fixture); assert.equal(baseline.verifiedFiles, 4); assert.equal(baseline.runtimePageCache.files.length, 0);
    await writeFile(resolve(root, "source.ts"), "export const qualified = false;\n"); assert.throws(() => verifyCaptionCompositionFreeze(root, frozen, fixture), /Frozen input changed/);
    await writeFile(resolve(root, "source.ts"), contents["source.ts"]); await chmod(resolve(root, "source.ts"), 0o644); assert.throws(() => verifyCaptionCompositionFreeze(root, frozen, fixture), /permissions changed/); await chmod(resolve(root, "source.ts"), 0o600);
    for (const path of ["extra.ts", "node_modules/owned/extra.js", ".next/server/app/extra.js"]) {
      await writeFile(resolve(root, path), "unexpected"); assert.throws(() => verifyCaptionCompositionFreeze(root, frozen, fixture), /Unexpected or missing frozen/); await rm(resolve(root, path));
    }
    const cached = `.next/server/route-cache/APP_PAGE/${"a".repeat(64)}/$/exhibitions/harbor-street.segments/_tree.segment.rsc`;
    await mkdir(dirname(resolve(root, cached)), { recursive: true }); await writeFile(resolve(root, cached), "derived runtime cache", { mode: 0o600 });
    const audited = verifyCaptionCompositionFreeze(root, frozen, fixture); assert.equal(audited.verifiedFiles, baseline.verifiedFiles); assert.equal(audited.runtimePageCache.files.length, 1);
    assert.equal(audited.runtimePageCache.files[0]!.sha256, sha("derived runtime cache")); assert.equal(audited.runtimePageCache.files[0]!.mode, 0o600);
    await writeFile(resolve(root, cached), "another derived cache"); assert.notEqual(verifyCaptionCompositionFreeze(root, frozen, fixture).runtimePageCache.sha256, audited.runtimePageCache.sha256);
    await rm(resolve(root, cached)); await symlink(fixture, resolve(root, cached)); assert.throws(() => verifyCaptionCompositionFreeze(root, frozen, fixture), /cannot introduce a runtime link/); await rm(resolve(root, cached));
    await writeFile(fixture, "changed fixture"); assert.throws(() => verifyCaptionCompositionFreeze(root, frozen, fixture), /Frozen fixture identity changed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("freeze launch verifies every generated archive and proof at both retained locations", async () => {
  const directory = await realpath(await mkdtemp(resolve(tmpdir(), "guild-caption-proof-test-"))), root = resolve(directory, "candidate"), frozen = resolve(directory, "freeze.json");
  try {
    await mkdir(resolve(root, "node_modules"), { recursive: true }); await mkdir(resolve(root, ".next")); await writeFile(resolve(root, ".next/BUILD_ID"), "proof-build", { mode: 0o600 });
    const proof = await evidence(directory), privatePath = resolve(directory, "private/retained.json"); await mkdir(dirname(privatePath)); await writeFile(privatePath, "retained", { mode: 0o600 });
    const freeze = { version: "guild.caption-web-composition-freeze.v1", sourceRoot: root, buildId: "proof-build", node: { version: process.version, sha256: sha(await readFile(process.execPath)) },
      files: [{ path: ".next/BUILD_ID", sha256: sha("proof-build"), mode: 0o600 }], symlinks: [], fixtures: [],
      privateFiles: [{ path: "private/retained.json", bytes: 8, sha256: sha("retained"), mode: 0o600 }], excludedSourceDirectories: ["node_modules", ".next"], excludedRuntimePaths: [".next/server/route-cache/"], ...proof };
    const serialized = JSON.stringify(freeze), nested = resolve(directory, proof.proofDirectory, "freeze.json");
    await writeFile(frozen, serialized); await writeFile(nested, serialized);
    for (const location of [frozen, nested]) assert.equal(verifyCaptionCompositionFreeze(root, location).generatedProofFiles, 8);
    for (const file of proof.proofFiles) {
      const path = resolve(directory, file.path), original = await readFile(path);
      await writeFile(path, Buffer.from(original.map(byte => byte ^ 1))); assert.throws(() => verifyCaptionCompositionFreeze(root, frozen), /Frozen generated proof changed/);
      await writeFile(path, original); await chmod(path, 0o644); assert.throws(() => verifyCaptionCompositionFreeze(root, frozen), /generated proof permissions changed/); await chmod(path, 0o600);
      await rm(path); assert.throws(() => verifyCaptionCompositionFreeze(root, frozen), { code: "ENOENT" }); await writeFile(path, original, { mode: 0o600 });
    }
    const archive = proof.archives[0]!, archiveBytes = await readFile(archive.path), outside = resolve(directory, "outside-archive"); await writeFile(outside, archiveBytes, { mode: 0o600 });
    await rm(archive.path); await symlink(outside, archive.path); assert.throws(() => verifyCaptionCompositionFreeze(root, frozen), /regular owned file/); await rm(archive.path); await writeFile(archive.path, archiveBytes, { mode: 0o600 });
    const linkedParent = resolve(directory, "linked-private"), actualParent = dirname(privatePath); await symlink(actualParent, linkedParent);
    await writeFile(frozen, JSON.stringify({ ...freeze, privateFiles: [{ ...freeze.privateFiles[0], path: "linked-private/retained.json" }] }));
    assert.throws(() => verifyCaptionCompositionFreeze(root, frozen), /linked or non-directory parent/);
    await writeFile(frozen, JSON.stringify({ ...freeze, proofFiles: proof.proofFiles.slice(1) })); assert.throws(() => verifyCaptionCompositionFreeze(root, frozen), /Missing generated proof manifest/);
    await writeFile(frozen, JSON.stringify({ ...freeze, archives: [{ ...archive, path: outside }, proof.archives[1]] })); assert.throws(() => verifyCaptionCompositionFreeze(root, frozen), /source archive is missing/);
    await writeFile(frozen, JSON.stringify({ ...freeze, secretScanSha256: sha("not the retained scan") })); assert.throws(() => verifyCaptionCompositionFreeze(root, frozen), /recorded manifest/);
    await writeFile(frozen, serialized); assert.equal(verifyCaptionCompositionFreeze(root, frozen).generatedProofFiles, 8);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("standalone generated-cache audits refuse linked, dangling, non-directory and escaped roots", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "guild-caption-cache-root-test-")), root = resolve(directory, "candidate"), server = resolve(root, ".next/server"), cache = resolve(server, "route-cache"), outside = resolve(directory, "outside");
  try {
    await mkdir(server, { recursive: true }); await mkdir(outside);
    assert.equal(captionRuntimePageCacheAudit(root).files.length, 0);
    for (const target of [outside, resolve(directory, "missing")]) {
      await symlink(target, cache); assert.throws(() => captionRuntimePageCacheAudit(root), /root must be an owned directory/); await rm(cache);
    }
    await writeFile(cache, "a file is not a generated cache directory"); assert.throws(() => captionRuntimePageCacheAudit(root), /root must be an owned directory/); await rm(cache);
    await rm(server, { recursive: true }); await mkdir(resolve(outside, "route-cache")); await symlink(outside, server);
    assert.throws(() => captionRuntimePageCacheAudit(root), /root leaves its independent candidate/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
