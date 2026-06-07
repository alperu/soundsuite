# syntax=docker/dockerfile:1

###############################################################################
# Sound Suite (court-lens-mcp) — production image
#
# Multi-stage build. See docs/roadmap-docker-mcp.md §4 (Phase 1) and docs/ci-cd.md.
#
# Base image MUST be glibc (bookworm-slim), NOT Alpine: the app loads native
# modules (sharp, onnxruntime-node, @lancedb/lancedb, better-sqlite3,
# @napi-rs/canvas, tokenizers) that ship prebuilt glibc binaries. Both stages
# use the SAME base so the Prisma schema engine glibc target matches and the
# native bindings copied from the builder run unchanged in the runner.
###############################################################################

############################
# Stage 1 — builder
############################
FROM node:22-bookworm-slim AS builder

# Build toolchain for any native module that needs to compile (better-sqlite3,
# node-gyp consumers). Most modules ship prebuilds, but keep this for safety.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      make \
      g++ \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Allow devDependencies (prisma CLI, typescript) to install even though
# NODE_ENV=production.
ENV NPM_CONFIG_PRODUCTION=false

# Install dependencies first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci

# Copy the rest of the source needed to generate the client and build.
COPY . .

# Generate the Prisma client (driver-adapter mode; reads prisma.config.ts).
RUN npx prisma generate

# Build Next.js in standalone mode (next.config.ts sets output: 'standalone').
#
# Next collects page data by executing route modules at build time. Several
# routes import src/lib/db/prisma.ts, which opens a better-sqlite3 connection at
# module load — so a writable DB directory must exist during the build or it
# fails with "Cannot open database because the directory does not exist". We
# point DATABASE_URL at a throwaway absolute path (the real runtime path is set
# in the runner stage). This DB is never shipped.
RUN mkdir -p /tmp/build-db \
    && DATABASE_URL="file:/tmp/build-db/build.db" npm run build

############################
# Stage 2 — runner
############################
FROM node:22-bookworm-slim AS runner

# Runtime libs only. No build toolchain. node:bookworm-slim already ships a
# usable glibc; we add ca-certificates for outbound HTTPS (model download,
# embedding APIs) and tini for clean PID-1 signal handling.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Next.js standalone server binds 0.0.0.0:3000 with these set; without them it
# may bind localhost and be unreachable from outside the container.
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

# --- Next.js standalone runtime -------------------------------------------------
# The standalone output bundles a pruned node_modules + server.js at the root.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# --- Prisma migrate runtime -----------------------------------------------------
# `prisma migrate deploy` runs on every boot (entrypoint). Standalone's pruned
# node_modules does NOT include the prisma CLI (a devDependency) nor the bits
# `prisma.config.ts` needs. Bake them in deterministically from the builder
# rather than doing a network `npm install` at container start.
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/node_modules/dotenv ./node_modules/dotenv
# better-sqlite3 driver adapter used by both runtime and the migrate config.
COPY --from=builder /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
COPY --from=builder /app/node_modules/@prisma/adapter-better-sqlite3 ./node_modules/@prisma/adapter-better-sqlite3
# The generated Prisma client. Next's standalone file-tracing does not reliably
# pull the generated `.prisma/client` into the bundle, so copy it explicitly —
# otherwise the app boots and throws "Prisma client did not initialize" on the
# first query. Idempotent if tracing already included it.
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
# Recreate the `prisma` CLI bin symlink in the runner. Copying the symlink
# itself across stages is fragile (Docker may dereference it, breaking the
# CLI's __dirname-relative requires); recreate it so `npx prisma` resolves.
RUN mkdir -p node_modules/.bin && ln -sf ../prisma/build/index.js node_modules/.bin/prisma

# Schema + migrations + Prisma 7 project config (datasource URL lives here).
COPY --from=builder /app/prisma/schema.prisma ./prisma/schema.prisma
COPY --from=builder /app/prisma/migrations ./prisma/migrations
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts

# Management script (db:migrate / db:backup / db:restore) used by upgrade flows.
COPY --from=builder /app/scripts ./scripts

# Entrypoint.
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Default mutable-state location (see roadmap §3). The compose file mounts a
# named volume here.
ENV SOUND_SUITE_DATA_DIR=/data
ENV DATABASE_URL=file:/data/v1/db/sound-suite.db
ENV REDIS_URL=redis://redis:6379
ENV WATCH_PATHS=/watch/cases
ENV EMBEDDING_PROVIDER=transformers
ENV MCP_AUTH_MODE=none
ENV LAYOUT_VERSION=1
# APP_VERSION is injected at build time from package.json by CI. Defaults to "dev".
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}

EXPOSE 3000 3001

# tini reaps zombies and forwards signals to the node process.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "server.js"]
