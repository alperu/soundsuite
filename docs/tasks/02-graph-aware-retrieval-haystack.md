# Graph-aware retrieval over the existing Haystack/Xeto graph

**Status:** Proposed · **Effort:** M · **Priority:** High

Derived from [`../rag-hybrid-retrieval-and-rlm-analysis.md`](../rag-hybrid-retrieval-and-rlm-analysis.md)
§7 ("GraphRAG / KG-RAG — Complementary") and §8 idea #3.

## The framing question: "aren't we already doing GraphRAG with the Haystack model?"

**Short answer: no — not in the Microsoft-GraphRAG sense — but we already own most of what GraphRAG
exists to build, and ours is better.** Three different things share the name "Haystack"; only one is
relevant here:

- `src/lib/haystack/` is **Project Haystack / Xeto** — a typed tagging ontology (originally
  building-automation) adapted to the court domain. See `docs/xeto-haystack-research.md:1`. It is
  **not** deepset's Haystack RAG framework, and **not** Microsoft GraphRAG.
- Our graph is an **authoritative, curated, typed legal knowledge graph** persisted in Prisma:
  `Case → Filing → Document/Motion → Exhibit`, plus `Person` with judge/movant/respondent/clerk/
  reporter roles, `MotionEvent`, `Hearing`, `Court`, `Jurisdiction`, and amendment/supersession
  chains. It is built at **ingestion** from parsed filings (`src/lib/haystack/commit.ts`,
  `ensure-filing.ts`), so there is **no LLM entity extraction** and nothing to hallucinate — the
  opposite of GraphRAG, which spends an expensive LLM pass extracting entities/relations from raw
  text and then summarizing communities.
- Today that graph is used at query time **only to compute filters**, not to retrieve. See "What we
  already have" below — the contrast is the whole point.

**Conclusion:** the heavy, hallucination-prone part of GraphRAG (build a graph from text) is already
done, correctly and authoritatively. The opportunity is the *cheap* half: **graph-aware retrieval**
that traverses the existing edges to expand the candidate set, instead of only narrowing it.

## Problem / opportunity

Questions about **connections** — "what links party X to motion Y across these filings?", "which
documents share this judge and this exhibit?", "what's the amendment lineage of this motion?" — are
poorly served by similarity-only retrieval. The relationships are *already modeled as FK edges*, but
retrieval never walks them. A multi-hop legal question gets answered from chunks that happen to be
textually similar, missing structurally-related documents that use different wording.

## What we already have

- **Query-time graph traversal — but for FILTERING only.** `src/lib/search/boolean-to-fts.ts`
  `resolveOne()` resolves ref fields against the Prisma graph and returns **`case_id IN (...)`**
  predicates that are AND'd into the LanceDB pre-filter. Confirmed traversals:
  - 1-hop Person refs (`judgeRef`/`movantRef`/`respondentRef`) → `Motion.judgeId`/`movantId`/
    `respondentId` → `caseId` (`FIELD_RESOLVERS`, the `prisma-traverse` entries).
  - 2-hop person-tag refs (`lawyerRef`/`clerkRef`/`reporterRef`) via `resolvePersonTagFilter()`
    (`PersonRole.tags` + `MotionEvent.courtClerkId`/`courtReporterId`).
  - 3-hop `case->judge|movant|respondent->attribute`.
  Every path **terminates in a set of caseIds used as a `WHERE` narrowing** — never to pull in
  related chunks. There is a `capFanout()` guard precisely because the output is a filter list.
- **The full entity graph in `prisma/schema.prisma`:** `Motion` carries `caseId`,
  `parentMotionId`/`childMotions` (nesting), `amendsId`/`supersedesId`/`revisionSeq` (amendment
  chains), and denormalized `judgeId`/`movantId`/`respondentId`. `MotionEvent` links
  `authoredBy`/`servedOn`/`courtClerk`/`courtReporter`/`hearing`/`document`. `Person` exposes every
  role relation (`motionsAsJudge`, `eventsAsClerk`, `hearingsAsJudge`, …). `MotionAttachment` has its
  own `amends`/`supersedes` chains. These are the edges a graph-aware retriever would walk.
- **Haystack read/commit infra to reuse:** `src/lib/haystack/refs.ts` (ref synthesis + ref→label
  inlining + provenance), `entities.ts` (`ENTITY_FINDERS`, `REF_TARGET_MODEL` dispatch maps),
  `commit.ts` (authoritative write path). These already know how to resolve a ref to its target
  entity and label.

## Proposed approach: traversal as *expansion*, not *narrowing*

