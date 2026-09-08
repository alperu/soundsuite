# MCP Report v12 — what I would change on the MCP surface to get complete answers fast

**Date:** 2026-09-08 · **Author's position:** a heavy MCP caller, not the implementer
**Basis:** measurements taken across this session — timings, call traces and failure modes are live, not estimated
**Status:** proposal. No code changed.

No case data. Counts, timings and synthetic patterns only.

---

## 1. The frame: single calls are fast, and every real question is a workflow

Individual tools are in good shape. An exhaustive regex scan of all 35,890 chunks returns in about
1.8 s. `query_case_knowledge` answers in ~6 s. Those are not the problem.

The problem is that **no interesting question is one call.** A real one I ran today — *find where a
named person said they could not do something, and prove nobody else said it* — cost roughly:

| Step | Calls | Why |
|---|---|---|
| Try the phrase several ways | 9 scans | each phrasing needs its own exhaustive pass |
| Establish who was speaking | 3 scans | witness index, swearing-in markers, label splitting |
| Dedupe the corpus's own copies | 0 | client-side, but only because I knew to |
| Widen a hit that opened mid-turn | 1 + 3 internal | `get_chunk_context` fires 3 probe queries per call |
| Poll a background job | 1 per poll | each poll is a whole tool call |

That is fifteen-plus round trips and several minutes of wall clock for one question whose answer was
a single sentence on one page. **Almost none of that time was retrieval.** It was the caller
re-deriving, in JavaScript, things the server already knows.

So the improvements below are not "make the index faster". They are: stop making the caller pay a
round trip for something the server could have said the first time.

---

## 2. First, the two things that make "complete" undefinable

Speed is worthless if the answer is silently partial. Two open items decide whether any completeness
claim means anything, and both outrank everything in §3.

### 2a. Nobody can say what fraction of the corpus is searchable — including from MCP

Five cases report **864 documents**. Task 21 records that **768 were never ingested**, citing the
ETL plan. If that holds, roughly nine in ten documents are not in the index.

**I could not confirm it from the MCP surface, and that is the finding.** There is no tool, and no
readable endpoint, that answers *"how many documents are indexed versus present?"* I tried; sampling
by scan is useless because results come back in table order, so a broad scan returns thousands of
chunks from a handful of documents.

This matters more than anything else in this report. After v9, a scan reports an absence as
**proven**. That word is true of the index and says nothing about the corpus. An operator who reads
"the absence is proven" while 89% of documents are unindexed is being misled by a technically correct
statement — the worst failure shape there is, and the same one v8→v11 kept finding at smaller scale.

**What I would do:**

1. `corpus_status()` — an MCP tool returning documents total / ingested / chunked / failed, per case
   and overall, plus the last ingest timestamp. Read-only, no LLM, trivially cheap.
2. **Make every proven-absence claim name its denominator.** *"Proven absent across 35,890 chunks
   spanning 96 of 864 documents"* is honest. *"The absence is proven"* is not, while that ratio holds.
3. Until (1) exists, treat every negative finding in this system as provisional. I would rather the
   tool say "I cannot tell you what I did not search" than assert proof over an unknown fraction.

### 2b. Chunk overlap is absent, so a proven absence is only ever per-chunk

Measured in task 20/21: median chunk ~130 characters, **98.7% of consecutive pairs share nothing**. A
phrase spanning a chunk boundary is in no single chunk, so an exhaustive scan reports it absent — and
now reports that absence as proven.

At ~20 words per chunk, boundaries are frequent. This is a routine failure, not an edge case, and it
is the same defect shape as the line-number bug fixed in task 17, one level up.

`get_chunk_context` makes it *diagnosable* but not *findable*: you must already suspect a boundary.
The real fix is task 21. Until it lands, the MCP surface should say so — see §4a.

---

## 3. Speed: collapse round trips, do not shave milliseconds

### 3a. Batch the context lookup — the single biggest win

`get_chunk_context` takes one `chunkId` and fires three probe queries. Padding twenty scan hits means
twenty calls and sixty probe queries. That is why the `context` parameter on `scan_for_pattern` was
deferred, and the deferral was correct: a naive per-hit loop is the wrong algorithm.

