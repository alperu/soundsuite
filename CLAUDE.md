# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Sound Suite (court-lens-mcp) is a local, self-hosted document intelligence platform for legal case management. It monitors directories for court PDFs, processes them through a hybrid OCR/vector pipeline, exposes data via Model Context Protocol (MCP) for AI consumption, and provides a Next.js dashboard.

## Commands

```bash
# Development
npm run dev              # Start Next.js dev server (port 3000)
npm run build            # Production build
npm run lint             # ESLint (next/core-web-vitals config)

# Testing
npm test                 # Run all Jest tests
npm run test:watch       # Watch mode
npm run test:coverage    # With coverage report
npx jest path/to/test    # Run a single test file

# Database
npx prisma generate      # Regenerate Prisma client after schema changes
npx prisma migrate dev   # Create and apply migrations (⚠️ SEE WARNING BELOW)
npx prisma migrate deploy # Apply pending migrations without resetting (safe for existing data)
npx prisma migrate reset # Reset database (DESTRUCTIVE — deletes all data)

# Service management — cross-platform (macOS/Linux/Windows)
npm run svc:start            # Start all services (dev mode)
npm run svc:start:prod       # Start in production mode
npm run svc:stop             # Stop all services
npm run svc:restart          # Restart all services
npm run svc:health           # Check service health
npm run db:migrate           # Run prisma migrate deploy
npm run db:backup            # Backup SQLite + LanceDB
npm run db:restore           # Restore from backup

# Service management — Unix shell scripts (macOS/Linux only)
./scripts/start.sh           # Start all services (dev mode)
./scripts/start.sh production # Start in production mode
./scripts/stop.sh            # Stop all services
./scripts/restart.sh         # Restart all services
./scripts/health-check.sh    # Check service health
```

## Architecture

### Tech Stack
- **Next.js 14** (App Router) with TypeScript, Tailwind CSS
- **Prisma** + SQLite for metadata (`data/sound-suite.db`)
- **LanceDB** for vector embeddings (`data/lancedb/`)
- **pdfjs-dist** for PDF text extraction
- **tesseract.js** for OCR on low-density pages and exhibit images
- **sharp** for image processing

### Core Data Flow

```
PDF files on disk → FileWatcher (chokidar) → JobQueue (p-queue) → IngestionPipeline → LanceDB + SQLite
```

1. **FileWatcher** (`src/services/file-watcher.ts`) monitors `WATCH_PATHS` directories for new PDFs, computes SHA-256 hashes, creates `Document` records with QUEUED status
2. **JobQueue** (`src/services/job-queue.ts`) processes documents with configurable concurrency and retry with exponential backoff
3. **IngestionPipeline** (`src/lib/ingestion/ingestion-pipeline.ts`) orchestrates: PDF text extraction → OCR for low-density pages → exhibit image extraction → text chunking → embedding generation → vector indexing
4. Document status transitions: `QUEUED → PROCESSING → INDEXED` (or `ERROR`)

### Embedding Providers

Abstract base class `EmbeddingProvider` (`src/lib/ingestion/embedding-provider.ts`) with three implementations:
- `TransformersEmbeddingProvider` — local via `@xenova/transformers` (default, no API key)
- `OpenAIEmbeddingProvider` — requires `OPENAI_API_KEY`
- `ClaudeEmbeddingProvider` — requires `ANTHROPIC_API_KEY`

Provider selection is configured via `EMBEDDING_PROVIDER` env var and persisted in the `Config` database table.

### MCP Server

`src/lib/mcp/mcp-server.ts` exposes three tools via HTTP (port 3001):
- `query_case_knowledge` — semantic vector search
- `scan_for_pattern` — regex pattern matching across documents
- `retrieve_exhibit` — search for exhibit images by description

Supports auth modes: `none`, `apikey`, `oauth` (configured via `MCP_AUTH_MODE`).

### Services Manager

`src/lib/services-manager.ts` is a singleton that tracks FileWatcher, JobQueue, and MCPServer health. The `/api/health` endpoint uses it to report system status.

### Key Prisma Models

- `Case` — represents a legal case (linked to a directory path)
- `Document` — a PDF file with processing status and hash deduplication
- `JobLog` — tracks batch processing runs
- `Config` — key-value store for app configuration
- `ModelDownload` — tracks embedding model download status

### Path Alias

`@/*` maps to `./src/*` (configured in both `tsconfig.json` and `jest.config.js`).

### Testing Notes

- Jest with `ts-jest` preset and `jsdom` environment
- Test timeout is 30 seconds (for OCR tests)
- `jest.setup.js` globally mocks: `tesseract.js`, `@/lib/logger`, `fetch`, and polyfills `TextEncoder`/`TextDecoder`
- Tests are colocated with source in `__tests__/` directories
- `transformIgnorePatterns` allows ESM packages: `chokidar`, `p-queue`, `eventemitter3`
- Native modules (`sharp`, `@xenova/transformers`, `@lancedb/lancedb`, `onnxruntime-node`) are externalized in webpack config for server-side only

### Database Safety

**⚠️ `prisma migrate dev` can silently wipe all data.** When Prisma detects unapplied migrations or schema drift, it may reset the entire database (drop + recreate all tables) to apply them cleanly. This deletes all Cases, Documents, and indexed data with no recovery.

**Rules:**
- **NEVER run `prisma migrate dev` or `prisma migrate reset` without explicitly asking the user first.** Always warn that it may delete all data.
- **Back up the database** before any migration: `cp prisma/data/sound-suite.db prisma/data/sound-suite.db.bak`
- **Prefer `prisma migrate deploy`** for applying migrations to an existing database with data — it applies without resetting.
- The active database file is `prisma/data/sound-suite.db` (NOT `data/sound-suite.db` at project root).

### Auto-Commit Hook

The Stop hook (`.claude/hooks/commit-on-complete.sh`) only commits if a **signal file** exists at `.claude/.pending-commit-message`. Without it, changes stay staged — no auto-commit.

**When you complete a plan or meaningful task**, write a descriptive commit message to the signal file:
```bash
echo "Add image preprocessing module for OCR optimization" > .claude/.pending-commit-message
```
The Stop hook will read it, commit with that message, and delete the file. If you're mid-work and haven't finished a plan, don't write the file — changes accumulate staged until the next completed task.

### Important Directories

- `data/` — SQLite database, LanceDB data, location JSON files, backups (gitignored)
- `public/exhibits/` — extracted exhibit images (gitignored)
- `logs/` — service logs
- `.pids/` — service PID file