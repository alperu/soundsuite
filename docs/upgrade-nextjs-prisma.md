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

- **pdfjs + Turbopack regression** ([vercel/next.js#91642](https://github.com/vercel/next.js/issues/91642)) — **RESOLVED.** This was fixed via [PR #91666](https://github.com/vercel/next.js/pull/91666) (merged). The Turbopack team fixed the dynamic module resolution for server-side Worker instantiation that affected `pdfjs-dist` and similar libraries. Turbopack production builds are now viable for this step.
- **Verification:** still run `npm run build 2>&1 | tail -30` after the bump and confirm clean standalone output. Run `npm run dev` and trigger a PDF ingestion to confirm the dynamic worker import resolves — this remains prudent even with the fix landed.

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

**CRITICAL: Known Next.js 16 + Prisma 7 Compatibility Issues**

Community testing has uncovered **active, unresolved** issues when running Prisma 7 with Next.js 16's Turbopack bundler. These directly affect the upgrade strategy.

**Issue A — New `prisma-client` generator breaks Turbopack** ([prisma/prisma#28627](https://github.com/prisma/prisma/issues/28627), **OPEN**)

Prisma 7's new `prisma-client` generator emits TypeScript files with ES module-style `.js` import paths (e.g. `import { PrismaClientClass } from "./internal/class.js"`), but only `.ts` source files exist at build time. Turbopack (and webpack) cannot resolve these imports, causing `Module not found: Error: Can't resolve './internal/class.js'`. No official fix merged yet, but a **community workaround exists** (see Alternative B below).

**Issue B — ESM PrismaClient instantiation failures** ([prisma/prisma#28670](https://github.com/prisma/prisma/issues/28670))

In pure ESM environments (`"type": "module"`), the PrismaClient constructor can throw `TypeError: __internal undefined` depending on how it is invoked.

**Issue C — Turbopack tries to bundle Prisma internals**

Turbopack's server-side rendering phase attempts to optimize/bundle the Prisma client, but Prisma uses native components and generated code that must be treated as external.

**Two approaches — pick one:**

### Alternative A — Keep `prisma-client-js` generator (safest, least work)

1. **DO NOT switch to the new `prisma-client` generator.** Keep `prisma-client-js` in `schema.prisma`. This generates the client in the traditional structure that Turbopack can resolve. You still get all v7 benefits including driver adapters.
2. **Add Prisma packages to `serverExternalPackages`** in `next.config.ts` so Turbopack skips bundling them:
   ```typescript
   serverExternalPackages: [
     '@prisma/client',
     '@prisma/adapter-better-sqlite3',
     'better-sqlite3',
     // ...existing entries (sharp, @lancedb/lancedb, etc.)
   ]
   ```
3. **Do NOT add `"type": "module"` to `package.json`.** This sidesteps Issue B entirely. Prisma 7 works without it when using the `prisma-client-js` generator — the ESM-only requirement is tied to the new `prisma-client` generator which we are deliberately avoiding.
4. If Turbopack still causes issues during build, fall back to webpack as a last resort: `next build --webpack`. This loses Turbopack speed but guarantees compatibility.

**Net effect:** dramatically reduces Step 3's scope. Instead of a full ESM migration + generator swap + import path rewrite, it becomes: install driver adapter, update one PrismaClient call site, add `serverExternalPackages`, create `prisma.config.ts`.

### Alternative B — Use the new `prisma-client` generator with Turbopack fix

A community-confirmed workaround ([prisma/prisma#28627 comment by @devanshtakkar](https://github.com/prisma/prisma/issues/28627)) resolves the `.js` import resolution issue by forcing Prisma to generate `.ts` file extensions instead. This lets you use the new generator with Turbopack:

```prisma
generator client {
  provider                = "prisma-client"
  output                  = "../src/generated/prisma"
  moduleFormat            = "esm"
  generatedFileExtension  = "ts"
  importFileExtension     = "ts"
}
```

The two critical fields are `generatedFileExtension = "ts"` and `importFileExtension = "ts"` — they force Prisma to emit `.ts` extensions in import paths instead of `.js`, which Turbopack can actually resolve. This approach:

- **Requires** `"type": "module"` in `package.json` (full ESM conversion).
- **Requires** updating all Prisma client imports to point at the new output path (`src/generated/prisma`).
- **Requires** Jest ESM migration (`jest.setup.js` → `jest.setup.mjs`, ESM transform config).
- Gives you the full v7 generator experience (smaller output, future-proof).
- **Carries more risk** — more moving parts, ESM + Jest is historically fiddly.

Still add the `serverExternalPackages` entries from Alternative A regardless.

### Recommendation

**Start with Alternative A.** It's lower risk, less work, and gets the key v7 benefit (better-sqlite3 adapter for WAL/busy_timeout). Switch to Alternative B later once #28627 gets an official fix upstream or if the community workaround proves stable across Prisma patch releases.

Sources: [Prisma v7 + Next.js 16 Turbopack Fix Guide](https://www.buildwithmatija.com/blog/migrate-prisma-v7-nextjs-16-turbopack-fix), [Medium — Prisma 7 + Next.js 16 fix](https://medium.com/@chakhit.kanchana/fixes-the-issue-where-prisma-7-is-not-compatible-with-nextjs-16-564dc6979636), [prisma/prisma#28627](https://github.com/prisma/prisma/issues/28627), [prisma/prisma#28670](https://github.com/prisma/prisma/issues/28670)

**Upside of switching to `@prisma/adapter-better-sqlite3`:**

Prisma's long-standing complaint — that the Rust engine never exposed `PRAGMA busy_timeout` ([prisma/prisma#2955](https://github.com/prisma/prisma/issues/2955)) — stops being an issue under v7 because the adapter hands execution to the `better-sqlite3` native driver, which honors standard SQLite pragmas. The existing `applySqlitePragmas()` function in `src/lib/db/prisma.ts:18-26` keeps working, and the pragmas actually take effect at the connection layer now rather than being best-effort. **This is a quality-of-life improvement specific to Sound Suite's WAL + 5000 ms busy_timeout setup under concurrent ingestion.**

**Procedure (updated to avoid known Turbopack issues — see compatibility section above):**

1. `git checkout -b upgrade/prisma-7`
2. `npm run svc:stop`
3. `npm run db:backup -- --output ./data/backups/pre-prisma-7`
4. `cp prisma/data/sound-suite.db prisma/data/sound-suite.db.pre-prisma-7.bak`
5. Read the official guide ([v6 → v7](https://www.prisma.io/docs/orm/more/upgrade-guides/upgrading-versions), [LLM prompt](https://www.prisma.io/docs/ai/prompts/prisma-7)) for background, but **follow this procedure** — the official guide's generator swap triggers known Turbopack breakage.
6. **Package changes:**
   - `npm install prisma@^7 @prisma/client@^7 @prisma/adapter-better-sqlite3 better-sqlite3`
   - **DO NOT** add `"type": "module"` to `package.json` — this triggers ESM instantiation failures ([prisma/prisma#28670](https://github.com/prisma/prisma/issues/28670)) and is only required for the new `prisma-client` generator which we are avoiding.
7. **`schema.prisma` — keep `prisma-client-js`:**
   - **DO NOT** switch to the new `prisma-client` generator. The new generator's ESM `.js` imports break Turbopack ([prisma/prisma#28627](https://github.com/prisma/prisma/issues/28627), **OPEN**).
   - Keep: `generator client { provider = "prisma-client-js" }`
   - `datasource db` block unchanged.
   - All v7 features (driver adapters, Rust-free engine, better-sqlite3) still work with `prisma-client-js`.
8. **`src/lib/db/prisma.ts` rewrite:**
   - Import the adapter: `import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'`.
   - Pass the adapter to the PrismaClient constructor: `new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: process.env.DATABASE_URL }) })`.
   - Keep the existing global-singleton pattern and the `applySqlitePragmas()` function.
9. **Create `prisma.config.ts`** at repo root per the upgrade guide. Load `.env` explicitly via `dotenv` if the new config file doesn't handle it.
10. **Update `next.config.ts`** `serverExternalPackages` array — add Prisma packages so Turbopack skips bundling them:
    ```
    '@prisma/client',
    '@prisma/adapter-better-sqlite3',
    'better-sqlite3',
    ```
    Add these next to the existing native modules (`sharp`, `@lancedb/lancedb`, etc.). This prevents Turbopack from trying to optimize Prisma internals.
11. **Audit `scripts/manage.mjs`** for any removed CLI flags (`--schema`, `--url`, `--skip-generate`) and replace them.
12. `npx prisma generate`
13. `npm run build 2>&1 | tail -60` — should be much cleaner than a full ESM migration. If build fails with module resolution errors, try `npm run build -- --webpack` as a diagnostic step — if webpack builds but Turbopack doesn't, add the failing package to `serverExternalPackages`.
14. `npm test` — should pass with minimal changes since we didn't convert to ESM.
15. `npm run svc:start`
16. **Do not run any migrations.** `migrate deploy` at startup is still a no-op.
17. Ingest the reference PDF. Compare counts to baseline.
18. Run Auto-Suggest, semantic search, backup, draft chat, sidecar command queue writes. The queue table is the most recent (migration 12: `20260310225301_add_sidecar_command_queue`), so exercise that path deliberately.
19. Observe memory and latency for 15 minutes under a real ingestion load — this is the step where the better-sqlite3 adapter shows whether it really improves WAL contention or introduces new quirks.
20. If green → merge. If red → revert the branch *and* restore from `sound-suite.db.pre-prisma-7.bak`.

**Deferred until [prisma/prisma#28627](https://github.com/prisma/prisma/issues/28627) is resolved:**
- Switching generator from `prisma-client-js` to `prisma-client`
- Adding `"type": "module"` to `package.json` (full ESM conversion)
- Custom generator output path (`src/generated/prisma`)
- Jest ESM migration

These can be done in a follow-up PR once the Turbopack import resolution issue is fixed upstream. They are **not required** for the driver adapter / better-sqlite3 benefits.

**Rollback:** revert the branch, reinstall Prisma 6, restore the backup file.

**Estimated effort:** 4–8 hours (significantly reduced from original 1–2 day estimate since we skip the ESM conversion and generator swap).

---

## 5. Performance: will Prisma 7 speed up Sound Suite?

**Short answer: no measurable difference for this app.** The real benefit is reliability (WAL/busy_timeout fix), not speed.

### What Prisma claims vs what the community measured

Prisma marketed v7 as "~3x faster" due to eliminating the Rust engine. Community benchmarks told a different story:

- **Prisma 7.0–7.3 was actually *slower* than Prisma 6 in some workloads** ([prisma/prisma#28794](https://github.com/prisma/prisma/issues/28794)). The Rust serialization overhead was replaced by TypeScript query compiler overhead. Simple CRUD and join benchmarks showed "incrementally better or similar" performance, not 3x.
- **Prisma acknowledged this** — one of the main feedback items was that "performance has not met expectations initially set" ([Prisma 7 benchmarks blog](https://www.prisma.io/blog/prisma-7-performance-benchmarks)).
- **Prisma 7.4 query caching fixed it** ([announcement](https://www.prisma.io/blog/prisma-orm-v7-4-query-caching-partial-indexes-and-major-performance-improvements)). A SQL statement cache avoids rebuilding the SQL on every request. 7.4+ benchmarks show it beating both v6 and v7.3. **If upgrading to v7, pin to ≥7.4.**
- **Raw queries** (`$queryRaw`, `$executeRaw`) bypass the compiler entirely in v7.3+, which helps heavy raw-SQL workloads.

### Why it doesn't matter for Sound Suite

Sound Suite's bottleneck is **not** Prisma query compilation. The hot paths are:

| Operation | Where time is spent | Prisma's role |
|---|---|---|
| PDF ingestion | pdfjs extraction, OCR (tesseract/Ollama), embedding generation | Prisma writes `Document`, `PageCache`, `Filing` rows — simple INSERTs, ~1ms each |
| Vector search | LanceDB hybrid search + optional reranker | Prisma not involved — LanceDB is a separate store |
| Draft chat | AI streaming (Anthropic/OpenAI/Ollama) | Prisma loads the draft + linked cases — 2-3 SELECTs, ~5ms total |
| Auto-Suggest | AI streaming + suggestion persistence | Prisma INSERTs 5-20 suggestion rows — trivial vs the 30-60s AI stream |

Even if Prisma 7.4 delivers a genuine 3x speedup on those queries, you're saving ~3ms on a pipeline that takes 30-180 seconds. Imperceptible.

### The actual benefit: SQLite reliability

The reason to upgrade is **not speed** — it's the `@prisma/adapter-better-sqlite3` driver adapter:

- **WAL mode + busy_timeout actually work.** The Rust engine's Quaint driver never properly honored `PRAGMA busy_timeout` ([prisma/prisma#2955](https://github.com/prisma/prisma/issues/2955)). Under concurrent ingestion (multiple workers + API requests), this caused intermittent `SQLITE_BUSY` errors. The `better-sqlite3` native driver respects these pragmas at the connection level.
- **~90% smaller Prisma package** (no Rust binary). Matters for Docker image size (see `roadmap-docker-mcp.md`).
- **Simpler debugging.** Errors from a TypeScript stack are easier to trace than errors from a Rust binary.

### Recommendation

Upgrade to Prisma 7.4+ (not 7.0–7.3) for the reliability fix. Do not expect a speed improvement. If query performance ever becomes a bottleneck (it won't for this app's scale), the answer is `$queryRaw` with hand-tuned SQL, not an ORM version bump.

Sources: [Prisma 7 benchmarks blog](https://www.prisma.io/blog/prisma-7-performance-benchmarks), [prisma/prisma#28794 — performance vs claims](https://github.com/prisma/prisma/issues/28794), [Prisma 7.4 query caching](https://www.prisma.io/blog/prisma-orm-v7-4-query-caching-partial-indexes-and-major-performance-improvements), [prisma/prisma#12785 — 100x slower than better-sqlite3](https://github.com/prisma/prisma/issues/12785), [prisma/prisma#2955 — busy_timeout](https://github.com/prisma/prisma/issues/2955)

---

## 6. What does not change  

- **`prisma/migrations/` directory** — all 13 existing migrations are unchanged and continue to work under v6 and v7. No rewrite, no replay, no reset.
- **SQLite file** — never touched by the Prisma upgrade itself. Only ever modified by `migrate deploy` applying new migrations, and none are added in this plan.
- **LanceDB** — zero coupling to Prisma; Step 3's adapter swap does not go near it.
- **Exhibit images** (`public/exhibits/`) — file-system only, unaffected.
- **Redis** — unaffected.
- **GPU sidecar** — the sidecar is a separate Next.js app with its own `package.json`. Its upgrade is explicitly out of scope for this plan and should happen on its own schedule.
- **Node.js base image** — already at 22 per the `roadmap-docker-mcp.md` plan, which clears both v6 and v7's minimums.

---

## 7. Risks and how we de-risk them

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| ~~Turbopack pdfjs worker regression (vercel/next.js#91642)~~ | ~~medium~~ | ~~high~~ | **RESOLVED** — fixed via [PR #91666](https://github.com/vercel/next.js/pull/91666). Turbopack production builds now safe. Still smoke-test PDF ingestion before merge. |
| `findUniqueOrThrow` throws new error shape, uncaught, surfaces as 500 | low | medium | Step 2 call-site audit; wrap with `P2025` check |
| Prisma 7 `prisma-client` generator breaks Turbopack ([prisma/prisma#28627](https://github.com/prisma/prisma/issues/28627)) | **confirmed** | high | **AVOID**: keep `prisma-client-js` generator. Do NOT switch. Defer until #28627 is resolved. |
| ESM `"type": "module"` causes PrismaClient init failure ([prisma/prisma#28670](https://github.com/prisma/prisma/issues/28670)) | **confirmed** | high | **AVOID**: do not add `"type": "module"` to package.json. Not needed when keeping `prisma-client-js` generator. |
| Turbopack tries to bundle Prisma internals | medium | medium | Add `@prisma/client`, `@prisma/adapter-better-sqlite3`, `better-sqlite3` to `serverExternalPackages` in `next.config.ts`. |
| Driver adapter regression under heavy concurrent ingestion | low | high | Step 3 soak test for 15 minutes under real load before merge; revert to v6 if latency increases |
| Path resolution breaks because `DATABASE_URL` is relative to `prisma/` dir, not project root (CLAUDE.md warning) | medium | high | Every step explicitly backs up `prisma/data/sound-suite.db` *by absolute path*; the entrypoint / dev server keeps working because the relative URL is unchanged |
| ~~New Prisma client output path breaks imports site-wide~~ | ~~high~~ | ~~low~~ | **AVOIDED** — keeping `prisma-client-js` generator means import paths don't change. Deferred to post-#28627. |
| `data/sound-suite.db` stale copy at project root gets confused with the live DB | low | catastrophic | Before every step, `ls -la data/sound-suite.db prisma/data/sound-suite.db` and confirm sizes; the stale file is ~100 KB vs the real one at ~984 MB |
| LanceDB concurrent write during unstopped backup | low | medium | **All three upgrade steps stop services first.** No exceptions. |
| Something else breaks months later due to a subtle semantic change we didn't catch | unknown | medium | Keep backups of each step retained for 30 days post-upgrade |

---

## 8. Post-upgrade verification checklist

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

## 9. Estimated total effort

| Step | Effort | Risk level |
|---|---|---|
| Step 0 baseline | 30–60 min | — |
| Step 1 Next.js 16.1.6 → 16.2.2 | 1–2 hours | low |
| Step 2 Prisma 5.22 → 6.latest | 2–4 hours | low |
| Step 3 Prisma 6.latest → 7.2 (keeping `prisma-client-js` — no ESM migration) | 4–8 hours | medium |
| **Total** | **~1.5 days active work, spread across 2–3 weeks of soak time** | |

The "soak time" matters: land Step 1, run the app for a few days, then start Step 2. This catches regressions that don't show up in automated tests but do show up under real ingestion over time.

---

## 10. Not in this plan

- GPU sidecar upgrades (`sideCar/` has its own `package.json`).
- React 20 (not released as of April 2026).
- Postgres migration — still deferred per `PostgressUpgradeV2.md`.
- Dockerization — see `roadmap-docker-mcp.md`. When that roadmap is executed, Step 3 of this plan (Prisma 7 + adapter) should already have landed, so the Docker image picks up the cleaner SQLite concurrency story for free.
- ~~Turbopack production build — only adopt after vercel/next.js#91642 is closed.~~ **Resolved** — #91642 is closed, Turbopack production builds are now viable.

---

## 11. References

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

---

## 12. Follow-on research: XETO + Project Haystack court-domain layer

This upgrade is a prerequisite for a larger architectural piece: layering [Project Haystack](https://project-haystack.org) tags + [XETO](https://github.com/Project-Haystack/xeto) typed specs onto the legal-domain models so the AI chat can reason about case state, per-state procedural rules, and "what's due / what's next".

That research lives in **[`docs/xeto-haystack-research.md`](./xeto-haystack-research.md)**. Headlines:

- **Stay on Prisma 7 + SQLite** — add `tags Json` columns, compile Haystack filter syntax to `json_extract` SQL, validate writes against XETO via `ajv`. No JS-native Haystack datastore worth switching to (Folio is JVM-only, j2inn ships SDK only).
- **`@xeto/sdk` does not exist on npm.** XETO compiles to JSON Schema; ship the compiled schema, not the Fantom JS bundle.
- **Encode procedural rules as XETO *instances*, not types.** Three libs: `proc.core`, `proc.tx`, `proc.ca`, `proc.frap`.
- **Use React Flow for the visual case-action graph.** Rete.js is overkill for a read-only derived diagram.
- **Calendar arithmetic stays in TypeScript.** XETO is the schema, not the rule engine.

**Sequencing:** the better-sqlite3 driver adapter from Prisma 7 (Step 3 above) is a hard prerequisite for the tag-heavy concurrent reads/writes that layer needs. Do the framework upgrade first.

---

## 13. Forward look: Prisma 8 / `prisma-next`

Prisma is shipping a TypeScript rewrite as a separate repo: [prisma/prisma-next](https://github.com/prisma/prisma-next). It introduces extension packs, a typed SQL plan builder, and explicit AI-agent ergonomics — all of which interact directly with the XETO + Haystack layer above.

When `prisma-next` ships stable (likely as Prisma 8), the playbook for whether/how to adopt it lives in **[`docs/prisma-8-readiness.md`](./prisma-8-readiness.md)**. Headlines:

- **Stay on Prisma 7 until prisma-next is stable.** Don't chase alpha.
- **Extension packs would let us replace the hand-rolled `haystackFilter()` SQL emitter** with a first-class typed Haystack query operator. Eliminates the main compromise in the XETO/Haystack hybrid plan.
- **Keep everything from this Step 3** when Prisma 8 lands: the better-sqlite3 driver-adapter pattern, `resolveSqlitePath()` shim, `serverExternalPackages` entries, the bare-`new PrismaClient()` purge in `src/services/workflow-service.ts`, the client-safe split in `src/lib/action-log.ts`. Those are foundational regardless of Prisma version.
- [Prisma discussion #15966 — SQLite WAL](https://github.com/prisma/prisma/discussions/15966)