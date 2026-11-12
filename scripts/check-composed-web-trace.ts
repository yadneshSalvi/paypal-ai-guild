import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { authoredWebPaths, readAuthoredWebAssets } from "../src/exhibition/generated/render";

const root = await realpath(process.cwd()), sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const forbidden = (path: string) => /^(?:\.env(?:\.|$)|\.private(?:\/|$)|\.local(?:\/|$)|plans(?:\/|$)|\.data(?:\/|$)|\.setup-evidence(?:\/|$)|artifacts\/private(?:\/|$)|\.vercel(?:\/|$)|\.git(?:\/|$)|\.agents(?:\/|$)|tests(?:\/|$)|scripts(?:\/|$)|docs(?:\/|$))/.test(path);
async function walks(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) files.push(...await walks(resolve(directory, entry.name)));
    else if (entry.isFile() && entry.name.endsWith(".nft.json")) files.push(resolve(directory, entry.name));
  }
  return files;
}
const traces = await walks(resolve(root, ".next/server")), unique = new Map<string, string>(), directories = new Set<string>(), traceFiles = new Map<string, Set<string>>();
for (const trace of traces) {
  const data = JSON.parse(await readFile(trace, "utf8")) as { files: string[] }, localFiles = new Set<string>();
  for (const item of data.files) {
    const absolute = resolve(dirname(trace), item), local = relative(root, absolute).split(sep).join("/");
    assert.ok(!isAbsolute(local) && local !== ".." && !local.startsWith("../") && !forbidden(local), "Out-of-root/private traced input: " + local);
    const actual = await realpath(absolute); assert.ok(actual === root || actual.startsWith(root + sep), "External traced symlink: " + local);
    const info = await stat(absolute); localFiles.add(local);
    if (info.isDirectory()) {
      assert.ok(local.startsWith(".next/node_modules/"), "Unexpected runtime directory alias: " + local); directories.add(local);
    } else { assert.ok(info.isFile()); unique.set(local, absolute); }
  }
  traceFiles.set(relative(resolve(root, ".next/server"), trace).split(sep).join("/"), localFiles);
}
const readerRequired = [...authoredWebPaths, "vendor/whisper/multilingual.tiktoken", "node_modules/js-tiktoken/package.json"];
const routes = [
  "api/commissions/[id]/publications/prepare/route", "api/commissions/[id]/publications/publish/route", "api/commissions/[id]/publications/withdraw/route", "api/commissions/[id]/publications/route",
  "api/commissions/[id]/publications/[editionId]/evidence/route", "api/artifacts/[id]/exhibition/[...path]/route", "api/artifacts/[id]/exhibition-download/route", "published/[publicId]/[[...path]]/route", "commissions/[id]/publication/page",
];
const positive = [];
for (const route of routes) {
  const files = traceFiles.get("app/" + route + ".js.nft.json"); assert.ok(files, "Missing required built route: " + route);
  const missing = readerRequired.filter(file => !files.has(file)); assert.deepEqual(missing, [], "Necessary original source/reader/tokenizer assets missing from " + route);
  positive.push({ route, tracedEntries: files.size, requiredFiles: readerRequired.length, missing: 0 });
}
const renderer = await readAuthoredWebAssets(root); assert.equal(renderer.capability.digest, "8aa2f01fbdef145a03b11996f26e943ff9b3e2c5cf7be07a27c8f6a3a9a16677");
const toolsLockHash = sha(await readFile(resolve(root, "tools/web-audit/package-lock.json"))); assert.equal(toolsLockHash, "253a85c463886aedfe082354ef4ef78e8574aaa1aada23a239c72f72e6d05946");
console.log(JSON.stringify({ version: "guild.composed-web-traced-closure.v1", buildId: (await readFile(resolve(root, ".next/BUILD_ID"), "utf8")).trim(), traces: traces.length,
  uniqueFiles: unique.size, existingGeneratedDependencyDirectories: [...directories].sort(), positive, rendererDigest: renderer.capability.digest, toolsLockHash, privateInputs: 0, outsideRoot: 0, missing: 0,
  sourceFilePaths: [...unique.keys()].sort(), providerCalls: 0, browserCalls: 0 }, null, 2));
