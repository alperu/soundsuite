# Upgrade Plan: Next.js 16.1.6 → 16.2.2 and Prisma 5.22 → 7.2

**Status:** Draft · **Date:** 2026-04-05 · **Scope:** framework/ORM upgrades, zero data loss

This document is the output of a four-agent investigation into what it would take to upgrade Next.js and Prisma in Sound Suite without losing any user data. It is meant to be executed as a sequence of **separate, independently verifiable steps** — never as one big branch.

The short version:

- **Next.js 16.1.6 → 16.2.2** is a single safe minor + patch hop. No migration code changes. One real risk to verify (pdfjs + Turbopack).
- **Prisma 5.22 → 7.2** should be done as **two separate upgrades**, not one jump. The v5 → v6 hop is almost drop-in. The v6 → v7 hop is large (ESM-only, driver adapters mandatory, new config file, new generator).
- **Neither upgrade touches the existing SQLite file or LanceDB.** `prisma migrate deploy` never resets data across any of these versions. The risk is upgrade code — not data migration.

---

## 1. Current state

| Component | Version | Source |
|---|---|---|
| Next.js | `^16.1.6` | `package.json` |
| React | `^19.2.4` | `package.json` |
| Prisma client | `^5.22.0` | `package.json` |
| Prisma CLI | `^5.22.0` | `package.json` |
| TypeScript | `^5` | `package.json` |
| Node.js | not pinned | — |
| SQLite path | `prisma/data/sound-suite.db` (984 MB) | `src/lib/db/prisma.ts`, CLAUDE.md |
| LanceDB path | `data/lancedb/` | `src/lib/vector/vector-store.ts` |
| Migrations | **13** under `prisma/migrations/` | audit |
| Singleton pattern | global Prisma client with WAL + 5000 ms busy_timeout | `src/lib/db/prisma.ts:3-26` |
| Turbopack | **enabled** (`turbopack: {}` in `next.config.ts`) | audit |
| Middleware / server actions | **none** | audit (no `src/middleware.ts`, no `'use server'`) |
| BackupManager | exists, backs up SQLite + LanceDB with manifest, supports restore | `src/lib/backup/backup-manager.ts`, `src/app/api/backup/route.ts`, `scripts/manage.mjs` |

## 2. Target state

- **Next.js 16.2.2** (released 2026-04-01)
- **Prisma 7.2.0** (released early 2026), reached via Prisma 6.x intermediate
- Everything else unchanged: React 19.2.4, TypeScript 5, SQLite + LanceDB + Redis.

---

## 3. Safety posture (what makes this non-destructive)

Three invariants anchor the whole plan. If any one of them holds, data is safe; we ensure all three.

### Invariant A — `prisma migrate deploy` never resets data

Across Prisma 5, 6, and 7, `migrate deploy` is strictly additive: it runs pending migrations from `prisma/migrations/` in order and stops on the first failure. It **never** drops columns or tables, never reruns applied migrations, never regenerates the schema from the Prisma file. The only Prisma commands that can wipe data are `migrate dev`, `migrate reset`, and `db push --force-reset`, and CLAUDE.md's rules already prohibit them in this repo. The entrypoint will continue to call `deploy` only.

### Invariant B — LanceDB is orthogonal to Prisma

The audit confirmed LanceDB is never referenced by any Prisma model or migration SQL. Vectors live in `data/lancedb/` and are written through `@lancedb/lancedb` directly from `src/lib/vector/vector-store.ts`. Upgrading Prisma (even to v7 with its driver adapter rewrite) has **zero impact** on vector data.

### Invariant C — Pre-upgrade backup always runs first

`BackupManager` (`src/lib/backup/backup-manager.ts`) already knows how to:
- Copy the SQLite file.
- Recursively copy the LanceDB directory.
- Write a manifest (`manifest.json`) with timestamps, byte sizes, and version info.
- Restore all of the above via `restoreBackup()` through `POST /api/backup` or `npm run db:restore`.

**Caveat:** backups are not atomic across SQLite + LanceDB while the app is running. For an upgrade we **stop services first**, then back up, then upgrade. This is the only reliable way.

---

## 4. Step-by-step upgrade sequence

**Hard rule: do one step per branch, per PR, per deploy.** Never combine steps. Each step has its own backup, its own smoke test, its own rollback trigger.

### Step 0 — Baseline (before touching anything)

