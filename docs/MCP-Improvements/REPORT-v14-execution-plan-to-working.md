# MCP Report v14 — the execution plan to a system you can rely on

**Date:** 2026-09-08 · **Supersedes the ordering in:** v12 §6, v13 §8
**Basis:** live measurement this session, plus `docs/PLAN-haystack-mcp-agentic-etl.md` §3.3
**Purpose:** a dependency-ordered task plan an agent can execute, with acceptance criteria per item
**Status:** plan. Four task files **now written** (34–37); no code built by this report.
**Amended 2026-09-08** after a source audit — see the corrections box in §2. Three of this report's
own claims did not survive it, including a function name cited as real that does not exist.

Counts only. No case names, cause numbers, party names or document text.

---

## 1. The state in one paragraph

The **claims layer is finished**. `scan_for_pattern` verifies its rows, tolerates transcript line
numbers, folds glyphs, escalates when keyword recall cannot reach a pattern, and every absence claim
now names the denominator it was proven from. `get_chunk_context` and `corpus_status` ship. That work
is done and verified live.

The **retrieval layer is not started**, and it is where "make this work" actually lives. Two
measurements decide everything below:

| Measure | Value | Consequence |
|---|---|---|
| Documents indexed | **96 of 864 (11.1%)** | 89% of the corpus is unsearchable |
| …of those, with a `parserVersion` | **22 of 96** | only **2.5% of the corpus** has structured parsing |
| Consecutive chunk pairs sharing overlap | **1.3%** | a phrase crossing a chunk boundary is unfindable |
| Median chunk size | **130 chars** (~20 words) | boundaries are frequent, so that failure is routine |

**The system is now honest about being unable to answer. Making it able to answer is a different
project, and it is mostly not an MCP project.**

---

## 2. The blocker, stated precisely

From the ETL plan §3.3, confirmed by `corpus_status`:

- Dropping a folder creates `Document` rows with status **`DISCOVERED`**
  (`src/services/file-watcher.ts:199-215`).
- **768 documents are parked at `DISCOVERED`** and have never entered the pipeline.
- `JobQueue` is vestigial — constructed and registered (`worker-init.ts:404-407`), never started,
  never fed. `enqueue` (`job-queue.ts:110`) has **zero production callers**. The real consumer of
  `QUEUED` is `src/services/parsing-worker.ts:199-213`. **Do not build against `JobQueue`.**
- The project `CLAUDE.md` documents this as `QUEUED` and is **stale** — it has probably misled
  readers, and one of them was every plan written on top of it.

> ### Corrections after source audit (2026-09-08)
>
> This section was written from the ETL plan plus `corpus_status`. A source audit was then run against
> it, and **three of its claims did not survive.** They are corrected here rather than quietly edited,
> because two of them changed what tasks 34–35 have to build.
>
> **1. `ssPromoteDiscovered` does not exist.** Every occurrence is prose — in the ETL plan
> (`:235,360`) and in §5 of this report. It is a *proposed* tool, cited across two documents as though
> it were an existing one. Promotion today is inline in two API routes with no shared function
> (`api/cases/[id]/parse/route.ts:112-128`, `api/cases/[id]/filing-queue/route.ts:189-199`), invoked by
> filing documents through the UI. **There is no bulk promotion script and no bulk requeue script.**
>
> **2. "Nothing auto-promotes them" is true of the 768 and false in general.** A startup hook runs on
> every `getWorkerManager()` init (`worker-init.ts:197-204`) and re-queues any **filed** document not
> already in `(QUEUED, PROCESSING, INDEXED)`. The 768 escape it only because their `filingId` is NULL.
>
> **3. "A transient failure is permanent" is wrong, and the truth is worse.** There is **no attempt
> counter anywhere** — no column on `Document`, no in-memory counter. So the two populations fail
> differently, and neither is a bounded retry:
>
> | Document | Behaviour on failure |
> |---|---|
> | **Filed** | the startup hook re-queues it every restart — `QUEUED → ERROR → QUEUED`, **unbounded** |
> | **Unfiled** | `ERROR` is genuinely terminal; nothing ever retries it |
>
> `maxRetries` being declared (`parsing-worker.ts:53-54`, `:76`) and never read is confirmed. And the
> OCR-not-ready branch (`:246-262`) is worse than a loop: it requeues *and pauses all claims
> process-wide for 30 s*, so one permanently-unparseable document can stall the entire pipeline rather
> than merely failing itself.
>
> **4. One claim this report did not make, which decides task 35's size: `filingId` is NOT required to
> parse.** `parsing-worker.ts:199-213` selects on `status: 'QUEUED'` alone — no `filingId` predicate,
> no join. Bulk promotion is therefore a status update, **not 768 per-document filing decisions**. But
> the filed/unfiled choice decides which failure column above applies, so it must be made deliberately
> before the first wave (task 34 item 5).
>
> Also stale: `job-queue.ts:1-10` still advertises *"Retry logic with exponential backoff (3 attempts:
> 1s, 2s, 4s)"* on a module nothing feeds, and `CLAUDE.md` is wrong on two counts — the status, and
> `WATCH_PATHS` (the live watcher is built from `Case.path` rows, `worker-init.ts:390-394`).
> `docs/application-overview.md:35,185` has it right, so the two documents contradict each other — and
> the wrong one is the file every agent reads first. **That is how a function that does not exist came
> to be cited as real in two planning documents.**

