# Roadmap: Dockerized Sound Suite & Safe Upgrade Strategy

**Status:** Phase 1 & Phase 2 implemented · **Owner:** TBD · **Scope:** packaging & upgrade, not features

> **Implementation status (2026-06):**
> - **Phase 1 (§4 — Dockerfile + compose):** ✅ implemented — `Dockerfile`,
>   `docker-compose.yml`, `.dockerignore`, `docker/entrypoint.sh`, and
>   `output: 'standalone'` in `next.config.ts`. The entrypoint does the
>   dir-ensure + `prisma migrate deploy` + start only; the §6 upgrade handshake
>   is a marked TODO.
> - **Phase 2 (§5 — release pipeline):** ✅ implemented (partial) —
>   `.github/workflows/docker-publish.yml` (GHCR, semver tags, amd64) and
>   `.github/workflows/release-zip.yml` (GitHub Release + buildable zip).
>   The `:stable` channel and the §9 upgrade-test matrix are **deferred**.
> - **Deferred:** §3 app-source path-unification, §6 safe-upgrade handshake,
>   §7 slim MCP image / catalog, §9 test matrix, multi-arch (arm64).
> See [`ci-cd.md`](./ci-cd.md) for usage.

This roadmap turns Sound Suite from a "clone the repo and run `npm run dev`" app into a container users can pull, run, and upgrade without losing data. It also prepares the MCP server half of the app for distribution through the Docker MCP Catalog, building on Docker Desktop 4.62 → 4.67's MCP Toolkit / Gateway features.

The roadmap is phased. Each phase is independently shippable.

---

## 1. Goals & non-goals

**Goals**

- One-command install: `docker compose up` brings the full app online with Redis, persistent storage, and healthchecks.
- One-command upgrade: pulling a newer image tag and restarting the stack never destroys user data — even across schema changes.
- An MCP-only slim image that Claude Desktop users can install via Docker Desktop's MCP Toolkit without editing any config files.
- A published release process: semver image tags, a `:stable` channel that only advances when upgrade tests pass.

**Non-goals** (so scope stays honest)

- Multi-tenant SaaS. Sound Suite remains a single-user local tool.
- Horizontal scaling or clustering.
- Cloud hosting on AWS/GCP/Azure.
- Postgres/pgvector migration — deferred per [`PostgressUpgradeV2.md`](./PostgressUpgradeV2.md).
- Multi-user auth.
- Fixing the Auto-Suggest anchor-position bug or Brief Mode work — separate tasks.
- Integrating the GPU sidecar (`sideCar/`) into the main compose file. It stays optional and remote in v1.

---

## 2. Current state the roadmap must respect

Everything below is already in the repo and shapes the design:

| Fact | Where | Implication |
|------|-------|-------------|
| Main Next.js app has **no Dockerfile** | repo root | Phase 1 writes it. |
| `sideCar/` already has a Dockerfile | `sideCar/Dockerfile` | Reference only; main app needs a different base image. |
| Native modules need glibc | `next.config.ts` → `serverExternalPackages` lists `sharp`, `onnxruntime-node`, `@lancedb/lancedb`, `tiktoken`, `tokenizers`, `@xenova/transformers` | Base image **must** be `node:22-bookworm-slim`, not Alpine. |
| SQLite canonical path | `prisma/data/sound-suite.db` (CLAUDE.md warns a stale copy at `data/sound-suite.db` must be ignored) | Entrypoint must point `DATABASE_URL` unambiguously. |
| 10 Prisma migrations | `prisma/migrations/2026021*` | Upgrade path runs `prisma migrate deploy` on every boot. |
| LanceDB canonical path | `data/lancedb/` | Becomes a named volume. |
| Exhibit images | `public/exhibits/` (gitignored) | Becomes a named volume so they survive image rebuilds. |
| Redis is a hard dependency | filing metadata + folder index cache | Shipped as a sidecar in v1. |
| `BackupManager` already atomically backs up SQLite + LanceDB + exhibits | `src/lib/backup/backup-manager.ts`, wired via `npm run db:backup` → `scripts/manage.mjs` | Reused by the upgrade entrypoint — no new backup code. |
| MCP server is **embedded** in the main Next.js app on port 3001 | `src/lib/mcp/mcp-server.ts` | Phase 4 extracts it as a separate bootable entrypoint for the slim image. |
| Current MCP auth modes | `none` / `apikey` / `oauth` via `MCP_AUTH_MODE` | Phase 4 retires `apikey`/`oauth` in favor of Docker Desktop Secrets Engine. |
| Docs already explain data model | `docs/application-overview.md`, `docs/sidecar-gossip-spec.md` | Link out, don't duplicate. |

