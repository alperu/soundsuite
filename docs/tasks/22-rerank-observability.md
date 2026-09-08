# Rerank is unobservable, unverifiable, and skipped for RLM evidence

**Status:** Proposed · **Effort:** S (items 1–4) + M (item 6) · **Priority:** P0 · **Created:** 2026-09-08
**Report:** [`../MCP-Improvements/REPORT-v12-mcp-surface-for-fast-correct-answers.md`](../MCP-Improvements/REPORT-v12-mcp-surface-for-fast-correct-answers.md) §4c, §6 items 2 and 7

Counts, field names and code citations only in this file and in any report it produces. No case data.

## Problem

v12 §4c reported that `modelsUsed` names a reranker whose contribution cannot be measured: no `rerank`
entry in `stats.phases`, and `rerankScore` identical to `score` on every row. It declined to assert a
cause. The cause is now settled in source, and it is worse than "the reranker did not run" — the
reranker **does** run, and the surface is incapable of showing what it did.

Four separate defects compose into one blind spot.

### 1. `rerankScore` and `score` are the same value by construction

`rerank()` overwrites `score` **in place** with the cross-encoder's output
(`src/lib/search/reranker.ts:587-591`):

```ts
  return {
    items: data.results.map((rr) => ({
      ...results[rr.index],
      score: rr.relevance_score,
    })),
```

The first-stage retrieval score is discarded at that line and is recoverable nowhere downstream. Then
`src/lib/search/gather-evidence.ts:424-425` populates both fields from the same property:

```ts
const reranked = stats.rerankPool > 0;
const initial = addItems(sources.map((s) => toItem(s, evidenceOrigin(s), reranked ? s.score : undefined)));
```

`sourceToEvidenceItem` (`src/lib/search/evidence-mapping.ts:25-38`) assigns `score: source.score` and
`rerankScore` from its third argument — which is `s.score`. They cannot differ. v12 observed the
symptom and correctly declined to infer a cause from it; the cause is that the comparison the field
exists to support was never possible.

### 2. Neither field is the cross-encoder's score either

After `rerank()` returns, `deduplicateAndMerge` applies multiplicative boosts to the same `score`
field (`src/lib/search/deep-search.ts:836-859`): transcript-intent `×1.35`, `blockType === 'table'`
`×1.2` on tabular intent, `'figure'` `×0.85`, table-page structure hint `×2.0`, speaker hint `×1.5`.

So both `score` and `rerankScore` carry *relevance_score × boosts*. A caller comparing them learns
nothing, and a caller reading `rerankScore` as "what the cross-encoder thought" is wrong.

### 3. The flag that gates `rerankScore` is a pool size, not a success signal

`stats.rerankPool` is assigned **before** the rerank call and never reassigned
(`src/lib/search/deep-search.ts:796-798`):

```ts
    rerankPool = merged.length;
    const rerankable = merged as (DeepSearchSource & RerankableResult)[];
    merged = await rerank(originalQuery, rerankable, poolSize, onWarning ? (w) => onWarning({
```

Meanwhile every degraded path inside `rerank()` returns the input array unchanged, so the caller
cannot distinguish success from silent fallback to first-stage hybrid order:

| Condition | `reranker.ts` line | Returns |
|---|---|---|
| `rerankEnabled === false` | `:171` | `results` |
| `rerankProvider === 'none'` | `:176` | `results` |
| no `rerankHost` | `:180` | `results` |
| all hosts failed (`warn('degraded', …)`) | `:376` | `results.slice(0, effectiveTopN)` |
| score validation failed | `:389` | `results.slice(0, effectiveTopN)` |
| thrown / fetch error (`warn('fetch', …)`) | `:416` | `results` |

`stats.rerankPool > 0` therefore means "at least one source was retrieved". **The presence of
`rerankScore` on a row is not evidence the cross-encoder ran.** Batch timeout is
`config.rerankTimeoutMs ?? 90_000` (`:190-192`), so a degraded fleet can burn 90 s and leave no trace
in the result.

### 4. Evidence gathered by the RLM is never reranked