1. `git checkout -b upgrade/baseline-snapshot`
2. `npm run svc:stop` — stop the Next.js app, workers, watchers.
3. `npm run db:backup -- --output ./data/backups/pre-upgrade-baseline`
4. Capture the exact set of passing tests: `npm test 2>&1 | tee ./data/backups/pre-upgrade-baseline/jest-output.txt`
5. Record the current `npm run build` output: `npm run build 2>&1 | tail -40 | tee ./data/backups/pre-upgrade-baseline/build-output.txt`
6. Ingest one known PDF end-to-end and save the resulting SQL row count + LanceDB row count as a "ground truth" for post-upgrade comparison.
7. Commit the baseline backup directory metadata (not the binary artifacts) to a throwaway commit so it's recoverable.

This step is **not optional**. Every subsequent step compares against this baseline.

### Step 1 — Next.js 16.1.6 → 16.2.2

**Why first:** it is the smallest hop, fully backward compatible, and clears the Turbopack noise before touching the database layer. If Next.js 16.2 breaks anything, we find out in isolation.

**Scope:** `next` package bump only. No code changes expected.

**Known risks:**

- **pdfjs + Turbopack regression** ([vercel/next.js#91642](https://github.com/vercel/next.js/issues/91642)). 16.2 introduced a Turbopack regression on libraries using `pdfjs-dist` dynamic worker imports. Sound Suite uses `pdfjs-dist` throughout the ingestion pipeline and in `filing-detector.ts`. This is a **direct hit**.
- **Mitigation:** do not adopt Turbopack for production `next build` in this step. Production build continues to use the webpack pipeline. Dev-mode Turbopack has been default since 16.0 and is already in use; it continues to work.
- **Verification:** run `npm run build 2>&1 | tail -30` after the bump and confirm it still produces the standalone output. Specifically run `npm run dev` and trigger a PDF ingestion to confirm the dynamic worker import still resolves.

**Changes required in code:**

- None. The audit found zero changes needed — `serverExternalPackages`, route handlers, React 19, `output: 'standalone'`, dynamic APIs are all already on the 16.x contract.
- The `params`/`searchParams` async migration the audit flagged (219+ references) **already happened** when the repo went to 16.0. Those occurrences are already awaited.

**Procedure:**

1. `git checkout -b upgrade/nextjs-16.2.2`
2. `npm run svc:stop`
3. `npm run db:backup -- --output ./data/backups/pre-nextjs-16.2.2`
4. `npx @next/codemod@latest upgrade latest` — for this hop it effectively just bumps `package.json` and reinstalls. There are no codemods to run for 16.1 → 16.2.
5. `rm -rf .next node_modules && npm ci`
6. `npm run build 2>&1 | tail -30` — confirm clean build.
7. `npm test` — confirm full test suite passes (compare to baseline).
8. `npm run svc:start` — boot the app.
9. Ingest the Step 0 reference PDF. Compare SQL row count and LanceDB row count to baseline. **They must match exactly.**
10. Exercise a draft chat call, an Auto-Suggest run, and a semantic search against an existing case to flush out any runtime regressions the build wouldn't catch.
11. If all green → merge. If anything red → revert the branch and open an issue.

**Rollback:** `git checkout main && rm -rf .next node_modules && npm ci`. No data rollback needed — Next.js upgrades don't touch the database.

**Estimated effort:** 1–2 hours including smoke tests.

---

### Step 2 — Prisma 5.22 → 6.latest

**Why next:** v5 → v6 is small and mechanical. It lets us land a clean 6.x before the much larger v7 work. Skipping v6 and going straight to v7 is officially supported, but for a production database we want the v5 → v6 smoke test in isolation.

**Scope:** `prisma` + `@prisma/client` version bump + a handful of runtime code changes.

**Breaking changes actually affecting Sound Suite:**

| Change | Where it hits |
|---|---|
| Node.js min becomes 18.18 / 20.9 / 22.11 | CI + Docker base image (already on `node:22-bookworm-slim` plan) |
| TypeScript min 5.1 | repo already on `^5` |
| `Buffer` → `Uint8Array` for `Bytes` fields | audit: **no `Bytes` fields in schema**, no impact |
| `NotFoundError` removed; `findUniqueOrThrow`/`findFirstOrThrow` now throw `P2025` via `PrismaClientKnownRequestError` | audit: no uses of `NotFoundError`; need to grep for `findUniqueOrThrow` and wrap any naked calls |
| `rejectOnNotFound` option fully removed | audit: **zero usages** in repo |
| Reserved model names `async`/`await`/`using` | audit: none of these exist in `schema.prisma` |
| Postgres-specific changes (`fullTextSearch`, implicit m-n unique index → PK) | **not applicable — we use SQLite** |

Net result: the v5 → v6 changes reduce to *verify error handling on `findUniqueOrThrow` / `findFirstOrThrow` call sites* and *bump the version*. Nothing else in the codebase matches the v6 breaking list.

**Procedure:**

1. `git checkout -b upgrade/prisma-6`
2. `npm run svc:stop`
3. `npm run db:backup -- --output ./data/backups/pre-prisma-6`
4. **Manually copy the SQLite file** as well, belt-and-suspenders: `cp prisma/data/sound-suite.db prisma/data/sound-suite.db.pre-prisma-6.bak`
5. `npm install prisma@^6 @prisma/client@^6`
6. `npx prisma generate`
7. Grep and manually audit every `findUniqueOrThrow` / `findFirstOrThrow` call site for naked usage that would now throw `P2025` differently:
   - `src/lib/draft/suggestion-persist.ts`
   - `src/lib/draft/draft-service.ts`
   - `src/app/api/cases/[id]/filings/route.ts`
   - any others the grep turns up
   Wrap them with `try/catch` that checks `e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025'` if they don't already.
8. `npm run build 2>&1 | tail -30` — expect clean.
9. `npm test`
10. `npm run svc:start`
11. **Do not run any migrations.** There are no new ones; `prisma migrate deploy` at startup will be a no-op because all 13 existing migrations are already applied and their SQL is unchanged.
12. Ingest the reference PDF. Compare SQL + LanceDB counts to baseline.
13. Run a full Auto-Suggest flow, a backup via `POST /api/backup`, and a semantic search.
14. If green → merge. If red → revert the branch *and* restore from `sound-suite.db.pre-prisma-6.bak` (step 4) if the DB looks weird.

**Rollback:** `git checkout main && npm ci && cp prisma/data/sound-suite.db.pre-prisma-6.bak prisma/data/sound-suite.db`.

**Estimated effort:** 2–4 hours including call-site audit and smoke tests.

---

### Step 3 — Prisma 6.latest → 7.2

**Why this is its own step:** v6 → v7 is the largest breaking change in Prisma's recent history. Four separate mechanical rewrites need to land at once — mixing them with Next.js work or v5 → v6 multiplies the debugging surface.

**Breaking changes that actually affect Sound Suite:**

| Change | Impact |
|---|---|
| Prisma is now **ESM-only**. Requires `"type": "module"` in `package.json` and `moduleResolution: "bundler"` in `tsconfig.json`. | Significant. Any remaining CJS code paths (including `scripts/manage.mjs`, tests, Jest setup) must become ESM-compatible. |
| `prisma-client-js` generator is **deprecated**. Must switch to the new `prisma-client` generator in `schema.prisma`. The new generator's `output` field is **mandatory**; the client no longer emits into `node_modules` by default. | Schema change + import paths potentially change throughout the codebase. |
| **Driver adapters are mandatory.** For SQLite this means installing `@prisma/adapter-better-sqlite3` and `better-sqlite3`, then passing an adapter to every `new PrismaClient()` call. | **One call site** in this repo: `src/lib/db/prisma.ts:8`. The singleton pattern survives. |
| New `prisma.config.ts` at project root replaces some datasource/env behavior. `.env` files are no longer auto-loaded — code must call `dotenv.config()` explicitly. | New file + explicit dotenv wiring wherever the DB URL is read. |
| `prisma.$use()` middleware is removed; migrate to Client Extensions if used. | Audit found **zero** `$use` calls — no impact. |
| Metrics preview removed. | Not used. |
| Several CLI flags removed: `--schema`, `--url`, `--skip-generate`, `--skip-seed` on specific commands. | `scripts/manage.mjs` may use these — audit and replace. |
| `prisma migrate dev` no longer auto-runs seed. **`migrate deploy` semantics are unchanged.** | Production path is unaffected. |
| Node.js min becomes 20.19. | Check Docker base image (already 22). |

**Upside of switching to `@prisma/adapter-better-sqlite3`:**

Prisma's long-standing complaint — that the Rust engine never exposed `PRAGMA busy_timeout` ([prisma/prisma#2955](https://github.com/prisma/prisma/issues/2955)) — stops being an issue under v7 because the adapter hands execution to the `better-sqlite3` native driver, which honors standard SQLite pragmas. The existing `applySqlitePragmas()` function in `src/lib/db/prisma.ts:18-26` keeps working, and the pragmas actually take effect at the connection layer now rather than being best-effort. **This is a quality-of-life improvement specific to Sound Suite's WAL + 5000 ms busy_timeout setup under concurrent ingestion.**

**Procedure:**

1. `git checkout -b upgrade/prisma-7`
2. `npm run svc:stop`
3. `npm run db:backup -- --output ./data/backups/pre-prisma-7`
4. `cp prisma/data/sound-suite.db prisma/data/sound-suite.db.pre-prisma-7.bak`
5. Read the official guide ([v6 → v7](https://www.prisma.io/docs/orm/more/upgrade-guides/upgrading-versions), [LLM prompt](https://www.prisma.io/docs/ai/prompts/prisma-7)) and follow it literally, not from memory.
6. **Package changes:**
   - `npm install prisma@^7 @prisma/client@^7 @prisma/adapter-better-sqlite3 better-sqlite3`
   - Add `"type": "module"` to `package.json`.
7. **`schema.prisma` changes:**
   - Replace `generator client { provider = "prisma-client-js" }` with the new `prisma-client` generator block, specifying an `output` path (e.g. `output = "../src/generated/prisma"`).
   - `datasource db` block unchanged.
8. **`src/lib/db/prisma.ts` rewrite:**
   - Import the adapter: `import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'`.
   - Pass the adapter to the PrismaClient constructor: `new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: process.env.DATABASE_URL }) })`.
   - Keep the existing global-singleton pattern and the `applySqlitePragmas()` function.
9. **Create `prisma.config.ts`** at repo root per the upgrade guide. Load `.env` explicitly via `dotenv` if the new config file doesn't handle it.
10. **Update `next.config.ts`** `serverExternalPackages` array: add `@prisma/adapter-better-sqlite3` and `better-sqlite3` (next to the existing native modules). **Keep** `@prisma/client` in the list if it's already there.
11. **Find every import of the Prisma client** and retarget them to the new output path (`src/generated/prisma`) if the old default import path breaks. Use a codemod-style find-and-replace.
12. **Audit `scripts/manage.mjs`** for any removed CLI flags and replace them.
13. **Audit `tsconfig.json`** for `moduleResolution` and `module` settings — set to `bundler` / `ESNext` if not already.
14. **Audit Jest config** — ESM + Jest is historically fiddly; `jest.setup.js` may need to become `jest.setup.mjs`.
15. `npx prisma generate`
16. `npm run build 2>&1 | tail -60` — expect a much noisier output than Steps 1 and 2. Fix import paths one by one.
17. `npm test` — expect some ESM-related fallout in tests. Fix per failure.
18. `npm run svc:start`
19. **Do not run any migrations.** `migrate deploy` at startup is still a no-op.
20. Ingest the reference PDF. Compare counts to baseline.
21. Run Auto-Suggest, semantic search, backup, draft chat, sidecar command queue writes. The queue table is the most recent (migration 12: `20260310225301_add_sidecar_command_queue`), so exercise that path deliberately.
22. Observe memory and latency for 15 minutes under a real ingestion load — this is the step where the better-sqlite3 adapter shows whether it really improves WAL contention or introduces new quirks.
23. If green → merge. If red → revert the branch *and* restore from `sound-suite.db.pre-prisma-7.bak`.

**Rollback:** revert the branch, reinstall Prisma 6, restore the backup file.

**Estimated effort:** 1–2 focused days. This is the step most likely to take longer than expected; plan a buffer.

---

## 5. What does not change

- **`prisma/migrations/` directory** — all 13 existing migrations are unchanged and continue to work under v6 and v7. No rewrite, no replay, no reset.
- **SQLite file** — never touched by the Prisma upgrade itself. Only ever modified by `migrate deploy` applying new migrations, and none are added in this plan.
- **LanceDB** — zero coupling to Prisma; Step 3's adapter swap does not go near it.
- **Exhibit images** (`public/exhibits/`) — file-system only, unaffected.
- **Redis** — unaffected.
- **GPU sidecar** — the sidecar is a separate Next.js app with its own `package.json`. Its upgrade is explicitly out of scope for this plan and should happen on its own schedule.
- **Node.js base image** — already at 22 per the `roadmap-docker-mcp.md` plan, which clears both v6 and v7's minimums.

---

## 6. Risks and how we de-risk them

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Turbopack pdfjs worker regression (vercel/next.js#91642) breaks ingestion | medium | high | Step 1 only; use webpack build for production; smoke-test PDF ingestion before merge |
| `findUniqueOrThrow` throws new error shape, uncaught, surfaces as 500 | low | medium | Step 2 call-site audit; wrap with `P2025` check |
| ESM conversion in Step 3 breaks Jest setup | high | low-medium | Expect to spend hours on Jest config; not a data risk |
| Driver adapter regression under heavy concurrent ingestion | low | high | Step 3 soak test for 15 minutes under real load before merge; revert to v6 if latency increases |
| Path resolution breaks because `DATABASE_URL` is relative to `prisma/` dir, not project root (CLAUDE.md warning) | medium | high | Every step explicitly backs up `prisma/data/sound-suite.db` *by absolute path*; the entrypoint / dev server keeps working because the relative URL is unchanged |
| New Prisma client output path breaks imports site-wide | high | low | Codemod-style find-and-replace; build errors surface immediately |
| `data/sound-suite.db` stale copy at project root gets confused with the live DB | low | catastrophic | Before every step, `ls -la data/sound-suite.db prisma/data/sound-suite.db` and confirm sizes; the stale file is ~100 KB vs the real one at ~984 MB |
| LanceDB concurrent write during unstopped backup | low | medium | **All three upgrade steps stop services first.** No exceptions. |
| Something else breaks months later due to a subtle semantic change we didn't catch | unknown | medium | Keep backups of each step retained for 30 days post-upgrade |

---

## 7. Post-upgrade verification checklist

After **every** step, not just the last one:

- [ ] `npm run build` produces a clean standalone output.
- [ ] `npm test` passes at the same count as the Step 0 baseline.
- [ ] Ingesting the reference PDF produces byte-identical SQL row count and LanceDB row count.
- [ ] Auto-Suggest run completes and persists suggestions.
- [ ] Semantic search returns the same top-k for a canary query.
- [ ] `POST /api/backup` produces a valid manifest.
- [ ] `PUT /api/backup` with the Step 0 baseline restores cleanly (tested on a throwaway copy, not the live DB).
- [ ] Memory profile under `npm run svc:start` is flat over 15 minutes.
- [ ] The 13-migration history is untouched: `ls prisma/migrations | wc -l` is still 13.

If any checkbox fails, revert the step and file an issue before trying again.

---

## 8. Estimated total effort

| Step | Effort | Risk level |
|---|---|---|
| Step 0 baseline | 30–60 min | — |
| Step 1 Next.js 16.1.6 → 16.2.2 | 1–2 hours | low |
| Step 2 Prisma 5.22 → 6.latest | 2–4 hours | low |
| Step 3 Prisma 6.latest → 7.2 | 1–2 focused days | medium |
| **Total** | **~2 days active work, spread across 2–3 weeks of soak time** | |

The "soak time" matters: land Step 1, run the app for a few days, then start Step 2. This catches regressions that don't show up in automated tests but do show up under real ingestion over time.

---

## 9. Not in this plan

- GPU sidecar upgrades (`sideCar/` has its own `package.json`).
- React 20 (not released as of April 2026).
- Postgres migration — still deferred per `PostgressUpgradeV2.md`.
- Dockerization — see `roadmap-docker-mcp.md`. When that roadmap is executed, Step 3 of this plan (Prisma 7 + adapter) should already have landed, so the Docker image picks up the cleaner SQLite concurrency story for free.
- Turbopack production build — only adopt after vercel/next.js#91642 is closed.

---

## 10. References

### Next.js
- [Next.js 16.2 blog post](https://nextjs.org/blog/next-16-2)
- [Next.js upgrade guide — v16](https://nextjs.org/docs/app/guides/upgrading/version-16)
- [Next.js GitHub releases](https://github.com/vercel/next.js/releases)
- [Issue #91642 — Turbopack pdfjs regression](https://github.com/vercel/next.js/issues/91642)

### Prisma
- [Prisma 7 announcement](https://www.prisma.io/blog/announcing-prisma-orm-7-0-0)
- [Prisma 7.2.0 release](https://www.prisma.io/blog/announcing-prisma-orm-7-2-0)
- [v5 → v6 upgrade guide](https://www.prisma.io/docs/orm/more/upgrade-guides/upgrading-versions/upgrading-to-prisma-6)
- [v6 → v7 upgrade guide](https://www.prisma.io/docs/orm/more/upgrade-guides/upgrading-versions)
- [Prisma 7 LLM migration prompt](https://www.prisma.io/docs/ai/prompts/prisma-7)
- [@prisma/adapter-better-sqlite3 on npm](https://www.npmjs.com/package/@prisma/adapter-better-sqlite3)
- [Prisma issue #2955 — SQLite busy_timeout](https://github.com/prisma/prisma/issues/2955)
- [Prisma discussion #15966 — SQLite WAL](https://github.com/prisma/prisma/discussions/15966)