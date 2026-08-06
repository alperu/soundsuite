# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Sound Suite (court-lens-mcp) is a local, self-hosted document intelligence platform for legal case management. It monitors directories for court PDFs, processes them through a hybrid OCR/vector pipeline, exposes data via Model Context Protocol (MCP) for AI consumption, and provides a Next.js dashboard.

## Privacy — NEVER commit case-identifying data

This repo processes real litigation documents. **Nothing case-identifying may be committed or
pushed**: no cause/case numbers (e.g. `D-1-FM-…`, `03-26-…-CV`), no party or attorney names, no
real filing titles or corpus file names, no text excerpts from real documents, and no document
IDs paired with case context. This applies to code, tests, fixtures, docs, plans, and **commit
messages** alike.

- Test fixtures must be **synthetic** (invented names, `CAUSE NO. 00-0000-XX`-style placeholders,
  generic filing titles like "motion.pdf").
- Integration tests that need a real PDF take its path from an **env var** (e.g.
  `RR_FIXTURE_PDF`) and skip when unset — never hardcode a corpus path or file name.
- Docs/plans describe documents generically ("a 73-page RR volume", "a 230-page motion") —
  never by their real names or cause numbers.
- Commit messages reference documents by role ("a real RR volume"), never by name/number.
- When debugging output containing real case data must be discussed, keep it in the
  conversation/scratchpad — never in tracked files.

## Tooling notes for Claude

**context-mode is installed in this repo.** Use its MCP helpers instead of raw shell or `WebFetch`:

- **Fetching web pages**: use `mcp__plugin_context-mode_context-mode__ctx_fetch_and_index(url, source)` to fetch + index a page, then `mcp__plugin_context-mode_context-mode__ctx_search(queries: [...])` to query it. For one-off scrapes where you only need a small extract, use `mcp__plugin_context-mode_context-mode__ctx_execute(language: "javascript", code: "...")` with a plain `await fetch(...)` and `console.log()` only the relevant slice. **Do not** use `WebFetch`, `curl`, or `wget` for web content — the PreToolUse hook will block them.
- **Large command output**: use `mcp__plugin_context-mode_context-mode__ctx_batch_execute({commands, queries})` for multi-step shell + analysis (auto-indexes results), or `ctx_execute({language: "shell", code: "..."})` for a single noisy command. Bash via the Bash tool is fine for short outputs (git, mkdir, mv, navigation).
- **Analyzing files**: prefer `ctx_execute_file(path, language, code)` over reading the whole file when you just need a summary or extraction. `Read` is correct when you're about to `Edit` the file.
- **Writing files**: always use the native `Write` / `Edit` tools — never use `ctx_execute` or `Bash` to author code or configs.

Memory of context-mode tool routing: check `~/.claude/projects/-Users-alper-Code-court-lens-mcp/memory/MEMORY.md` for any user-specific preferences before invoking a tool that might have been overridden.

## Troubleshooting the app in a browser

When you need to inspect the running Next.js app (DOM, network, console, navigation), use the **chrome-devtools MCP** — never screenshots.

1. Check if it's already wired up: look for `mcp__chrome-devtools__*` tools in the available tool list, or probe CDP at `http://localhost:9222/json/version`.
2. If not running, launch it: `./scripts/chromeMcpRun.sh [path]` (e.g. `./scripts/chromeMcpRun.sh /search`). The script registers the MCP server with Claude Code, verifies `:3000` is up, and launches Chrome with `--remote-debugging-port=9222` against a dedicated user-data-dir at `~/.cache/claude-debug-chrome`.
3. After launching, the chrome-devtools MCP tools attach to that Chrome instance — drive the page from there.

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

### Host-Ollama mode (Mac / Windows hosts)

The sidecar can manage a **native Ollama process on the Docker host** instead of a containerized one. Used on macOS (Metal) and Windows (CUDA) hosts where Docker has no GPU passthrough but native Ollama does.

**Operator setup on the host (one-time):**
- macOS: `brew install ollama && brew services start ollama && launchctl setenv OLLAMA_HOST 0.0.0.0:11434`
- Windows: install Ollama from ollama.com, then set system env `OLLAMA_HOST=0.0.0.0:11434` and restart the Ollama service.
- Pull the models you'll use: `ollama pull qwen3-embedding:4b`, etc.

