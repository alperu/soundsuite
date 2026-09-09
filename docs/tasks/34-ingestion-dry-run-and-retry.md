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

**Correction (re-audit 2026-09-09): the table above is incomplete, in a way that matters.**
`worker-init.ts:187-190` runs a *second* requeue immediately before the filed one:

```sql
UPDATE "Document" SET "status" = 'QUEUED', "errorMessage" = NULL
WHERE "status" = 'PROCESSING'
```

**No `filingId` predicate on this one.** `parsing-worker.ts` claims by setting `PROCESSING`
(`:207-211`) and only leaves that state on success or on the `ERROR` write, so a document that kills
the process mid-parse — OOM, a native fault in `sharp`/`onnxruntime`, an operator kill — stays at
`PROCESSING` and is requeued on **every** subsequent restart, filed or not. If it kills the process
again, the loop is closed and self-sustaining.

So "unfiled `ERROR` is genuinely terminal" holds, but "nothing ever retries an unfiled document" does
not: an unfiled document stuck at `PROCESSING` is retried without bound. The row that reads as the
safe one has an unbounded path through a state the table never names — and it is the only one of the
three that can take the process down rather than merely stall it.

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
| 1 | **Promote one document and trace it.** Record every status it passes through, wall-clock per stage, and whether `ingestCheckpoint` is ever written. Use a document from the smallest case. | ☐ **operator** |
| 2 | **Promote ~20 spanning different filing types.** Record failures **by cause**, not by count. With 0 current `ERROR` rows, any failure here is new information. | ☐ **operator** |
| 3 | **Add a bounded attempt counter.** Split by loop lifetime — see below. In-process counter for the OCR loop: **done**, no schema change. Durable counter for the cross-restart loop: **not built**; still needs `Document.parseAttempts Int @default(0)`. ⚠️ `prisma migrate deploy` or a reviewed `db push`; **never `migrate dev`**. Back up `prisma/data/sound-suite.db` first. | ◐ |
| 4 | **Cap the unbounded paths.** OCR-not-ready requeue (`parsing-worker.ts`): **done** — capped at `maxRetries`, then `ERROR` with a named cause. Startup hooks (`worker-init.ts:187-190` and `:198-203`): **not built**, blocked on item 3's column. | ◐ |
| 5 | **Decide filed vs unfiled promotion for the bulk run**, and write the reasoning down. | ☑ **unfiled** — decision and reasoning in `src/lib/ingestion/promotion.ts` (`PROMOTION_MODE_RATIONALE`) |
| 6 | **Make `maxRetries` real or delete it.** | ☑ made real — it is now the OCR requeue cap, read in `parsing-worker.ts`, with its doc comment narrowed to what it actually bounds |
| 7 | **Write the requeue path** (the thing the plans call `ssRequeueErrored`). It must carry its own attempt cap. | ☑ `planRequeueErrored` / `applyRequeue` in `src/lib/ingestion/promotion.ts`; `--limit` required, dry-run by default via `scripts/promote-discovered.ts` |
| 8 | **Fix the stale documentation** — see below. | ◐ `job-queue.ts` header done; `CLAUDE.md` block drafted below, **not applied** |

### Why item 3 splits in two

The two loops have different lifetimes, and only one of them needs durable state.

- **The OCR loop is within one process run.** Requeue → claim → requeue, pausing every worker for 30 s
  each cycle. An in-process `Map<documentId, attempts>` bounds it exactly, with **no schema change**
  and therefore no migration against a ~985 MB live database. Built: `parsing-worker.ts`, counter
  keyed by document id, cleared on success, `ERROR` with a named cause at the cap.
  It also unblocks the head of the queue: claims are `orderBy: createdAt asc`, so a permanently
  unparseable old document currently returns to the front every cycle. Failing it removes it from the
  claim pool.
- **The startup loops are across restarts.** No in-memory counter can survive the restart that drives
  them. These genuinely need the column.

**Residual, stated plainly: the system is not yet bounded.** A filed document past the in-process cap
still gets one fresh attempt per server restart, and a document stuck at `PROCESSING` gets one
regardless of `filingId`. Item 4 is half done, not done.

## `worker-init.ts:187-190` — diagnosed, not fixed (2026-09-09)