**What I would build instead:** `get_chunk_context({ chunkIds: [...] })`, batched by document. Hits
from one scan cluster heavily in a few documents, so one grouped query per document plus one boundary
probe per document replaces N × 4. Then `context` on `scan_for_pattern` becomes a thin caller of the
batched form rather than a loop.

Build the batched function *first*. If the single-target one ships alone and gets called in a loop
later, the wrong shape is baked in.

### 3b. Stream what is already sequenced

`GET /api/mcp/research/{id}/events` already emits sequenced NDJSON progress events, and
`research_status` already exposes `cursor` and `newEvidenceCount` for incremental pulls. None of it
reaches MCP: a `deep-rlm` call returns a `jobId` and the caller then sits blind for 140 s, spending a
tool call per poll.

Map the NDJSON to MCP `notifications/progress` under the caller's `_meta.progressToken`, using `seq`
for resumption. Keep polling as the fallback for clients that ignore notifications. The streaming
source, the sequencing and the cursor all exist — this is a translation layer.

**But be honest about what it buys.** Streaming makes 140 s *legible*, not shorter. In my run, 49.7 s
went to retrieving sub-queries the decomposer invented (§3d). Fixing that removes more wall clock
than streaming ever will.

### 3c. Let one call carry a whole page of work

Two smaller round-trip taxes worth removing:

- **The 60 KB result ceiling** pushes callers to small `limit`s, which causes more pages, which costs
  more calls. A `fields` parameter — return `citationShort`, `page`, `match` and drop `text` — would
  let a caller pull 200 rows in one call when they only need to count and locate.
- **Pagination costs a call per page.** For a full scan that is already exhaustive server-side,
  returning a compact summary (`totalMatches`, plus the first N rows) would answer "how many and
  where" in one call instead of five.

### 3d. Do not spend retrieval on invented questions

In the `deep-rlm` run, five of six generated sub-queries were off-corpus — an entire invented subject
area — and retrieval spent **49.7 s** on them. The RLM then ran its own rounds against the same wrong
frames, inheriting the error rather than catching it.

Run each candidate sub-query through a shallow retrieval before committing to deep retrieval, and
drop the ones that return nothing above a floor. On that run it would have discarded five of six in
about a second. **Cheap grounding first, expensive recursion second** — today the order is reversed.

---

## 4. Correctness: make one call self-describing

This is where I would spend the most effort, because it is what stops a caller inventing its own
half-correct logic.

### 4a. A machine-readable completeness object, instead of warning prose

Today I determine whether an answer is exhaustive by **string-matching English warning text** —
looking for "capped", or for the phrase "the absence is proven, not merely unreached". That is
brittle, it silently breaks when wording is improved, and every caller reimplements it.

Replace it with a field:

```jsonc
"completeness": {
  "exhaustive": true,
  "method": "full-scan" | "uncapped-fts",
  "scanned": 35890,
  "corpusChunks": 35890,
  "documentsSearched": 96,
  "documentsTotal": 864,        // ← §2a; the denominator that makes "proven" honest
  "truncated": false,
  "caveats": ["chunk-boundary-spanning phrases not detectable"]   // ← §2b, until task 21 lands
}
```

Keep the human warnings — they are good and they are what an operator reads. But give callers
something to branch on that is not a sentence.

### 4b. Derive the speaker server-side

Attribution is currently a caller-side ritual: scan for a printed label, split chunks on label
boundaries, walk backwards to the nearest `Q`/`A` marker, then scan the volume's witness index to
turn an `A` into a name. I wrote that by hand today. It works, and it is documented in the skill —
but every caller who needs it will rewrite it, slightly differently, and some will get it wrong.

The labels are in the text and the witness index is in the document. **This should be a field, not a
recipe.** Derive `speaker` (and `speakerBasis`: `colloquy-label` | `witness-index` | `unknown`) on
transcript chunks and project it on scan and semantic rows.

That is the highest-value correctness change in this report, because it converts a five-call method
that a caller can get subtly wrong into one field computed once, correctly. The pending structure
backfill would populate `speakers` properly, but derivation from printed text works today without it.

### 4c. Make the expensive stages prove they ran

`modelsUsed` names four models. For the reranker I cannot confirm it did anything: there is no
`rerank` entry in `stats.phases`, and `rerankScore` is identical to `score` on every row. The timing
fits reranking inside `fuse` (150 candidates × ~60 ms ≈ 9 s against `fuse` 8,100 ms), but that is
inference and I will not present it as fact.