Two things follow that change the shape of the work.

**First, "run the structure backfill" was the wrong frame.** 74 of the 96 indexed documents have no
`parserVersion` — they predate structured parsing. So `headingPath`, `blockType` and `speakers` are
not awaiting a backfill over a healthy index; three quarters of the indexed slice needs
**re-parsing**, not back-filling. Task 28 (server-side speaker attribution) derives from printed text
precisely because it does not depend on this — that remains the right call.

**Second, promotion alone is not the finish line.** Promoting 768 documents into a pipeline with no
retry, against a chunker that produces 130-character chunks with no overlap, would multiply the
existing defect by nine. **Task 21 must land before the bulk promotion, or the corpus is rebuilt
wrong at scale.**

---

## 3. Dependency order

```
              ┌─ 34 ingestion dry-run + retry ──┐
21 chunk overlap ──────────────────────────────┴─→ 35 bulk promotion ─→ 36 reparse (74 docs)
      │                                                                        │
      └─→ (re-measure with task 20 method)                                     └─→ structure fields live
                                                                                    ↓
22 rerank observability ─→ 27 grounding gate ─→ 24 completeness ─→ 37 generated-prose denominators
```

Read it as three independent tracks that must not be interleaved carelessly:

- **Track A — corpus (blocks everything about completeness).** 21 → 34 → 35 → 36.
- **Track B — retrieval quality (independent, cheap, do in parallel).** 22 → 27.
- **Track C — caller contract (independent, but 37 needs 24 first).** 24 → 37, plus 26, 29, 30, 31, 32.

Track A is the only one that changes what the system can answer. Tracks B and C change how well and
how honestly it answers what it already can.

---

## 4. Existing tasks — status and verdict

| # | Task | Status | Verdict for this plan |
|---|---|---|---|
| 16 | Phrase verification default | ✅ Done | verified live |
| 17 | Line-number tolerance | ✅ Done | verified live |
| 18 | Query-time folding | ✅ Done | verified live |
| 19 | `get_chunk_context` | ✅ Done (item 7 deferred) | verified; item 7 → task 26 |
| 20 | Measure chunk overlap | ✅ Done | promoted task 21 |
| 21 | **Chunk overlap defect** | Proposed · **P0** | **gates Track A. Do first.** |
| 22 | Rerank observability | Proposed | cheap; item 2 is a 2-call measurement |
| 23 | corpus_status + denominators | ✅ Implemented | verified live |
| 24 | Completeness object | Proposed | do after 22; 37 depends on it |
| 25 | rlmNotes live trace | Proposed | XS; do opportunistically |
| 26 | Batched chunk context | Proposed — diagnosed, not verified | build batched form **first** |
| 27 | Sub-query grounding gate | Proposed — diagnosed, not verified | biggest wall-clock win |
| 28 | Server-side speaker attribution | Proposed — diagnosed, not verified | independent of Track A |
| 29 | Progress notifications | Proposed — diagnosed, not verified | premise corrected; re-scope first |
| 30 | MCP parity + fleet visibility | Proposed | read-only half is safe and useful |
| 31 | Result-size economy | Proposed | premise corrected (cap is client-side) |
| 32 | Draft semantics | Proposed | I hit this independently; real |
| 33 | Full-scan denominator gap | ✅ Implemented | verified live, all four paths |

**Nothing in 22–32 is verified against the code except where marked.** Four of v12's premises were
wrong; assume a similar rate survives in the specs written from it. Every task below carries a
"confirm before building" step for that reason.

---

## 4a. Three measurements the plan did not have

Taken from the live database, 2026-09-08, alongside the audit above.

