# Test Suite Triage — remaining failing suites (#83 / #84 / #85)

Status as of 2026-08-14 (post-#84): **96 suites passing / 13 failing · 1215 tests passing / 79 failing.**
Everything below is pre-existing debt made *visible* by the test-infra recovery
(polyfills wiring, component tests running for the first time, mcp-server suite 0→22).
Nothing here is a regression from the Haystack Block View work.

## ⚠️ #83 — Prisma integration suites (3 suites) — DO NOT "quick fix"

**Suites:** `case-list`, `admin-settings`, `file-watcher`.

These are **integration tests**, not unit tests that accidentally touch Prisma. Each
constructs `new PrismaClient()` and calls `deleteMany` on real tables (case-list: 4×
document/case; admin-settings: 6× config/modelDownload; file-watcher: 2×).
`DATABASE_URL=file:./data/sound-suite.db` resolves relative to `prisma/` — i.e. the
**production corpus** (~985 MB, 820 documents, 5 cases).

They currently fail only because Prisma 7 refuses `new PrismaClient()` without an
adapter. **That failure is the only thing standing between `npm test` and an empty
Document table.** Handing them a working datasource — the obvious "make the suites
pass" move — wipes the corpus on the next test run.

**Options (user decision required):**

| Option | What it means | Trade-off |
|---|---|---|
| (a) Disposable test DB | Separate `DATABASE_URL` (e.g. `file:./data/test.db`), schema push + teardown per run | Correct for integration tests; someone must own test-DB lifecycle in jest globalSetup |
| (b) Convert to unit tests | Wire the opt-in proxy mock `src/lib/db/__mocks__/prisma.ts` (already delivered, unused) | Cheap; but DB behaviour is exactly what these suites assert — most of their value evaporates |
| (c) Leave failing | Current state | Safe; 3 red suites forever, and a standing trap for anyone who "fixes" them naively |

Recommendation: **(a)**, scoped as its own task with jest `globalSetup`/`globalTeardown`
owning the test DB. Until then, (c) is the deliberate, safe status quo.

## #84 — Transform/worker pair (2 suites)

- **ingestion-e2e:** the offending ESM package is `@xenova/transformers`.
  `transformIgnorePatterns` now includes it (kept — correct setting regardless).
  Error moved from "Unexpected token 'export'" to ts-jest's CJS `__dirname` colliding
  with the package's own ESM declaration. Remaining fix is a judgement call: mock
  `@xenova` in this suite (fast, but then what does "e2e" test?) vs. an ESM-aware
  transform for that path. **Decision open.**
- **job-queue:** ~~worker child-process exceptions~~ **FIXED under #84** — root cause
  was an inline Prisma mock enumerating only the two methods JobQueue used at the
  time it was written; same class as #82's mcp-server bug, same fix (memoised Proxy
  delegates, stable fn identity for mockResolvedValue). 0→16 tests passing. The one
  remaining failure (crash recovery expects 2 jobs, gets 0, `job-queue.test.ts:345`)
  is a never-before-executed assertion → moved to the #85 table below.

## #85 — Per-area assertion triage (9 suites, ~70 tests)

Pre-existing assertion failures from the embedding/ingestion era, grouped by area.
Plan: one focused pass per area, in this order (largest first), deciding per test
whether the assertion is stale (fix the test) or the code drifted (fix or file):

| Area | Suites | Failing tests |
|---|---|---|
| claude-embedding | 2 | 23 + 17 |
| ingestion-pipeline | 1 | 9 |
| ollama-embedding | 1 | 6 |
| pdf-parser | 1 | 5 |
| services-manager | 1 | 4 |
| exhibit-extractor | 1 | 3 |
| deep-search-boolean | 1 | 2 |
| job-queue (crash recovery only) | 1 | 1 |

Method (established this sprint): arithmetic proof for every change (N+delta=M, no
green→red), diagnostics written to files (the output condenser swallows jest console
output), DB-level verification over JS comparisons, `@jest-environment node` for
server-only suites, no global mocks — every suite mocks what it needs.

**Scheduled last** (after #87–#90) per user direction. Say "start 85" to launch.
