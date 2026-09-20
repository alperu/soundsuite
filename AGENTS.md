# AGENTS.md — Sound Suite reference

Agent-agnostic project reference for `court-lens-mcp`. Claude Code loads `CLAUDE.md` (the
short, per-session file) and reads this one only on demand; other agents (Codex, Cursor, …)
read this file directly. Keep the two consistent: rules live in `CLAUDE.md` and
`.claude/rules/`, reference lives here.

## What it is

Sound Suite is a local, self-hosted document intelligence platform for legal case management.
It monitors directories for court PDFs, processes them through a hybrid OCR/vector pipeline,
exposes the data over the Model Context Protocol (MCP) for AI clients, and provides a Next.js
dashboard. Nothing leaves the machine unless an operator configures a remote provider.

## Privacy (non-negotiable)

The corpus is real litigation. Never commit or push anything case-identifying: cause/case
numbers, party or attorney names, real filing titles or file names, text excerpts, or document
IDs paired with case context — in code, tests, fixtures, docs, plans or commit messages.
Fixtures are synthetic; integration tests take a real PDF path from an env var and skip when it
is unset; docs and commits describe documents by role only.

## Commands

```bash
npm run dev / build / lint            # Next.js dev server on :3000, prod build, ESLint
npm test / test:watch / test:coverage # Jest;  npx jest path/to/test for one suite
npx prisma generate                   # regenerate client after schema changes
npx prisma migrate deploy             # apply migrations without reset (safe with data)
npx prisma migrate dev | reset        # ⚠ can wipe all data — ask the operator first
npm run svc:start | svc:start:prod | svc:stop | svc:restart | svc:health
npm run db:migrate | db:backup | db:restore
./scripts/start.sh [production] | stop.sh | restart.sh | health-check.sh   # Unix only
./scripts/buildSidecar.sh [major|minor|patch]   # see .claude/rules/sidecar-release.md
```

## Architecture

### Stack

Next.js 14 (App Router), TypeScript, Tailwind CSS · Prisma + SQLite for metadata
(`prisma/data/sound-suite.db`) · LanceDB for vectors (`data/lancedb/`) · pdfjs-dist for text
extraction · tesseract.js for OCR · sharp for images. `@/*` maps to `./src/*` in both
`tsconfig.json` and `jest.config.js`.

### Ingestion data flow

```
PDFs on disk → FileWatcher → Document(DISCOVERED) → [promote] → QUEUED
             → parsing-worker claims → PROCESSING → IngestionPipeline → INDEXED | ERROR
                                                     └─ LanceDB (chunks) + SQLite (metadata)
```

- `src/services/file-watcher.ts` builds its watch list from `Case.path` rows (creating a Case
  *is* registering a folder; `WATCH_PATHS` only feeds an admin display). It streams SHA-256
  for dedup, re-points a record when the hash matches but the path moved, and creates
  `Document` rows as `DISCOVERED`. Nothing auto-promotes them.
- Promotion to `QUEUED` happens in case routes (`parse`, `upload`, `filing-queue`, …).
- `src/services/parsing-worker.ts` polls `QUEUED`, claims atomically (conditional update on
  status), runs `src/lib/ingestion/ingestion-pipeline.ts` (extract → OCR low-density pages →
  exhibit images → chunk → embed → index). Concurrency: config key `parsing.workerCount`.
- `ERROR` is terminal; `maxRetries` is declared but never read. `JobQueue`
  (`src/services/job-queue.ts`) is vestigial — registered for status monitoring only.
- Case association is a prefix match over case paths, so nested case folders resolve to the
  first match.

### Embedding providers

`EmbeddingProvider` (`src/lib/ingestion/embedding-provider.ts`) has these implementations:
`Transformers` (local via `@xenova/transformers`, default), `Ollama`, `OpenAI`, `OpenRouter`,
`Claude`, `AllSources`, `Mock`. Selection via `EMBEDDING_PROVIDER` and persisted in the
`Config` table. Non-registry Ollama models need `hf.co/{repo}:{quant}` names or the sidecar's
pull 404s and the role serves zero vectors.

### Tokenizer

`tokenizers` (HuggingFace Rust, async) loads `tokenizer.json` from
`~/.cache/transformers/{model}/`, falling back to `len/4`. `LegalTextSplitter` wraps
`TextChunker` and is what production uses (`worker-init.ts`).

### MCP server

`src/lib/mcp/mcp-server.ts` serves 23 tools on `MCP_PORT=3001` (semantic search, regex scan,
exhibit retrieval, graph/timeline/entity/argument analysis, research jobs, presets, fleet
status). Tools declare `profiles: ['local' | 'routed']`: `local` is fail-closed and never
writes; `routed` adds reports, presets and routing explanation. Design and policy:
`docs/tasks/06-mcp-two-profiles.md`. Auth modes `none | apikey | oauth` via `MCP_AUTH_MODE`;
keys in `MCP_API_KEYS`. The stdio bridge lives in `scripts/mcp-bridge/`.

### Haystack layer

`src/lib/haystack/` (`commit.ts`, `ensure-filing.ts`, `refs.ts`, `entities.ts`) is the single
entity write path; `src/app/api/haystack/[op]` is the Haystack protocol server (`about`, `ops`,
`defs`, `read`, `commit`, …) and `read-grid` the plain-JSON reader. `commit.ts` has known
write-path hazards (null deletes a tag, `''` nulls a column, `caseRef` moves a filing
non-transitively) documented in `docs/PLAN-haystack-mcp-agentic-etl.md` §8.5 — read that
before adding any caller.

### Services manager