| Measure | Value | Why it changes something |
|---|---|---|
| `ERROR` rows / non-null `errorMessage` | **0 / 0** | the failure path has **never fired in production**. Task 34 is its first real exercise — expect to discover behaviour, not confirm it |
| Non-null `ingestCheckpoint` | **0 of 864** | resume-from-checkpoint has never been exercised. Do not assume a 768-document run is resumable |
| Distinct `parserVersion` values | **1** (`hybrid-docparse-1`, 22 docs) | one parser generation, so a new value cleanly separates old from new after task 35 |

And the wave order for task 35 falls straight out of the per-case backlog — smallest first:

| Case | `DISCOVERED` | `INDEXED` | Coverage |
|---|---|---|---|
| A | 30 | 24 | 44.4% |
| B | 39 | 15 | 27.8% |
| C | 45 | 19 | 29.7% |
| D | 252 | 6 | 2.3% |
| E | 402 | 32 | 7.4% |

**The two largest cases hold 654 of the 768.** Waves A–C total 114 documents and exercise every path
the big two will hit, at 15% of the volume.

## 5. Four tasks that do not exist yet

> **Now written:** [34](../tasks/34-ingestion-dry-run-and-retry.md),
> [35](../tasks/35-bulk-promotion.md), [36](../tasks/36-reparse-pre-structure-documents.md),
> [37](../tasks/37-generated-prose-denominators.md) — each carrying the audit corrections above. The
> summaries below are the original plan; the task files supersede them where they differ.

### Task 34 — Ingestion dry-run and retry (`P0`, effort S, **blocks 35**)

The pipeline has no retry and 768 documents about to enter it. Prove the path on a small batch first.

| # | Item |
|---|---|
| 1 | Promote **one** `DISCOVERED` document — via the existing route path, since `ssPromoteDiscovered` does not exist — and trace it to `INDEXED`, recording every state and the wall-clock. |
| 2 | Promote a batch of ~20 spanning different filing types. Record failures by cause, not just count. |
| 3 | Implement `ssRequeueErrored` with **its own attempt cap** — the ETL plan flags an unbounded OCR loop as the hazard here. Uncapped retry on a document that always fails is worse than no retry. |
| 4 | Make `maxRetries` actually read in `parsing-worker.ts`, or delete the field. A declared-and-ignored setting is a lie in the config. |
| 5 | Fix `CLAUDE.md`'s `QUEUED`/`DISCOVERED` error. It is stale documentation that has already misled planning. |

**Acceptance:** 20 documents promoted; every failure has a named cause; a deliberately-failing
document stops retrying at the cap; `CLAUDE.md` matches the code.
**Fails if:** the batch is promoted before task 21 lands — you would be chunking 20 documents wrong.

### Task 35 — Bulk promotion of the 768 (`P0`, effort M, **needs 21 + 34**)

| # | Item |
|---|---|
| 1 | Promote in waves by case, smallest case first, so a systemic failure is caught on tens rather than hundreds. |
| 2 | Re-run `corpus_status` after each wave and record coverage per case. This is the progress metric. |
| 3 | Re-run the task 20 overlap measurement on newly-ingested documents **only**, to confirm task 21's fix holds on the real path and not just in a unit test. |
| 4 | Keep the old generation identifiable — task 21 item 5 already records that partial reindex produces duplicate indices and gaps. Do not mix generations silently. |

**Acceptance:** coverage rises measurably per wave; newly-ingested documents show the configured
overlap; no new duplicate-index documents.
**Fails if:** run as one 768-document job. There is no retry worth trusting yet and no way to bisect.

### Task 36 — Re-parse the 74 pre-structure documents (`P1`, effort M, **needs 35**)

74 of 96 indexed documents have no `parserVersion`. Structure fields are projected on scan and
semantic rows already, so this is the step that makes them non-null.

| # | Item |
|---|---|
| 1 | Identify the 74 by absent `parserVersion`; confirm the count against `corpus_status` before acting. |
| 2 | Re-parse them through the current parser. Renumber chunk indices for the whole document — do not append a fresh counter beside surviving rows (task 21 item 5). |
| 3 | Verify `headingPath` / `blockType` / `speakers` populate on a sample, and that citations still resolve. |
| 4 | Decide explicitly whether the pre-existing 22 need re-parsing too, or are already current. |

**Acceptance:** structure fields non-null on re-parsed documents; no citation regressions; chunk
indices contiguous per document.

### Task 37 — Denominators in generated prose (`P1`, effort M, **needs 24**)

The unaudited surface. `research_evidence` emits `gaps`, and `run-report.ts` emits report prose —
both **LLM-authored at runtime**. A model writing *"no evidence found for section X"* is an
undenominated corpus-absence claim by construction, and it is the sentence most likely to be pasted
into something that matters. Every technique that found the other defects greps static strings and
cannot see this one.

