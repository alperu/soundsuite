# Chunk overlap is absent, and chunks are far smaller than configured

**Status:** Proposed · **Effort:** M · **Priority:** P0 · **Created:** 2026-09-08
**Report:** [`../MCP-Improvements/REPORT-v11-chunk-overlap-measurement.md`](../MCP-Improvements/REPORT-v11-chunk-overlap-measurement.md)
**Promoted from:** [`20-measure-chunk-overlap.md`](./20-measure-chunk-overlap.md) item 6

Counts only in this file and in any report it produces. No chunk text.

## ✅ Verification 2026-09-09 — measurements reproduce; **the named hypothesis is aimed at the wrong module**

Re-measured read-only against the live chunk store, ordered by document then `chunk_index` (task 20
method).

**Every figure below is a dated measurement, not a fact — re-derive before relying on it.** All of
them come from query **Q1**; the duplicate-index figure comes from **Q2**. Both are read-only.

> **Q1 — chunk shape and overlap.** Open `data/lancedb` → table `chunks`; select
> `document_id, chunk_index, text, is_exhibit, block_type` for `countRows()` rows. Partition into
> `ALL`, `NON_EXHIBIT` (`is_exhibit` false) and `BODY_NON_BLOCK` (`is_exhibit` false **and**
> `block_type` empty/`text`/`body`). Within each partition group by `document_id`, sort by
> `chunk_index`, and for each consecutive pair compute the longest suffix-of-previous that is a
> prefix-of-next. Report pair count, zero-overlap fraction, window median/p90, and the `text.length`
> distribution. **Emit window *lengths* only — a window is document text.**
>
> **Q2 — duplicate `chunk_index`.** Same table; group by the stream key
> (`document_id` + `is_exhibit` + `exhibit_path`), count rows per `chunk_index`, and report streams
> and documents where any index occurs more than once.

**CONFIRMED** — all figures measured **2026-09-09**

| Claim | Evidence |
|---|---|
| The body-non-block population is 89 documents / 21,513 pairs *(Q1, 2026-09-09)* | reproduces the Problem table below exactly |
| **98.7% of body-non-block pairs share nothing**; median window 0, p90 window 0 *(Q1, 2026-09-09)* | the number that decides whether a P0 exists — task 20 item 3 |
| **Median body-non-block chunk ≈130 chars** *(Q1, 2026-09-09)* against a configured ≈2,000 | configured values at `src/lib/ingestion/langchain-text-chunker.ts:105-107` (`chunkSize ?? 512`, `overlapSize ?? 50`, `charsPerToken ?? 4`). **See "unsatisfiable by construction" in REFUTED item 2(b) — this measurement is the evidence for it.** |
| Neither block chunking nor exhibit interleaving explains it *(Q1, 2026-09-09)* | the zero-overlap fraction stays in the high nineties across ALL, NON_EXHIBIT and BODY_NON_BLOCK alike |
| Item 5: partial reindex produces duplicate `chunk_index` — **4 documents** *(Q2, 2026-09-09)* | `src/app/api/documents/[id]/reindex-pages/route.ts:412` calls `chunkPages(...)` on a fresh chunker (`:148`) whose counter restarts at 0; `:452` `deleteByPages` removes only the target pages. The measured count matches the comment at `src/lib/mcp/tools/get-chunk-context.ts:142-144`. |

**REFUTED**

1. **"`LegalTextSplitter` wraps `TextChunker` in production."** It does not run in the ingestion path
   at all. Production instantiates `new StructuredChunker(new LangChainTextChunker())` —
   `src/services/worker-init.ts:47`, and the same pair at
   `src/app/api/documents/[id]/reindex-pages/route.ts:148` and
   `src/app/api/admin/structure-backfill/route.ts:151`. `LegalTextSplitter` does wrap `TextChunker`
   (`src/lib/ingestion/legal-text-splitter.ts:196`), but its only callers are chat ingest
   (`src/lib/chat/chat-ingest.ts:69`, `src/lib/chat/chat-image-ingest.ts:100`). **The corpus never
   went through the module item 1 asks you to trace.**

