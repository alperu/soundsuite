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
  ],
  turbopack: {},
};

export default nextConfig;
