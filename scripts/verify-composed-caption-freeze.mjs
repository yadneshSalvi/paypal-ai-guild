import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const localPath = path => { assert.ok(typeof path === "string" && path.length && !path.startsWith("/") && !path.split("/").includes("..") && !path.includes("\\")); return path; };

/** The source/runtime inventory and its generated proof have separate roots.
 * Both retained freeze.json copies identify the same exact evidence directory. */
function verifyEvidence(freeze, freezeFile) {
  assert.ok(typeof freeze.evidenceRoot === "string" && isAbsolute(freeze.evidenceRoot), "An exact private evidence root is required.");
  const evidenceRoot = resolve(freeze.evidenceRoot), rootStat = lstatSync(evidenceRoot);
  assert.ok(rootStat.isDirectory() && !rootStat.isSymbolicLink(), "The private evidence root must be an owned directory.");
  assert.equal(realpathSync(evidenceRoot), evidenceRoot, "The private evidence root cannot have linked parents.");
  const proofDirectory = localPath(freeze.proofDirectory); assert.match(proofDirectory, /^freeze-attempt-[1-9][0-9]*$/);
  assert.ok([resolve(evidenceRoot, "freeze.json"), resolve(evidenceRoot, proofDirectory, "freeze.json")].includes(resolve(freezeFile)), "The freeze is outside its exact recorded evidence locations.");
  const expected = new Map();
  function verify(file, kind) {
    const path = localPath(file.path), absolute = resolve(evidenceRoot, path);
    assert.ok(absolute.startsWith(evidenceRoot + sep), "Frozen evidence leaves its private directory: " + path);
    let current = evidenceRoot;
    for (const component of path.split("/").slice(0, -1)) {
      current = resolve(current, component); const parent = lstatSync(current);
      assert.ok(parent.isDirectory() && !parent.isSymbolicLink(), "Frozen evidence has a linked or non-directory parent: " + path);
    }
    const stat = lstatSync(absolute);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), "Frozen evidence must be a regular owned file: " + path);
    assert.ok(realpathSync(absolute).startsWith(evidenceRoot + sep), "Frozen evidence leaves its private directory: " + path);
    const bytes = readFileSync(absolute);
    assert.equal(bytes.length, file.bytes, "Frozen " + kind + " length changed: " + path);
    assert.equal(sha(bytes), file.sha256, "Frozen " + kind + " changed: " + path);
    assert.equal(stat.mode & 0o777, file.mode, "Frozen " + kind + " permissions changed: " + path);
    return absolute;
  }
  for (const file of freeze.privateFiles) verify(file, "private evidence");
  assert.ok(Array.isArray(freeze.proofFiles) && freeze.proofFiles.length > 0, "Generated proof files must be frozen explicitly.");
  for (const file of freeze.proofFiles) {
    const path = localPath(file.path); assert.equal(dirname(path), proofDirectory, "Generated proof must remain in this exact freeze attempt.");
    assert.ok(!expected.has(path), "Generated proof membership is duplicated."); expected.set(path, file); verify(file, "generated proof");
  }
  const manifests = { "source-manifest.json": "sourceManifestSha256", "dependency-manifest.json": "dependencyManifestSha256", "build-manifest.json": "buildManifestSha256",
    "secret-scan.json": "secretScanSha256", "isolation.json": "isolationSha256", "verification-manifest.json": "verificationManifestSha256" };
  const requiredPaths = new Set();
  for (const [name, property] of Object.entries(manifests)) {
    const path = proofDirectory + "/" + name, file = expected.get(path); assert.ok(file, "Missing generated proof manifest: " + name);
    assert.equal(file.sha256, freeze[property], "Generated proof digest differs from its recorded manifest: " + name); requiredPaths.add(path);
  }
  assert.ok(Array.isArray(freeze.archives) && freeze.archives.length === 2, "Both full-source and delta archives are required.");
  for (const archive of freeze.archives) {
    assert.ok(isAbsolute(archive.path)); const path = relative(evidenceRoot, archive.path).split(sep).join("/"), file = expected.get(path);
    assert.ok(file, "An exact source archive is missing from generated proof.");
    assert.equal(file.sha256, archive.sha256); assert.equal(file.bytes, archive.bytes); assert.equal(file.mode, archive.mode); requiredPaths.add(path);
  }
  assert.deepEqual([...expected.keys()].sort(), [...requiredPaths].sort(), "Generated proof membership differs from its exact manifest and archive register.");
  return { proofFiles: expected.size, privateFiles: freeze.privateFiles.length };
}

/** Next production rendering creates these derived page caches after build.
 * They are deliberately outside the qualified build membership, but never
 * ignored without an independent byte/mode inventory. Compiled route inputs
 * under .next/server/app remain part of the exact immutable build. */
