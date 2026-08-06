# Hybrid Retrieval & RLM — How Sound Suite's RAG Compares to Industry Practice (2026)

**Status:** Analysis · **Last updated:** 2026-06-08 · **Scope:** retrieval architecture, not a change spec

This document answers a question raised after reading InfoQ's
[*"Why Vector Search Alone Isn't Enough: Hybrid Retrieval for RAG"*](https://www.infoq.com/articles/vector-search-hybrid-retrieval-rag/)
(Aaditya Chauhan, 2 Jun 2026):

> Do we already implement what this blog describes, or do we have something better with RLM?
> And what competes with RLM as of mid-2026?

It is an **analysis** — nothing in the running system changes because of this file.

---

## 1. TL;DR

1. **We already implement everything the blog recommends.** The blog's "production retrieval
   stack" is: chunk → run **BM25 + dense vector** in parallel → fuse with **Reciprocal Rank
   Fusion (RRF, k≈60)** → optional **cross-encoder rerank** → top-K to the LLM. Sound Suite does
   exactly this, with the **same RRF constant (k=60)** and a **larger cross-encoder** than the
   blog's example.
2. **We go beyond the blog** with structured metadata pre-filters (the `{{ }}` chips),
   legal-aware chunking, and multi-pass query decomposition.
3. **RLM is not the same kind of thing as the blog.** The blog is about the **retrieval
   substrate** (how to find the right pages). **RLM is an agentic reasoning layer that sits on
   top of** that substrate (how to decide what to look up, in rounds, before answering). They are
   complementary — RLM *uses* hybrid retrieval; it does not replace it.

### The blog's recommended stack vs. ours

| Layer | Blog recommends | Sound Suite today |
|------|-----------------|-------------------|
| Chunking | Split at sensible boundaries | **Legal-aware** splitter (sections/paragraphs/sentences, 512-token, transcript line numbers) |
| Dense vector | kNN over embeddings | LanceDB vector search (L2), pluggable embedding providers |
| Sparse / lexical | **BM25** (IDF + TF-saturation + length-norm) | LanceDB native **FTS/BM25** inverted index + boolean parser |
| Fusion | **RRF, k≈60** | LanceDB `RRFReranker.create(60)` — **same k** — single I/O pass |
| Rerank | Optional cross-encoder on 20–50 candidates (`ms-marco-MiniLM-L-6-v2`) | **Qwen3-Reranker-8B** cross-encoder via vLLM (much larger model) |
| Pre-filters | (not covered) | **`{{ }}` chips** → hard SQL `WHERE` + Prisma-traverse refs + soft-boost |
| Multi-step reasoning | (not covered) | **Deep-search** decomposition **+ RLM** agentic loop |

**Verdict:** we are at or above the blog's bar on every layer it discusses, and we have two
layers above it that the blog doesn't cover.

---

## 2. Plain-language primer (skip if you know RAG)

Before answering, the AI runs to a "library" and pulls the most relevant pages, then answers
using them. That pattern is **RAG** (Retrieval-Augmented Generation). The library lookup blends:

- **Vector search** — find pages by *meaning*. Great for "documents about the trust dispute,"
  poor at exact tokens like a cause number `03-25-00333-CV` or a person's name.
- **Keyword search (BM25)** — find pages by *exact words*. The mirror image: great at the cause
  number, blind to meaning.
- **Hybrid + RRF** — run both and merge their ranked lists with a fair "voting" rule (RRF).
  Pages both methods rank highly float to the top; RRF needs no score calibration.
- **Reranker** — a slow, careful "expert" that re-reads the top ~20–50 candidates as
  *query+document pairs* and re-orders them. More accurate than the first-stage scores.

**RLM** is a different idea: instead of one lookup, a small "junior researcher" model searches,
notices what's missing, searches again (a few rounds), gathers evidence, then hands it to the
"senior" model (Claude) to write the final answer.

---

## 3. What the InfoQ blog argues

Faithful summary of the article (all points from the piece):

- **Embeddings are approximation engines.** They excel at semantic similarity but are
  *systematically weak* at distinguishing specific entities — version numbers, error codes,
  feature-flag names. Most real queries are **hybrid** (need both meaning *and* exact match),
  which is where single-method retrieval fails (e.g., *"rollback runbook for v3.2 deployment"*).
- **BM25 supplies the precision embeddings lack**, via three mechanisms: **IDF** (rare
  distinguishing tokens weighted high), **TF saturation** (repeated terms have diminishing
  returns), and **length normalization** (long chunks don't unfairly outrank short ones).
- **RRF fuses the two lists by rank, not score**: `RRF_score(d) = Σ 1/(k + rank_r(d))`, with
  **k ≈ 60**. It sidesteps the impossible problem of normalizing bounded cosine scores against
  unbounded BM25 scores, and it *rewards consensus* (docs both retrievers like win).
- **The production stack is layered**: BM25 + vector in parallel → RRF → *optionally* a
  **cross-encoder rerank** on a small candidate set (20–50) → top-K to the LLM. The blog notes
  cross-encoders process the full query–document pair jointly, so they beat bi-encoders on
  relevance. It cites Perplexity (on Vespa) and Glean as converging on this same pattern.

Notably, the blog is entirely about the **retrieval substrate**. It does **not** discuss agentic
/ iterative / recursive retrieval — that's a different layer, which is where RLM lives.

---

## 4. What Sound Suite implements today (mapped to code)

> Line numbers verified against the tree on 2026-06-08; treat as close anchors, not contracts.

- **Dense vector search** — `src/lib/vector/vector-store.ts` `vectorSearch()` (line ~361),
  LanceDB with L2 distance; embeddings via `src/lib/ingestion/embedding-provider.ts` (OpenAI /
  Claude / Transformers implementations). Query embedded once and reused across sub-queries.
- **Sparse / BM25** — LanceDB **native FTS** (inverted index, stemming + stopwords):
  `vector-store.ts` `ftsSearch()` (line ~399). Boolean query support:
  `src/lib/search/boolean-query.ts` (precedence-climbing parser for AND/OR/NOT/phrases) →
  `src/lib/search/boolean-to-fts.ts`. Graceful `legacyTextSearch()` LIKE fallback (line ~488)
  when no FTS index is present.
- **Hybrid fusion (RRF)** — `vector-store.ts` `hybridSearch()` (line ~434) runs vector + FTS and
  fuses them with **`rerankers.RRFReranker.create(60)`** (line ~461) in a single LanceDB query;
  manual `legacyHybridSearch()` (line ~524) reproduces `1/(k+rank+1)` with **k=60**. This is the
  **exact constant the blog cites.**
- **Cross-encoder reranking** — `src/lib/search/reranker.ts` calls a vLLM **`/v1/rerank`**
  endpoint with **Qwen3-Reranker-8B** (header comment lines 2–3). Hardened for production:
  per-GPU serialization so one rerank runs at a time (lines ~43–48), preflight/warmup checks,
  token budgeting; lifecycle in `reranker-lifecycle.ts` / `reranker-watchdog.ts`. The blog lists
  this stage as *optional* and uses a tiny `ms-marco-MiniLM-L-6-v2`; we run a far larger model.
- **Chunking** — legal-aware `src/lib/ingestion/legal-text-splitter.ts` + `text-chunker.ts`:
  ~512-token chunks split on legal structure (ORDER / MOTION / FINDINGS, numbered paragraphs,
  sentences) with transcript line numbers preserved for precise citations.
- **Orchestration entry** — `searchMode` (`vector` | `hybrid` | `keyword`) dispatched by
  `src/app/api/search/unified/route.ts` into the `query_case_knowledge` tool
  (`src/lib/mcp/tools/query-case-knowledge.ts`), which over-fetches (~5×) before rerank.

---

## 5. Where we exceed the blog

- **Structured metadata pre-filters.** The `{{ }}` chips are parsed by
  `src/lib/search/chip-segments.ts` `segmentChipsAndIntents()` (line ~58) into a boolean AST,
  lifted into hard LanceDB `.where()` predicates (e.g. `case==@uuid`, `judgeRef==`, date ranges)
  plus Prisma-traverse for cross-entity refs, with optional soft-boost. This narrows the corpus
  **before** hybrid search even runs — a precision lever the blog doesn't cover.
- **Multi-pass query decomposition.** `src/lib/search/deep-search.ts` `decomposeQuery()`
  (line ~172) breaks a hard question into focused, *paraphrased* sub-queries, runs them in
  parallel through `query_case_knowledge`, then merges/dedupes by chunk and reranks. Paraphrasing
  directly addresses legal-terminology variation that a single embedding of a long question misses.
- **The RLM agentic layer** — see §6.

---

## 6. RLM (Recursive Language Model) — what it is and how we use it

**Origin.** RLM is **MIT OASYS's "Recursive Language Models"** (Alex L. Zhang, Tim Kraska,
Omar Khattab — note Khattab of ColBERT/DSPy), arXiv [2512.24601](https://arxiv.org/abs/2512.24601),
published **31 Dec 2025** ([HF paper page](https://huggingface.co/papers/2512.24601)). We run the
lab's official post-trained model **`mit-oasys/rlm-qwen3-8b-v0.1`**
([model card](https://huggingface.co/mit-oasys/rlm-qwen3-8b-v0.1)) — Qwen3-8B finetuned on RLM
trajectories. (Defined in code at `src/lib/ai/stream-rlm.ts:54`.)

**Canonical RLM** puts the *entire raw prompt* into a REPL environment and lets the model
programmatically chunk/grep/peek at it, **recursively calling a smaller LM over snippets** before
answering. On the hardest long-context splits it beats a much larger single-shot model at
comparable cost — its strength is *very long context that overflows a normal window*.

**How Sound Suite uses it** — as an **evidence-gathering agent on top of our retrieval pipeline**,
not over a raw prompt:

- Toggle `useRlm` in `src/components/search-interface.tsx:447`, passed to the deep-search runner
  (line ~1309) → route `src/app/api/search/deep/route.ts`.
- Control loop in `src/lib/ai/stream-rlm.ts` `runRlmWithTools()`: the small model iteratively
  emits `query_case_knowledge` tool calls (≤ ~4 rounds), inspects results, fills gaps, and stops
  when it has enough — then a **larger model (Claude) writes the final report**.
- **Context-budget enforcement** (`stream-rlm.ts`): `RLM_CONTEXT_TOKENS = 32768` (line 74),
  `TOKEN_CHAR_RATIO = 3.2` (line 75), `clampOutputTokens()` (line ~98), `trimHistoryToFit()`
  (line ~119) drop the oldest rounds when the window fills.
- **Tool-result caps** (`src/lib/search/deep-search.ts`): `RLM_TOOL_LIMIT_CAP = 8` (line 1198),
  `RLM_TOOL_CHUNK_CHAR_CAP = 600` (line 1204) — ≤8 excerpts/call, 600 chars each in the
  model-facing text (full text is retained for citations). Orchestrated by
  `generateReportWithRlm()` (line ~1225), which also inherits the `{{ }}` chip scope so RLM stays
  inside the user's filters.

**Why this is the key framing.** Hybrid retrieval (the blog) is the **recall substrate**; RLM is
the **adaptive reasoning loop above it**. For a *large private corpus*, our design (pre-indexed
hybrid → rerank → RLM agent → Claude) is arguably **stronger than canonical RLM**, because we
pre-index instead of streaming the whole corpus through a REPL each query.

---

## 7. The 2026 competitive landscape

Sourced from web research (June 2026). "Fit for us" = a self-hosted, single-user, privacy-
sensitive *legal* corpus.

| Approach | What it is | Fit vs. an RLM-style agent for us |
|---|---|---|
| **Self-RAG** | Model emits reflection tokens to decide whether/what to retrieve + self-critique | Lighter adaptive gating; no programmatic context control. RLM wins on long single-doc reasoning. |
| **FLARE** | Retrieves when next-sentence confidence drops | Cheap, low-latency; weaker on multi-hop across many docs. |
| **IRCoT** | Interleaves chain-of-thought with retrieval per step | Strong multi-hop; same spirit as our rounds, no code/REPL layer. |
| **Adaptive-RAG** | Router picks no-/single-/iterative retrieval by query complexity | **Most useful to adopt** — put *in front of* RLM so easy lookups skip its cost. |
| **DeepRAG / Search-R1 / Search-o1** | Learned/RL "think-to-retrieve" models | The momentum direction; obviate a separate agent only if you trust a hosted model (privacy issue for us). |
| **ReAct + retrieval tool** | Reason–act loop over a search tool | Our closest baseline; the RLM paper reports RLM > ReAct+BM25 at 100+ docs. |
| **Long-context "stuff it all in"** | Gemini 2.5 Pro 1M, Claude Sonnet 4.6 1M (Mar 2026), GPT-5 400K | Ruled out for whole-corpus prompts: privacy, cost, and "lost in the middle" (still real on 1M-token models in 2026). Useful only as the final-answer synthesizer over retrieved evidence. |
| **Reasoning models w/ self-retrieval** | DeepSeek R2/V4, o-series, Gemini Deep Think | Validate the paradigm but can't be handed a private corpus; a *local* small RLM is the privacy-preserving equivalent. |
| **Late interaction (ColPali / ColQwen3)** | Per-token/patch embeddings + MaxSim; layout-aware | A better *recall layer*, not a competitor — would **feed** RLM. Strong for scanned/exhibit-heavy legal PDFs. |
| **GraphRAG / KG-RAG** | Build a knowledge graph; answer global/multi-hop questions | **We already own the graph** (see §7.1) — the curated Haystack/Xeto + Prisma entity model. Gap is *graph-aware retrieval*, not building one. |

### 7.1 "Aren't we already doing GraphRAG with Haystack?" — almost

**Short answer: we own the expensive half of GraphRAG already, but we don't yet *retrieve* with it.**

- **"Haystack" here = Project Haystack / Xeto** (`src/lib/haystack/`, `docs/xeto-haystack-research.md`) —
  a typed tagging *ontology* adapted to courts. It is **not** deepset's RAG framework and **not**
  Microsoft GraphRAG.
- **We have a curated, authoritative, typed legal knowledge graph** in `prisma/schema.prisma`:
  Case → Filing → Document / Motion → Exhibit; Person in roles judge/movant/respondent/clerk/reporter;
  MotionEvent, Hearing, Court, Jurisdiction; motion amendment/supersession chains. It's built at
  ingestion from parsed filings (`src/lib/haystack/commit.ts`, `ensure-filing.ts`) — so unlike GraphRAG
  there is **no LLM entity extraction and nothing to hallucinate**. This is the hard, expensive part of
  GraphRAG, and we already have it (and better, because it's authoritative).
- **But today the graph is traversed only to compute FILTERS.** `src/lib/search/boolean-to-fts.ts`
  walks `judgeRef` / `lawyerRef` / `case->judge->displayName` (1–3 hops via `prisma-traverse`) and
  returns `case_id IN (...)` predicates AND'd into the LanceDB pre-filter. That **narrows** what we
  search — it never *expands* retrieval along edges or answers "what connects X to Y across the corpus."

**So the GraphRAG opportunity for us is small, not a from-scratch build:** reuse the same
`prisma-traverse` machinery to *expand* the candidate pool along relationships and to answer multi-hop
relationship questions. See [`docs/tasks/02-graph-aware-retrieval-haystack.md`](./tasks/02-graph-aware-retrieval-haystack.md).

---

## 8. Verdict & forward-looking ideas (not implemented here)

**Keep RLM as the agentic reasoning layer.** It's justified for our exact constraints: privacy +
cost rule out long-context whole-corpus prompts; we can't outsource a private corpus to a hosted
reasoning model; and it beats plain ReAct at scale. Our budget caps (32K, ~4 rounds, ≤8 chunks)
are exactly the engineering hardening the RLM authors flag as needed (they note latency can run
seconds→minutes and there are no built-in cost guarantees).

Each idea below has a concrete, code-grounded proposal under **[`docs/tasks/`](./tasks/)** (see
[`docs/tasks/README.md`](./tasks/README.md)). These are proposals — **not** done by this document.

1. **Adaptive-RAG-style router** so simple lookups skip RLM's cost/latency —
   [`tasks/01-adaptive-rag-router.md`](./tasks/01-adaptive-rag-router.md).
2. **Graph-aware retrieval over our existing Haystack/Xeto graph** (not a from-scratch GraphRAG; see
   §7.1) for cross-document relationship questions (parties / motions / filings / precedents) —
   [`tasks/02-graph-aware-retrieval-haystack.md`](./tasks/02-graph-aware-retrieval-haystack.md).
3. **ColPali / ColQwen3** for scanned, exhibit-heavy PDFs where text-only chunking loses layout —
   [`tasks/03-colpali-visual-retrieval.md`](./tasks/03-colpali-visual-retrieval.md).
4. **Learned / query-dependent fusion** to replace the **fixed RRF k=60 and arbitrary 1.2 soft-boost** —
   [`tasks/04-learned-fusion-weighting.md`](./tasks/04-learned-fusion-weighting.md).
5. **Reranker resilience + chunk-overlap tuning** (90 s timeout under a degraded fleet; chunk overlap) —
   [`tasks/05-reranker-resilience-and-chunk-overlap.md`](./tasks/05-reranker-resilience-and-chunk-overlap.md).

---

## 9. Sources

- InfoQ — *Why Vector Search Alone Isn't Enough: Hybrid Retrieval for RAG* (2 Jun 2026):
  https://www.infoq.com/articles/vector-search-hybrid-retrieval-rag/
- RLM paper (arXiv 2512.24601, 31 Dec 2025): https://arxiv.org/abs/2512.24601 ·
  HF paper page: https://huggingface.co/papers/2512.24601 ·
  model: https://huggingface.co/mit-oasys/rlm-qwen3-8b-v0.1 ·
  author blog: https://alexzhang13.github.io/blog/2025/rlm/
- *Agentic RAG: A Survey* (arXiv 2501.09136, rev Apr 2026): https://arxiv.org/abs/2501.09136
- *One-shot vs Iterative retrieval* (arXiv 2509.04820): https://arxiv.org/pdf/2509.04820
- Context-window comparison 2026: https://www.elvex.com/blog/context-length-comparison-ai-models-2026 ·
  "Lost in the middle is still real in 2026": https://dev.to/gabrielanhaia/lost-in-the-middle-is-still-real-in-2026-even-on-1m-token-models-2ehj
- Late interaction (ColPali, arXiv 2407.01449): https://arxiv.org/pdf/2407.01449 ·
  overview: https://weaviate.io/blog/late-interaction-overview
- Microsoft GraphRAG: https://microsoft.github.io/graphrag/
- Internal: `src/lib/vector/vector-store.ts`, `src/lib/search/reranker.ts`,
  `src/lib/ai/stream-rlm.ts`, `src/lib/search/deep-search.ts`,
  `src/lib/search/chip-segments.ts`, `src/app/api/search/unified/route.ts`,
  `src/app/api/search/deep/route.ts`. Related: [`docs/chunking-research.md`](./chunking-research.md),
  [`docs/xeto-haystack-research.md`](./xeto-haystack-research.md).

> Verification note: the "ICML 2025" venue that surfaced in one search for RLM is **unverified
> and appears incorrect** — primary sources show a Dec-2025 arXiv preprint only.
