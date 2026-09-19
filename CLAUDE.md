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
- **There are no global mocks.** `jest.polyfills.js` (wired via `setupFiles`, so it
  runs before any import is evaluated) supplies `TextEncoder` / `TextDecoder` and
  nothing else. Every suite mocks what it needs itself — assume no ambient
  `fetch`, logger or `tesseract.js` mock exists.
  - History worth knowing: a `jest.setup.js` used to *describe* global mocks for
    `fetch` / `Request` / `Response` / `@/lib/logger`, but it was never referenced
    by `jest.config.js`, so it never ran. Wiring it in was measured against the
    full suite and cost 12 suites and 100 test failures — its hand-rolled Web API
    stubs shadow the real ones route tests use. It was deleted (task #55).
- Server-only suites that import native/ESM-heavy modules (e.g. `@lancedb/lancedb`,
  which pulls apache-arrow) should declare `@jest-environment node` in a docblock —
  jsdom is the wrong environment for code that never runs in a browser
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

### Building and releasing the sidecar

```bash
./scripts/buildSidecar.sh [major|minor|patch]   # default: patch
```

Bumps `sideCar/package.json`, builds, stages a tarball, and publishes
`sidecar-latest.tar.gz` + `manifest.json` (version, sha256) to
`public/sideCar/builds/`. Hosts install by curling `install.sh` from a master,
which reads the manifest, verifies the checksum, and extracts to `./sidecar/`.

**The launcher is NOT generated by the build — it is copied.**
`public/sideCar/scripts/start.sh` is the single source of truth, and the same
file is both what operators curl standalone and what ships inside the tarball.
`buildSidecar.sh` copies it and then greps the staged copy for the `--docker`
arm; a launcher that cannot parse `--docker` fails the build.

This rule exists because it was violated. The build used to generate `start.sh`
from an inline heredoc — a second, hand-maintained transcription. The standalone
copy grew `--docker`/`-d` parsing, Mac `SS_HOST_OLLAMA=1` defaulting and
`EXTERNAL_IP` detection; the heredoc got none of it. Every tarball therefore
shipped a launcher that took `--docker` as the master URL, so the one-liner the
docs tell every operator to run produced `SOUND_SUITE_MASTER_URL=--docker`, an
"Invalid URL" reconnect loop, and Node mode instead of a container — meaning
Macs ran CPU-only Ollama with no error that said so.

**Rules:**

- **Change the launcher in `public/sideCar/scripts/start.sh`, never in the build
  script.** If you find yourself editing launcher text inside `buildSidecar.sh`,
  stop — that is the defect returning.
- **Any flag must be stripped before the master URL is read.** The URL is the
  first *remaining* positional arg. `install.sh`, `install.bat` and `start.sh`
  each parse args; all three must strip, and must reject an unknown `-*` rather
  than silently treating it as a URL. A flag that lands in `SERVER` builds URLs
  like `--docker/sideCar/builds/manifest.json`.
- **`start.bat` is still heredoc-generated** and is deliberately NOT the same as
  `public/sideCar/scripts/start.bat` (that one is Docker-only; the shipped one
  keeps a Node fallback that Windows hosts rely on). Do not "unify" them without
  checking what the Windows fleet actually runs.
- **Docs and scripts must agree.** `public/docs/install-sidecar.md` is rendered
  at `/docs` with `{{MASTER_URL}}` substituted and is what operators copy. If a
  flag appears there, the script must implement it — the doc is not the place to
  paper over a script that ignores it.

**Verify a build before releasing it** — the staged launcher, not the source:

```bash
tar tzf public/sideCar/builds/sidecar-latest.tar.gz | head
mkdir -p /tmp/sctest && tar xzf public/sideCar/builds/sidecar-latest.tar.gz -C /tmp/sctest
grep -n 'FORCE_DOCKER' /tmp/sctest/sidecar/start.sh   # must be present
```

Then exercise the real install path against a running master, which is the only
check that covers `install.sh`, the manifest, the checksum and the launcher
together:

```bash
cd $(mktemp -d) && curl -fsSL http://<master>:3000/sideCar/scripts/install.sh -o install.sh \
  && chmod +x install.sh && ./install.sh --docker http://<master>:3000
```

The header must echo `Server: http://<master>:3000` — **not** `Server: --docker`.

**Verifying a release actually reached a host:** `/status.version`. A build is
only live on a host once that host reports the new version; masters can serve a
new manifest for a long time before any sidecar takes it.

**`public/` is served from disk at request time**, so a fixed `install.sh` or
`start.sh` under `public/sideCar/scripts/` is live to operators immediately —
no `npm run build`, no dashboard restart. A new *tarball* still needs
`buildSidecar.sh`.

**Public mirror + GitHub Releases.** `sideCar/` is also published as its own
repo, `github.com/Project-SandStar/SideCar` (git remote `sandstar`). Its history
is `git subtree split --prefix=sideCar`, so every release goes there as well:

```bash
./scripts/buildSidecar.sh patch        # bump + tarball + manifest (as above)
git commit -am "Release sidecar X.Y.Z …" && git push
./scripts/publishSidecarGithub.sh      # subtree push → sandstar/main, tag vX.Y.Z,
                                       # GitHub Release with the tarball + manifest
```

The publish script is idempotent and never force-pushes: it refuses if
`sideCar/` has uncommitted changes (the split is taken from HEAD), if HEAD's
`sideCar/package.json` does not carry the version being published, or if the
split would not fast-forward the mirror (someone committed directly to the
mirror — merge that into `sideCar/` here first). A published tag is never moved;
bump and release again instead.

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

⚠️ **`marketing/website/scripts/private/` is gitignored** (`marketing/website/.gitignore:6`), so `deploy.sh` and `upload.sh` — and every landmine fix in them — exist **only on whichever machine last edited them**. They are not backed up and do not propagate to another checkout. The fixes for landmines #5, #6 and #7 below all live in those two files. If that directory is lost, those bugs return silently and the next deploy reverts production passwords and MCP tokens again. The landmines are documented here precisely because the code enforcing them is not version-controlled. **Recommended:** track `deploy.sh` and `upload.sh` in git and keep only `.passw` ignored. Until that happens, re-verify the excludes before trusting a deploy from an unfamiliar checkout:

```bash
cd marketing/website/scripts/private && ./deploy.sh --dry-run --skip-build > /tmp/dry.txt
grep -cE '^users/|storage/statamic-mcp|storage/statamic/updater' /tmp/dry.txt   # must be 0
grep -n 'package:discover\|statamic:addons:discover' deploy.sh                  # must be present
```

**Deploy landmines — DO NOT re-introduce:**

1. **Never add `php artisan vendor:publish --tag=statamic --force` to any deploy or update script.** The `statamic` tag is a superset that includes `statamic-config`, which overwrites every `config/statamic/*.php` file with the vendor default. On 2026-04-14 this took the site down: `users.php` was reverted from the customized `'repository' => 'file'` to vendor default `'repository' => 'eloquent'`, which 500'd the CP because Eloquent queried a users table this file-repo site doesn't have. If CP/frontend/addon **assets** need re-publishing after a major upgrade, publish only the asset groups manually: `--tag=statamic-cp`, `--tag=statamic-frontend`, `--tag=statamic-mcp`, `--tag=seo-pro`. Skip `--force` on configs. Routine deploys should not publish at all.
2. **Remote composer detection must validate executability, not just presence.** `composer.phar` lives at `~/public_html/composer.phar` on this host and is NOT in `$PATH`. A naive `[ -x "$candidate" ]` check with a bare name resolves via cwd but bash command exec won't search cwd — so `COMPOSER="composer.phar"; "$COMPOSER" install` fails with "command not found". Either use `command -v`'s resolved path, or require a `/` in the candidate before accepting `[ -x ]`. This was the bug that caused the 2026-04-14 outage (stage 1 silently skipped `composer install`; stage 2 then ran `--force` publish against a lockfile mismatch).
3. **`composer install | tail -N` under plain `set -e` masks failures.** Pipelines report the last command's exit status (0 from `tail`), so a failing composer invocation slides past. Use `set -eo pipefail` in any remote stage script that pipes composer/artisan through `tail`.
4. **Static cache:** every deploy must end with `php artisan statamic:static:clear` or content changes won't appear until files age out. (`deploy.sh` and `update-remote.sh` already do this — don't strip it.) ⚠️ **As of 2026-09-18 production reports `Static caching is not enabled`** — the server `.env` no longer sets `STATAMIC_STATIC_CACHING_STRATEGY=full`. The clear is harmless while disabled (it exits non-zero and is swallowed by `|| true`), but if you re-enable static caching, confirm the clear actually runs. Unresolved: decide whether to restore the env var or drop the claim.
5. **Server-owned state must be rsync-excluded, or deploys silently revert it.** "No `--delete`" only protects files that exist *solely* on the server. A file present both locally and remotely gets **overwritten**, so anything the production CP writes must be excluded explicitly in `deploy.sh`'s `EXCLUDES` heredoc **and** in `upload.sh`'s `is_unsafe_path()`. Three found on 2026-09-18, all silently clobbering production for months:
   - **`users/`** — Statamic runs `'repository' => 'file'`, so CP accounts and their bcrypt `password_hash` live in `users/*.yaml`. Deploying would have reverted the production CP password to the local checkout's. Caught pre-deploy: local and remote hash checksums differed (`3731887298` vs `4215688097`).
   - **`storage/statamic-mcp/`** — MCP API tokens (`tokens/*.yaml` + `tokens/.index`), OAuth clients, audit log. Tokens are minted in the production CP, but every deploy pushed a local snapshot over them. The server was found holding an **April 13 file, byte-identical to local including mtime**. This is why MCP auth kept failing with 401 no matter how often the token was regenerated — each deploy reverted it. See "MCP 401 debugging" below.
   - **`storage/statamic/updater/`** — Statamic's update-check cache. Shipping the local copy makes the CP Updates screen report this machine's view instead of the server's.

   **Diagnostic that settles it in one shot:** compare `cksum` + mtime of the same file local vs remote. `rsync -a` preserves mtime, so identical mtimes prove the server is holding the rsynced local copy rather than its own state.
