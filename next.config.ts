import type { NextConfig } from "next";

const webRuntimeFiles = ["./tools/web-audit/*.mjs", "./tools/web-audit/policy.json", "./tools/web-audit/package*.json", "./src/domain/web-exhibition.ts", "./src/domain/web-contrast.ts", "./src/exhibition/generated/render.ts", "./src/exhibition/generated/zip.ts", "./src/exhibition/safety.ts", "./public/exhibit-reader/v1/*", "./public/museum/fonts/*"];
const config: NextConfig = {
  agentRules: false,
  // Approval challenges must never appear in the development request log.
  logging: { incomingRequests: { ignore: [/^\/approval\//] } },
  // Isolated copies and the standalone deployment must trace only this project.
  // The qualified renderer is immutable, so contain its existing dynamic reads
  // here instead of changing those source bytes to silence a bundler warning.
  turbopack: { root: process.cwd() },
  outputFileTracingRoot: process.cwd(),
  outputFileTracingExcludes: {
    "**/*": ["./.env", "./.env.*", "./.private/**", "./.local/**", "./plans/**", "./.data/**", "./.setup-evidence/**", "./artifacts/private/**", "./.vercel/**", "./.git/**", "./.agents/**", "./.source-baseline.json", "./tests/**", "./scripts/**", "./docs/**", "./coverage/**", "./test-results/**", "./playwright-report/**", "./**/*.log", "./**/*.tsbuildinfo"],
  },
  serverExternalPackages: ["@fracture/paypal-core", "paypal", "pg", "better-sqlite3", "@paypal/agent-toolkit", "axios", "sharp", "ffmpeg-static", "ws", "@vercel/sandbox", "@vercel/oidc"],
  outputFileTracingIncludes: {
    "/api/commissions/*/publications/prepare": [...webRuntimeFiles, "./vendor/whisper/multilingual.tiktoken", "./node_modules/js-tiktoken/package.json"],
    "/api/commissions/*/publications/publish": [...webRuntimeFiles, "./vendor/whisper/multilingual.tiktoken", "./node_modules/js-tiktoken/package.json"],
    "/api/workspace": [...webRuntimeFiles, "./public/museum/images/*.webp", "./node_modules/ffmpeg-static/ffmpeg", "./node_modules/ffmpeg-static/package.json", "./vendor/whisper/multilingual.tiktoken", "./node_modules/js-tiktoken/package.json"],
    "/api/jobs/recover": [...webRuntimeFiles, "./public/museum/images/*.webp", "./node_modules/ffmpeg-static/ffmpeg", "./node_modules/ffmpeg-static/package.json", "./vendor/whisper/multilingual.tiktoken", "./node_modules/js-tiktoken/package.json"],
    "/api/commissions/*/commands": [...webRuntimeFiles, "./public/museum/images/*.webp", "./node_modules/ffmpeg-static/ffmpeg", "./node_modules/ffmpeg-static/package.json", "./vendor/whisper/multilingual.tiktoken", "./node_modules/js-tiktoken/package.json"],
  },
  poweredByHeader: false,
  experimental: { optimizePackageImports: ["lucide-react"] },
  async headers() {
    return [{ source: "/(.*)", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      { key: "X-Frame-Options", value: "SAMEORIGIN" },
    ] }, { source: "/published/:path*", headers: [
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "X-Frame-Options", value: "DENY" },
    ] }, { source: "/approval/:path*", headers: [
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "Cache-Control", value: "private, no-store, max-age=0" },
      { key: "X-Frame-Options", value: "DENY" },
    ] }];
  },
};
export default config;
