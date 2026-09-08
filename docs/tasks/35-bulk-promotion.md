# Bulk promotion of the 768 un-ingested documents

**Status:** Proposed · **Effort:** M · **Priority:** P0 · **Created:** 2026-09-08
**Report:** [`../MCP-Improvements/REPORT-v14-execution-plan-to-working.md`](../MCP-Improvements/REPORT-v14-execution-plan-to-working.md) §5
**Blocked by:** [`21-chunk-overlap-defect.md`](./21-chunk-overlap-defect.md) **and** [`34-ingestion-dry-run-and-retry.md`](./34-ingestion-dry-run-and-retry.md)

Counts only. Cases appear as A–E; the mapping is not recorded in this file.

## Problem

**768 of 864 documents have never entered the pipeline.** They sit at `DISCOVERED`, which is not a
failure state — it is the state a document is created in, and promotion is a deliberate act nobody
has performed at scale.

This is the only task in the 22–37 range that changes what the system can *answer*. Everything else
changes how well or how honestly it answers what it already can.

## Why this is a status update, not a classification project

Established by audit (2026-09-08): **`filingId` is not required to parse.**
`src/services/parsing-worker.ts:199-213` selects on `status: 'QUEUED'` alone — no `filingId`
predicate, no join. So this is a bounded migration, not 768 filing decisions.

**But the filed/unfiled choice decides the failure behaviour**, and it must be made before the first
wave (it is [task 34](./34-ingestion-dry-run-and-retry.md) item 5):

| Promoted **with** a filing | Promoted **without** |
|---|---|
| `worker-init.ts:197-204` re-queues it on every restart | never auto-requeued |
| Retry exists, but is **unbounded** until task 34 item 4 | `ERROR` is genuinely terminal |
| One bad document can loop forever | one bad document is simply lost until noticed |

Neither is acceptable as-is, which is why task 34 blocks this one.

## Measured starting state (2026-09-08)

Per-case backlog, smallest first — this **is** the wave order:

| Case | `DISCOVERED` | `INDEXED` | Total | Coverage |
|---|---|---|---|---|
| A | 30 | 24 | 54 | 44.4% |
| B | 39 | 15 | 54 | 27.8% |
| C | 45 | 19 | 64 | 29.7% |
| D | 252 | 6 | 258 | 2.3% |
| E | 402 | 32 | 434 | 7.4% |

**The two largest cases hold 654 of the 768.** Waves A–C total 114 documents and exercise every code
path the big two will hit, at 15% of the volume. If something systemic is wrong, it shows up there.

Two facts that bear directly on running this safely:

- **`ingestCheckpoint` is NULL on all 864 rows.** Resume-from-checkpoint has never been exercised. Do
  not assume a long run is resumable — establish it in task 34, or design the waves so a lost run
  costs one wave, not the corpus.
- **There are 0 `ERROR` rows today.** Any error during this task is new behaviour, not a pre-existing
  backlog being re-surfaced.

## Work

| # | Item | Status |
|---|---|---|
| 1 | **Promote in waves by case, smallest first** (A → B → C → D → E). A systemic failure then surfaces on 30 documents, not 402. | ☐ |
| 2 | **Re-run `corpus_status` after each wave** and record per-case coverage. This is the progress metric, and it is now a one-call measurement. | ☐ |
| 3 | **Re-run the [task 20](./20-measure-chunk-overlap.md) overlap measurement on newly-ingested documents only** — document-then-index ordering, never page order. This is what proves [task 21](./21-chunk-overlap-defect.md)'s fix holds on the real path rather than in a unit test. Do it after wave A, before wave D. | ☐ |
| 4 | **Keep the generations distinguishable.** Task 21 item 5 records that partial reindex produces duplicate `chunk_index` values and gaps within one document. Newly-ingested documents must be identifiable — `parserVersion` is the natural marker, and today it has exactly one value (`hybrid-docparse-1`, 22 documents), so a new value cleanly separates the generations. | ☐ |
| 5 | **Stop between waves and look.** The point of waves is the pause, not the batching. Coverage rising is necessary but not sufficient — check overlap, chunk sizes, and `ERROR` causes each time. | ☐ |
| 6 | **Record wall-clock and throughput per wave**, so the D and E waves (654 documents) can be scheduled rather than guessed at. | ☐ |

## Risks

- **Running this as one 768-document job is the main failure mode.** There is no retry worth trusting
  until task 34, no demonstrated checkpoint resume, and no way to bisect a systemic fault mid-run.
- **Promoting before [task 21](./21-chunk-overlap-defect.md) rebuilds the defect at nine times the
  scale.** At a median 130-character chunk with 1.3% overlap, every promoted document is a document
  to re-parse later. Re-parsing 768 is far more expensive than waiting.
- **One unparseable document can stall the pipeline**, not just itself: the OCR-not-ready branch
  pauses all claims process-wide for 30 s with no attempt counter (`parsing-worker.ts:246-262`). Task
  34 item 4 caps it; do not start this task if that is still uncapped.
- **Coverage is the wrong sole metric.** 768 documents ingested badly would read as success on
  `corpus_status` and fail every question anyone asks of them. Item 3 is the real check.
- **This changes every denominator in the system.** Proven-absence sentences, `corpus_status` output
  and the skill's quoted figures all move. Expect the reports to date to read as stale afterwards —
  that is the intended outcome, not a documentation regression.

## Acceptance

| Check | Expected |
|---|---|
| After each wave | `corpus_status` coverage measurably higher for that case |
| Newly-ingested documents | consecutive chunks share the configured overlap (task 20 method) |
| Median chunk size on new documents | within a stated tolerance of the configured size |
| `chunk_index` per new document | contiguous; no duplicates, no gaps |
| Failures | each with a named cause; none looping unboundedly |
| Generations | separable by `parserVersion` |
| At completion | corpus coverage above 95%, with a named reason per residual document |

## References

- `src/services/parsing-worker.ts:199-213` — the real consumer; status-only predicate
- `src/services/worker-init.ts:197-204` — the filed-document auto-requeue
- [`34-ingestion-dry-run-and-retry.md`](./34-ingestion-dry-run-and-retry.md) — must land first
- [`21-chunk-overlap-defect.md`](./21-chunk-overlap-defect.md) — must land first
- [`20-measure-chunk-overlap.md`](./20-measure-chunk-overlap.md) — the measurement method to re-run
- [`36-reparse-pre-structure-documents.md`](./36-reparse-pre-structure-documents.md) — follows this
