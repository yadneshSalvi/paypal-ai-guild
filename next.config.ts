import type { NextConfig } from "next";

const config: NextConfig = {
  agentRules: false,
  serverExternalPackages: ["@fracture/paypal-core", "paypal", "pg", "better-sqlite3", "@paypal/agent-toolkit", "axios", "sharp", "ffmpeg-static", "ws"],
  outputFileTracingIncludes: {
    "/api/workspace": ["./public/museum/images/*.webp", "./node_modules/ffmpeg-static/ffmpeg", "./node_modules/ffmpeg-static/package.json", "./vendor/whisper/multilingual.tiktoken", "./node_modules/js-tiktoken/package.json"],
    "/api/jobs/recover": ["./public/museum/images/*.webp", "./node_modules/ffmpeg-static/ffmpeg", "./node_modules/ffmpeg-static/package.json", "./vendor/whisper/multilingual.tiktoken", "./node_modules/js-tiktoken/package.json"],
    "/api/commissions/*/commands": ["./public/museum/images/*.webp", "./node_modules/ffmpeg-static/ffmpeg", "./node_modules/ffmpeg-static/package.json", "./vendor/whisper/multilingual.tiktoken", "./node_modules/js-tiktoken/package.json"],
  },
  poweredByHeader: false,
  experimental: { optimizePackageImports: ["lucide-react"] },
  async headers() {
    return [{ source: "/(.*)", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      { key: "X-Frame-Options", value: "SAMEORIGIN" },
    ] }];
  },
};
export default config;
