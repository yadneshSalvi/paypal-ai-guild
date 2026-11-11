import type { Locale } from "@/contracts/guild";

export const whisperPromptPolicy = {
  version: "northlight.whisper-prompt-excerpt.v1",
  tokenizer: "openai/whisper multilingual",
  upstreamCommit: "86098128c0b4f24f0e2aa2994de830614b474227",
  ranksSha256: "b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126",
  implementation: "js-tiktoken@1.0.21 with pinned Whisper regex and merge ranks",
  maximumTokens: 224,
  countRule: "Maximum of exact excerpt tokens and a leading-space excerpt, excluding special control tokens",
  excerptRule: "Grow a contiguous source suffix at grapheme/word boundaries until the first token-budget overflow",
  sourceOffsets: "UTF-16 code units, start inclusive and end exclusive",
  disclosure: "Prompted production alignment; never blind recognition or independent transcription proof",
} as const;
export interface WhisperPromptExcerpt {
  policy: typeof whisperPromptPolicy;
  locale: Locale;
  sourceHash: string;
  sourceStart: number;
  sourceEnd: number;
  text: string;
  textHash: string;
  tokenCount: number;
  leadingSpaceTokenCount: number;
  boundedTokenCount: number;
  tokenIdsHash: string;
  leadingSpaceTokenIdsHash: string;
  completeSourceIncluded: boolean;
}
