# Task 54 — Profiles: Chrome-style data sets, one active at a time

**Date:** 2026-09-19 · **Status:** shipped

No case names, docket numbers, party names or file names appear in this document.

## The ask

> Add profiles just like Chrome profiles. I have my case ingested and I can't create a demo
> profile. I should be able to switch profiles and it should show its data. On the MCP side there
> should be profile listing and I should be able to say "work with profile Alper" / "work with
> Demo". Make the current profile Alper, refactor the folders to `data/<profileName>/lancedb` etc.
> The MCP server must list profiles and what cases are in them so Claude Desktop can check it is
> making the right calls. No hardcoded routing to profiles.

Decisions taken with the operator before code:

- **Not hardcoded.** Profiles are discovered from disk: any `data/<name>/` that carries a
  `profile.json`. `data/profiles.json` holds only which one is active. `SS_PROFILE` overrides at
  boot (launchd / prod). Nothing in code lists names.
- **Design A — one process-wide active profile.** Switching changes what every caller sees:
  dashboard, MCP, HTTP APIs. No per-request or per-session routing. The operator chose this over a
  per-MCP-session profile because one state is easier to debug than session ids.
- **MCP can switch** (`profile_use`), and every MCP result carries the profile it ran against, plus
  an `expectProfile` guard on every tool.

## Layout

```
data/
  profiles.json               { "active": "alper", "updatedAt": … }
  alper/
    profile.json              { name, displayName, createdAt, description? }
    sound-suite.db{,-wal,-shm}
    lancedb/
    chat/history/
    chat-attachments/
    ocr-captures/
    backups/
  demo/
    …
  countries.json, us-*.json   static location data — shared, not per profile
  backups/, lancedb-test/, *.bak*   left where they were
```

Migration: `node scripts/profiles-migrate.mjs alper --display "Alper"` (dry run with
`--dry-run`). Renames only, same volume, no copy. Refuses while :3000/:3001 listen or the SQLite
WAL is non-empty. Rewrites `.env` `DATABASE_URL` / `LANCEDB_PATH` to the profile's absolute
paths so shell scripts that still read them keep working.

**Legacy mode.** With no profile directory on disk the process runs exactly as before —
`DATABASE_URL`, `data/lancedb`, `data/chat` — under the synthetic name `legacy`. The dropdown is
disabled and says to run the migration. Nothing breaks on a checkout that has not migrated.

## How it works

| Layer | File | What changed |
|---|---|---|
| Registry | `src/lib/profiles/registry.ts` | sync, fs-only: `listProfiles`, `activeProfileName` (cached on `globalThis`), `profilePaths`, `setActiveProfileName`, `scaffoldProfile`. `SS_DATA_ROOT` relocates `data/` (tests). |
| Create | `src/lib/profiles/create.ts` | `createProfile`: skeleton + the SCHEMA cloned from the active profile's SQLite (`sqlite_master` DDL + the `_prisma_migrations` ledger, no rows — the Prisma CLI is unreliable on an empty file: `db push` trips on the JSON `@default("{}")` DDL, `migrate deploy` on a migration that assumes data) + optional `Config` rows copied from another profile (API keys, models). A failed create removes its skeleton. `peekCases(name)` reads a non-active profile's SQLite read-only. |
| Switch | `src/lib/profiles/switch.ts` | registry → stop watcher / parsing workers / scanner daemon → release Prisma + Kysely clients, quit Redis, reset the tool registry → `getWorkerManager()` again. Serialised. |
| Prisma | `src/lib/db/prisma.ts` | `prisma` is a Proxy over a per-profile client map. 119 importers unchanged. `releasePrismaClient(name)`. |
| Kysely | `src/lib/legal/kysely.ts` | same shape: `db` proxy, `releaseKysely(name)`. |
| Redis | `src/lib/redis.ts` | `keyPrefix: p:<profile>:` on the shared client (legacy: no prefix). Pub/sub channels unprefixed on purpose — a status event is harmless across profiles and prefixing one side of a pair drops every event. |
| LanceDB | 27 call sites | `process.env.LANCEDB_PATH \|\| './data/lancedb'` → `lancedbPath()` from `@/lib/profiles`; module-level constants became call-time lookups. |
| Data dirs | chat history, chat attachments, OCR captures, backups | read `activeProfile().<dir>` at call time. |
| Services | `src/services/worker-init.ts` | `stopProfileBoundServices()` / `startProfileBoundServices()`; shutdown handlers registered once per process. |
| Tool registry | `src/lib/mcp/get-tool-registry.ts` | `resetToolRegistry()` — its VectorStore is bound to one profile's LanceDB. |
| MCP | `src/lib/mcp/tools/profile-tools.ts` | `profile_list` (profiles, active flag, cases each), `profile_use(name)`. Both MCP profiles, no LLM. |
| MCP guard | `src/lib/mcp/tool-registry.ts` | `expectProfile` accepted on EVERY tool, consumed before validation; mismatch → `PROFILE_MISMATCH` (HTTP 409). Every `ToolExecutionResult` carries `profile`. `/api/mcp/execute` and the :3001 server send `x-ss-profile` and fold `profile` into object payloads. |
| Haystack ops | `src/lib/haystack/ops/index.ts` | every `ss*` grid's meta carries `profile`. |
| API | `src/app/api/profiles/route.ts`, `…/active/route.ts` | list / create; get / switch. |
| UI | `src/components/profile-switcher.tsx`, `navigation.tsx` | dropdown above **Cases**; "＋ New profile…" inline with "copy settings from"; switching reloads the page. Collapsed sidebar shows the initial. |
| Scripts | `scripts/manage.mjs`, `prisma.config.ts` | resolve the active profile (`--profile <name>` / `SS_PROFILE`); `db:migrate`, `db:backup`, `db:restore` target it. `npx prisma migrate deploy` with an absolute `DATABASE_URL` targets that file explicitly. |

## What a switch costs

A few seconds: the scanner daemon, parsing workers and file watcher stop and start again against
the new profile's Case rows; the tool registry rebuilds its VectorStore on first use. A parse in
flight is re-queued by the same orphan-recovery that runs at boot. Fleet / sidecar state is not
profile-bound and stays up.

## Guarantees for an MCP client

- `profile_list` → which is active, and the cases in every profile, before any call.
- Every result carries `profile`. Read it before citing.
- `expectProfile: "demo"` on any tool refuses the call if Demo is not active — no silent read from
  the wrong data set after a dashboard switch.
- `profile_use("demo")` switches everything; say so when reporting.

## Tests

`src/lib/profiles/__tests__/registry.test.ts` (discovery, resolution order, validation, paths over
a temp `SS_DATA_ROOT`), `src/lib/mcp/__tests__/profile-guard.test.ts` (stamp + guard).

## Open

- Deleting or renaming a profile: not built. Remove the directory by hand while the server is
  stopped.
- Background services run only for the active profile; a non-active profile's `QUEUED` documents
  wait until it is active.
- `filing-type-classifier.ts` caches its LanceDB connection per process; it reconnects lazily on
  the next call after a switch but a classifier already mid-call finishes on the old profile.
