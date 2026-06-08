# ColPali/ColQwen3 layout-aware visual retrieval

**Status:** Proposed · **Effort:** L · **Priority:** Medium

Derived from [`../rag-hybrid-retrieval-and-rlm-analysis.md`](../rag-hybrid-retrieval-and-rlm-analysis.md)
§7 ("Late interaction (ColPali / ColQwen3) — a better *recall layer*, would feed RLM") and §8 idea #2.

## Problem / opportunity

Our pipeline is **text-first**: PDFs become extracted text → chunks → single-vector embeddings.
For scanned, exhibit-heavy legal PDFs this loses exactly the evidence that matters in court:
file-stamps and clerk date-stamps, signature blocks, hand-marked exhibit labels, table structure
(damages schedules, billing records), and seals. OCR recovers *some* of this as noisy text, but
layout and spatial relationships are gone before retrieval ever sees them — a query like "find the
file-stamped page where Exhibit C is signed" is structurally hard for text-only retrieval.

ColPali / ColQwen3 embed **page images directly** as a grid of per-patch vectors and score with
**late-interaction MaxSim**, so layout, stamps, and tables are first-class. The analysis doc is
explicit that this is a *recall layer that feeds the reranker*, not a competitor to RLM.

## What we already have

- **Page-image rendering and exhibit extraction already exist** in the ingestion path:
  `src/lib/ingestion/ingestion-pipeline.ts` imports `ExhibitExtractor`/`detectExhibitBoundaries`
  (`:17`), `preprocessImage`/`batchPreprocessImages` (`:18`), and Poppler page-image listing
  (`listPdfImages`/`filterWorthyImages`, `:20`). The pipeline's documented step 4 is "Apply OCR to
  low-density pages and exhibits" (`ingestion-pipeline.ts:104`). So we *already rasterize pages and
  isolate exhibit images* — the raw material ColPali needs is produced today.
- **OCR + image preprocessing infra:** `CachedOCREngine`/`ocrWorkerPool` (`ingestion-pipeline.ts:114`/
  `:115`), `image-preprocessor.ts`, tesseract.js (mocked in tests per `jest.setup.js`).
- **A reranker stage that already accepts a heterogeneous candidate pool:** `rerank()` in
  `src/lib/search/reranker.ts`, called from `deep-search.ts:690`. A visual retriever can contribute
  candidates that get re-scored alongside text candidates.
- **Extracted exhibit images on disk** at `public/exhibits/` (per CLAUDE.md), addressable by the
  graph (`Exhibit` model in `prisma/schema.prisma`).

## The hard part — name it up front

ColPali/ColQwen3 are **multi-vector** models: each page is many patch vectors scored by MaxSim. Our
vector store today is **single-vector L2**: `VectorStore.vectorSearch()` and `hybridSearch()` in
`src/lib/vector/vector-store.ts` (RRF reranker created at `:461`) assume one embedding per chunk.
**This is not a drop-in index change** — late interaction needs either (a) a separate multi-vector
store / MaxSim scorer, or (b) a "shortlist-then-MaxSim-rerank" architecture that keeps the existing
single-vector store for first-stage recall and applies MaxSim only over a small candidate set. That
storage gap is why this is **L effort**.

## Proposed approach

Adopt the **shortlist-then-visual-rerank** shape (option b) — lowest-risk, reuses everything:

1. Keep today's text hybrid search as first-stage recall (cheap, broad).
2. For document types flagged as visual/scanned/exhibit-heavy, also index **page-image patch
   embeddings** (ColQwen3) in a *separate* multi-vector store keyed by `(documentId, pageNumber)`.
3. At query time, embed the query with the same visual model and run **MaxSim** over the page-image
   patches of the shortlisted documents, producing visual candidates.
4. Merge visual candidates into the pool that flows into the existing `rerank()` stage
   (`deep-search.ts:690`), so the final ordering still goes through Qwen3-Reranker-8B.

This treats ColPali as a **recall booster for visual pages**, exactly the analysis doc's framing,
without forcing a rewrite of the L2 single-vector store that serves the text path.

## Implementation steps

1. **Spike the model + serving.** Run ColQwen3 via the existing vLLM-style sidecar fleet (the same
   infra that serves the reranker — see `reranker-lifecycle.ts`). Confirm a `/embed`-style
   multi-vector endpoint and VRAM budget.
2. **Multi-vector store.** Add `src/lib/vector/visual-store.ts` — a separate store (LanceDB
   multi-vector if available in our version, else a purpose-built MaxSim index) keyed by
   `(documentId, pageNumber)`. Do **not** retrofit `vector-store.ts`'s single-vector schema.
3. **Ingestion hook.** In `ingestion-pipeline.ts`, after page rasterization (the Poppler path,
   `:20`) and for exhibit images (`ExhibitExtractor`, `:17`), gate on a "visual document" predicate
   (scanned / low text-density / has exhibits) and compute + persist patch embeddings. Reuse
   `image-preprocessor.ts` for normalization.
4. **Query path.** Add `visualSearch(queryEmbedding, candidateDocIds)` returning page-level visual
   candidates with a normalized score; call it for visual-flagged scope and merge into the
   `deep-search.ts` pool before `rerank()`.
5. **Citations.** Visual hits cite `(documentId, pageNumber)` and the exhibit label from the
   `Exhibit`/graph (reuse `haystack/refs.ts` labels), so the UI can render the page image.
6. **Config + cost gating.** Off by default; enable per-case or per-document-type. Embedding visual
   pages is expensive — only index flagged documents.

## Risks / open questions

- **Storage gap is real.** MaxSim multi-vector is fundamentally different from our L2 store; the
  shortlist-then-MaxSim design contains the blast radius but still adds a second store to operate.
- **Index cost / size.** Patch embeddings per page are large. Restrict to visual/scanned documents;
  measure footprint on a representative case before committing.
- **Which scanned-document signal?** Reuse the existing OCR low-text-density detection
  (`ocrThreshold`, `ingestion-pipeline.ts:86`) as the "visual document" gate.
- **Does it actually beat OCR+text for our corpus?** Many filings are born-digital (good text);
  the win is concentrated in scanned exhibits. Validate before broad rollout.
- **vLLM fleet contention** with the reranker (one GPU op at a time — `reranker.ts:43`). Sequence or
  separate the workers.

## How to measure success

- **Recall on visual queries:** eval set of stamp/signature/table/exhibit-label questions; measure
  recall@K text-only vs. text+visual.
- **Page-localization accuracy:** for "which page is X stamped on", % returning the correct
  `(documentId, pageNumber)`.
- **Cost envelope:** added index size and per-page embedding latency stay within budget on a
  reference scanned case.
- **No text-path regression:** born-digital query quality unchanged (visual path is additive).

## References

- ColPali (arXiv 2407.01449): https://arxiv.org/pdf/2407.01449
- Late-interaction overview (Weaviate): https://weaviate.io/blog/late-interaction-overview
- Analysis doc §7 (late interaction row), §8 #2.
- Internal: `src/lib/ingestion/ingestion-pipeline.ts`, `src/lib/vector/vector-store.ts`,
  `src/lib/search/reranker.ts`.
