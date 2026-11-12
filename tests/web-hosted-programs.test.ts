import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostedBrowserProgram, hostedReadonlyIndexCommand, hostedUploadCommand } from "@/server/web/hosted-commands";
import { hostedWebFixture, MemoryHostedStore } from "./support/hosted-web";
const exec = promisify(execFile);
process.env.AUTH_SECRET = "synthetic-hosted-program-seal-only";

test("the actual Node dispatcher guard permits one stub invocation and readonly indexing changes no original file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "guild-hosted-program-"));
  try {
    const tools = join(directory, "tools"), caseDirectory = join(directory, "case"); await mkdir(tools); await mkdir(caseDirectory);
    const request = join(caseDirectory, "request.json"); await writeFile(request, JSON.stringify({ caseId: "synthetic-guard-only" }));
    // This stub contains filesystem operations only. It is not the owned audit
    // runner, never imports Playwright/Chromium, and makes no network requests.
    await writeFile(join(tools, "runner.mjs"), `import {mkdir,writeFile} from 'node:fs/promises';
export async function runCase({request,outputDirectory}) {
  await writeFile(new URL('./invoked.json',import.meta.url),JSON.stringify({synthetic:true}),{flag:'wx'});
  await mkdir(outputDirectory);await writeFile(outputDirectory+'/dispatch.json',JSON.stringify({synthetic:true}));
  const result={caseId:request.caseId,complete:false};await writeFile(outputDirectory+'/result.json',JSON.stringify(result));return result;
}`);
    const identity = { bindingDigest: "a".repeat(64), requestHash: "b".repeat(64), sessionId: "synthetic_program_session", programHash: "c".repeat(64) };
    const args = ["--input-type=module", "--eval", hostedBrowserProgram, join(directory, "synthetic-no-runtime.json"), request, join(directory, "bundle"), caseDirectory, tools, JSON.stringify(identity)];
    const env = { NODE_ENV: "test" as const, PATH: process.env.PATH ?? "", TMPDIR: tmpdir(), LANG: "en_US.UTF-8" };
    await assert.rejects(exec(process.execPath, args, { env, timeout: 10000 }), error => !!error && typeof error === "object" && "code" in error && error.code === 2);
    const first = await readFile(join(caseDirectory, "hosted-launch.json"));
    const index = JSON.parse(await readFile(join(caseDirectory, "hosted-output-index.json"), "utf8"));
    assert.equal(index.source, "original_browser_command"); assert.deepEqual(index.files.map((file: { path: string }) => file.path), ["dispatch.json", "result.json"]);
    await assert.rejects(exec(process.execPath, args, { env, timeout: 10000 }), /EEXIST/);
    assert.ok((await readFile(join(caseDirectory, "hosted-launch.json"))).equals(first));
    const fixture = await hostedWebFixture(), store = new MemoryHostedStore(fixture.row), authority = await fixture.input.beforeLaunch(); assert.ok(authority);
    const record = await store.begin({ caseId: fixture.row.id, tenantId: fixture.row.tenant_id, jobId: fixture.row.job_id, bundleId: fixture.input.bundleId, request: fixture.request, configuration: fixture.configuration, ...authority });
    record.session = { id: "synthetic_program_session", createdAt: new Date().toISOString() };
    const readonly = hostedReadonlyIndexCommand(record), script = readonly.args[readonly.args.indexOf("--eval") + 1]!;
    const names = await readdir(join(caseDirectory, "evidence"));
    const read = await exec(process.execPath, ["--input-type=module", "--eval", script, join(caseDirectory, "evidence"), JSON.stringify(identity)], { env, timeout: 10000 });
    assert.equal(JSON.parse(read.stdout).source, "readonly_original_result_read"); assert.deepEqual(await readdir(join(caseDirectory, "evidence")), names);
    for (const spec of [readonly, hostedUploadCommand(record)]) {
      const program = spec.args[spec.args.indexOf("--eval") + 1]!, path = join(directory, "syntax-only.mjs"); await writeFile(path, program);
      await exec(process.execPath, ["--check", path], { env, timeout: 10000 });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
