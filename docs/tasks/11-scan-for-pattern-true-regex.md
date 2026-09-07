# `scan_for_pattern` — make it a real regex scan

**Status:** Implemented (2026-09-07) · **Effort:** M · **Priority:** High · **Source:** operator report (a live session, 2026-09-07)

## The defect, measured

From a live session using the served MCP client against the running instance (values synthetic here):

| pattern | hits | expected |
|---|---|---|
| `unbeknownst` | 37 | 37 |
| `[Uu]nbeknownst` | **0** | 37 |
| `nbeknownst` (mid-word fragment) | **0** | 37 |
| `SURNAME` (frequent token) | 60 — **hit the cap**, target rows missing | all, or a page cursor |

Character classes and fragments **silently return nothing instead of erroring** — a false negative
that quietly costs a search. On litigation material, "no hits" is read as "the record does not
contain this", so a silent recall failure is the worst behaviour this tool can have.

## Root cause (verified in `src/lib/mcp/tools/scan-for-pattern.ts`)

The tool is not a regex scanner. It is **FTS recall bounded by literal-keyword extraction, with the
regex applied only as a post-filter**:

1. `extractKeywords(pattern)` pulls literal runs out of the regex.
2. Those go to LanceDB FTS (`MatchQuery`, BM25, tokenized, case-folded, OR) with `fetchLimit = limit × 5`.
3. `new RegExp(pattern, 'i').test(result.text)` filters the candidates.

Any pattern whose literal parts are not whole index tokens yields **zero candidates**, and the regex
never runs. The existing `warn` ("regex post-filter dropped all FTS candidates") fires only when
candidates existed and were all rejected — not when recall itself returned nothing.

## Work items

| # | Item | Status |
|---|---|---|
| 1 | **True regex fallback**: when keyword extraction yields no usable whole-token keywords, or FTS returns 0 candidates, run the regex over the full chunk text column (bounded scan, `caseId`-scoped when given) instead of returning nothing | ✅ |
| 2 | **Never silent**: every result carries `strategy: 'fts+regex' \| 'full-scan'` and `candidatePool` / `scanned` counts, and a `warnings[]` entry whenever recall may be bounded | ✅ |
| 3 | **Pagination over a hard cap**: replace the 60 ceiling with `cursor` / `nextCursor`; `limit` bounds a page, not the answer | ✅ |
| 4 | Keyword extraction handles alternation and classes sensibly (e.g. `[Uu]nbeknownst` → keyword `nbeknownst` is useless; recognise it and go to full-scan) | ✅ |
| 5 | Regex safety: reject catastrophic patterns (nested quantifiers) with `INVALID_REGEX`; time-box the full scan | ✅ |
| 6 | Tests in the SS-3 style: a tripwire per row of the table above | ✅ |
| 7 | Report in `docs/MCP-Improvements/` | ✅ |

## Ownership

Owns `src/lib/mcp/tools/scan-for-pattern.ts`, `src/lib/search/boolean-to-fts.ts` (keyword
extraction if it lives there), a **new, additive** scan method on `src/lib/vector/vector-store.ts`
(another live stream may also touch that file additively — check `git diff` first, add only, do not
reformat), and `src/lib/mcp/tools/__tests__/scan-for-pattern*.test.ts`.

Does not touch `src/app/api/**`, the 10 LLM tools, `ai-helper.ts`, `base-tool.ts`, discovery tools.

## Privacy

The operator's report contains a real surname and a real phrase. **Neither appears in this file, in
tests, in fixtures, or in the report.** Synthetic patterns only.

## Outcome

`[Uu]nbeknownst` 0 → 37, `nbeknownst` 0 → 37; full scan ~1–2 s over ~36k chunks; cursor pagination; catastrophic patterns rejected. The 60 cap was client-supplied. See `docs/MCP-Improvements/REPORT-scan-for-pattern-true-regex.md`.