---

## 3. Data-directory discipline (the foundation)

The single biggest source of future upgrade breakage is that mutable state lives in **three different relative paths** today:

- `prisma/data/sound-suite.db` — SQLite
- `data/lancedb/` — LanceDB vectors
- `public/exhibits/` — extracted images

Before any Dockerfile is written, these must be unified behind a single env var:

```
SOUND_SUITE_DATA_DIR=/data            # container default
SOUND_SUITE_DATA_DIR=./data-local     # dev default
```

Layout inside the data dir is **versioned**:

```
${SOUND_SUITE_DATA_DIR}/
└── v1/
    ├── db/          # sound-suite.db (+ .wal, .shm)
    ├── lancedb/     # LanceDB fragments
    ├── exhibits/    # extracted exhibit images
    ├── backups/     # BackupManager output
    └── cache/       # page cache, OCR cache, etc.
```

The `v1` segment is a **layout version**. If a future release needs a breaking layout change (e.g. splitting the DB per case), it creates `v2/` next to `v1/` and a forward-migration script copies data — never deletes the old dir.

Dev mode keeps the current paths working via a compatibility shim so `npm run dev` continues to work unchanged. The only code change is that the three path constants read from `SOUND_SUITE_DATA_DIR` when set.

**Why this matters first:** without it, a container version has no single volume to mount, and upgrade-safety becomes impossible.

---

## 4. Phase 1 — Containerize the main app  ✅ IMPLEMENTED

**Deliverable:** a working `docker compose up` that runs the full app with data persistence. No MCP catalog work yet, no slim image.

> **Done:** `Dockerfile` (multi-stage, `node:22-bookworm-slim`, standalone),
> `docker-compose.yml` (app + redis, healthchecks, `soundsuite-data` /
> `soundsuite-redis` volumes, `/watch/cases` bind mount), `.dockerignore`,
> `docker/entrypoint.sh`, and `output: 'standalone'` in `next.config.ts`.
> **Entrypoint scope:** dir-ensure + `prisma migrate deploy` (deploy-only
> enforced) + start. The §6 backup/handshake/layout-gate steps are a
> clearly-marked TODO in the entrypoint (need app-source support).

### Topology

```
┌──────────────────┐     ┌──────────┐
│  soundsuite      │────▶│  redis   │
│  :3000 (UI/API)  │     └──────────┘
│  :3001 (MCP)     │
└────────┬─────────┘
         │
         ▼
   named volumes
   ┌───────────────────┐
   │ soundsuite-data   │  → /data/v1
   │ soundsuite-redis  │  → /data (redis)
   └───────────────────┘
         ▲
         │ bind mount (read-only where possible)
   ~/Documents/Cases → /watch/cases
```

### Dockerfile sketch (not the final file — Phase 1 implementation will write it)

- **Stage 1 (builder)** — `node:22-bookworm-slim`, install build deps, `npm ci`, `prisma generate`, `next build` with standalone output.
- **Stage 2 (runner)** — `node:22-bookworm-slim`, copy `.next/standalone`, `.next/static`, `public/`, `prisma/schema.prisma`, `prisma/migrations/`, the Prisma client, and a slim entrypoint script. Expose 3000 and 3001.

