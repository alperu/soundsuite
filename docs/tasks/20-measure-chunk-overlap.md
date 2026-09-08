# Measure chunk overlap properly

**Status:** ✅ Done 2026-09-08 — **it promoted a P0** · **Effort:** XS · **Priority:** P1 · **Created:** 2026-09-08
**Result:** [`../MCP-Improvements/REPORT-v11-chunk-overlap-measurement.md`](../MCP-Improvements/REPORT-v11-chunk-overlap-measurement.md) → [`21-chunk-overlap-defect.md`](./21-chunk-overlap-defect.md)
**Report:** [`../MCP-Improvements/REPORT-v10-search-quality-gaps.md`](../MCP-Improvements/REPORT-v10-search-quality-gaps.md) §4

No case data. Report counts and character statistics only — never chunk text.

## Problem

Sampling 120 chunks, only **23 of 106** page-adjacent pairs (22%) showed a shared window at the
boundary. Chunk sizes ran 60 / 1,488 / 2,120 characters (min / median / max).

**The report was right to hedge this.** The adjacency test used *page order* as a proxy for *chunk
order*, which is imprecise, so 22% may be an artefact of the measurement rather than a property of
the index.

It matters because the two outcomes are far apart:

- **If overlap is genuinely partial**, a phrase spanning a chunk boundary is unfindable for the same
  reason as task 17 at the line level — and that is a P0 sitting undiscovered.
- **If overlap is fine**, the concern is closed for the cost of one query.

The 60-character minimum is a second, independent signal: a chunk that small cannot carry context,
and it is worth knowing how many of those exist and where they come from.

## The measurement

| # | Item | Status |
|---|---|---|
| 1 | ✅ Order chunks by `document_id`, then `chunk_index` — **not** by page. Page order was the flaw in the first pass. | ✅ |
| 2 | ✅ For each consecutive pair within a document, compute the longest common suffix/prefix window. Report the distribution, not just a mean. | ✅ |
| 3 | ✅ Report the fraction of pairs with **zero** overlap, which is the number that decides whether a P0 exists. | ✅ |
| 4 | ✅ Report the chunk-length distribution and count chunks under, say, 200 characters, with their producing path if it is recoverable. | ✅ |
| 5 | ✅ Compare against the configured overlap setting. The chunker has a documented target; a large gap between configured and observed is itself the finding. | ✅ |
| 6 | ✅ Write the result into a short report. If zero-overlap pairs are common, open a P0 task for it. | ✅ |

## How to run it

A read-only query against the chunk store. **No writes, no reindex, no service restart.** It can run
against the live index safely, which is why it should happen before any of the larger items.

## Privacy

Report **counts, fractions and character lengths only.** No chunk text, no document names, no page
numbers tied to content. An overlap window is document text and must not appear in the output or in
the committed report.

## Acceptance

| Check | Expected |
|---|---|
| Ordering | by document then chunk index, verified against the schema |
| Output | distribution of overlap sizes, and the zero-overlap fraction |
| Short-chunk count | reported with a threshold stated |
| Configured vs observed overlap | both stated, gap called out |
| The report | contains no document text |

## Outcome

98.1% of consecutive pairs share nothing at the boundary — far worse than the 22% the sampled pass
suggested, and **not** explained by block chunking (the plain-chunked population is 95.5%). Chunks
are also about an order of magnitude shorter than configured. Promoted to
[task 21](./21-chunk-overlap-defect.md).

A second finding fell out: 23% of consecutive pairs are non-contiguous in `chunk_index`. That is
unexplained and blocks [task 19](./19-chunk-context-tool.md), which assumes adjacency.
