import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readAuthoredWebAssets, renderWebFiles } from "@/exhibition/generated/render";
import { webZipChunks } from "@/exhibition/generated/zip";
import { webFixture } from "./web-fixture";

async function main() {
  const output = process.argv[2];
  if (!output) throw new Error("Choose an isolated structural-fixture output directory.");
  const fixture = webFixture(), rendered = renderWebFiles(fixture.source, fixture.design, await readAuthoredWebAssets());
  const chunks = [];
  for await (const chunk of webZipChunks(rendered.bundle, async file => rendered.authored.get(file.path) ?? fixture.bytes.get(file.mediaId!)!)) chunks.push(chunk);
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, "structure.zip"), Buffer.concat(chunks));
  await writeFile(resolve(output, "manifest.json"), JSON.stringify(rendered.bundle));
  process.stdout.write("Saved structural ZIP and manifest; no browser or media decoder ran.\n");
}
void main();