v12 §4c raised this as a thing to check and explicitly declined to assert it ("key order is not
execution order"). It is confirmed from two independent sites:

- `deep-search.ts:798` is the **only** `rerank(` call in the file, and `runRlmEvidenceRounds` is
  defined at `deep-search.ts:1628` — inside the same module, making no rerank call of its own.
- `gather-evidence.ts:459-461` maps RLM-round items with the `rerankScore` argument **omitted**,
  which is the mapping-site corroboration.

So the pipeline reranks the fused first-round pool, then the RLM gathers further evidence that is
merged in **unreranked** and scored on a different basis. This decides whether multipass makes
results better or noisier, which is exactly the question v12 said it would check first.

## Two corrections to the report

Both matter because they change what to build.

**`rerankPoolSize` is never written into any tool response.** v12 §6 item 2 frames the open question
as "`rerankPoolSize` 5 vs 150". Grep across `src/lib/` and `src/app/` finds only reads, config
plumbing, schema description text and allowlists. The canonical default is **150** everywhere
(`src/lib/db/config.ts:296`, `deep-search.ts:789-791`, `admin-reranking-settings.tsx:46`,
`research-evidence.ts:63`). `query_case_knowledge` clamps it (`query-case-knowledge.ts:466`):

```ts
const rerankPool = Math.min(appConfig.rerankPoolSize ?? 150, Math.max(limit * 8, 40));
```

With the default `limit = 10` (`:188`) that is `min(150, 80) = 80`, and it **floors at 40** — it can
never produce 5. The only pool figure in any response is `stats.rerankPool`
(`gather-evidence.ts:581`). A reported `5` is therefore almost certainly `stats.rerankPool`, meaning
only 5 unique chunks survived dedup and **the cross-encoder saw 5 candidates, not 150**. That is a
recall problem upstream of rerank, not a rerank configuration problem, and it should be investigated
as one (item 7).

**`stats.phases` ordering is genuine, not incidental.** Built at `gather-evidence.ts:220-226` with
keys `routing, decompose, retrieve, pattern, fuse, rlm, outline`. There is no `rerank` key, and the
rerank await genuinely sits inside the `fuse` span — `timed('fuse', () => deduplicateAndMerge(...))`
at `:378-380`. v12's timing inference (150 candidates × ~60 ms ≈ 9 s against `fuse` 8,100 ms) is
consistent with the code.

## The routed profile disagrees with the local one

`src/lib/mcp/routed/run-report.ts` never passes a rerank score to `sourceToEvidenceItem`, hardcodes
`rerank: 'n/a'` in `modelsUsed` (`:312`), and fills the **same field name** from a different quantity
(`:304`):

```ts
      rerankPool: result.searchStats.finalAfterRerank,
```

Local `rerankPool` is the pool size *before* rerank; routed `rerankPool` is the count *after*. One
field name, two meanings, no way for a caller to tell which it is holding.

## Work

| # | Item | Status |
|---|---|---|
| 1 | **Preserve the first-stage score before it is overwritten.** In `reranker.ts:587-591`, carry the incoming `score` onto the returned item as `retrievalScore` before assigning `score = rr.relevance_score`. This is the single change that makes every other comparison possible. | ☐ |
| 2 | **Preserve the raw cross-encoder score too.** Because §2 boosts mutate `score` after rerank, three values are needed, not two: `retrievalScore` (first stage), `rerankScore` (raw `relevance_score`, set once and never boosted), and `score` (final, post-boost). Set `rerankScore` at the reranker, not at the mapping site. | ☐ |
| 3 | **Replace the `reranked` flag with a real outcome.** Have `rerank()` return an applied/degraded outcome alongside its items — it already classifies every failure via `RerankWarning.reason` (`'preflight' \| 'lifecycle' \| 'fetch' \| 'score-validation' \| 'fallback-model' \| 'degraded'`, `reranker.ts:148-153`). Surface `rerankApplied: boolean` and, when false, the reason. Delete `const reranked = stats.rerankPool > 0` (`gather-evidence.ts:424`). | ☐ |
| 4 | **Add a `rerank` key to `stats.phases`** (`gather-evidence.ts:220-226`), timed around the rerank await specifically so `fuse` stops absorbing it. Keep `fuse` reporting the rest of the merge. | ☐ |
| 5 | **Reconcile `rerankPool` across profiles.** Either rename one side, or emit both `rerankPoolIn` and `rerankPoolOut` in both paths. Fix `run-report.ts:312`'s hardcoded `'n/a'` to report the routed profile's actual reranker or an explicit "not applicable in this profile". | ☐ |
| 6 | **Decide whether RLM-round evidence should be reranked.** This is a retrieval-quality decision, not plumbing — do not just wire it up. Measure a fixed query set with RLM evidence reranked and unreranked before choosing. Whatever is decided, state it in the response so a caller knows which items passed a cross-encoder. | ☐ |
| 7 | **Investigate the 5-candidate pool.** If `stats.rerankPool` is routinely single-digit where 150 was configured, dedup or first-stage recall is collapsing the pool and the reranker is being starved. Reproduce, then measure the pool distribution over a fixed query set. | ☐ |

## Risks

- **Item 1 changes a hot mapping path.** `RerankableResult` is generic (`rerank<T extends
  RerankableResult>`); adding a field must not break the three call sites
  (`deep-search.ts:798`, `query-case-knowledge.ts:475`, `ai-helper.ts:674`).
- **Item 3 will start reporting `rerankApplied: false` in places that today look fine.** That is the
  point, but expect it to surface fleet problems that were previously invisible, and do not read the
  first such report as a regression introduced by this task.
- **Item 6 could change every ranking.** Gate it behind a measurement, not a flag flip.
- **Do not "fix" `rerankScore === score` by computing a difference.** There is no stored first-stage
  score to difference against until item 1 lands. Any such fix before item 1 is fabricated data.

## Acceptance

| Check | Expected |
|---|---|
| A response from a healthy fleet | `retrievalScore`, `rerankScore` and `score` present, and `retrievalScore !== rerankScore` on at least some rows |
| A response with the reranker disabled (`rerankProvider: 'none'`) | `rerankApplied: false` with a reason; no `rerankScore` emitted |
| A response with an unreachable rerank host | `rerankApplied: false`, reason `'degraded'`, and the answer still returned |
| `stats.phases` | contains `rerank` with its own duration; `fuse` no longer includes it |
| `rerankPool` on local and routed | either the same quantity, or two distinctly named fields |
| RLM-round items | carry an explicit marker of whether they were reranked |
| Pool starvation | `stats.rerankPool` distribution reported over a fixed query set |

## References

- `src/lib/search/reranker.ts` — `rerank()`, the six degraded returns, `/v1/rerank` at `:501`
- `src/lib/search/deep-search.ts:789-798` — pool sizing and the single rerank call site
- `src/lib/search/deep-search.ts:836-859` — post-rerank boosts
- `src/lib/search/deep-search.ts:1628` — `runRlmEvidenceRounds`
- `src/lib/search/gather-evidence.ts:220-226, 378-380, 424-425, 459-461, 581`
- `src/lib/search/evidence-mapping.ts:25-38`
- `src/lib/mcp/routed/run-report.ts:304, 312`
- [`21-chunk-overlap-defect.md`](./21-chunk-overlap-defect.md) — the other measurement-before-fix task
