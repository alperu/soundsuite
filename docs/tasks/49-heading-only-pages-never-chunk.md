# Heading-only pages can never be indexed, and Fix Partial lies about why

**Status:** Open — root cause identified, not yet fixed · **Effort:** M · **Priority:** **P1** — the repair burns its retry budget and reports a false reason
**Created:** 2026-09-15
**Root cause:** `src/lib/ingestion/structured-chunker.ts` · **Misreporting:** `src/lib/ingestion/repair-tracking.ts:92`
**Related:** [task 48](./48-discovered-pdfs-pollute-case-list.md)

Documents referred to by shape only — no names, cause numbers or file names.

## Symptom

Fix Partial reports pages it can never repair, with a reason that is not true.

A ~101-page motion: 101 pages, 98 indexed, 0 blank by design, **3 missing**. The
panel offered "These have extracted text but produced no chunks — re-embedding
is likely to fix them." Three repair attempts produced:

> Attempted 3 · repaired 0 · still failing 3 · given up on 0
> Page 42 · 1 attempt — Re-embedded successfully but the page still did not appear in the index

A second, ~15-page notice showed the same thing on one page, having already
exhausted its three attempts and been given up on.

## Root cause

`StructuredChunker.chunkStructuredPage()` emits chunks **only** from paragraph
blocks. Heading blocks are deliberately not emitted as body — the structural
dedup stated in the module docstring:

> dedup is structural: heading blocks set context and are not re-emitted as
> body, so a chunk never contains its own heading twice

`flushParas()` returns immediately when `paraBuf` is empty. So **a page whose
blocks are all headings produces zero chunks**, and a page with zero chunks is
by definition unindexed. It is not a transient failure; it is structurally
unreachable, and no number of retries changes it.

The three failing pages in the motion are exactly that shape: two are
single-line exhibit separators (~80 characters, e.g. an "EXHIBIT A — <date>
<instrument title>" divider) and one is a dotted index/table-of-contents page.

Confirmed from the repair run's own log:

```
[PdfBlockExtractor]  Extracted structured blocks { pages: 3, blocks: 9, tables: 0 }
[StructuredChunker]  Structured chunking complete { structuredPages: 3, delegatedPages: 0, chunks: 0 }
[reindex-pages]      Chunking: 3 non-empty pages → 0 page chunks, 0 exhibit chunks
[reindex-pages]      Generating embeddings for 0 chunks (batch size 50)
```

Nine blocks in, zero chunks out, zero embeddings generated.

### Why it is not the dimension mismatch

That was the first hypothesis and the evidence rules it out. `/api/vectors/stats`
reports `vectorDimensions: 1024` against a configured `qwen3-embedding:4b` with
`virtualInference.mode.embedding = cloud-only`, which is a genuine and separate
problem — but it is not this one. The repair never reached the embedding call:
`Generating embeddings for 0 chunks`. No dimension error appears anywhere in the
log for these pages.

The page-level gates are also not the cause. Two of the three pages pass
`figureTextEmbeddable` comfortably (81 chars at 69.1% alpha, 79 at 67.1%, versus
a ≥40-char and ≥0.55-alpha gate), and all three are above the OCR density
threshold, so OCR is correctly skipped:

| page | chars | alpha | figure gate | indexed |
|---|---|---|---|---|
| 41 | 2871 | 69.5% | pass | yes |
| **42** | 414 | 34.3% | fail | **no** |
| 43 | 117 | 70.9% | pass | yes |
| **58** | 81 | 69.1% | pass | **no** |
| **75** | 79 | 67.1% | pass | **no** |

Page 42 fails the figure gate as well, but 58 and 75 do not — so the figure gate
cannot be the shared explanation. The empty-`paraBuf` path is.

## The misreporting, which is the more damaging half

`classifyRepairFailure()` has no branch for "the chunker produced nothing". Its
`unknown` fallback is returned instead:

```ts
return {
  code: 'unknown',
  reason: 'Re-embedded successfully but the page still did not appear in the index',
};
```

Nothing was re-embedded. The sentence asserts that the expensive part succeeded
and something downstream lost the result, which sends the reader to LanceDB, to
the vector width, to `addChunks` — the exact wrong places. It cost this
investigation most of its time.

Three consequences:

1. The panel advertises "re-embedding is likely to fix them" for a class where
   re-embedding provably cannot.
2. `MAX_REPAIR_ATTEMPTS = 3` is spent on a deterministic non-repair, after which
   the page is "given up on" and the operator is told to fix OCR quality or
   embedding width — neither of which is the problem.
3. It is indistinguishable from the real silent-insert-drop case, so if that bug
   ever occurs it will be misread as this one.

## Fix

**1. Emit a chunk for a heading-only page.** A page carrying a real exhibit
divider is meaningful retrieval content — arguably *high* value, since it is
what a search for "Exhibit A" should land on. When `paraBuf` is empty and a
heading exists, emit the heading as its own chunk (`blockType: 'heading'`) so
the page is reachable. The dedup rationale does not apply: there is no body for
it to be duplicated against.

**2. Classify the real cause.** Add a `no-chunks-produced` reason code, set when
the chunker returns zero chunks for a page that had text. It must be treated as
`isImmediatelyTerminal` — like `dimension-mismatch`, retrying cannot help — so
the attempt budget is not burned. Wording should say what actually happened:
the page's text produced no chunk, not that it was re-embedded.

**3. Do not offer a repair that cannot work.** `partition­EligiblePages` should
exclude this class from "N pages can be re-indexed", or the panel should label
them distinctly, so the operator is not invited to run a repair with a known
outcome.

## Also observed (same panel, separate defect)

On the 15-page document the same page was listed under **both** "Given up on (no
further attempts will be made)" **and** "Still failing (will be retried, up to 3
attempts)" in one result. Those are contradictory; a page at the attempt cap
belongs in exactly one. Likely the result view builds the two lists from
different predicates and does not subtract the terminal set from the retriable
one.

## Acceptance

- A page whose blocks are all headings produces at least one chunk and indexes.
- The two documents above reach 101/101 and 15/15 with no pages given up on.
- A page that genuinely produces no chunk is reported as such, terminally, on
  the first attempt rather than the third.
- No page appears in both the "given up on" and "will be retried" lists.
