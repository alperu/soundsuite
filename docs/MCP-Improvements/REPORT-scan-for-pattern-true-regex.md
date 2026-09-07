# `scan_for_pattern` — true regex scan

**Task:** `docs/tasks/11-scan-for-pattern-true-regex.md` · **Date:** 2026-09-07 · **Status:** complete

All patterns, names and counts below are synthetic or generic. `unbeknownst` is an ordinary English
word chosen because it exercises the class/fragment shapes; nothing here comes from a document.

## 1. The defect

| pattern | before | after |
|---|---|---|
| `unbeknownst` (literal token) | 37 | 37 |
| `[Uu]nbeknownst` (character class) | **0** | **37** |
| `nbeknownst` (mid-word fragment) | **0** | **37** |
| frequent token, limit 200 | capped, no way to page | 200 + `nextCursor` |

Zero was returned **silently** — `{results: []}` with nothing to say recall had never run. On
litigation material that reads as "the record does not contain this".

## 2. Root cause

`scan-for-pattern.ts` was FTS recall bounded by literal-keyword extraction with the regex as a
post-filter: `extractKeywordsFromPattern()` → BM25 `MatchQuery` (`fetchLimit = limit × 5`) →
`regex.test(result.text)`. BM25 matches whole index tokens; `[Uu]nbeknownst` extracts the run
`nbeknownst`, a *fragment* of the token `unbeknownst`, which matches no term — zero candidates, so
the regex never ran. The existing `logger.warn` fired only when candidates existed and were all
rejected, never on the zero-candidate path.

**The 60 ceiling was client-supplied.** No cap exists in `tool-registry.ts`, the execute/tools
routes, the bridge, or the two live callers (`/api/search/pattern` limit 50, `/api/search/ai`
limit 30). A live probe at `limit: 200` returns 200 rows plus a `nextCursor`. Pagination was still
required — `limit` was the whole answer, not a page.

## 3. Trigger rule

Full scan runs when the regex compiled AND any of:

- **(a)** the pattern is regex-like and no literal run survives as a whole index token —
  `[Uu]nbeknownst`, `(Unbe|unbe)knownst`;
- **(b)** FTS returned zero candidates AND the pattern is a single expression (no whitespace, no
  alternation) — the bare fragment `nbeknownst`;
- **(c)** the caller passed a `full-scan` cursor.

(b) is deliberately narrow. Multi-word natural language and the `\bfoo\b|\bbar\b` shape that
`/api/search/ai` builds never full-scan on zero candidates — a linear pass would find no more and
would cost seconds on every dashboard search. **Dashboard search behaviour is unchanged**; those
callers stay on `fts+regex` and only gain `warnings[]`. Tripwires assert both directions.

"Whole index token" is decided by `literalRuns()` / `safeKeywords()`: a run of `[A-Za-z0-9_]` is a
token if both flanks are boundaries (`\b`, `\s`, whitespace, `|`, `^`, `$`, escaped punctuation,
pattern edge), or if the compiled regex still matches the run standing alone between separators —
the rescue that keeps `\bfoo\b|\bbar\b` on FTS. Classes, groups, `.` and quantifiers count as
possibly token-extending.

## 4. Result shape

`results[]` unchanged (all callers keep working). Added:

- `strategy: 'fts+regex' | 'full-scan'` — always present
- `candidatePool?` (FTS candidates pre-filter) / `scanned?` (rows read)
- `truncated?`
- `nextCursor?` — absent means end of answer
- `warnings: string[]` — empty means the answer is believed complete

Warnings fire on: no whole-token keyword; zero FTS candidates (with and without a scan); FTS pool
capped at `fetchLimit`; post-filter dropping every candidate; time box hit; store unable to scan.

Results also carry `caseId` and, where resolvable, `motionId` (shared `attachMotionIds` helper from
the discovery-tools stream, applied to the returned page only).

### 4a. Motion integration

`attachMotionIds` (shared `src/lib/mcp/motion-resolution.ts`) is awaited **once**, on the enriched
final page only — after the regex post-filter and after pagination — so it never sees the candidate
pool: one batched `motion.findMany` per call regardless of page size, and paging never re-resolves
rows the caller already has. Best-effort by contract: a missing `Motion` table ships results without
`motionId` rather than failing the query. `scanTextColumn` selects `case_id` and `filing_id`, so
provenance resolves identically on the full-scan path — live, all three pattern forms returned
37/37 with `caseId` and 12/37 with `motionId`, across both strategies. Three tripwires pin this
(one query on full-scan; page-only resolution at `limit: 2`; no covering motion leaves `motionId`
undefined while `caseId` is still stamped).