**Sidecar run command:**
```
docker run -d --name ss-sidecar \
  -p 8098:3000 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --add-host host.docker.internal:host-gateway \
  -e MASTER_URL=http://<master>:3000 \
  -e SS_HOST_OLLAMA=1 \
  -e SS_HOST_OLLAMA_ROLES=embedding,completion,ocr \
  -e SS_HOST_OLLAMA_BUDGET_MB=16384 \
  -e HOST_OS=darwin \
  soundsuite-sidecar:2.2.70
```

**Env vars:**
- `SS_HOST_OLLAMA=1` — enable host-Ollama mode (default off; sidecar manages Docker containers as usual).
- `SS_HOST_OLLAMA_ROLES` — comma-separated roles to route to host Ollama (only `ollama`-type roles; `reranker` stays vLLM CUDA-only).
- `SS_HOST_OLLAMA_HOST` — default `host.docker.internal`. Override if the host is reachable elsewhere.
- `SS_HOST_OLLAMA_BUDGET_MB` — operator-declared VRAM budget for the host endpoint (e.g. `16384` for a 24 GB Mac leaving 8 GB for the OS). `0` = unknown; planner falls back to per-role `def.vram`.
- `HOST_OS` — `darwin` / `win32` / `linux`. Optional hint; sidecar detects from Docker `/info` if unset.

**Behavior changes for host-runtime roles:**
- `getContainerState` returns a synthetic `{status: 'running'}` (master routes unchanged).
- `ollamaPull` / `ollamaLoad` / `ollamaUnload` hit `host.docker.internal:11434` instead of the in-container Ollama.
- Idle timer fires `ollamaUnload(model)` with `keep_alive: 0` instead of `docker stop`. Other models on the same Ollama keep their VRAM.
- `nvidia-smi` is unavailable on Mac/Windows → `vramSource: 'host-declared'` (when budget set) or `'unknown'`.

**Health watchdog**: `host-ollama-watchdog.ts` probes the host endpoint every 15 s and reconciles `state.modelLoading` against `/api/ps` every 60 s. Status surfaced at `/api/status.hostOllama`. The same watchdog also probes Docker Model Runner when `SS_DMR=1` (see below) and surfaces health at `/api/status.dmr`.

### Docker Model Runner mode (vllm-metal on Apple Silicon)

A third runtime: `'docker-model-runner'`. When `SS_DMR=1`, roles listed in `SS_DMR_ROLES` are served by Docker Model Runner on the Docker host (default TCP port `12434`). On Mac this means **vllm-metal** — real vLLM via MLX/Metal, including `/engines/vllm/v1/rerank`. The sidecar does not manage DMR's lifecycle; DMR's scheduler lazy-starts vllm-metal workers on first request and reaps them on its own.

