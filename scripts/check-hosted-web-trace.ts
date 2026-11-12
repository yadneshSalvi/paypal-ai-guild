import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { digest } from "../src/domain/primitives";
import { authoredWebPaths, readAuthoredWebAssets } from "../src/exhibition/generated/render";

const root = await realpath(process.cwd()), sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const toolNames = ["identity.mjs", "server.mjs", "evidence.mjs", "contract.mjs", "contrast.mjs", "interactions.mjs", "runner.mjs", "qualify.mjs", "policy.json", "package.json", "package-lock.json"];
const requiredRuntime = [...authoredWebPaths, ...toolNames.map(name => "tools/web-audit/" + name)];
const sdkRequired = ["node_modules/@vercel/sandbox/package.json", "node_modules/@vercel/sandbox/dist/index.js", "node_modules/@vercel/sandbox/dist/sandbox.js", "node_modules/@vercel/sandbox/dist/session.js", "node_modules/@vercel/sandbox/dist/snapshot.js", "node_modules/@vercel/sandbox/dist/command.js", "node_modules/@vercel/sandbox/dist/api-client/api-client.js", "node_modules/@vercel/sandbox/dist/api-client/base-client.js", "node_modules/@vercel/sandbox/dist/api-client/with-retry.js", "node_modules/@vercel/oidc/package.json", "node_modules/@vercel/oidc/dist/index.js"];
const routes = [
  { path: "api/workspace", runtime: true, sdk: false },
  { path: "api/commissions/[id]/commands", runtime: true, sdk: true },
  { path: "api/jobs/recover", runtime: true, sdk: true },
  { path: "api/web-jobs/[id]/recover", runtime: false, sdk: true },
];
const forbidden = (path: string) => /^(?:\.env(?:\.|$)|\.private(?:\/|$)|\.local(?:\/|$)|plans(?:\/|$)|\.data(?:\/|$)|\.setup-evidence(?:\/|$)|artifacts\/private(?:\/|$)|\.vercel(?:\/|$)|\.git(?:\/|$)|\.agents(?:\/|$)|tests(?:\/|$)|scripts(?:\/|$)|docs(?:\/|$))/.test(path);
const reports = [];
const staged = await mkdtemp(join(tmpdir(), "guild-hosted-closure-"));
try {
  for (const route of routes) {
    const path = resolve(root, ".next/server/app/" + route.path + "/route.js.nft.json"), trace = JSON.parse(await readFile(path, "utf8")) as { files: string[] };
    const files = new Map<string, string>();
    for (const entry of trace.files) {
      const absolute = resolve(dirname(path), entry), local = relative(root, absolute).split(sep).join("/");
      if (isAbsolute(local) || local === ".." || local.startsWith("../") || forbidden(local)) throw new Error("The function trace contains an out-of-project or private input: " + route.path);
      files.set(local, absolute);
    }
    const required = [...(route.runtime ? requiredRuntime : []), ...(route.sdk ? sdkRequired : [])], missing = required.filter(entry => !files.has(entry));
    if (missing.length) throw new Error("A required runtime file is absent from " + route.path + ": " + missing.join(", "));
    reports.push({ route: route.path, files: files.size, requiredFiles: required.length, missing: 0, privateInputs: 0, outsideRoot: 0 });
    if (route.path === "api/jobs/recover") {
      // Only traced files enter this fresh staging tree. Recompute renderer/tool
      // identities and import the actual control-plane SDK without any request.
      for (const [local, source] of files) if (requiredRuntime.includes(local) || local.startsWith("node_modules/")) {
        const target = resolve(staged, local); await mkdir(dirname(target), { recursive: true }); await copyFile(source, target);
      }
    }
  }
  const original = await readAuthoredWebAssets(root), copied = await readAuthoredWebAssets(staged);
  if (digest(original.capability) !== digest(copied.capability)) throw new Error("The staged renderer differs from its exact original bytes");
  const code = [];
  for (const path of toolNames) {
    const source = await readFile(resolve(root, "tools/web-audit", path)), copied = await readFile(resolve(staged, "tools/web-audit", path));
    if (!source.equals(copied)) throw new Error("A staged original runner file changed");
    if (path !== "package-lock.json") code.push({ path, sha256: sha(copied) });
  }
  const sdk = await import(pathToFileURL(resolve(staged, "node_modules/@vercel/sandbox/dist/index.js")).href);
  if (typeof sdk.Sandbox?.create !== "function" || typeof sdk.Session?.prototype.runCommand !== "function" || typeof sdk.Snapshot?.get !== "function") throw new Error("The staged SDK closure did not import its real public APIs");
  const sandboxVersion = JSON.parse(await readFile(resolve(staged, "node_modules/@vercel/sandbox/package.json"), "utf8")).version;
  if (sandboxVersion !== "3.9.1") throw new Error("The staged Sandbox SDK version changed");
  process.stdout.write(JSON.stringify({ version: "guild.hosted-web-runtime-closure.v1", routes: reports, stagedRendererDigest: copied.capability.digest, stagedRunnerHash: digest(code),
    stagedPackageLockHash: sha(await readFile(resolve(staged, "tools/web-audit/package-lock.json"))), sandboxVersion, actualSdkImported: true,
    providerRequests: 0, browserLaunched: false, privateInputs: 0, outsideRoot: 0 }, null, 2) + "\n");
} finally { await rm(staged, { recursive: true, force: true }); }
