# Ground sub-queries before deep retrieval spends 50 s on invented subjects

**Status:** Proposed — **diagnosed, not verified** · **Effort:** S · **Priority:** P1 · **Created:** 2026-09-08
**Report:** [`../MCP-Improvements/REPORT-v12-mcp-surface-for-fast-correct-answers.md`](../MCP-Improvements/REPORT-v12-mcp-surface-for-fast-correct-answers.md) §3d, §6 item 6

> **Provenance.** Code citations read from source; the 49.7 s / five-of-six figure is v12's single
> observed run and has **not** been reproduced. Reproduce it before building — if sub-query drift is
> not routine, this task is not worth its risk.

Counts and code citations only. No case data.

## Problem

In v12's `deep-rlm` run, five of six generated sub-queries were off-corpus — an entire invented
subject area — and retrieval spent **49.7 s** on them. The RLM then ran its own rounds against the
same wrong frames, inheriting the error rather than catching it. Of a 140 s job, that is more wall
clock than streaming (§3b) could ever recover.

**There is no grounding check anywhere in the path.** The only pre-retrieval decision is tier routing
on query text (`src/lib/search/gather-evidence.ts:251-253`), which never touches the corpus. A module
`src/lib/search/rr-grounding.ts` exists but is **imported nowhere under `src/`**.

## Where it happens

Sub-queries are generated in the `decompose` phase (`gather-evidence.ts:285-350`), three branches:
`fast` single-query (`:289`), chip dispatch `buildChipSpecs` (`:293-303`), and LLM `decomposeQuery`
under timeout (`:307-320`) with `heuristicDecompose` fallback (`:325`).

Retrieval then fans out, one call per sub-query — `src/lib/search/deep-search.ts:496-509`:

```js
const promises = specs.map(async (spec): Promise<SubQueryResult> => {
  const subQuery = spec.query;
  const searchResult = await registry.execute('query_case_knowledge', {
    query: subQuery, …, limit: limitPerSubQuery, searchMode: 'hybrid',
```

## A cheaper gate than v12 proposed

v12 proposes a shallow retrieval per candidate sub-query before committing to deep retrieval. There is
a better insertion point that needs **no extra retrieval at all**: `gather-evidence.ts:427-429`,
immediately before `if (mode === 'deep-rlm') {`.

By that line, fuse **and** rerank have already run (`:377-382`), so `sources`, `stats.rerankPool` and
`stats.finalAfterRerank` are already computed and available as groundedness signals — and `mode` is
still downgradeable. A sub-query that contributed nothing above a score floor is already visible in
what came back.

This is the same discipline v12 names — *cheap grounding first, expensive recursion second* — but it
reuses a measurement already paid for instead of buying a new one.

**The trade-off, stated plainly:** the fan-out at `deep-search.ts:496-509` has already happened by
`:427`, so this gate does not save the first-round retrieval. It saves the **RLM rounds**, which is
where the recursion cost lives. Cutting the first round too requires v12's per-sub-query probe and is
a second, larger change. Do the cheap one first and measure what it recovers.

## Work

| # | Item | Status |
|---|---|---|
| 1 | **Reproduce the drift.** Re-run a `deep-rlm` job and record how many sub-queries return nothing above a floor, and the wall clock they consumed. If it is not routine, stop here. | ☐ |
| 2 | Attribute retrieved sources back to the sub-query that found them, so a per-sub-query yield is computable at `:427`. Confirm whether `SubQueryResult` already carries this. | ☐ |
| 3 | Add the gate before `if (mode === 'deep-rlm')`: drop ungrounded sub-queries from the RLM's frame set, and downgrade `mode` when none survive. | ☐ |
| 4 | **Report what was dropped.** A silently narrowed question is exactly the failure this series keeps finding. Surface the dropped sub-queries and the floor used, in the result and in the NDJSON stream. | ☐ |
| 5 | Decide whether `rr-grounding.ts` is the intended home. It is currently dead code — either use it or delete it; leaving an unimported module named "grounding" while adding grounding elsewhere is a trap for the next reader. | ☐ |
| 6 | Only if item 1 shows first-round waste dominates: add the per-sub-query shallow probe v12 proposed. | ☐ |

## Risks

- **A floor that is too high silently narrows the question.** This is the worst failure available
  here: it looks like speed and behaves like lost recall. Item 4 is not optional.
- **One observed run is not a rate.** v12's five-of-six is a single sample.
- **Decomposition quality is the real defect.** A gate is a filter on a generator that is producing
  off-corpus subjects; fixing the generator may be the better change. Note which is being fixed.
- **Do not gate on `stats.rerankPool` alone.** Per [task 22](./22-rerank-observability.md) that value
  is a pool size read before the rerank call, and is non-zero whenever anything was retrieved.

## Acceptance

| Check | Expected |
|---|---|
| A reproduced `deep-rlm` run | per-sub-query yield and wall clock recorded, before any change |
| The same run with the gate | dropped sub-queries named in the result; wall-clock delta measured |
| A run where every sub-query is grounded | byte-identical evidence to today |
| A run where none are | mode downgraded, and the response says so |
| `rr-grounding.ts` | used or deleted |

## References

- `src/lib/search/gather-evidence.ts:251-253, 285-350, 377-382, 427-429`
- `src/lib/search/deep-search.ts:496-509`
- `src/lib/search/rr-grounding.ts` — present, imported nowhere
- [`22-rerank-observability.md`](./22-rerank-observability.md) — why `rerankPool` is not a quality signal
- [`01-adaptive-rag-router.md`](./01-adaptive-rag-router.md) — the adjacent "pick the cheapest mode" idea
