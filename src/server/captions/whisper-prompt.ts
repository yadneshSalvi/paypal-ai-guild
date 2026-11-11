import { createHash } from "node:crypto";
import { Tiktoken } from "js-tiktoken/lite";
import type { Locale } from "@/contracts/guild";
import { digest } from "@/domain/primitives";

import { whisperPromptPolicy, type WhisperPromptExcerpt } from "@/domain/caption-prompt-policy";
export { whisperPromptPolicy, type WhisperPromptExcerpt } from "@/domain/caption-prompt-policy";
const pattern = "'s|'t|'re|'ve|'m|'ll|'d| ?\\p{L}+| ?\\p{N}+| ?[^\\s\\p{L}\\p{N}]+|\\s+(?!\\S)|\\s+";
const hashBytes = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** The asset hash is an admission condition, not an optional provenance label. */
export function createWhisperTokenizer(rankFile: string) {
  if (hashBytes(rankFile) !== whisperPromptPolicy.ranksSha256) throw new Error("The frozen Whisper tokenizer asset changed");
  const ranks = rankFile.trim().split("\n").map(line => {
    const [token, rank, extra] = line.trim().split(/\s+/);
    if (!token || !/^\d+$/.test(rank ?? "") || extra) throw new Error("Invalid Whisper merge rank");
    // Whisper encodes its empty rank as "="; base64-js represents it as "".
    return `! ${rank} ${token === "=" ? "" : token}`;
  }).join("\n");
  const encoder = new Tiktoken({ pat_str: pattern, special_tokens: { "<|endoftext|>": 50257 }, bpe_ranks: ranks });
  const encode = (text: string) => {
    if (/[\uD800-\uDFFF]/u.test(text) || /<\|[^\n]*?\|>/u.test(text) || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0085\uFEFF]/u.test(text)) throw new Error("Source contains unsupported tokenizer controls or malformed Unicode");
    // Python and JavaScript whitespace/Unicode tables can differ. Explicitly
    // reject nonstandard whitespace instead of claiming equivalent tokenization.
    if ([...text].some(char => /[\s\p{Z}]/u.test(char) && !/[ \t\r\n]/u.test(char))) throw new Error("Source whitespace requires a separately qualified tokenizer mapping");
    const pieces = [...text.matchAll(new RegExp(pattern, "gu"))].map(item => item[0]).join("");
    if (pieces !== text) throw new Error("Tokenizer did not cover the exact source bytes");
    const tokens = encoder.encode(text);
    if (encoder.decode(tokens) !== text) throw new Error("Tokenizer round trip changed the exact source");
    return tokens;
  };
  function excerpt(source: string, locale: Locale): WhisperPromptExcerpt {
    if (!source.trim() || source.length > 6000) throw new Error("A complete bounded source script is required");
    encode(source);
    const end = source.length - (source.match(/\s*$/u)?.[0].length ?? 0);
    const start = source.match(/^\s*/u)?.[0].length ?? 0;
    const boundaries = [...new Intl.Segmenter(locale, { granularity: "grapheme" }).segment(source)].map(item => item.index).filter(index => index >= start && index < end);
    let chosen: WhisperPromptExcerpt | undefined;
    for (const offset of boundaries.reverse()) {
      if (/\s/u.test(source[offset]!)) continue;
      const currentPoint = String.fromCodePoint(source.codePointAt(offset)!), previousPoint = Array.from(source.slice(0, offset)).at(-1) ?? "";
      if (locale !== "ja" && offset > start && /[\p{L}\p{N}\p{M}]/u.test(currentPoint) && /[\p{L}\p{N}\p{M}]/u.test(previousPoint)) continue;
      const text = source.slice(offset, end), tokens = encode(text), leading = encode(` ${text}`), count = Math.max(tokens.length, leading.length);
      if (count > whisperPromptPolicy.maximumTokens) break;
      chosen = { policy: whisperPromptPolicy, locale, sourceHash: hashBytes(source), sourceStart: offset, sourceEnd: end,
        text, textHash: hashBytes(text), tokenCount: tokens.length, leadingSpaceTokenCount: leading.length, boundedTokenCount: count,
        tokenIdsHash: digest(tokens), leadingSpaceTokenIdsHash: digest(leading), completeSourceIncluded: offset === start };
    }
    if (!chosen || !/[\p{L}\p{N}]/u.test(chosen.text)) throw new Error("No complete supported source excerpt fits the frozen prompt budget");
    return chosen;
  }
  return { encode, excerpt };
}
