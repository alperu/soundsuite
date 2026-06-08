# Retrieval & RLM — Engineering Task Proposals

**Status:** Proposed · **Last updated:** 2026-06-08

These are concrete, code-grounded engineering proposals derived from the verdict and the
"ideas to evaluate later" list in [`../rag-hybrid-retrieval-and-rlm-analysis.md`](../rag-hybrid-retrieval-and-rlm-analysis.md).
That document is an *analysis* (nothing changes because of it); these files translate its §8
forward-looking ideas into actionable tasks that cite real files and symbols in this repo.

Each task is a single self-contained markdown file with: Problem/opportunity · What we already have
(file:line) · Proposed approach · Implementation steps · Risks/open questions · How to measure
success · References. Nothing here is implemented — these are proposals for review.

| # | Title | Effort | Priority | One-line summary |
|---|-------|--------|----------|------------------|
| [01](./01-adaptive-rag-router.md) | Adaptive-RAG complexity router | M | High | Auto-pick no-retrieval / single-shot hybrid / deep-search / RLM per query, so simple lookups skip RLM's cost+latency (today `useRlm`/`deepSearchMode` are manual UI toggles). |
| [02](./02-graph-aware-retrieval-haystack.md) | Graph-aware retrieval over the existing Haystack/Xeto graph | M | High | Reuse our authoritative legal knowledge graph + `prisma-traverse` for multi-hop *retrieval/expansion* (connections between parties/motions/filings), not just `case_id` filtering. NOT Microsoft GraphRAG — no entity extraction. |
| [03](./03-colpali-visual-retrieval.md) | ColPali/ColQwen3 layout-aware visual retrieval | L | Medium | Late-interaction (multi-vector MaxSim) retrieval over exhibit/scanned page-images, where text-only chunking loses stamps/tables/signatures. Feeds the existing `rerank()` stage. |
| [04](./04-learned-fusion-weighting.md) | Learned / query-dependent fusion weighting | M | Medium | Replace the fixed RRF `k=60` and the arbitrary `SOFT_BOOST = 1.2` with tunable / query-dependent / learned weighting. Closes the one real gap vs. the blog's ideal. |
| [05](./05-reranker-resilience-and-chunk-overlap.md) | Reranker resilience + chunk-overlap tuning | S | Medium | Two small, well-scoped hardening items: a graceful first-stage-order path for the 90s reranker timeout on a degraded fleet, and revisiting the 50-token chunk overlap for legal boilerplate. |

## On "are we already doing GraphRAG?"

The answer is **no, not in the Microsoft-GraphRAG sense** — but we already have most of the
substrate. See [task 02](./02-graph-aware-retrieval-haystack.md) for the full framing. Short version:
our `src/lib/haystack/` is **Project Haystack / Xeto** (a typed tagging ontology), and the graph it
backs is *authoritative* (built from parsed filings at ingestion, not LLM-extracted). Today that
graph is used at query time only to compute **filters** (`case_id IN (...)`), not for multi-hop
retrieval or community summarization.
