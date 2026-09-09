# A machine-readable `completeness` object, so callers stop regex-matching English

**Status:** Proposed · **Effort:** S (`scan_for_pattern`) + M (`query_case_knowledge`) · **Priority:** P0 · **Created:** 2026-09-08
**Report:** [`../MCP-Improvements/REPORT-v12-mcp-surface-for-fast-correct-answers.md`](../MCP-Improvements/REPORT-v12-mcp-surface-for-fast-correct-answers.md) §4a, §6 item 3

Field names, counts and code citations only. No case data.

## ✅ Verification 2026-09-09 — premises hold; **every line citation has drifted, and item 4 is partly already done**

**CONFIRMED**

| Claim | Evidence |
|---|---|
| No `completeness` object exists on either tool | `completeness` appears in `scan-for-pattern.ts` only inside a comment (`:1193`); nowhere in `query-case-knowledge.ts` |
| Callers must string-match prose | `ScanForPatternResult` (`scan-for-pattern.ts:57-90`) exposes `strategy`, `candidatePool`, `scanned`, `truncated`, `nextCursor`, `warnings` — and no exhaustive/proven boolean |
| 15 warning strings pushed into one array | `const warnings: string[]` at `:839`; **15** `warnings.push` sites |
| The return assembly is exactly as quoted | `:1405-1414`, byte-identical to the block quoted below |
| `query_case_knowledge` computes none of it | `return { results: enrichedResults };` — `query-case-knowledge.ts:708` — the whole assembly |
| **The five variables really are out of scope at the return** | all inside the FTS `else` branch: `fetchLimit` `:1083`, `poolCapped` `:1117`, `pageFills` `:1138`, `willEscalate` `:1141`, `provenAbsence` `:1144`. The in-scope five are `strategy` `:995`, `candidatePool` `:997`, `scanned` `:998`, `truncated` `:999`, `nextCursor` `:1000`. **Item 1's hoist is real work.** |
| `documentsSearched` does not exist and cannot be faked | no distinct-document count on either path |
| `distinctDocs` is a pool statistic, not a corpus denominator | `query-case-knowledge.ts:527` — used only to size a per-document diversity cap |
| `scanTextColumn` exists and exposes no count API | `src/lib/vector/vector-store.ts:460` — signature confirmed at the cited line |

**REFUTED / STALE**

1. **Every `file:line` in this task is stale**, by +7 near the top of `executeImpl` and by up to +43
   further down. The table above carries the current numbers. The claims themselves survive — this is
   citation drift, not a wrong diagnosis — but a reader following the old numbers lands in unrelated
   code, and the variable table was the part most likely to be trusted without re-checking.

2. **Item 4 is partly already done.** The task treats the corpus denominators as pending work from
   task 23. `scan-for-pattern.ts:12` already imports `getCorpusDenominator, provenAbsenceClause` from
   `../corpus-denominator`, and calls them at `:1026`, `:1151` and `:1172`. The denominator is already
   in the **prose** on the zero-result branches. What item 4 must actually do is narrower: surface the
   same values as **fields**, and ensure they reach the non-zero branch too — which is precisely the
   asymmetry this task's closing section already identifies. Reword item 4 from "wire the
   denominators" to "project the denominators that the prose already carries".

3. **`documentsTotal: 864` in the proposed shape is a frozen number.** The live count differs. Replace
   the literal in the JSON example with a note that the value comes from
   `getCorpusDenominator(context, scopeIds)` at call time.