2. **The unreached overlap branch is not the mechanism.** Two separate mechanisms are visible in
   source, and they explain the two symptoms separately — do not merge them.

   **(a) Missing overlap — the per-page loop.** `LangChainTextChunker.chunkPages`
   (`src/lib/ingestion/langchain-text-chunker.ts:216-247`) calls `splitTextWithContext(page.text)`
   **inside a per-page loop** (`:228`). `RecursiveCharacterTextSplitter` is constructed with a real
   `chunkOverlap` (`:112-118`), so overlap *is* configured and *does* apply — but only *within* one
   page's split. It can never carry a tail across a page boundary.

   **(b) The 130-character median — `HARD_MAX_CHUNK_CHARS`, and it contradicts the configured size.**
   `HARD_MAX_CHUNK_CHARS = 1000` (`:52`). Every chunk over that cap is re-split by a second
   `fallbackSplitter` (`:124-127`) whose separator chain is
   `['\n', '. ', '? ', '! ', '; ', ', ', ' ', '']` — **newline first**. On transcript text, where a
   newline ends every printed line, that fragments to roughly line granularity.

   **The measurement and the mechanism agree, and that is what makes this conclusive.** The
   configured `chunkSize` of 512 tokens is ≈2,048 characters, but `HARD_MAX_CHUNK_CHARS` is 1,000, so
   **no chunk can ever exceed 1,000** — every chunk must sit well below the configured size, and a
   newline-first re-split of transcript text (where a printed line runs tens of characters) predicts
   fragments an order of magnitude below it. The measured **median body-non-block chunk of ≈130
   chars** *(Q1, 2026-09-09)* is exactly that shape. Neither the code reading nor the measurement
   would settle this alone; together they do.

   So the "configured vs observed" row in the Problem table compares against a number the code cannot
   produce. **The configured value is not merely ignored — it is unsatisfiable by any input.** A
   setting no document can honour should fail loudly at startup rather than silently emit fragments;
   add that check in the same change that resolves item 3.

   **`StructuredChunker` is not the fragmenting site.** It delegates unstructured pages straight to
   the inner chunker (`src/lib/ingestion/structured-chunker.ts:94`, `:98`) and tags the chunks it
   builds itself with a `blockType` (`:191` paragraph, `:219` table, `:277` figure). The large
   majority of rows carry an **empty** `block_type` *(Q1, 2026-09-09 — group the `chunks` table by
   `block_type` and count)*, i.e. they came through the delegated LangChain path, not through block
   decomposition. That is consistent with (b) and rules out structural chunking as the cause.

   All of this is **readable in source without a runtime trace**, which is what item 1 was reserving
   effort for.

3. **Task 20's "23% of consecutive pairs are non-contiguous" is a cross-stream artefact, not a
   defect.** Over all rows it reproduces (~23%); **within the body stream** it is **27 of 21,513
   pairs (0.1%)** *(both Q1, 2026-09-09 — count consecutive pairs where `chunk_index` does not
   increase by exactly 1, per partition)*. The 23% is page-chunk and exhibit-chunk streams interleaving under
   one `document_id`, which `get_chunk_context` already separates via `inStream`
   (`src/lib/mcp/tools/get-chunk-context.ts:298-302`). **It does not block task 19**, and the
   acceptance row "`chunk_index` gaps explained" is answered here.

4. **"35,890 of them carry the old shape"** — as of **2026-09-09** the store held that many rows over
   **104 distinct documents** *(Q1 — `tbl.countRows()` and the distinct `document_id` count)*, while
   SQLite reported a smaller INDEXED count over a larger total *(`select status, count(*) from
   Document group by status;`)*. Both move with every ingest; **re-run both queries rather than
   quoting these** — the gap between the two is itself the finding, not either number.

**Revised disposition — keep P0, rewrite items 1 and 3.** The defect is real and reproduces at full
strength. Item 1 must trace `StructuredChunker` → `LangChainTextChunker.chunkPages`, not
`LegalTextSplitter` — and it is largely answered above, so re-scope it to confirming (a) and (b) with
a unit test rather than an investigation. Item 3's question ("overlap in the splitter, or stop
pre-fragmenting") becomes two sharper ones: **should `chunkPages` split per page at all**, given that
a page boundary is not a semantic boundary; and **what is `HARD_MAX_CHUNK_CHARS` for**, given that it
sits below the configured chunk size and silently overrides it. Item 5 stands, scoped to 4 documents.

**On the figures in the rest of this file.** The Problem table, item 7 and the Risks section below
quote the same measurements as bare numbers, from the 2026-09-08 pass. They are **reproduced** by
Q1/Q2 above as of 2026-09-09 — so they are correct, not stale — but they carry no date and no query.
Treat Q1/Q2 as their provenance, and re-derive rather than quote them onward.
Drop the `chunk_index`-gaps acceptance row.

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
