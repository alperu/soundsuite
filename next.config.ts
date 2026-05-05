import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [
      {
        protocol: "http",
        hostname: "localhost",
      },
    ],
  },
  serverExternalPackages: [
    "@xenova/transformers",
    "sharp",
    "onnxruntime-node",
    "@lancedb/lancedb",
    "ioredis",
    "tiktoken",
    "pdfjs-dist",
    "@napi-rs/canvas",
    "@d0paminedriven/pdfdown",
    "tokenizers",
    "ollama",
    "ws",
    // Prisma 7 + better-sqlite3 driver adapter — keep Turbopack from
    // bundling the generated client + native bindings.
    "@prisma/client",
    "@prisma/adapter-better-sqlite3",
    "better-sqlite3",
  ],
  turbopack: {},
};

export default nextConfig;