export function captionRuntimePageCacheAudit(root) {
  const prefix = ".next/server/route-cache/", directory = resolve(root, prefix), files = [];
  function visit(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const absolute = resolve(path, entry.name), local = relative(root, absolute).split(sep).join("/");
      assert.ok(!entry.isSymbolicLink(), "A generated page cache cannot introduce a runtime link: " + local);
      if (entry.isDirectory()) visit(absolute);
      else {
        assert.ok(entry.isFile(), "Unexpected generated cache file type: " + local);
        assert.match(local, /^\.next\/server\/route-cache\/APP_PAGE\/[a-f0-9]{64}\/\$\/(?:[^/]+\/)*[^/]+\.(?:html|meta|rsc)$/);
        const bytes = readFileSync(absolute), stat = lstatSync(absolute); files.push({ path: local, bytes: bytes.length, sha256: sha(bytes), mode: stat.mode & 0o777 });
      }
    }
  }
  let directoryStat;
  try { directoryStat = lstatSync(directory); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (directoryStat) {
    assert.ok(directoryStat.isDirectory() && !directoryStat.isSymbolicLink(), "The generated page cache root must be an owned directory.");
    assert.ok(realpathSync(directory).startsWith(realpathSync(root) + sep), "The generated page cache root leaves its independent candidate.");
    visit(directory);
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { version: "guild.caption-web-generated-route-cache-audit.v1", at: new Date().toISOString(), excludedPrefix: prefix, files, sha256: sha(JSON.stringify(files)),
    disclosure: "Generated Next APP_PAGE cache membership is separately measured. Qualified source, dependencies and compiled build files retain their exact frozen bytes and modes." };
}

export function verifyCaptionCompositionFreeze(root, freezeFile, fixtureFile) {
  const freezeStat = lstatSync(freezeFile); assert.ok(freezeStat.isFile() && !freezeStat.isSymbolicLink(), "The freeze manifest must be a regular owned file.");
  const freezeBytes = readFileSync(freezeFile), freeze = JSON.parse(freezeBytes);
  assert.equal(freeze.version, "guild.caption-web-composition-freeze.v1"); assert.equal(freeze.sourceRoot, root);
  assert.equal(freeze.buildId, readFileSync(resolve(root, ".next/BUILD_ID"), "utf8").trim());
  assert.equal(process.version, freeze.node.version); assert.equal(sha(readFileSync(process.execPath)), freeze.node.sha256);
  assert.ok(freeze.excludedRuntimePaths.includes(".next/server/route-cache/"));
  const expectedFiles = new Set(), expectedLinks = new Set();
  for (const file of freeze.files) {
    const path = localPath(file.path), absolute = resolve(root, path), stat = lstatSync(absolute);
    assert.ok(stat.isFile(), "Frozen regular file type changed: " + path); assert.ok(!expectedFiles.has(path)); expectedFiles.add(path);
    assert.equal(sha(readFileSync(absolute)), file.sha256, "Frozen input changed: " + path); assert.equal(stat.mode & 0o777, file.mode, "Frozen input permissions changed: " + path);
  }
  for (const link of freeze.symlinks) {
    const path = localPath(link.path), absolute = resolve(root, path); assert.ok(lstatSync(absolute).isSymbolicLink()); assert.ok(!expectedLinks.has(path)); expectedLinks.add(path);
    assert.equal(readlinkSync(absolute), link.target, "Frozen dependency link changed: " + path);
    assert.ok(resolve(dirname(absolute), link.target).startsWith(root + sep), "A frozen link leaves its independent candidate: " + path);
  }
  const actualFiles = [], actualLinks = [];
  const excluded = path => freeze.excludedRuntimePaths.some(item => item.endsWith("/") ? path.startsWith(item) : path === item);
  function inventory(directory, scope) {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, item.name), local = relative(root, absolute).split(sep).join("/");
      if (excluded(local)) continue;
      if (scope === "source" && (freeze.excludedSourceDirectories.includes(item.name) && item.isDirectory() || item.name.endsWith(".log") || item.name.endsWith(".tsbuildinfo") || item.name === ".source-baseline.json")) continue;
      if (item.isSymbolicLink()) actualLinks.push(local);
      else if (item.isDirectory()) inventory(absolute, scope);
      else { assert.ok(item.isFile(), "Unexpected frozen input type: " + local); actualFiles.push(local); }
    }
  }
  inventory(root, "source"); inventory(resolve(root, "node_modules"), "dependency"); inventory(resolve(root, ".next"), "build");
  assert.deepEqual(actualFiles.sort(), [...expectedFiles].sort(), "Unexpected or missing frozen source/dependency/build files.");
  assert.deepEqual(actualLinks.sort(), [...expectedLinks].sort(), "Unexpected or missing frozen runtime links.");
  if (fixtureFile) {
    const record = freeze.fixtures.find(item => resolve(item.path) === resolve(fixtureFile)); assert.ok(record, "The fixture is absent from this exact freeze.");
    assert.equal(sha(readFileSync(fixtureFile)), record.sha256, "Frozen fixture identity changed.");
  }
  const evidence = verifyEvidence(freeze, freezeFile);
  return { version: "guild.caption-web-freeze-verification.v1", at: new Date().toISOString(), freezeSha256: sha(freezeBytes), buildId: freeze.buildId,
    verifiedFiles: expectedFiles.size, verifiedLinks: expectedLinks.size, privateFiles: evidence.privateFiles, generatedProofFiles: evidence.proofFiles, runtimePageCache: captionRuntimePageCacheAudit(root) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  console.log(JSON.stringify(verifyCaptionCompositionFreeze(root, resolve(process.argv[2] ?? "missing-freeze"), process.argv[3] ? resolve(process.argv[3]) : undefined), null, 2));
}