6. **`deploy.sh` must rebuild BOTH manifests, before any `*:cache` command.** `bootstrap/cache/` is rsync-excluded (correctly — it's server-owned), so after an addon upgrade the server keeps the OLD manifests until explicitly rebuilt; shipping new `vendor/` files does not touch them. They are two separate manifests and **neither rebuilds the other**:
   - `php artisan package:discover` → `bootstrap/cache/packages.php` + `services.php` (Laravel)
   - `php artisan statamic:addons:discover` → `bootstrap/cache/addons.php` (Statamic)

   Observed 2026-09-18: a deploy shipped `statamic-mcp v2.10.1` into `vendor/`, but the CP Updates screen kept reporting `2.8.0` because `addons.php` was still the Aug 8 build — while `vendor/composer/installed.json` and `composer.lock` were both correct. Core showed the right version (read from a different source), so **"core current but addons stale" is the signature of this bug.** Use `statamic:addons:discover`, **NOT** `statamic:install` — install also publishes vendor assets, which is landmine #1's blast radius.
7. **`update-all.sh` / `update-local.sh` must point at `update-remote.sh`, never `private/upload.sh`.** `upload.sh` contains no composer handling at all — it rsyncs files and runs view/cache/stache clears. Deploying a composer bump through it leaves remote with a **new `composer.lock` and the old `vendor/`**, which is the 2026-04-14 outage shape, and it skips `statamic:static:clear`. `update-all.sh` carried this wrong instruction until 2026-09-18.

**MCP 401 debugging (`AUTH_HEADER_REJECTED` / "Provide a Bearer token"):** work the server side and the client side separately — in 2026-09 both were broken at once, which made each fix look ineffective.

- **Client:** `.mcp.json` must carry the scheme — `"Authorization": "Bearer <token>"`. A bare token produces *"Provide a Bearer token or Basic Auth credentials"*, i.e. the **missing-credential** message, not an invalid-token one. That wording is the tell.
- **Server:** confirm the token actually exists on *that* host. `ls -l --time-style=full-iso storage/statamic-mcp/tokens/` — if the newest file predates the token you just created, a deploy reverted the store (landmine #5), or you created the token in a different site's CP. `soundsuite.ai` and `project-sandstar.org` are separate installs with separate token stores.
- The endpoint is `POST /mcp/statamic`; `php artisan route:list --path=mcp` confirms it. `public/.htaccess` already carries the `HTTP_AUTHORIZATION` rewrite — verified present, so header stripping is *not* the usual cause here.
- Repeated failed attempts trip a rate limit that returns **429 "Too many authentication attempts"**. Let it clear before retrying, or a correct token still looks broken.
- `claude mcp add` takes name and URL **positionally** — there is no `--url` flag: `claude mcp add --transport http --scope project statamic <url> --header "Authorization: Bearer <token>"`. Omit `--scope project` and it lands in local scope instead of `.mcp.json`.

**`statamic-mcp` 3.0 (Laravel MCP 1.0):** requires `laravel/mcp ^1.0` and lists only 3 of 11 tools by default, exposing the rest via `search_tools`/`execute_tools`. This site sets **`STATAMIC_MCP_SEARCHABLE_CATALOG=false`** in the server `.env` to list all tools directly (config key `statamic.mcp.catalog.searchable`). `.env` is rsync-excluded, so env changes must be made on the server **and followed by `config:clear && config:cache`** — the config cache bakes `.env` values in at cache time.

**Blog index template gotcha:** `marketing/website/src/resources/views/blog.antlers.html` must use `{{ collection:articles sort="date:desc" }}`. If you ever see hardcoded `<a href="/blog/...">` tags in that template, new posts won't appear on `/blog`. Add a new post by dropping a markdown file at `marketing/website/src/content/collections/articles/YYYY-MM-DD.{slug}.md` matching the `blog` blueprint (`title`, `subtitle`, `author`, `category`, `reading_time`, `date` as unix timestamp).

**Verifying a deploy:**
```bash
curl -s --max-time 10 -o /dev/null -w "%{http_code}\n" https://soundsuite.ai/blog
curl -s --max-time 10 https://soundsuite.ai/blog | grep -oE 'href="/blog/[a-z-]+"' | sort -u
```