Reuse the exact same `prisma-traverse` resolvers — but add an **expansion mode** that, given a
seed (a top-ranked chunk's document/motion/case, or an entity named in the query), walks N hops along
the graph and returns the **chunk ids of related entities** to *add* to the candidate pool before
rerank. This is the inverse of today's `case_id IN (...)` filter.

Concretely, two new capabilities:

1. **Graph-expanded retrieval.** After first-stage hybrid search returns its top chunks, take their
   parent entities, traverse one or two hops (same motion's amendment chain; same judge's other
   motions in scope; documents attached to the same `MotionEvent`), fetch those entities' chunks,
   and merge them into the pool that goes to `rerank()` (`deep-search.ts:690`). The reranker already
   handles a heterogeneous pool, so no scoring change is needed — graph hops just improve *recall*.
2. **Relationship-answering tool for RLM/deep-search.** A new `query_case_graph` MCP tool (sibling to
   `query_case_knowledge`) that answers structural questions directly from the graph: "documents
   sharing judge J and exhibit E", "amendment lineage of motion M", "all filings where person P
   appeared". This gives RLM (`runRlmWithTools`, `stream-rlm.ts:395`) a second tool so it can choose
   *structural* lookups, not only semantic ones.

## Implementation steps

1. **Refactor the resolver registry for bidirectional use.** Extract the `FIELD_RESOLVERS` traversal
   primitives from `boolean-to-fts.ts` into a shared `src/lib/search/graph-traverse.ts` that exposes
   both `resolveToFilter()` (today's `case_id IN`) and a new `expandFromSeed(entityRef, hops)` →
   related entity ids. Keep `capFanout()` semantics to bound blast radius.
2. **Map entities → chunk ids.** Add a helper that turns an entity id (documentId/motionId/caseId)
   into its chunk rows via the LanceDB scalar columns already used as filters (`document_id`,
   `case_id`, `filing_id` — see the `lance-scalar` resolvers).
3. **Graph-expansion hook in deep-search.** Between merge and rerank (`deep-search.ts` ~`:690`),
   optionally call `expandFromSeed()` on the top-K seeds (config-gated, capped fan-out), dedupe by
   chunk key (the path already dedupes), and let the existing `rerank()` order the enlarged pool.
4. **New MCP tool** `src/lib/mcp/tools/query-case-graph.ts` registered in `src/lib/mcp/mcp-server.ts`,
   built on `graph-traverse.ts` + `haystack/refs.ts` label inlining, returning structured edges
   (with `dis` display strings) rather than prose. Add it to the RLM tool list in
   `generateReportWithRlm()` (`deep-search.ts:1225`).
5. **Scope inheritance.** The expansion must stay inside the user's `{{ }}` chip scope (same
   constraint RLM already inherits per `generateReportWithRlm`). Intersect expanded caseIds with the
   chip filter set.
6. **Tests:** amendment-chain expansion, shared-judge expansion, fan-out capping, and chip-scope
   intersection.

## Explicit contrast with Microsoft GraphRAG

| | Microsoft GraphRAG | This proposal |
|---|---|---|
| Graph source | LLM-extracted from raw text (lossy, hallucination-prone) | **Authoritative**, built from parsed filings at ingestion (`haystack/commit.ts`) |
| Index cost | Heavy per-corpus LLM extraction + community summarization | **Zero** new extraction — graph already exists |
| Query | Global summarization over community reports | Targeted N-hop expansion + structural lookups, scoped to chips |
| Risk | Wrong/invented edges | Edges are FK-true |

We do **not** need entity extraction, community detection, or global summarization. We need a
traversal direction we don't currently have (expand, not just filter).

## Risks / open questions

- **Fan-out / precision.** A prolific judge or shared exhibit can explode the pool. Reuse
  `capFanout()` and cap hops at 1–2; let rerank prune. Make expansion opt-in per route.
- **Where to trigger.** Heuristic (relationship keywords) vs. always-on-for-deep vs. RLM-tool-only.
  Recommend: RLM-tool first (lowest risk, model-gated), then opt-in deep-search expansion.
- **Chunk granularity vs. entity granularity.** Some entities (a `Hearing` spanning many cases) map
  to many chunks; need a per-entity chunk cap.
- **Overlap with chip filters.** Ensure expansion can't escape the user's hard scope.

## How to measure success

- **Recall on relationship questions:** build a small eval set of "what connects X and Y" /
  "amendment lineage" questions with gold document sets; measure recall@K with vs. without
  graph expansion.
- **RLM tool-selection:** fraction of relationship queries where RLM picks `query_case_graph`, and
  whether final answers cite structurally-related docs that pure-semantic retrieval missed.
- **No latency regression** on non-relationship queries (expansion is opt-in / gated).

## References

- Microsoft GraphRAG: https://microsoft.github.io/graphrag/
- KG-RAG / GraphRAG row — analysis doc §7.
- Internal: `docs/xeto-haystack-research.md`, `prisma/schema.prisma`,
  `src/lib/search/boolean-to-fts.ts`, `src/lib/haystack/refs.ts`, `src/lib/haystack/entities.ts`,
  `src/lib/haystack/commit.ts`.