Two changes settle it permanently: **add `rerank` to `stats.phases`**, and **keep `retrievalScore`
alongside `rerankScore`** so a caller can see how far the cross-encoder moved each item. Right now the
most expensive component in the stack is the only one whose contribution is invisible.

Related, and worth deciding explicitly: the phase data reads `fuse` → `rlm` → `outline`. If rerank
lives inside `fuse`, then evidence the RLM gathers afterwards is never reranked at all. I am not
asserting that is what happens — key order is not execution order — but it is the first thing I would
check, because it decides whether multipass makes results better or just noisier.

### 4d. Keep the reasoning trace

`rlmNotes` is populated on `research_status` while a job runs and comes back **empty** on
`research_result`. The audit trail disappears exactly when someone would want to review it. Carry it
onto the final result.

### 4e. Reconcile the two meanings of "draft"

A single response can carry a citation reading `Draft: Motion` next to `containsDraft: false`. Both
are internally correct — one derives from filing detection, the other from `recordStatus` — but an
operator gets contradictory signals from one payload. Either reconcile them or have the response state
that they measure different things.

---

## 5. Parity items that block whole workflows

From the `/search` comparison: `searchMode` and `recordStatus` exist on `query_case_knowledge` but not
on `research_evidence`; `multiPass` is absent from MCP entirely; and `search_workflows` can find a
workflow but nothing can apply one. The first is an asymmetry with no evident reason; the second means
multipass retrieval — the thing a reranker is most useful for — cannot be requested from MCP at all.

Separately, **the fleet has no MCP surface**. Writing this report required reading
`/api/admin/gpu-fleet` in a browser pane because no tool exposes it. `fleet_status()` and
`role_assignments_list()` are read-only and safe; `role_assign()` mutates machine state and belongs
behind the same profile discipline the cloud-provider boundary already gets.

---

## 6. What I would do, in order

| # | Change | Why it is here | Cost |
|---|---|---|---|
| 1 | `corpus_status()`, and name the denominator in every completeness claim | every "proven" answer is currently unbounded (§2a) | S |
| 2 | Confirm whether rerank is in the path (`rerankPoolSize` 5 vs 150) | one unknown blocks judging the whole stack | minutes |
| 3 | `completeness` object alongside the warnings | stops callers regex-matching English (§4a) | S |
| 4 | Carry `rlmNotes` onto `research_result` | trace vanishes on completion (§4d) | XS |
| 5 | Batched `get_chunk_context({ chunkIds })`, then `context` on scan | the biggest round-trip win (§3a) | M |
| 6 | Ground sub-queries with shallow retrieval before deep retrieval | ~50 s of a 140 s job (§3d) | S |
| 7 | `rerank` in `stats.phases`; `retrievalScore` beside `rerankScore` | makes the priciest stage visible (§4c) | S |
| 8 | Server-side `speaker` + `speakerBasis` on transcript rows | turns a fallible ritual into a field (§4b) | M |
| 9 | NDJSON → `notifications/progress` with `seq` resumption | removes the 140 s blind wait (§3b) | M |
| 10 | `fleet_status` / `role_assignments_list` (read-only) | no fleet visibility from MCP (§5) | S |
| 11 | Task 21 — chunk overlap | the correctness floor under every negative (§2b) | L |

Items 1–4 are small, independent, and three of them are measurement or plumbing rather than
algorithm. They are also the ones that stop the system asserting more than it knows, which is why they
lead.

---

## 7. The judgement underneath all of it

Every defect this series has found has the same shape: **the system describes what it intended to do
more precisely than it verifies what it did.** Recall bookkeeping improved faster than matching (v10).
`modelsUsed` names a reranker whose contribution cannot be measured (v11). And a scan now proves an
absence across an index whose coverage of the corpus nobody can state (§2a).

Speed follows from the same discipline rather than competing with it. The round trips in §3 exist
because the caller does not trust — or cannot see — what one call already established, so it asks
again in a different way. A call that reports its own completeness, its own speaker attribution and
its own denominators is both faster and safer, because the second call never has to happen.

If only one thing gets built from this report, build `corpus_status()` and make "proven" carry its
denominator. Everything else is optimisation; that one is the difference between a search tool and a
tool that can be relied on in a filing.