**Env vars:**
- `SS_DMR=1` — enable DMR mode.
- `SS_DMR_ROLES` — comma-separated roles routed to DMR (e.g. `reranker,embedding`). Works for any role (vLLM rerank is the killer use case — host-Ollama can't do that).
- `SS_DMR_HOST` — default `host.docker.internal`.
- `SS_DMR_PORT` — default `12434` (Docker Desktop → AI → Enable host-side TCP).
- `SS_DMR_BUDGET_MB` — operator-declared VRAM budget (informational; DMR manages eviction itself).

**Example:** reranker on Mac via DMR, embedding via host-Ollama:
```
-e SS_HOST_OLLAMA=1 -e SS_HOST_OLLAMA_ROLES=embedding,completion,ocr \
-e SS_DMR=1 -e SS_DMR_ROLES=reranker -e SS_DMR_PORT=12434 \
```

**Behavior:**
- `getDockerHost(role)` returns `state.dmrHost` for DMR roles; their `def.port` is rewritten to `state.dmrPort`.
- `ensureContainerForRole`: probes `GET /engines/v1/models` (5 s timeout). On failure throws with hint to enable DMR in Docker Desktop and `docker model pull <model>`.
- `getAllContainerStates`: synthesizes `{status: 'running', image: 'dmr'}`, lists models from `/engines/v1/models`.
- Idle timer: no-op — DMR has no public unload API. Logged as deferred-to-v2.
- Operator must `docker model pull <model>` on the host; DMR has no auto-pull from the sidecar.
- Master inference calls go DIRECT to `http://<dmr-host>:12434/engines/v1/...` (chat, embed) or `/engines/vllm/v1/rerank` — NOT through the sidecar.

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

### Marketing Website (Statamic) Deployment

The marketing site at `marketing/website/` is a separate Statamic CMS project with its own git repo. The entire `marketing/` tree is gitignored from this root repo (see `.gitignore:67`), so it does not show up in `git status` here.

**Local dev:** `cd marketing/website/src && composer dev` runs Statamic on `http://localhost:8000`. Stache is the content cache — refresh after editing files: `php artisan statamic:stache:refresh`.

**Deploy to production (`soundsuite.ai`):** two scripts, both now rsync-based over SSH (see `scripts/private/_common.sh` for `rsync_files` / `rsync_one` / `rsync_tree` helpers). SSH credentials live in `scripts/private/.passw` (`HOST`, `USERNAME`, `REMOTE_PATH`, `PORT`, `SSH_KEY_PATH`, `SSH_KEY_PASSPHRASE`, `PASSWORD`).

- **`scripts/private/deploy.sh`** — full-site deploy. Builds vite, runs `composer install --no-dev`, rsync's `src/` with `--exclude-from` (no `--delete`, so `.env` / `storage/` / `public/exhibits/` are preserved), then cache flush + `statamic:static:clear`. Interactive `y/N` unless `--yes`.
- **`scripts/update-remote.sh`** — composer-only deploy. Rsync's `composer.json` + `composer.lock` (~30 KB), runs `composer install --no-dev --no-scripts` on the server, then `package:discover`, cache flush, and an OPcache reset via a token-gated public endpoint. Use this for routine dependency bumps paired with `update-local.sh` / `update-statamic.sh` / `update-mcp-plugin.sh`.

**Deploy landmines — DO NOT re-introduce:**

1. **Never add `php artisan vendor:publish --tag=statamic --force` to any deploy or update script.** The `statamic` tag is a superset that includes `statamic-config`, which overwrites every `config/statamic/*.php` file with the vendor default. On 2026-04-14 this took the site down: `users.php` was reverted from the customized `'repository' => 'file'` to vendor default `'repository' => 'eloquent'`, which 500'd the CP because Eloquent queried a users table this file-repo site doesn't have. If CP/frontend/addon **assets** need re-publishing after a major upgrade, publish only the asset groups manually: `--tag=statamic-cp`, `--tag=statamic-frontend`, `--tag=statamic-mcp`, `--tag=seo-pro`. Skip `--force` on configs. Routine deploys should not publish at all.
2. **Remote composer detection must validate executability, not just presence.** `composer.phar` lives at `~/public_html/composer.phar` on this host and is NOT in `$PATH`. A naive `[ -x "$candidate" ]` check with a bare name resolves via cwd but bash command exec won't search cwd — so `COMPOSER="composer.phar"; "$COMPOSER" install` fails with "command not found". Either use `command -v`'s resolved path, or require a `/` in the candidate before accepting `[ -x ]`. This was the bug that caused the 2026-04-14 outage (stage 1 silently skipped `composer install`; stage 2 then ran `--force` publish against a lockfile mismatch).
3. **`composer install | tail -N` under plain `set -e` masks failures.** Pipelines report the last command's exit status (0 from `tail`), so a failing composer invocation slides past. Use `set -eo pipefail` in any remote stage script that pipes composer/artisan through `tail`.
4. **Static cache:** production has `STATAMIC_STATIC_CACHING_STRATEGY=full`. Every deploy must end with `php artisan statamic:static:clear` or content changes won't appear until files age out. (`deploy.sh` and `update-remote.sh` already do this — don't strip it.)

**Blog index template gotcha:** `marketing/website/src/resources/views/blog.antlers.html` must use `{{ collection:articles sort="date:desc" }}`. If you ever see hardcoded `<a href="/blog/...">` tags in that template, new posts won't appear on `/blog`. Add a new post by dropping a markdown file at `marketing/website/src/content/collections/articles/YYYY-MM-DD.{slug}.md` matching the `blog` blueprint (`title`, `subtitle`, `author`, `category`, `reading_time`, `date` as unix timestamp).

**Verifying a deploy:**
```bash
curl -s --max-time 10 -o /dev/null -w "%{http_code}\n" https://soundsuite.ai/blog
curl -s --max-time 10 https://soundsuite.ai/blog | grep -oE 'href="/blog/[a-z-]+"' | sort -u
```