# Ingestion dry-run, and a retry that is actually bounded

**Status:** Proposed · **Effort:** S–M · **Priority:** P0 · **Created:** 2026-09-08
**Report:** [`../MCP-Improvements/REPORT-v14-execution-plan-to-working.md`](../MCP-Improvements/REPORT-v14-execution-plan-to-working.md) §5
**Blocks:** [`35-bulk-promotion.md`](./35-bulk-promotion.md) · **Blocked by:** [`21-chunk-overlap-defect.md`](./21-chunk-overlap-defect.md)

Counts and code citations only. No case names, cause numbers or document names.

## Problem

768 documents are parked at `DISCOVERED` and have never entered the pipeline. Before any of them is
promoted, the path they would take has to be proven on a small batch — because the failure handling
around it is not what any current document describes.

## What the audit actually found (2026-09-08)

Five corrections to the plan this task came from. Each changes what gets built.

### 1. `ssPromoteDiscovered` does not exist

Every occurrence of that name is **prose** — `docs/PLAN-haystack-mcp-agentic-etl.md:235,360` and the
v14 report itself. There is no such function, script, CLI or MCP tool. It was cited across two
documents as though it existed.

Promotion today is **inline in two API routes**, with no shared function:

- `src/app/api/cases/[id]/parse/route.ts:112-128` — `if (existing && existing.status === 'DISCOVERED')`
  → `data: { status: 'QUEUED', filingId, documentType }`
- `src/app/api/cases/[id]/filing-queue/route.ts:189-199` — the same upgrade path

An operator promotes by filing documents through the UI. **There is no bulk promotion script and no
bulk requeue script.**

### 2. Something *does* auto-promote — but not the 768

`src/services/worker-init.ts:197-204`, on every `getWorkerManager()` init:

```sql
UPDATE "Document" SET "status" = 'QUEUED', "errorMessage" = NULL
WHERE "filingId" IS NOT NULL
  AND "status" NOT IN ('QUEUED', 'PROCESSING', 'INDEXED')
```

The 768 survive only because their `filingId` is NULL. So "nothing auto-promotes them" is true of the
768 and false in general.

### 3. `ERROR` is not terminal, and the retry is unbounded

The plan says a failure is "permanent". For a **filed** document it is the opposite: the startup hook
above matches `ERROR` unconditionally, so restart → `QUEUED` → parse throws → `ERROR` → next restart →
`QUEUED`, forever. `src/services/file-watcher.ts:262-275` re-drives it too, via
`healOrphanedDuplicate()`.

**There is no attempt counter anywhere.** `Document` in `prisma/schema.prisma` has `status`,
`errorMessage` and `ingestCheckpoint` — no attempts column. `parsing-worker.ts` keeps no in-memory
counter either. `maxRetries` is declared at `:53-54`, defaulted at `:76`, and **never read**.

So the true state is worse than "no retry", and differently shaped:

| Document | Behaviour on failure |
|---|---|
| **Filed** (`filingId` set) | unbounded retry across restarts, no cap, no counter |
| **Unfiled** (`filingId` NULL) | `ERROR` is genuinely terminal; nothing ever retries it |

Neither is a bounded retry. Both need fixing, and they need *different* fixes.

### 4. `filingId` is NOT required to parse

This is the one that keeps [task 35](./35-bulk-promotion.md) tractable.
`src/services/parsing-worker.ts:199-213` selects on status alone:

```ts
const candidate = await this.prisma.document.findFirst({
  where: { status: 'QUEUED' },
  orderBy: { createdAt: 'asc' },
  select: { id: true, filePath: true },
});
```

No `filingId` predicate, no join. So bulk promotion is a **status update**, not 768 per-document
classification decisions.

**But the choice is load-bearing.** Promoting *without* a filing avoids the unbounded restart loop
(the hook needs `filingId IS NOT NULL`) at the cost of losing all retry. Promoting *with* one gets
retry, unbounded. Decide deliberately in item 5, not by accident.

### 5. The OCR branch is worse than a loop

`parsing-worker.ts:246-262`: an OCR-not-GPU-ready error requeues the document **and pauses all claims
process-wide for 30 seconds**, with no attempt counter. One permanently-unparseable document can
therefore stall the entire pipeline indefinitely, not merely fail itself. The ETL plan flags this at
`docs/PLAN-haystack-mcp-agentic-etl.md:120-123`.

## Measured starting state (2026-09-08)

| Fact | Value | Why it matters |
|---|---|---|
| `ERROR` rows | **0** | the failure path has **never fired in production** — it is untested, not merely unretried |
| `errorMessage` non-null | **0** | same |
| `ingestCheckpoint` non-null | **0 of 864** | resume-from-checkpoint has never been exercised; do not assume a bulk run is resumable |
| Distinct `parserVersion` values | **1** (`hybrid-docparse-1`, on 22 docs) | there is only one parser generation to compare against |

The zero-`ERROR` figure is the important one: **this task is the first real exercise of the failure
path**, so expect to discover its behaviour rather than confirm it.

## Work

