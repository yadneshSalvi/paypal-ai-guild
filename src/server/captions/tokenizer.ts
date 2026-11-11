import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createWhisperTokenizer } from "./whisper-prompt";

let tokenizer: Promise<ReturnType<typeof createWhisperTokenizer>> | undefined;
export function qualifiedWhisperTokenizer() {
  return tokenizer ??= (async () => {
    const [ranks, dependency] = await Promise.all([
      readFile(resolve(process.cwd(), "vendor/whisper/multilingual.tiktoken"), "utf8"),
      readFile(resolve(process.cwd(), "node_modules/js-tiktoken/package.json"), "utf8"),
    ]);
    if (JSON.parse(dependency).version !== "1.0.21" || process.versions.node.split(".")[0] !== "22") throw new Error("The frozen Whisper tokenizer requires js-tiktoken 1.0.21 on the qualified Node 22 runtime.");
    return createWhisperTokenizer(ranks);
  })();
}
