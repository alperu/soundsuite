# Task 56 — Machine state must not follow the profile: `data/system.db`

**Date:** 2026-09-19 · **Status:** shipped · **Parent:** [`54-profiles.md`](./54-profiles.md)

No case names, docket numbers, party names or file names appear in this document.

## The break

After profiles landed, switching the dashboard to a new profile emptied `/admin/roleassign`
and `/admin/hostprov`. Both read Prisma tables — `HostRoleAssignment`, `HostProvisioning` —
and the `prisma` proxy was forwarding every model to the active profile's database. A fresh
profile clones the schema, not rows, so the fleet "disappeared". The GPU page showed the same
symptom through the same tables. `/admin/redis` was affected differently: the first cut had
prefixed every Redis key with the profile, so the sidecar command queue written under one
prefix was invisible after a switch ("sidecar did not poll in time").

## The rule

A profile is a **case set**. The machine — its GPU fleet, provisioning, sidecar queue, model
downloads, admin logins, MCP sessions — is not part of any case set and must read the same
whichever profile is active.

| Where | Follows the profile | Shared (machine) |
|---|---|---|
| SQLite | `Case`, `Document`, `Filing`, the tag graph, `Config` (the embedding model is bound to the profile's LanceDB), chat, presets, action log, courts, people, … | `SidecarCommand`, `HostProvisioning`, `HostRoleAssignment`, `AdminUser`, `McpSession`, `ModelDownload` |
| LanceDB | all of it | — |
| Redis | — | all of it (see below) |
| Disk | chat, attachments, OCR captures, backups | `data/system.db`, `data/*.json` location data |

## How

- `src/lib/db/prisma.ts`: `SYSTEM_MODELS` names the delegates the proxy routes to a second
  client over `data/system.db` (same Prisma schema; the case tables in it stay empty). Legacy
  mode (no profiles) has no split.
- `system.db` is created on first use: schema cloned from the active profile, then the six
  system tables seeded from **every** profile with `INSERT OR IGNORE` — so a fleet configured
  before the split is found whichever profile happens to be active when it is first read.
  `lib/profiles/create.ts` gained `copyTableRows` for this.
- **Redis is not partitioned.** The profile key prefix was removed. Every cached case key is
  rooted in a UUID (case, document, chat id) and profiles never share ids (schema clone, no
  rows), so the prefix bought nothing and broke the fleet. The one filename-keyed cache (the
  filing-type classifier) yields the same answer for the same file. The profile switch no longer
  quits the Redis client.
- Stale `p:<profile>:*` keys left by the short-lived prefix were deleted once.

## Verified live

On the `demo` profile: `/api/admin/role-assignments` returns the fleet's assignments,
`/api/admin/host-provisioning` its rows, `/api/redis/keys` scans `soundsuite:*` as before,
`/api/admin/gpu-fleet` lists the connected sidecar. `data/system.db` holds the seeded rows.

## Test

`src/lib/db/__tests__/system-models.test.ts` — the model list is the contract: a new
machine-level model must be added to `SYSTEM_MODELS` or it silently becomes per-profile.

## Open

- `Config` is per profile on purpose, but it also carries machine-ish keys (Ollama host,
  OpenRouter key, worker counts). They are copied at profile creation and drift afterwards.
  If that bites, split `Config` by key prefix the same way — not by moving the whole table.

## Follow-up (same day): "FileWatcher not registered" on `/api/health`

Three causes, all fixed:

1. **`next dev` HMR reset module state.** `worker-init.ts` kept `managerInstance` /
   `coreServicesStarted` in module `let`s and `ServicesManager` in a static field; an edit
   anywhere in their import graph re-evaluated the modules and produced an empty manager while
   the real watcher kept running. Both now live on `globalThis` (`__ssWorkerInit`,
   `__ssServicesManager`), like the Prisma client map and the profile cache.
2. **A profile with zero cases never registered a watcher**, so `applyCaseSideEffects` had no
   watcher to `addPath()` the first case into — a fresh profile could not discover PDFs until a
   restart. The watcher is now always registered; `FileWatcher.addPath()` starts chokidar on the
   first path when it was constructed with none.
3. **Nothing re-started services after a switch left them unregistered.** `/api/health` now
   self-heals: if no watcher, job queue or tool registry is registered and no init is in flight,
   it kicks `getWorkerManager()` (the one start path) and reports this call's snapshot; the next
   call shows them running.

`src/services/__tests__/file-watcher.test.ts` fails 9/9 before and after this change — it
constructs a bare `PrismaClient()` without the Prisma 7 driver adapter. Pre-existing; not touched.

