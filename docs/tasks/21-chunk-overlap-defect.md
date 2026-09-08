# Chunk overlap is absent, and chunks are far smaller than configured

**Status:** Proposed · **Effort:** M · **Priority:** P0 · **Created:** 2026-09-08
**Report:** [`../MCP-Improvements/REPORT-v11-chunk-overlap-measurement.md`](../MCP-Improvements/REPORT-v11-chunk-overlap-measurement.md)
**Promoted from:** [`20-measure-chunk-overlap.md`](./20-measure-chunk-overlap.md) item 6

Counts only in this file and in any report it produces. No chunk text.

## Problem

Measured over all 35,890 chunks, ordered by document then chunk index:

| Measure | Configured | Observed |
|---|---|---|
| Chunk size | 512 tokens (≈2,000 chars) | **median 130 chars** |
| Overlap | 50 tokens (≈200 chars) | **median 0; 98.7% of pairs share nothing** |

Measured on the **body, non-block** population — 89 documents, 21,513 pairs — which is exactly the
population the overlap setting governs. Two innocent explanations were tested and neither holds:
block chunking does not explain it (this population excludes block chunks), and neither does the
exhibit-stream interleaving that confounded the first pass (this population excludes exhibits).

**Consequence.** A phrase spanning a chunk boundary is unmatchable. With a median chunk of about 20
words, boundaries are frequent, so this is a routine failure rather than an edge case. It also
weakens every proven-absence claim: an exhaustive scan proves a phrase is in no single chunk, which
after v9 is reported as "the absence is proven".

## First: confirm or kill the hypothesis

`LegalTextSplitter` wraps `TextChunker` in production. `TextChunker` emits overlap only when it
flushes a chunk **at the size limit**; the carried tail is built at that boundary. If the splitter
hands it units already below 512 tokens, every unit becomes one chunk and the overlap branch never
runs — explaining both the small chunks and the missing overlap.

**This is untested, and the fix differs sharply depending on the answer.** Do not write code before
resolving it.

| # | Item | Status |
|---|---|---|
| 1 | Trace the production chunking path from `worker-init.ts` through `LegalTextSplitter` into `TextChunker`. Determine what unit sizes the splitter emits and whether the overlap branch is ever reached. | ☐ |
| 2 | Add a unit test that chunks a synthetic multi-page document and **asserts consecutive chunks share the configured overlap**. This is the regression guard that should have existed. | ☐ |
| 3 | If the hypothesis holds: decide whether overlap belongs in the splitter, or whether the splitter should stop pre-fragmenting. State the reasoning — the two give different chunk shapes and different retrieval behaviour. | ☐ |
| 4 | If it does not hold: find the real cause before changing anything. | ☐ |

## Then

| # | Item | Status |
|---|---|---|
| 5 | **Fix partial reindex, which is the confirmed cause.** `reindex-pages` re-chunks target pages with a fresh `chunkPages()` counter that restarts at 0, then inserts alongside surviving rows — producing duplicate indices and gaps in the same document. It must continue the document's existing numbering, or renumber the whole document. Then decide whether the stale generation now in the index is still being served, and clean the affected documents. | ☐ |
| 6 | Re-measure after any change, using the task 20 method — document-then-index ordering, never page order. | ☐ |
| 7 | Decide the reindex question explicitly. Fixing the chunker does not fix existing chunks; 35,890 of them carry the old shape. | ☐ |

## Risks

- **A reindex is expensive and is not obviously worth it yet.** 768 documents were never ingested at
  all (see the ETL plan §3.3), so a reindex of the 96 that were may not be where the value is. Decide
  item 7 against that backdrop rather than in isolation.
- **Larger chunks change retrieval behaviour**, not just matching. Embedding quality, reranking and
  the evidence budget all assume the current shape. Measure recall before and after on a fixed query
  set, or a "fix" could quietly degrade search.
- **Restoring overlap will duplicate text in `get_chunk_context`.** That tool returns adjacent
  chunks verbatim, and at today's 98.7% zero-overlap that is moot. Once overlap works, a caller
  concatenating a window gets the shared span twice at every boundary. De-duplication belongs in the
  same change that restores overlap, not as a later fix.
- **Do not raise `overlapSize` as a first move.** If the overlap branch never executes, a larger
  number changes nothing and will look like a fix that failed.

## Interim mitigation, available now

[Task 19](./19-chunk-context-tool.md) (`get_chunk_context`) **shipped 2026-09-08**. It does not fix
matching, but it makes a boundary-spanning phrase findable by a caller who suspects one, with no
reindex. It handles the duplicate-index problem by taking the adjacent *row* within the target's own
stream rather than index ± 1, and flags the window when indices are not truly adjacent — so item 5
is no longer a blocker for it, only for trusting the 4 partially-reindexed documents.

## Acceptance

| Check | Expected |
|---|---|
| The hypothesis | confirmed or killed in writing, with the trace that settles it |
| A synthetic multi-page document, freshly chunked | consecutive chunks share the configured overlap |
| Median chunk size after the fix | within a stated tolerance of the configured size |
| Re-measurement | zero-overlap fraction reported, using the task 20 method |
| `chunk_index` gaps | explained, or raised as their own defect |
| Retrieval quality | measured before and after on a fixed query set |