4. **The task's opening example is stale *text*, not just a stale line number — and this strengthens
   the task.** The quoted warning ending *"so this answer is exhaustive: the absence is proven, not
   merely unreached"* **no longer exists in the emitted prose.** The current wording is
   `scan-for-pattern.ts:1157` (*"…the candidate pool was not capped, so this answer is exhaustive over
   the …"*) and `:1177`. The old sentence survives only in comments and in **negative test
   assertions** — `src/lib/mcp/__tests__/corpus-denominator.test.ts:56` and
   `src/lib/mcp/tools/__tests__/scan-for-pattern-full-scan-denominator.test.ts:267, :280, :287` all
   assert `not.toMatch(/the absence is proven/i)`; `src/lib/mcp/corpus-denominator.ts:185` describes
   `provenAbsenceClause` as *"the clause that **replaces**"* it.

   So the exact substring this task holds up as the thing callers latch onto **has already been
   rewritten once, and a test now forbids its return.** That is the argument for the task, made
   empirically: a caller written against the v12-era string is already broken today, silently, with no
   error and no version signal — which is precisely the failure `completenessVersion` (item 6) exists
   to prevent. Update the quoted block to the current wording and cite this history beside it.

**UNVERIFIABLE without a run** — item 7a's "a deliberately absurd query still returned three passages
scoring 0.73". Settle it by issuing an off-corpus `query_case_knowledge` and recording the score
distribution; the design guidance (design for the confident-irrelevant case, not the empty one) does
not depend on the exact figure.

**Revised disposition — keep P0, keep the shape, refresh the citations.** Nothing here is refuted on
substance. Before item 1 is started, re-derive the variable table from source rather than from this
file, and rewrite item 4 per point 2 above.

## Problem

A caller today determines whether an answer is exhaustive by **string-matching English warning
prose** — looking for `"capped"`, or for `"the absence is proven, not merely unreached"`. v12 did
exactly this and flagged it as brittle. It is worse than brittle: the stable substring a caller
latches onto sits in the **tail of an interpolated sentence**
(`src/lib/mcp/tools/scan-for-pattern.ts:1104-1112`):

```ts
`Keyword recall returned no candidates for [${ftsKeywords.join(', ')}]. ` +
'Every branch of this pattern contributes a keyword the index can match and the candidate pool ' +
'was not capped, so this answer is exhaustive: the absence is proven, not merely unreached.'
```

So any rewording silently breaks every caller, with no error and no version signal. There are **15
distinct warning strings** in the file, all pushed into `const warnings: string[]` (`:832`).

## The task is smaller than v12 implies for one tool, and larger for the other

This is the correction that matters for planning. v12 §6 sizes item 3 as a single **S**. The two tools
are not symmetric.

**`scan_for_pattern` already returns half of it.** `scan-for-pattern.ts:1344-1352`:

```ts
    return {
      results: enrichedResults,
      strategy,
      ...(candidatePool !== undefined ? { candidatePool } : {}),
      ...(scanned !== undefined ? { scanned } : {}),
      ...(truncated ? { truncated } : {}),
      ...(nextCursor ? { nextCursor } : {}),
      warnings,
    };
```

`strategy` is already the method indicator (`'fts+regex'` | `'full-scan'`, `:988`), and `scanned`,
`truncated` and `candidatePool` are already there. What is missing is the **exhaustive/proven
boolean**, the **document denominators**, and **`caveats`**.

**`query_case_knowledge` computes none of it.** Its entire assembly is
`query-case-knowledge.ts:708` — `return { results: enrichedResults };`. No `warnings[]`, no cursor,
no truncation signal, no strategy. Giving it a `completeness` object means **deriving facts that do
not currently exist**, which is a materially larger change than projecting existing state.

## The blocker: the facts are out of scope at the return

The variables the object needs are **block-scoped inside branches** and are not live at `:1344`:

| Variable | Declared | Meaning | In scope at return? |
|---|---|---|---|
| `strategy` | `:988` | `'fts+regex'` \| `'full-scan'` | ✅ |
| `candidatePool` | `:990` | FTS candidates before regex post-filter | ✅ |
| `scanned` | `:991` | chunk rows read (full-scan only) | ✅ |
| `truncated` | `:992` | stopped on time box / `SCAN_MAX_ROWS` | ✅ |
| `nextCursor` | `:993` | page token | ✅ |
| `poolCapped` | `:1075` | `searchResults.length >= fetchLimit` | ❌ inside `else` at `:1031` |
| `fetchLimit` | `:1041` | `verify ? wanted * 5 : wanted + 1` | ❌ inside `else` at `:1031` |
| `pageFills` | `:1095` | page filled to the requested limit | ❌ inside `else` at `:1092` |
| `willEscalate` | `:1098` | capped-page rescue trigger | ❌ inside `else` at `:1092` |
| `provenAbsence` | `:1101` | `coveredKeywordSet && !poolCapped && !willEscalate` | ❌ inside `else` at `:1092` |
| `coveredKeywordSet` | `:975-976` | every branch yields an index-reachable keyword | ✅ |
| `ftsKeywords` | `:941-943` | folded whole tokens sent to FTS | ✅ |
| `verify` | `:919-920` | returned rows were regex-checked | ✅ |
| `scanSupported` | `:978` | store exposes `scanTextColumn` | ✅ |

**Five variables must be hoisted to the `:988-993` block first.** That is a mechanical but real
refactor, and it is why this is not a purely additive change.

## Proposed shape

Emitted alongside — never instead of — `warnings`. The prose is what an operator reads; this is what
a caller branches on.

```jsonc
"completeness": {
  "exhaustiveOverIndex": true,    // scoped name — see "Two claims, two fields" below
  "method": "full-scan",          // from `strategy`
  "verified": true,               // from `verify` — rows regex-checked, not raw BM25
  "scanned": 35890,               // chunk rows actually read
  "candidatePool": 0,             // FTS candidates before post-filter
  "poolCapped": false,
  "truncated": false,             // time box / SCAN_MAX_ROWS
  "provenAbsence": true,          // the boolean behind the sentence
  "coveredKeywordSet": true,
  "corpusChunks": 35890,          // ← task 23
  "documentsSearched": 96,        // ← new instrumentation, see below
  "documentsTotal": 864,          // ← task 23
  "corpusCoverage": 0.111,        // documentsSearched / documentsTotal — machines gate on this

  "caveats": ["chunk-boundary-spanning phrases not detectable"]   // ← task 21, while it stands
}
```

## Two claims, two fields — and why there is no threshold

The object makes **two separate claims**, and the whole design turns on not merging them.

**`exhaustiveOverIndex` stays `true` when the search really was exhaustive.** It is a property of the
*search*, and the search genuinely did read every indexed chunk. Flipping it to `false` because
corpus coverage is low would be inaccurate in the other direction, and would destroy a signal callers
actually need: distinguishing *"I scanned everything available"* from *"I gave up at a cap."* Those
are different failures and a caller must be able to tell them apart.

**`corpusCoverage` carries the other fact** — what fraction of the corpus the index represents. Two
fields for two claims is the same discipline as splitting `retrievalScore` from `rerankScore` in
[task 22](./22-rerank-observability.md): one number that means two things is a number that means
neither.

**The name is scoped deliberately.** `exhaustiveOverIndex` beats `exhaustive` for the same reason
`speakerBasis` beats an unexplained `speaker` ([task 28](./28-server-side-speaker-attribution.md)) —
an unqualified name drifts toward the broader reading every time someone new reads it, and this
project's recurring defect is exactly that: technically-true statements being read as broader ones.
The qualifier is not verbosity; it is the fix.

### Why a coverage threshold was rejected

The alternative considered was suppressing the confident wording below some coverage fraction. It was
rejected **in principle, not on the difficulty of picking the number**:

- **Any threshold below 1.0 is wrong.** An absence is proven *of the corpus* only at complete
  coverage. At 99% it is exactly as unproven as at 11% — only less obviously so.
- **A threshold creates a cliff** where the wording flips back to confident while the claim is still
  false.
- **It teaches operators the wrong meaning.** They would learn that "proven" means "coverage cleared
  the line", which is not what they will hear in the word.

That is the same bug in a milder, better-hidden form. The wording rule in
[task 23](./23-corpus-status-and-denominators.md) item 6 needs **no threshold at all**: the sentence
has the same shape at 11% and at 100%, and only the numbers move. When `documentsSearched ===
documentsTotal` it reads as a corpus-wide proof on its own, with no rule firing — nothing to choose,
nothing to defend, no cliff.

### Said plainly

**If the real indexed fraction is near 11%, wording is damage control, not a fix.** No sentence
rescues a corpus that is 89% unsearchable. This task stops the tool overclaiming; it does not make
the answers complete. The ingestion backlog is the thing actually standing between this system and a
negative finding that could be put in a filing, and neither this task nor
[task 23](./23-corpus-status-and-denominators.md) shortens it.

**`documentsSearched` does not exist and cannot be faked.** `scan_for_pattern` has no distinct-document
count, searched or returned. The nearest data are `scanned` (chunk rows, full-scan only) and distinct
`result.metadata.documentId` over **returned** rows (`:1216`, `:1323`) — which is a different
quantity and must not be relabelled as the denominator. `src/lib/vector/vector-store.ts:460` exposes
`scanTextColumn` but no count API. This field needs new instrumentation or must be omitted; omitting
is honest, guessing is not.

## Work

| # | Item | Status |
|---|---|---|
| 1 | **Hoist** `poolCapped`, `fetchLimit`, `pageFills`, `willEscalate`, `provenAbsence` to the `:988-993` declaration block, initialised to `undefined`. Pure refactor — no behaviour change, existing tests must pass untouched. | ☐ |
| 2 | **Add `completeness` to `ScanForPatternResult`** (`scan-for-pattern.ts:53-86`) and to the return at `:1344-1352`. Keep every existing field and all 15 warnings exactly as they are. | ☐ |
| 3 | **Count distinct documents actually covered** during a full scan, in `runFullScan` (`:786-806`) where rows are already being read. Under `fts+regex` the honest value is the distinct documents in the candidate pool — label the two cases differently or omit. Do not conflate with returned-row documents. | ☐ |
| 4 | **Wire the corpus denominators** from [task 23](./23-corpus-status-and-denominators.md): `corpusChunks`, `documentsTotal`. `exhaustive: true` must not be emitted without them once they are available. | ☐ |
| 5 | **Emit `caveats`** carrying the chunk-boundary limitation while [task 21](./21-chunk-overlap-defect.md) is open. This is the machine-readable form of a known-unsound negative, and it should disappear from the payload the day task 21 lands — not linger as stale prose. | ☐ |
| 6 | **Add a `completenessVersion` integer** (start at `1`). The whole point is that callers stop guessing; a version lets the shape change later without silently breaking them, which is the exact failure being fixed. | ☐ |
| 7 | **`query_case_knowledge`: decide scope explicitly.** It has no warnings, cursor or truncation signal to project. Either (a) derive a minimal honest object (`method`, `verified: false`, `rerankApplied` from [task 22](./22-rerank-observability.md), `limit`/`returned`), or (b) emit nothing and document that this tool makes no completeness claim. **Do not emit `exhaustive` from a top-k semantic search** — it is never exhaustive, and a field saying so would be the same over-claim in a new place. | ☐ |
| 7a | **The bare silent zero — and the thing that actually happens instead.** Audit finding 2026-09-08: `query_case_knowledge` returns a zero with no warning, cursor or denominator. But a follow-up could **not reproduce an empty result at all** — a deliberately absurd query still returned three passages scoring 0.73. Semantic search essentially never returns empty, so the empty case is rarer than it looks and **the real failure mode is worse**: a confident, irrelevant, non-empty result with nothing attached either. Design for that case, not the empty one. A relevance floor, or a `completeness` that reports what the scores actually were, beats a marker for a branch that rarely fires. | ☐ |
| 8 | **Update the skill.** `skills/soundsuite-mcp/SKILL.md` documents the string-matching method; replace it with the field, and keep one line explaining the warnings remain for humans. | ☐ |

## The asymmetry that argues for this task most directly

Verified live 2026-09-08, after [task 33](./33-full-scan-denominator-gap.md) landed:

| Full-scan answer | Where the completeness statement lives |
|---|---|
| **Zero results** | a **per-call** warning naming the scoped denominator |
| **Non-zero results** (e.g. 29 rows, no cursor, `scanned: 35890`) | only the **tool description**, read once per session |

`noteFullScanAbsence` deliberately skips the non-zero case, and that is correct — a non-zero result is
not an absence claim, so it should not carry an absence sentence. The description was amended to say
"complete OVER THE INDEX" so the contract covers both.

**But a caller that inspects `warnings[]` — which is what the skill teaches, and what callers actually
do — sees a denominator on one branch and silence on the other.** The honesty of an answer should not
depend on which branch produced it, and a caller should not have to remember a sentence from a
description to interpret a payload. A `completeness` object is emitted on every answer regardless of
branch, which is the whole point: it makes the guarantee structural rather than editorial.

## A blind spot a structured field does not close

Audit finding, 2026-09-08, recorded because it is invisible to every method used so far.

A sweep of string literals found no other tool making an undenominated corpus-wide absence claim. But
two surfaces emit absence prose that **no literal sweep can see, because a model writes it at
runtime**:

- `research_evidence` emits **`gaps`**
- `routed/run-report.ts` emits **report prose**

A model writing *"no evidence found for section X"* is an undenominated corpus-absence claim by
construction — and it is the claim most likely to be pasted into something that matters. The static
surface for both is clean; the generated surface is unaudited and, as things stand, unauditable by
the technique that found everything else.

This is not solved by `completeness` on a tool response: the field would sit beside prose that
already over-claims. It needs either a denominator injected into the generation context, or a
post-generation check. **It deserves its own task**; noted here so it is not lost, and because it is
the reason a structured field is necessary but not sufficient.

## Risks

- **Three test files assert on the warning prose** and must keep passing unchanged, because item 2
  changes nothing about it: `scan-for-pattern-branch-recall.test.ts` (proven-vs-bounded strings incl.
  a negative `BOUNDED` regex), `scan-for-pattern-phrase-matching.test.ts` (a capped filtered page
  never claims proven/exhaustive), `scan-for-pattern-regex.test.ts` (strategy/candidatePool/scanned on
  rescue paths). If item 1's hoist breaks one, the hoist is wrong — do not edit the test.
- **`provenAbsence` and `exhaustive` are not synonyms.** `provenAbsence` is about a *zero-result*
  answer; a non-empty exhaustive full scan is also exhaustive. Model both, or the field will be wrong
  for every answer that found something.
- **The prose and the object must never disagree.** Derive both from the same hoisted variables in the
  same place. Two independent derivations will drift, and a caller comparing them will trust the
  wrong one.
- **Do not add a `fields` projection in this task.** It is [task 31](./31-result-size-economy.md) and
  it interacts with `completeness` (a projected response is still complete about what it scanned).
  Keeping them separate keeps this one small.

## Acceptance

| Check | Expected |
|---|---|
| A zero-result scan over a fully covered, uncapped keyword pass | `completeness.provenAbsence: true`, `exhaustive: true`, and the existing prose unchanged |
| A capped page | `poolCapped: true`, `exhaustive: false`; prose and object agree |
| A time-boxed scan | `truncated: true`, `exhaustive: false`, `nextCursor` present |
| A keyword-mode answer | `verified: false` |
| Any answer, while task 21 is open | `caveats` contains the chunk-boundary entry |
| Any `exhaustive: true` answer, after task 23 | carries `documentsTotal` |
| All three existing scan test suites | pass unchanged |
| A caller written against `completeness` | needs no string matching to decide exhaustiveness |

## References

- `src/lib/mcp/tools/scan-for-pattern.ts:53-86` (result interface), `:663-724` (input schema,
  JSON-schema literal), `:832` (warnings array), `:786-806` (`runFullScan`), `:975-1179` (the fact
  computations), `:1344-1352` (assembly)
- `src/lib/mcp/tools/query-case-knowledge.ts:104-167` (input schema), `:527` (`distinctDocs`, pool not
  corpus), `:708` (assembly)
- `src/lib/mcp/base-tool.ts:243-248` — outer `{ success, data, executionTimeMs }` wrapper, unchanged
- `src/lib/vector/vector-store.ts:460` — `scanTextColumn`, no count API
- [`23-corpus-status-and-denominators.md`](./23-corpus-status-and-denominators.md) — supplies the denominators
- [`22-rerank-observability.md`](./22-rerank-observability.md) — supplies `rerankApplied`
- [`21-chunk-overlap-defect.md`](./21-chunk-overlap-defect.md) — the caveat this object must carry
