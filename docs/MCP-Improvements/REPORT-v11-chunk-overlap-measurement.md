# MCP Report v11 — chunk overlap, measured properly

**Date:** 2026-09-08 · **Task:** [`../tasks/20-measure-chunk-overlap.md`](../tasks/20-measure-chunk-overlap.md)
**Method:** read-only query over the live index, ordered by `document_id` then `chunk_index`.
**Status:** measurement complete. **Promotes to P0** — see [`../tasks/21-chunk-overlap-defect.md`](../tasks/21-chunk-overlap-defect.md).

Counts, fractions and character lengths only. No chunk text, document names, or page numbers.

---

## 1. Why this was worth measuring

Report v10 §4 sampled 120 chunks and found a shared boundary window in only 22% of page-adjacent
pairs — then correctly hedged it, because the test used **page order as a proxy for chunk order**.
That hedge was right to be there, and the proper measurement makes the picture worse rather than
better.

## 2. What the measurement says

Ordered correctly, over all 35,890 chunks in 104 documents (35,786 consecutive pairs):

| Measure | Value |
|---|---|
| Consecutive pairs with **zero** overlap | **35,113 of 35,786 — 98.1%** |
| Overlap chars, median across all pairs | **0** |
| Overlap chars, median across the 1.9% that do overlap | 66 |
| Chunk length, median | 216 chars |
| Chunk length, 25th percentile | 78 chars |
| Chunks under 200 chars | **17,326 of 35,890 — 48%** |
| Configured | 512-token chunks, 50-token overlap (≈2,000 and ≈200 chars) |

So chunks are roughly **an order of magnitude shorter than configured**, and the configured overlap
is essentially absent.

## 3. It is not explained by block chunking

The obvious innocent explanation is that structured, block-based chunks do not overlap by design.
**That explanation does not survive the data.** Splitting the corpus by whether a document uses block
chunking at all:

| Population | Documents | Chunks | Median chunk length | Mean zero-overlap fraction |
|---|---|---|---|---|
| Block-chunked | 18 | 9,017 | 471 chars | **99.8%** |
| Plain-chunked | 86 | 26,873 | 286 chars | **95.5%** |

The plain-chunked population is the one configured with a 50-token overlap, it is the larger of the
two, and **95.5% of its consecutive pairs share nothing at the boundary.** Block chunking is not the
cause.

## 4. Why it matters

A phrase spanning a chunk boundary cannot be matched, for the same reason a phrase spanning a
printed line number cannot (v10 §1). With a median chunk of 216 characters — roughly 35 words —
**boundaries are frequent**, so this is not an edge case.

It compounds three things already on the list:

- **It makes v10 §1 worse.** A transcript phrase now has two ways to be unfindable: a line number
  inside it, or a chunk edge through it.
- **It makes a proven absence weaker than it reads.** An exhaustive scan proves the phrase is in no
  single chunk. After v9 the tool says "the absence is proven", and for a multi-chunk phrase that
  wording is true of the index and false of the corpus.
- **It raises the value of chunk context** ([task 19](../tasks/19-chunk-context-tool.md)) from
  convenience to mitigation.

## 4a. Re-measured stream-aware — the finding survives, and sharpens

A confound turned up after the first pass, found while verifying a parallel agent's work: **exhibit
chunks restart `chunk_index` at 0** and are concatenated into the same document, so ordering by index
alone interleaves two streams. My first measurement was therefore partly comparing unrelated
neighbours.

Re-measured with the streams separated:

| Population | Documents | Pairs | Zero-overlap | Median chunk |
|---|---|---|---|---|
| All chunks (first pass, confounded) | 104 | 35,786 | 98.1% | 216 chars |
| Body only, exhibits excluded | 104 | 28,678 | **99.0%** | 190 chars |
| **Body, non-block — the population the setting governs** | 89 | 21,513 | **98.7%** | **130 chars** |

**The confound was not the cause.** On the exact population that `overlapSize: 50` applies to, 98.7%
of consecutive pairs share nothing, and the median chunk is about 20 words against a configured
~2,000 characters.

## 5. A second finding, unlooked for

**`chunk_index` is not unique within a document**, which is worse than the gaps it also has.

| Measure | Keys | Rows | Documents |
|---|---|---|---|
| Duplicate `(document_id, chunk_index)` | 623 | **8,681** | 44 |
| Still duplicated after separating the exhibit stream | 172 | 1,122 | **4** |

Independently verified. Most of it is the exhibit stream restarting at 0 — benign once streams are
separated, and the reason the first overlap pass was confounded. **The residual 172 across 4
documents is not benign**: those documents were partially reindexed, leaving two generations of
chunks sharing indices.

### ⚠️ Correcting my own figure

My earlier "23% non-contiguous" number was **wrong, or at least badly framed**. It counted pairs
whose index difference is not exactly 1, which lumps duplicates in with gaps. Separated, and
independently re-verified:

| Measure over 35,786 pairs | Hits | Share |
|---|---|---|
| **Real gaps** (difference > 1) | **68** | **0.2%** |
| Gaps plus duplicates (difference ≠ 1) | 8,126 | 22.7% |

**All 68 real gaps sit in a single document** of 104, with a maximum gap of 164. So this is not a
corpus-wide adjacency problem. It is one damaged document.

### The mechanism, found and confirmed

`src/app/api/documents/[id]/reindex-pages/route.ts` re-chunks only the target pages through a fresh
`chunkPages()` call **whose counter restarts at zero**, deletes the old rows by page, and inserts the
new ones numbered from 0 upward. That produces gaps and duplicates in the same document — exactly the
distribution measured, and the same document carries both.

Normal ingestion is clean: nothing in any chunker drops a chunk after its index is assigned, and 98
of 99 documents with body chunks are perfectly contiguous. **Partial reindex is the only source.**

**Consequence for adjacency.** A neighbour cannot be computed as index ± 1. It must be the adjacent
*row* within the same stream, and a caller assembling text across chunks needs to be told when the
indices are not actually adjacent. Task 19 implements exactly that.

## 6. A hypothesis, offered as a hypothesis

`LegalTextSplitter` wraps `TextChunker` on the production path. `TextChunker` emits overlap only when
it *flushes a chunk at the size limit* — the carried-over tail is built at that boundary. If the
splitter hands it units already smaller than the 512-token limit, every unit becomes one chunk and
the overlap branch never executes.

That would explain both observations at once: chunks far below the configured size, and overlap
near zero. **It is untested.** Task 21 starts by confirming or killing it, because the fix differs
sharply depending on the answer.

## 7. What was not measured

- Whether the gaps in `chunk_index` correspond to real missing text.
- Whether short chunks cluster in particular producers (OCR, structured, RR).
- Overlap measured in *tokens* rather than characters, which is the unit the config uses.