### Entrypoint responsibilities (order matters)

1. Ensure `${SOUND_SUITE_DATA_DIR}/v1/{db,lancedb,exhibits,backups,cache}` exists.
2. **Pre-migration backup** — call the existing `BackupManager` via a one-shot script, tag the backup `pre-upgrade-<fromVersion>-to-<toVersion>-<timestamp>`. Skip if the DB is empty (fresh install).
3. Run the **version handshake** from §6. Refuse to start if the data is newer than the image.
4. `prisma migrate deploy` — never `dev` or `reset`.
5. Stamp the new `app_version` and `schema_version` rows in the `Config` table.
6. `exec node server.js`.

### docker-compose.yml sketch

Four services:
- `app` — the Sound Suite image, depends on `redis`, mounts the named volume at `/data`, mounts the watch path.
- `redis` — official `redis:7-alpine`, named volume for AOF.
- `mcp` *(optional, Phase 4)* — the slim MCP-only image, read-only mount of `soundsuite-data`.
- Healthchecks on `/api/health` (main) and `redis-cli ping`.

### Environment variables the image honors

| Var | Default | Purpose |
|-----|---------|---------|
| `SOUND_SUITE_DATA_DIR` | `/data` | Root of all mutable state |
| `DATABASE_URL` | derived from `SOUND_SUITE_DATA_DIR` | SQLite file path |
| `REDIS_URL` | `redis://redis:6379` | Redis connection |
| `WATCH_PATHS` | `/watch/cases` | Directories to monitor |
| `EMBEDDING_PROVIDER` | `transformers` | CPU default works out of the box |
| `MCP_AUTH_MODE` | `none` | Becomes irrelevant in Phase 4 |
| `APP_VERSION` | baked in at build time | Used by §6 handshake |
| `LAYOUT_VERSION` | `1` | Used by §6 layout check |

### Acceptance criteria for Phase 1

- `docker compose up` on a fresh machine produces a reachable UI at `http://localhost:3000`.
- Dropping a PDF into the bind-mounted watch path completes the full 14-stage ingestion pipeline.
- Stopping and restarting the stack preserves all data.
- `docker volume inspect soundsuite-data` shows the `v1` layout described in §3.
- Image size under 2.5 GB uncompressed (target: 1.5 GB).

---

## 5. Phase 2 — Image versioning & release pipeline  ✅ IMPLEMENTED (partial)

> **Done:** `.github/workflows/docker-publish.yml` builds `linux/amd64` and
> pushes to GHCR (`ghcr.io/<owner>/soundsuite`) via `GITHUB_TOKEN` with semver
> tags `1.4.2` / `1.4` / `1` / `latest` (`docker/metadata-action`); PRs build
> without pushing. `.github/workflows/release-zip.yml` cuts a GitHub Release and
> attaches a buildable source zip. `APP_VERSION` is read from `package.json` at
> build time.
> **Deferred:** the `:stable` channel and its promotion gate (depends on the §9
> test matrix), and `CHANGELOG.md` automation. See [`ci-cd.md`](./ci-cd.md).

Semver synced to `package.json`. Every release produces these tags:

```
soundsuite/app:1.4.2   ← exact
soundsuite/app:1.4     ← minor
soundsuite/app:1       ← major
soundsuite/app:latest  ← newest built
soundsuite/app:stable  ← passes the Phase 7 test matrix
```

`:latest` moves automatically on every tag. `:stable` **only** moves after the full upgrade-test matrix (§9) passes against the previous `:stable` and `:stable-1`.

### Release process

1. Bump `package.json` version.
2. Update `CHANGELOG.md` — **every entry must list Prisma migrations that will run on upgrade**, in human language ("adds `draftCase.indexingStatus` column, no data loss").
3. Git tag `v1.4.2`.
4. GitHub Actions (or local `scripts/release.sh`) builds, tests against the test matrix, pushes tags, opens a GitHub Release.
5. `:stable` promotion is a separate manual workflow with explicit approval.

