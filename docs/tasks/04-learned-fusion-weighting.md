# Learned / query-dependent fusion weighting

**Status:** Proposed · **Effort:** M · **Priority:** Medium

Derived from [`../rag-hybrid-retrieval-and-rlm-analysis.md`](../rag-hybrid-retrieval-and-rlm-analysis.md)
§8 idea #4: "Our one real gap vs. the blog's ideal: **fixed RRF k and an arbitrary 1.2 soft-boost** —
no learned/query-dependent fusion weighting yet."

## Problem / opportunity

Our hybrid fusion uses **two hardcoded constants** that are applied identically to every query:

1. **RRF `k = 60`** — fixed for all queries. RRF with a single global `k` weights vector and BM25
   contributions equally and statically. But the *right* balance is query-dependent: an exact
   cause-number or party-name query should lean on BM25; a conceptual "trust dispute" query should
   lean on vectors. A single global `k` can't express that.
2. **`SOFT_BOOST = 1.2`** — a magic multiplier with no tuning basis. It's a reasonable default but
   was never fit to data.

This is the only place the system falls short of the blog's "production ideal," and it's a contained,
measurable fix.

## What we already have

- **Fixed RRF k=60** — `this.rrfReranker = await rerankers.RRFReranker.create(60)` in
  `src/lib/vector/vector-store.ts:461` (created once, cached at `:460`, used in `hybridSearch()` at
  `:434` via `.rerank(this.rrfReranker)` `:467`). The manual fallback `legacyHybridSearch()`
  (`:524`) reproduces the same `1/(k+rank+1)` with the same `k=60`.
- **The arbitrary 1.2 soft-boost** — `const SOFT_BOOST = 1.2` in
  `src/lib/mcp/tools/query-case-knowledge.ts:367`, applied to results whose metadata matches
  caller-supplied `softBoostRefs` (`:366`). Documented as "~1.2" at `query-case-knowledge.ts:36`.
  It's driven by deep-search's framing-segment path — `softBoostRefs` is plumbed from
  `src/lib/search/deep-search.ts:299` (and the chip-derived ref values gathered around
  `deep-search.ts:339`–`:360`).
- **A separate transcript-intent boost and a per-doc cap** in the same function
  (`query-case-knowledge.ts:343` and the `perDocCap` at `:391`) — more hand-tuned constants in the
  same fusion stage, worth folding into the same tuning effort.
- **A reranker downstream** (`reranker.ts`) that already re-scores, so fusion weighting only needs to
  get the *right candidates into the rerank pool* — it doesn't have to be the final word.

## Proposed approach

Three tiers, smallest first; ship tier 1, evaluate before tier 3:

1. **Make the constants configurable + query-typed (cheap).** Replace the literals with values that
   vary by query class from the router (see [task 01](./01-adaptive-rag-router.md)): exact-token
   queries get a smaller RRF `k` (sharper rank discrimination, BM25-leaning); conceptual queries
   keep ~60. Expose `k` and `SOFT_BOOST` via `Config` so they're tunable without a deploy.
2. **Query-dependent fusion weighting (medium).** Move from a single `k` to **weighted RRF** —
   `Σ wᵣ/(k + rankᵣ(d))` — where `w_vector` / `w_bm25` are set per query class (or by a cheap signal
   like "fraction of query tokens that are rare/identifier-like"). This requires computing RRF
   manually rather than via the cached `RRFReranker`; `legacyHybridSearch()` (`vector-store.ts:524`)
   already implements the manual `1/(k+rank+1)` loop and is the natural home for weights.
3. **Learned weights (larger, optional).** Once tier 1/2 telemetry + a labeled relevance set exist,
   fit `w_vector`, `w_bm25`, `k`, and `SOFT_BOOST` (e.g. a small logistic/linear model over query
   features) to maximize ranking quality. Keep it offline-trained and shipped as static coefficients
   — no per-query model call, preserving latency and privacy.

## Implementation steps

1. **Externalize constants.** Replace `RRFReranker.create(60)` (`vector-store.ts:461`) and
   `SOFT_BOOST = 1.2` (`query-case-knowledge.ts:367`) with values read from `Config` (defaulting to
   today's 60 / 1.2 so behavior is unchanged until tuned).
2. **Weighted RRF path.** Generalize `legacyHybridSearch()` (`vector-store.ts:524`) to accept
   `{ kVector, kBm25 | wVector, wBm25 }`; route weighted queries through it. Decide whether to keep
   the native `RRFReranker` fast path for the default (unweighted) case.
3. **Plumb query class through.** Thread the router's query classification (task 01) into
   `hybridSearch`/`query_case_knowledge` so weights are chosen per query.
4. **Offline tuning harness** `src/lib/search/__tests__/fusion-tuning.ts` (or a script) that replays
   a labeled query→relevant-docs set and grid-searches `k`/weights/boost, reporting nDCG/recall@K.
   Use it to pick tier-1 defaults before any learned model.
5. **Telemetry.** Log per-query the chosen weights and whether the top reranked result came from the
   vector or BM25 side, to build the dataset tier 3 needs.

## Risks / open questions

- **Don't over-fit a tiny corpus.** Single-user legal corpora are small; a learned model risks
  fitting noise. Tier 1/2 (typed constants + weighted RRF) likely capture most of the gain — treat
  tier 3 as optional and validate hard.
- **The reranker may already absorb fusion error.** Qwen3-Reranker-8B re-scores the pool, so fusion
  weighting only matters insofar as it changes *which candidates reach rerank*. Measure end-to-end
  (post-rerank) quality, not just first-stage fusion order.
- **Losing the native RRFReranker fast path.** Manual weighted RRF is a second I/O/merge path; keep
  the native path for the unweighted default to avoid regressing the common case.
- **Where does query-class signal come from before task 01 lands?** A standalone cheap heuristic
  (identifier-token ratio) can drive weights independently if the router isn't built yet.

## How to measure success

- **Ranking quality:** nDCG@10 / recall@K on a labeled legal query set, weighted vs. fixed `k=60`,
  measured *after* rerank.
- **Exact-match queries:** cause-number / party-name queries surface the canonical document at
  rank 1 more often.
- **Tunability:** operators can adjust `k`/boost via `Config` and see measurable, monotone effects
  in the offline harness.
- **No latency regression** from the manual weighted-RRF path on the default case.

## References

- RRF / k≈60 and the production fusion stack — analysis doc §3, §4, §8 #4.
- InfoQ hybrid-retrieval article: https://www.infoq.com/articles/vector-search-hybrid-retrieval-rag/
- Internal: `src/lib/vector/vector-store.ts`, `src/lib/mcp/tools/query-case-knowledge.ts`,
  `src/lib/search/deep-search.ts`, `src/lib/search/reranker.ts`.
