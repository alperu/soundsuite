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
    // @haxall/haxall ships ~13 MB of Fantom-compiled JS and is ESM-only;
    // never bundle it for the client. haystack-core is consumed only by
    // server code (HFilter compiler, Hayson encoder). kysely is the
    // typed SQL emitter for the tag-query lane — server-side only.
    "@haxall/haxall",
    "haystack-core",
    "kysely",
  ],
  turbopack: {},
};

export default nextConfig;