### CHANGELOG shape

```
## 1.4.2 (2026-05-12)

### Migrations applied on upgrade
- `20260512_add_draft_indexing_status` — adds two nullable columns to Draft. Safe.

### Features
- ...

### Upgrade notes
- None. Rollback via pre-upgrade backup supported.
```

---

## 6. Phase 3 — Safe upgrade mechanics

This is the core of the user's second question: *how do we package and upgrade without breaking users' databases?* The answer is four layered defenses.

### Defense 1 — Mandatory pre-migration backup

Before any `prisma migrate deploy` runs, the entrypoint invokes `BackupManager.createBackup()` and tags the backup:

```
pre-upgrade-1.4.1-to-1.4.2-20260512T150400Z.tar.gz
```

Retention policy (configurable via env):
- Last **5** upgrade backups are always kept.
- Backups newer than **30 days** are always kept.
- Older backups beyond both thresholds are pruned on startup.

The backup archive is written to `${SOUND_SUITE_DATA_DIR}/v1/backups/`, which is on the persistent named volume, so it survives container removal.

### Defense 2 — Image version ↔ data version handshake

Two rows in the existing `Config` table:

| key | value | written by |
|-----|-------|------------|
| `app_version` | `"1.4.2"` | entrypoint on successful startup |
| `schema_version` | highest applied migration name, e.g. `"20260512_add_draft_indexing_status"` | entrypoint after `prisma migrate deploy` |

On every boot:

1. Read `app_version` from the DB.
2. Compare against the image's baked-in `APP_VERSION`.
3. If **data version > image version**, **refuse to start** with a clear message:
   > "This data was last used by Sound Suite 1.5.0 but you're running 1.4.2. Downgrades can corrupt migrated data. Either pull the newer image or restore a pre-upgrade backup from `/data/v1/backups/`."
4. If equal, start normally.
5. If data version < image version, proceed to migrate. Re-stamp both rows on success.

This single check is what makes downgrades safe: they simply cannot happen by accident.

### Defense 3 — `prisma migrate deploy` only, enforced

The entrypoint hard-fails if anyone passes `MIGRATION_MODE=dev` or similar. `prisma migrate dev` and `prisma migrate reset` are never invoked inside the image, ever. CLAUDE.md already enshrines this rule at the source level; the entrypoint enforces it at runtime.

### Defense 4 — Layout version gate

Analogous to the schema handshake but for the on-disk layout from §3. An env `LAYOUT_VERSION=1` is baked into the image. Before touching anything in `${SOUND_SUITE_DATA_DIR}/`, the entrypoint:

1. Reads the highest `vN/` directory present.
2. If `N > LAYOUT_VERSION`, refuse to start (same reason as Defense 2).
3. If `N < LAYOUT_VERSION`, run the forward-migration script `scripts/migrate-layout-v${N}-to-v${N+1}.sh`, then stamp.

### One-way migration escape hatch

Some migrations genuinely cannot be rolled back — type changes, data transformations, column drops. For those:

- CHANGELOG marks the release as `[DESTRUCTIVE UPGRADE]`.
- Entrypoint reads a required env var `CONFIRM_DESTRUCTIVE_UPGRADE=1`. Without it, the container prints the release notes and exits.
- Pre-migration backup still runs regardless, giving the user a rollback target.

### Rollback recipe (documented for users)

```
# 1. Stop the stack
docker compose down

# 2. Restore from the last pre-upgrade backup (one-shot container)
docker run --rm \
  -v soundsuite-data:/data \
  soundsuite/app:1.4.1 \
  node scripts/manage.mjs db:restore /data/v1/backups/pre-upgrade-1.4.1-to-1.4.2-*.tar.gz

# 3. Start the older image
SOUNDSUITE_TAG=1.4.1 docker compose up
```

### Summary table