**Not fixed. The loop is live as of this writing.** The diagnosis is shipped deliberately in place of
a patch; the reasoning is below.

### The predicate

```sql
UPDATE "Document" SET "status" = 'QUEUED', "errorMessage" = NULL
WHERE "status" = 'PROCESSING'
```

Runs on every `getWorkerManager()` init. **No `filingId` predicate, no attempt predicate, no age
predicate.** It is unbounded in the strict sense: nothing in the statement, and nothing in any column
it reads, can ever stop it matching the same row again.

### What happens to a poison document

`parsing-worker.ts` claims a document by setting `PROCESSING` (`:207-211`) and leaves that state only
on the `INDEXED` success write or the `ERROR` write. A document whose parse **kills the process** —
OOM in embedding or chunking, a native fault in `sharp` / `onnxruntime` / `pdfjs`, an operator kill
during a long OCR — reaches neither. It is left at `PROCESSING`.

The service restarts. The hook above sets it back to `QUEUED` and clears `errorMessage`. The worker
claims it — claims are `orderBy: createdAt asc`, and this document is by construction older than
anything queued after it, so it goes **first**. It parses, and kills the process again.

That is the whole cycle, and it is self-sustaining: **the failure is the thing that triggers the
retry.** No counter is spent, because the increment would have to survive a process death; no error is
recorded, because the `ERROR` write never runs; and the cleared `errorMessage` erases whatever a
previous, gentler failure had left. Nothing accumulates, so nothing can ever cross a threshold.

### Why this is the serious one of the three

The other two unbounded paths degrade throughput. This one is a **crash loop**, and it takes the
process with it:

| Path | Cost of one cycle | Terminates? |
|---|---|---|
| Filed-document requeue (`:198-203`) | one wasted parse per restart | no, but the service stays up |
| OCR-not-ready requeue (`parsing-worker.ts`) | 30 s process-wide claim pause | **now capped in-process** (item 4) |
| **`PROCESSING` requeue (`:187-190`)** | **the whole process** | **no** |

It also defeats the fix above it. The in-process OCR counter is the correct bound for a within-run
loop, but a document that kills the process resets every in-memory counter by definition. And because
this hook runs at *init*, a crash loop here means the service never reaches a steady state at all —
it is the one failure mode that can prevent an operator from getting far enough in to diagnose it.

### What to change, and the risk of changing it

The change is to gate the requeue on a durable attempt count:

```sql
UPDATE "Document" SET "status" = 'QUEUED', "errorMessage" = NULL
WHERE "status" = 'PROCESSING' AND "parseAttempts" < :cap
```

with `parseAttempts` incremented **in the claim statement itself** (`parsing-worker.ts:207-211`), not
on any success or failure path. That placement is the entire point: a document that kills the process
never reaches a success or failure path, so an increment written anywhere else is exactly the
increment a poison document skips. Incrementing at claim time means the count is already durable
before the parse that might kill us begins.

**The risk is real and it runs the other way.** This is a *recovery* path, not a retry path. Its
legitimate job is to rescue documents that were mid-parse when the service went down for reasons
having nothing to do with them — a deploy, a machine reboot, an operator `Ctrl-C`, a sidecar
restart. A cap that is too low, or a naive "stop requeuing `PROCESSING`" fix, **strands those
documents permanently at a status nothing else looks at**. `PROCESSING` is not surfaced as a failure
anywhere: it is not `ERROR`, so no requeue path finds it, and it is not `DISCOVERED`, so bulk
promotion does not either. A stranded document is invisible in a way a failed one is not — which is
worse than the loop for anything that has to reason about corpus coverage.

So the cap must be paired with making capped-out documents *visible*: move them to `ERROR` with a
named cause rather than leaving them at `PROCESSING`, so they appear in `corpus_status` and in the
requeue path (`planRequeueErrored`) as a deliberate, counted decision.

### The evidence problem — and it is currently unsolved

The fix above assumes we can tell these two apart:

- **A**: this document's parse killed the process.
- **B**: this document was interrupted by something unrelated (deploy, reboot, OOM caused by a
  *different* process, operator kill).