| # | Item |
|---|---|
| 1 | Inject the resolved denominator (from `corpus-denominator.ts`) into the generation context for both surfaces. |
| 2 | **Add a post-generation check** — the model can ignore context; it cannot ignore a validator. Flag output asserting absence without a denominator near it. |
| 3 | Decide the failure mode: block, annotate, or return with a warning. Annotating is probably right — refusing to emit a report because one sentence over-claims is worse than the over-claim. |
| 4 | Extend the existing banned-phrase test to the generated surface, so "the absence is proven" cannot reappear via a model. |

**Acceptance:** a report whose section found nothing says so with a denominator; the validator catches
a synthetic over-claiming string.
**Do not rely on (1) alone.** Context is a suggestion; the check is the guarantee.

---

## 6. Execution waves

**Wave 1 — measurement, no code (hours).** Task 22 item 2 (`rerankPoolSize` 5 vs 150). Task 21 item 1
(trace `LegalTextSplitter` → `TextChunker`, confirm or kill the hypothesis in writing). Task 34 item 1
(promote one document, trace it). All three are cheap, and each decides how a later task is built.

**Wave 2 — the corpus (days).** Task 21 fix → task 34 → task 35 by wave → task 36. This is the only
track that raises 11.1%.

**Wave 3 — retrieval quality, in parallel with 2.** Task 22 items 1/3/4, then task 27. Task 27 alone
recovers ~50 s of a ~140 s deep job.

**Wave 4 — caller contract.** Task 24, then 37. Then 26, 29 (re-scoped), 30 read-only half, 25, 32.

Waves 3 and 4 do not touch ingestion and can run concurrently with wave 2 by a different agent.

---

## 7. What "working" means — the definition of done

Not a feeling; four checkable statements.

1. **`corpus_status` reports coverage above 95%**, and the residual has a named reason per document.
2. **A phrase spanning a chunk boundary is findable** — the task 20 measurement re-run shows overlap
   at the configured size on newly-ingested documents.
3. **A negative finding is defensible**: `scan_for_pattern` returns a proven absence whose denominator
   is the whole corpus, not 11% of it.
4. **A generated report that says "no evidence" says over what** — task 37's validator passes.

Until (1) and (2), the honest use of this system is: **find and cite, never prove absence.** That is
a genuinely useful tool for drafting; it is not one you can rest a filing's negative assertion on.

---

## 8. Things not to do

- **Do not promote the 768 before task 21.** Nine times the documents through a chunker that produces
  130-character chunks with no overlap rebuilds the defect at scale, and re-parsing is expensive.
- **Do not build against `JobQueue`.** It is vestigial; `parsing-worker.ts` is the real consumer.
- **Do not raise `overlapSize` as a first move.** If the overlap branch never executes, a larger
  number changes nothing and looks like a fix that failed (task 21's own warning).
- **Do not treat tasks 26–32 as verified.** They were written from v12, and four of v12's premises
  were wrong. Confirm each against the code before building — that step found the last four defects.
- **Do not add a relevance floor to `query_case_knowledge` without reporting what it dropped.** A
  score threshold is a new undeclared denominator; filtering silently recreates the exact defect this
  series has spent eleven reports removing.

---

## 9. The judgement

Every report from v8 onward found the same failure: **the system described what it intended to do
more precisely than it verified what it did.** That defect is now largely fixed at the claims layer —
warnings carry denominators, rows are verified, and a banned phrase has a test enforcing its absence.

The corpus numbers are the same defect at the largest possible scale, and they were invisible until
`corpus_status` existed to state them. A search tool over 11% of a corpus, reporting exhaustively over
that 11%, is technically correct and practically useless for the one question litigation actually
asks. Tasks 34–36 are unglamorous pipeline work and they are worth more than everything in 22–32
combined.

The right order is: **make it able to answer, then make it fast, then make it pleasant.** The claims
work had to come first only because without it nobody could see which of those three was missing.

**And this report caught the same defect in itself.** It asserted `ssPromoteDiscovered` as an existing
function, that nothing auto-promotes, and that a failure is permanent. A source audit refuted all
three — the function is prose, a startup hook re-queues every *filed* document, and filed failures
loop **unboundedly** rather than sticking. The false name had already propagated from the ETL plan
into this report unchallenged, because `CLAUDE.md` — the file every agent reads first — describes a
status flow the code abandoned, while `docs/application-overview.md` describes the real one.

That is the failure at the documentation layer rather than the code layer: **a description precise
enough to be quoted, and never verified against the thing it describes.** The audit that caught it
cost minutes. Fixing `CLAUDE.md` is task 34 item 8, and it is worth more than its size suggests —
it is the input to every plan written after it.