| Risk | Defense |
|------|---------|
| Migration corrupts data mid-flight | Pre-migration backup + atomic tar |
| User downgrades by accident | Version handshake refuses to start |
| Bad layout change silently drops data | Layout version gate + forward-only migrations |
| `prisma migrate dev` wipes DB (see CLAUDE.md warning) | Hard-enforced to `deploy` only |
| Destructive one-way migration runs unattended | `CONFIRM_DESTRUCTIVE_UPGRADE=1` required |
| Backup retention eats disk | 5-latest + 30-day window, pruned on startup |

---

## 7. Phase 4 — MCP slim image & Docker MCP Catalog entry

This phase plugs Sound Suite into the Docker MCP Toolkit / Gateway features that arrived in Docker Desktop 4.62–4.67.

### Second image: `soundsuite/mcp`

A thinner image that runs **only** the MCP server from `src/lib/mcp/mcp-server.ts`. No Next.js, no frontend, no file watcher, no worker pool.

- Base: same `node:22-bookworm-slim` for native-module parity.
- Entrypoint: `node dist/mcp-server-entry.js` (a small new entry file to be written in the implementation phase).
- Reads the **same** `soundsuite-data` volume as the main app, but **read-only**, so an active main app and a Claude Desktop-driven MCP instance can share data without write races.
- Exposes stdio transport (for `docker mcp` CLI) and optionally HTTP on 3001.

### Docker MCP Catalog manifest

A `mcp-catalog.yaml` at the repo root declares:

- Image reference, semver tags.
- Tool names: `query_case_knowledge`, `scan_for_pattern`, `retrieve_exhibit`, plus the 11 higher-level tools from `application-overview.md`.
- Required secrets (optional in this app): `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `MCP_AUTH_TOKEN`.
- A **profile template** so Claude Desktop users pick "Sound Suite — Legal Case Knowledge" from the Profiles tab and get everything wired up in one click.
- Volume mounts the user must provide (`soundsuite-data:/data:ro`).

### What this lets us retire

- `MCP_AUTH_MODE=apikey` — secrets come from Docker Desktop Secrets Engine instead.
- `MCP_AUTH_MODE=oauth` — 4.65's OAuth-in-UI handles consent and token refresh; the app no longer maintains its own OAuth code path.
- Custom `claude_desktop_config.json` snippets in README — users install via Docker Desktop UI.

### Gateway interceptors (optional, follow-up)

Docker MCP Gateway supports interceptors that run before/after every tool call. For legal data this is a drop-in spot for:

- PII redaction on tool arguments.
- Tamper-evident audit logs of every `query_case_knowledge` call (ethics-wall compliance).
- Time-of-day or per-matter access gates.

These live in Gateway config, not in `mcp-server.ts`. Documented as a follow-up, not implemented in Phase 4.

### Acceptance criteria for Phase 4

- Claude Desktop with Docker MCP Toolkit can discover Sound Suite via a private catalog URL or a one-off install command.
- A `query_case_knowledge` call from Claude against a running Sound Suite stack returns real results.
- No manual config files edited by the user.
- Main app stack keeps working unchanged when the slim MCP image is not running.

---

## 8. Phase 5 — Developer ergonomics & user docs

Small but important:

- **`scripts/docker-dev.sh`** — mounts the repo into the app container and runs `next dev` for hot reload while still exercising the containerized data layer.
- **`docs/containerization.md`** — end-user install/upgrade guide. Explains volumes, first-boot, backups, rollback.
- **README** — top-level "Run with Docker" section pointing at `docs/containerization.md`.
- **`docs/mcp-catalog-install.md`** — Claude Desktop user guide for Phase 4.

---

## 9. Testing matrix — non-negotiable before `:stable` moves

Every release runs all of these in CI (or locally via `scripts/test-upgrade.sh`):

| Test | What it proves |
|------|----------------|
| **Fresh install** | Empty volumes → first boot → ingest 1 test PDF → all 14 pipeline stages complete → MCP `query_case_knowledge` returns. |
| **Upgrade from previous minor** | Boot previous `:stable`, ingest a PDF, shut down, boot new image. Data still queryable, new migrations applied, pre-upgrade backup present. |
| **Upgrade skipping a minor** | Same but from `:stable-2`. Catches cumulative-migration bugs. |
| **Downgrade block** | Boot new image (stamps `app_version`), shut down, boot older image — must refuse to start. |
| **Destructive upgrade gate** | For any release marked `[DESTRUCTIVE UPGRADE]`, verify container exits without `CONFIRM_DESTRUCTIVE_UPGRADE=1` and proceeds with it. |
| **Backup/restore round-trip** | Take backup → wipe volumes → restore → verify semantic search returns identical top-k results. |
| **Layout migration** | Synthesize a `v1/` data dir, boot an image with `LAYOUT_VERSION=2`, verify migration runs and data is intact. |
| **MCP slim image parity** | Main app + slim MCP image share the volume, both return the same `query_case_knowledge` results for the same query. |

`:stable` promotion **blocks** on all eight passing.

---

## 10. Known risks & open questions

| Risk | Mitigation / open question |
|------|----------------------------|
| Image size balloons past 2 GB due to `sharp`, `@xenova/transformers`, `@lancedb/lancedb`, ONNX runtime | Prune dev deps aggressively; consider per-arch images (`linux/amd64`, `linux/arm64`) rather than a fat multi-arch one. Acceptance: < 2.5 GB uncompressed in v1. |
| macOS/Windows bind-mount performance on the watch path | Document VirtioFS (Docker Desktop default on Mac) and gRPC-FUSE gotchas. Recommend users place watch paths on native Docker volumes if possible. |
| Redis required at startup | Ship as sidecar in v1. Revisit making it optional once we know whether the filing-metadata cache is hot enough to matter for small installs. |
| `@xenova/transformers` model download at first boot is slow and opaque | Bake the default embedding model into the image, OR surface the existing `ModelDownload` tracking in the startup logs. Leaning toward bake. |
| Multi-arch builds triple CI time | Start with `linux/amd64` only. Add arm64 when a Mac user actually asks for it. |
| Changing `SOUND_SUITE_DATA_DIR` after first boot | Document as "don't do this" and add a startup check that refuses if the DB path doesn't match the stamp. |
| GPU sidecar not integrated | Out of scope for v1. The existing remote GPU sidecar continues to work unchanged — the main-app container simply points at it via `GPU_SIDECAR_URL`. |
| Prisma `migrate deploy` failing mid-upgrade | Backup defense kicks in; user restores and files a bug. |

---

## 11. What this roadmap does NOT cover

- Postgres / pgvector migration — see [`PostgressUpgradeV2.md`](./PostgressUpgradeV2.md).
- Multi-user auth, RBAC, audit logs beyond what `ActionLog` already provides.
- Cloud hosting on AWS/GCP/Azure.
- Hot-reload production containers.
- GPU sidecar inclusion in the main compose stack.
- Fixing the Auto-Suggest anchor-position bug or the Brief Mode citation work — those are separate planning tasks.
- MCP Gateway interceptor implementation (mentioned in Phase 4 as a follow-up).

---

## 12. Sequencing

```
Phase 3 (data-dir discipline)   ← §3, prerequisite for everything else
        │
        ▼
Phase 1 (Dockerfile + compose)  ← §4
        │
        ▼
Phase 3 mechanics (upgrade)     ← §6, implemented inside the entrypoint
        │
        ▼
Phase 2 (release pipeline)      ← §5
        │
        ▼
Phase 5 (dev ergonomics + user docs) ← §8
        │
        ▼
Phase 4 (MCP slim image + catalog)   ← §7, can also branch off after Phase 1
```

Phase 3 data-dir discipline is the unavoidable prerequisite. Once that ships, the remaining phases can be parallelized across sessions.