## 5. Pagination

`limit` bounds a page (default 10, max 200); `cursor`/`nextCursor` bound the answer. The cursor is
base64url JSON `{s, o, p}` — `o` is a matched-list index on the FTS path and a **row offset** on the
full-scan path, so a page truncated mid-scan resumes at the first unscanned row rather than
skipping it. A cursor whose `p` (pattern + caseId fingerprint) mismatches is rejected with
`INVALID_PARAMS`.

## 6. Safety limits

- `catastrophicReason()` rejects with `INVALID_REGEX` in `validateParams`, before any scan:
  quantified lookbehind, and a quantified group whose body has an unbounded quantifier and no
  mandatory anchoring atom. Verified: reject `(a+)+b`, `(x*)*y`, `(?<=a*)b`, `(\d+)+`,
  `(\s*\w*)*`; accept `(a|b)+`, `(Exhibit)+`, `(\d{4})+`, `(No\.\s*\d+)+`,
  `\bMotion\b|\bOrder\b`. The first cut rejected `(No\.\s*\d+)+` — a false positive on a plausible
  legal pattern — fixed and tested.
- Full scan: batch 1000 rows, 10 s time box, 250,000-row ceiling. Exceeding either returns partial
  results with `truncated: true`, a warning and a cursor — never a hang, never a silent short answer.
- `scanTextColumn` scopes by `caseId` and caller `whereClauses` exactly as FTS does, so the
  full-scan path cannot widen scope.

## 7. Live verification (`:3000`, profile `local`) — counts and timings only

| probe | results | strategy | scanned | time |
|---|---|---|---|---|
| `unbeknownst`, limit 200 | 37 | fts+regex (pool 37) | — | 1.1 s |
| `[Uu]nbeknownst`, limit 200 | **37** | full-scan | 35,890 | 0.9 s |
| `nbeknownst`, limit 200 | **37** | full-scan (pool 0) | 35,890 | 1.9 s |
| frequent token, limit 200 | 200 + nextCursor | fts+regex | — | 1.3 s |
| `(No\.\s*\d+)+`, limit 200 | 200 | full-scan | 9,460 | 0.3 s |

Full-scan pagination, `[Uu]nbeknownst` at limit 10: 4 pages (10/10/10/7), 37 total, 37 distinct —
no overlap, no gap; 321/553/225/38 ms. `(a+)+b` → HTTP 400 `INVALID_REGEX`. A full linear pass over
the ~36k-chunk corpus costs ~1–2 s, well inside the 10 s box.

## 8. Tests

`src/lib/mcp/tools/__tests__/scan-for-pattern-regex.test.ts` — 19 tests. Doubles are plain objects
cast once at the boundary; the FTS double matches whole tokens only, which is what reproduces the
defect. Coverage: one tripwire per defect-table row; alternation-of-fragments; "never silently
empty"; zero-candidate warning; both dashboard shapes staying on FTS; store-cannot-scan caveat;
full-scan and FTS pagination with no overlap; cursor/pattern mismatch; page cap; `caseId` +
`whereClauses` reaching the scan; catastrophic rejects and anchored-group accepts; time-box partial
+ warning + cursor.

## 9. Left undone

- A stray NUL byte was found in this file's `cursorKey` template separator during reconciliation and
  replaced with `|`. Worth knowing: a NUL silently turns `grep` into binary mode and would have hidden
  the file from any text search of the repo.

- `strategy` / `warnings` / `nextCursor` are not surfaced in `mcp-result-renderer.tsx` or
  `/api/search/pattern`'s response. Dashboard Pattern-mode operators get corrected results but not
  the caveats.
- Time box / batch size are module constants, not config-driven. Past ~200k chunks a single page
  will start truncating; the cursor makes that recoverable but noisy.
- `scan_for_pattern` declares no `profiles` in its metadata (nor does `query_case_knowledge`) —
  pre-existing; the profile gate resolves from routing defaults, not the tool.