| # | Item | Status |
|---|---|---|
| 1 | **Promote one document and trace it.** Record every status it passes through, wall-clock per stage, and whether `ingestCheckpoint` is ever written. Use a document from the smallest case. | ☐ |
| 2 | **Promote ~20 spanning different filing types.** Record failures **by cause**, not by count. With 0 current `ERROR` rows, any failure here is new information. | ☐ |
| 3 | **Add a bounded attempt counter.** There is no column for it — this needs a schema change. `Document.parseAttempts Int @default(0)`, incremented on each `PROCESSING` transition, checked before requeue. ⚠️ Use `prisma migrate deploy` or a reviewed `db push`; **never `migrate dev`** on this database (CLAUDE.md § Database Safety — it can silently drop and recreate every table). Back up `prisma/data/sound-suite.db` first. | ☐ |
| 4 | **Cap the two unbounded paths** using that counter: the startup hook (`worker-init.ts:197-204`) must exclude documents past the cap, and the OCR-not-ready requeue (`parsing-worker.ts:246-262`) must stop requeuing past it. The OCR one matters more — it pauses the whole process, not just its own document. | ☐ |
| 5 | **Decide filed vs unfiled promotion for the bulk run**, and write the reasoning down. Unfiled = no unbounded loop, no retry. Filed = retry, currently unbounded (until item 4). This is [task 35](./35-bulk-promotion.md)'s single most consequential input. | ☐ |
| 6 | **Make `maxRetries` real or delete it.** Declared at `parsing-worker.ts:53-54`, defaulted at `:76`, never read. A config field that does nothing is a lie in the config — the same defect class this series has spent eleven reports removing, sitting in a settings object. | ☐ |
| 7 | **Write the requeue path** (the thing the plans call `ssRequeueErrored`). It must carry its own attempt cap. Uncapped retry on a document that always fails is worse than no retry, because it pauses the pipeline. | ☐ |
| 8 | **Fix the stale documentation** — see below. | ☐ |

## Stale documentation this task must correct

| Where | Says | Truth |
|---|---|---|
| `CLAUDE.md:100` | FileWatcher "creates `Document` records with **QUEUED** status" | it writes `DISCOVERED` (`file-watcher.ts:199-215`) |
| `CLAUDE.md:103` | "`QUEUED → PROCESSING → INDEXED` (or `ERROR`)" | omits `DISCOVERED`, the state 89% of the corpus is in |
| `CLAUDE.md` | `WATCH_PATHS` drives the watcher | the live watcher is built from `Case.path` rows (`worker-init.ts:390-394`) |
| `src/services/job-queue.ts:1-10` | "Retry logic with exponential backoff (3 attempts: 1s, 2s, 4s)" | nothing feeds `JobQueue`; `enqueue` (`:110`) has **zero production callers** |

`DISCOVERED` appears **nowhere** in `CLAUDE.md`. `docs/application-overview.md:35,185` has it right, so
the two documents contradict each other — and the wrong one is the file every agent reads first. That
is how `ssPromoteDiscovered` came to be cited as real in two separate planning documents.

## Risks

- **Do not run this before [task 21](./21-chunk-overlap-defect.md).** Twenty documents chunked at 130
  characters with no overlap is twenty documents to re-parse later.
- **Do not build against `JobQueue`.** It is constructed and registered (`worker-init.ts:404-407`)
  with no `.start()` and no feed. `loadJobsFromDatabase()` (`:84-92`) does query `status: 'QUEUED'`
  but only fills an in-memory map — nothing executes.
- **A schema migration on a 984.9 MB live database is the riskiest step here.** Back up first; prefer
  `migrate deploy`.
- **Item 4 changes restart behaviour.** Documents that currently retry forever will stop. That is the
  point, but it will look like a regression to anyone watching a filed `ERROR` row stop moving.

## Acceptance

| Check | Expected |
|---|---|
| One document promoted | full state trace recorded, with wall-clock per stage |
| ~20 promoted | every failure has a **named cause**; count alone is not acceptance |
| A deliberately-failing document | stops being retried at the cap, in both the startup and OCR paths |
| The OCR-not-ready path | can no longer pause the process indefinitely on one document |
| `maxRetries` | read, or gone |
| `CLAUDE.md` | describes `DISCOVERED`, the real watcher source, and the real consumer |
| `job-queue.ts` header | no longer advertises retry behaviour nothing can reach |
| Filed-vs-unfiled decision | written down with its reasoning, before task 35 starts |

## References

- `src/services/file-watcher.ts:199-215`, `:262-275`
- `src/services/worker-init.ts:186-204`, `:390-394`, `:404-407`
- `src/services/parsing-worker.ts:53-54`, `:76`, `:199-213`, `:246-262`, `:264-270`
- `src/services/job-queue.ts:1-10`, `:84-92`, `:110`
- `src/app/api/cases/[id]/parse/route.ts:112-128`, `src/app/api/cases/[id]/filing-queue/route.ts:189-199`
- `docs/PLAN-haystack-mcp-agentic-etl.md:93-139` (§3.3), `:120-123` (OCR hazard), `:361`
- Adjacent existing routes: `api/queue/clear`, `api/cases/[id]/rescan`, `api/documents/[id]/refresh-path`,
  `api/documents/[id]/clear-index`, `api/documents/[id]/reindex-pages`,
  `api/admin/documents/clean-orphans`, `scripts/rechunk-page-only-docs.ts`
