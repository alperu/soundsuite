# Adaptive-RAG complexity router

**Status:** Proposed · **Effort:** M · **Priority:** High

Derived from [`../rag-hybrid-retrieval-and-rlm-analysis.md`](../rag-hybrid-retrieval-and-rlm-analysis.md)
§7 ("Adaptive-RAG — **Most useful to adopt**") and §8 idea #1.

## Problem / opportunity

The expensive paths — multi-pass deep-search decomposition and the RLM agentic loop — are gated
**entirely by manual UI toggles**. A user asking *"what is the cause number on the petition?"* (a
single exact-token lookup that hybrid search nails in one pass) pays the same up-to-4-round,
seconds-to-minutes RLM cost as someone asking *"trace how the trust dispute evolved across every
filing."* There is no automatic complexity assessment in front of these routes. Adaptive-RAG (the
router pattern: pick *no-retrieval / single-shot / iterative* by query complexity) is the cheapest,
highest-leverage improvement available — it sits **in front of** the existing machinery and changes
nothing downstream.

## What we already have

- **Manual toggles, no router.** `deepSearchMode` and `useRlm` are `usePersistedState` booleans set
  by the user — `src/components/search-interface.tsx:442` (`deepSearchMode`) and `:447` (`useRlm`).
  They are read straight into the deep-search start call (`search-interface.tsx:1309`, `:1337`) with
  no query inspection in between. The toggle UI lives at `search-interface.tsx:2016`/`:2028`.
- **Three distinct cost tiers already exist** and are individually invokable:
  1. Single-shot hybrid via `query_case_knowledge` (`src/lib/mcp/tools/query-case-knowledge.ts`),
     dispatched by `searchMode` in `src/app/api/search/unified/route.ts`.
  2. Deep-search decomposition — `decomposeQuery()` at `src/lib/search/deep-search.ts:172` fans a
     hard question into paraphrased sub-queries, then merges + reranks (`deep-search.ts:690`).
  3. RLM agentic loop — `generateReportWithRlm()` at `deep-search.ts:1225`, driving
     `runRlmWithTools()` (`src/lib/ai/stream-rlm.ts:395`, `maxRounds` default 4 at `:414`).
- **A chip/intent segmenter that already classifies query shape.**
  `segmentChipsAndIntents()` in `src/lib/search/chip-segments.ts` separates structured `{{ }}`
  filters from free text — a natural place to read complexity signals (presence of an exact
  cause-number token, a single hard filter, etc.).

The router is the **only missing piece**; all four destination tiers are built and tested.

## Proposed approach

Add a `classifyQueryComplexity()` step that runs before dispatch and returns one of four routes:

| Route | When | Destination |
|-------|------|-------------|
| `no-retrieval` | Pure metadata lookup fully satisfiable by chips (e.g. `{{case}}` + "list motions") | Structured query, skip vector search |
| `single-shot` | One focused factual question, exact tokens present | `query_case_knowledge` hybrid, no decomposition |
| `deep` | Multi-faceted / comparative / "across filings" | `decomposeQuery()` path |
| `rlm` | Open-ended synthesis, gap-filling, "trace/connect/how did X evolve" | `generateReportWithRlm()` |

Start with a **cheap heuristic classifier** (token/length features, chip presence, interrogative
type, comparison keywords) and keep the manual toggles as an override. A learned/LLM classifier is a
later upgrade; the heuristic captures most of the win and adds ~0ms.

## Implementation steps

1. **New module** `src/lib/search/query-router.ts` exporting
   `classifyQueryComplexity(query, chipResult): RouteDecision` where `RouteDecision` is
   `{ route: 'no-retrieval'|'single-shot'|'deep'|'rlm'; reason: string; confidence: number }`.
   Consume the output of `segmentChipsAndIntents()` (`chip-segments.ts`) so the classifier sees the
   same parse the search path uses.
2. **Heuristic rules** (v1): exact-token presence (cause-number regex, quoted phrases) → bias
   `single-shot`; comparison/temporal/"across"/"every" keywords → `deep`; "trace"/"connect"/
   "how did"/"relationship" + no hard filter → `rlm`; chips-only with an enumerable intent →
   `no-retrieval`.
3. **Wire into the entry point.** In `search-interface.tsx`, when the user has NOT explicitly set
   `deepSearchMode`/`useRlm`, call the router and use its decision; when they have, honor the toggle
   and record an "override" telemetry event so we can later compare router vs. human.
4. **Surface the decision** in the progress UI (the deep-search progress block at
   `search-interface.tsx:2332`) — e.g. a one-line "Routed to single-shot (exact identifier
   detected)" so the choice is auditable.
5. **Server guardrail.** Add the same classification call in `src/app/api/search/deep/route.ts`
   before invoking RLM, so an API caller can't accidentally pay RLM cost for a trivial query.
6. **Tests** colocated in `src/lib/search/__tests__/query-router.test.ts` covering the four routes
   with representative legal queries.

## Risks / open questions

- **Misroute cost asymmetry.** Under-routing (sending a hard question to single-shot) hurts answer
  quality; over-routing (RLM for a lookup) only wastes latency. Bias the heuristic toward
  *escalation only on strong signals* and keep the manual override prominent.
- **Where does the router live — client or server?** Client lets us reuse the existing chip parse
  cheaply; server is the safer guardrail. Proposal does both (client decides, server clamps).
- **Confidence thresholding.** Below a confidence floor, default to `deep` (the safe middle) rather
  than `rlm` or `single-shot`.
- A learned classifier needs labeled traffic — defer until step 3's override telemetry has data.

## How to measure success

- **Latency:** p50/p95 end-to-end search latency drops on the long tail of simple queries (today
  those that the user happened to leave RLM toggled on for).
- **Cost:** count of RLM/deep invocations per 100 queries falls without a quality regression.
- **Routing accuracy:** on a hand-labeled query set, % matching the human-chosen tier; track
  override rate from step 3 telemetry as the live signal.
- **Quality guard:** answer-quality spot-checks on `single-shot`-routed queries show no regression
  vs. forcing `deep`.

## References

- Adaptive-RAG (router by query complexity) — analysis doc §7, §8 #1.
- *Agentic RAG: A Survey* (arXiv 2501.09136): https://arxiv.org/abs/2501.09136
- *One-shot vs Iterative retrieval* (arXiv 2509.04820): https://arxiv.org/pdf/2509.04820