**Today nothing in the database distinguishes them.** Both leave exactly one artefact — `status =
'PROCESSING'` — and `errorMessage` is cleared on the way back out. `ingestCheckpoint` would be the
natural discriminator and it is NULL on every row in the corpus, so it has never been exercised and
cannot be relied on. `ParsingWorker.currentDocumentId` knows the answer at the moment it matters and
is **in-memory only**, so it dies with the process that held it.

A count alone cannot separate A from B — it only separates "interrupted repeatedly" from
"interrupted once", and a document unlucky enough to be mid-parse across three consecutive deploys
looks identical to a poison one. That is tolerable for a cap (both should stop being retried
silently), but it is not tolerable as a *diagnosis*, and the operator needs the diagnosis.

What would actually distinguish them, cheapest first:

1. **A claim-time durable marker.** Write `parseAttempts` **and** a `claimedAt` timestamp in the same
   statement that sets `PROCESSING`. On init, a row whose `claimedAt` is older than the process start
   time was interrupted; the *number* of times that has happened is the signal. Cheap: one column,
   one statement, no new machinery.
2. **A clean-shutdown marker.** Have the worker record an orderly stop (SIGTERM handler → write a
   shutdown sentinel to `Config`). If the last shutdown was clean, every `PROCESSING` row is case B
   and should be requeued freely. If it was not, the `PROCESSING` rows are candidates for case A.
   This is the single highest-value signal, because deploys and reboots are almost always orderly and
   crashes are not — it separates the common benign case from the rare dangerous one directly, rather
   than inferring it from a count.
3. **Correlating with the process exit.** A crash caused *by* a document and a crash merely
   *concurrent with* it are only separable if the exit is attributed. In practice signal 2 plus the
   count from signal 1 is enough to act on; full attribution is not worth building.

**Recommendation: build 2 before tuning the cap in 1.** A cap without the clean-shutdown signal will
mostly fire on documents that did nothing wrong, which teaches operators to raise it until it stops
firing — at which point the crash loop is back and the column is a lie in the schema, which is the
defect class this whole series exists to remove.

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

`src/services/job-queue.ts:1-10` is **corrected** — the header now leads with the fact that nothing
feeds the class, so the retry description below it cannot be read as the system's retry behaviour.

### Ready-to-apply `CLAUDE.md` replacement (NOT applied)

`CLAUDE.md` was outside the editing territory of the agent that did this audit, so the correction is
drafted here rather than applied. Replace the "Core Data Flow" numbered list with:

> ```
> PDF files on disk → FileWatcher (chokidar) → DISCOVERED → (promotion) → QUEUED
>   → ParsingWorker → IngestionPipeline → LanceDB + SQLite
> ```
>
> 1. **FileWatcher** (`src/services/file-watcher.ts`) monitors the directories named by `Case.path`
>    rows — **not** `WATCH_PATHS`; `worker-init.ts:394` builds the watcher from `casePaths`. It
>    computes SHA-256 hashes and creates `Document` records with **`DISCOVERED`** status. Discovery
>    does **not** queue anything.
> 2. **Promotion** `DISCOVERED → QUEUED` is a deliberate act. In the UI it happens as a side effect of
>    filing (`api/cases/[id]/parse`, `api/cases/[id]/filing-queue`); in bulk it is
>    `src/lib/ingestion/promotion.ts` via `scripts/promote-discovered.ts` (dry-run by default).
>    The large majority of the corpus sits at `DISCOVERED`.
> 3. **ParsingWorker** (`src/services/parsing-worker.ts`) is the consumer: it polls for
>    `status: 'QUEUED'` — status only, no `filingId` predicate — and claims one document at a time.
>    **`JobQueue` is not on this path**; it is constructed and registered but never started or fed.
> 4. **IngestionPipeline** (`src/lib/ingestion/ingestion-pipeline.ts`) orchestrates: PDF text
>    extraction → OCR for low-density pages → exhibit image extraction → chunking → embeddings →
>    vector indexing.
> 5. Document status transitions: `DISCOVERED → QUEUED → PROCESSING → INDEXED` (or `ERROR`).
>    `worker-init.ts:187-190` requeues anything left at `PROCESSING` on every init, and `:198-203`
>    requeues every **filed** document not already QUEUED/PROCESSING/INDEXED. Both are currently
>    uncapped — see this task.

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