`src/lib/services-manager.ts` is a singleton tracking FileWatcher, JobQueue and MCPServer
health; `/api/health` reports it. The dashboard runs under launchd
(`com.soundsuite.dashboard`, managed by `scripts/svc-ctl.sh`).

### Prisma models (key ones)

`Case` (folder ↔ case) · `Filing`, `Motion`, `MotionAttachment`, `MotionEvent`, `Person`,
`PersonRole`, `Hearing`, `Court` (the entity graph) · `Document` (PDF, status, hash) ·
`JobLog` · `Config` (key-value) · `ModelDownload` · `ActionLog` (provenance).

### Native modules

`sharp`, `@xenova/transformers`, `@lancedb/lancedb`, `onnxruntime-node`, `tiktoken`,
`tokenizers` must be listed in `serverExternalPackages` in `next.config.ts` or Turbopack fails
to bundle them.

### Directories

- `data/` — LanceDB, location JSON, backups (gitignored). The SQLite DB is under `prisma/data/`.
- `public/exhibits/` — extracted exhibit images (gitignored, multi-GB).
- `public/sideCar/` — sidecar install scripts and built tarballs (`builds/` gitignored).
- `logs/`, `.pids/` — service logs and PID file.
- `docs/` — plans, task specs, runbooks. `docs/application-overview.md` is the product overview.
- `.claude/agents/` — specialist subagents; `.claude/rules/` — path-scoped rules.

## Testing

Jest + ts-jest, jsdom by default, 30 s timeout (OCR). Tests are colocated in `__tests__/`.
There are **no global mocks**: `jest.polyfills.js` (via `setupFiles`) supplies
`TextEncoder`/`TextDecoder` only; every suite mocks its own `fetch`, logger, tesseract. Server
suites importing native/ESM-heavy modules declare `@jest-environment node`.
`transformIgnorePatterns` whitelists `chokidar`, `p-queue`, `eventemitter3`, `@xenova`, …
Full notes and history: `.claude/rules/testing.md`.

## Database safety

`prisma migrate dev` and `migrate reset` can drop and recreate every table when they detect
drift — this has wiped all cases once. Always back up `prisma/data/sound-suite.db` first,
prefer `migrate deploy` or `db push`, and get explicit operator confirmation before either
destructive command.

## Sidecar runtime modes

The sidecar (`sideCar/`) manages inference roles on remote hosts. Three runtimes:

**Docker (default)** — the sidecar manages containers itself.

**Host-Ollama (Mac / Windows)** — native Ollama on the Docker host, for Metal/CUDA where Docker
has no GPU passthrough. Host setup: `brew install ollama && brew services start ollama &&
launchctl setenv OLLAMA_HOST 0.0.0.0:11434` (Windows: set `OLLAMA_HOST=0.0.0.0:11434` and
restart the service), then `ollama pull <model>`. Run the sidecar with
`-e SS_HOST_OLLAMA=1 -e SS_HOST_OLLAMA_ROLES=embedding,completion,ocr
-e SS_HOST_OLLAMA_BUDGET_MB=16384 -e HOST_OS=darwin` (plus `--add-host
host.docker.internal:host-gateway`, the Docker socket mount and `MASTER_URL`). Env:
`SS_HOST_OLLAMA_HOST` (default `host.docker.internal`), `SS_HOST_OLLAMA_BUDGET_MB` (0 =
unknown, planner uses per-role `def.vram`). Behaviour: container state is synthesized as
running; pull/load/unload hit the host endpoint; idle timer calls `ollamaUnload` with
`keep_alive: 0`; `nvidia-smi` is unavailable so `vramSource` is `host-declared` or `unknown`.
`host-ollama-watchdog.ts` probes every 15 s and reconciles against `/api/ps` every 60 s;
status at `/api/status.hostOllama`. `reranker` stays vLLM/CUDA-only under this mode.

**Docker Model Runner (`docker-model-runner`)** — with `SS_DMR=1`, roles in `SS_DMR_ROLES`
are served by DMR on the host (`SS_DMR_HOST`, `SS_DMR_PORT` default 12434, enable host-side
TCP in Docker Desktop). On Apple Silicon that is vllm-metal, which is what makes
`/engines/vllm/v1/rerank` possible. The sidecar does not manage DMR's lifecycle: it probes
`GET /engines/v1/models`, synthesizes `{status: 'running', image: 'dmr'}`, and the idle timer
is a no-op. The operator must `docker model pull <model>`. Master inference calls go directly
to `http://<dmr-host>:12434/engines/v1/...`, not through the sidecar. Example: embedding via
host-Ollama, reranker via DMR: `-e SS_HOST_OLLAMA=1 -e SS_HOST_OLLAMA_ROLES=embedding,completion,ocr
-e SS_DMR=1 -e SS_DMR_ROLES=reranker`.

Registry gotcha: fields added to `defaultRegistry` in `state.ts` are dropped at runtime unless
also added to `mode-templates.ts`; the master's `/config` push replaces `state.registry[role]`
wholesale.

## Runbooks and rules (single source of truth)

- `.claude/rules/sidecar-release.md` — building, verifying and publishing the sidecar, and
  the launcher rule that must never be re-broken.
- `.claude/rules/marketing-website.md` — the Statamic site under `marketing/` (its own repo):
  deploy scripts, seven landmines, MCP 401 debugging, blog gotcha.
- `.claude/rules/testing.md` — Jest conventions and the global-mock history.
- `.claude/rules/cli-corrections.md` — command-line patterns learned by rtk.
- `docs/PLAN-haystack-mcp-agentic-etl.md` — the model-driven ETL plan and write-path hazards.
- `docs/jev-browser.md` — autonomous browser agent (`jev_navigate`) setup, limits, and the
  `config/dev-mode` + `/admin/login#auth=` gate that lets it start signed in on localhost.
