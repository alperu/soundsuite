# `scan_for_pattern` — alternation recall, honest exhaustion, and speaker attribution

**Status:** Implemented 2026-09-07 (items 1, 3, 5, 7, 8) · **Effort:** M · **Priority:** High
**Owner agent:** `.claude/agents/scan-recall-engineer.md`
**Report:** [`../MCP-Improvements/REPORT-v8-speaker-attribution-and-alternation-recall.md`](../MCP-Improvements/REPORT-v8-speaker-attribution-and-alternation-recall.md)

All ids and patterns in this file are synthetic. No case names, docket numbers, or person names.

## Problem

Three defects, one documentation error, measured on the live corpus.

1. **An alternation of transcript boilerplate returns zero results.** `(MR\.|MS\.|THE COURT)` matches
   a large fraction of every reporter's record we hold and returns nothing, with
   `Keyword recall returned no candidates for [THE]`.
2. **An exhausted cursor does not mean an exhausted corpus.** A scan can page to a `nextCursor`-free
   final page while still reporting `Keyword recall was capped at 2000 candidates`. No negative
   finding is defensible under that combination.
3. **We told operators speaker attribution is impossible, and it is not.** Speaker labels live in the
   chunk text even though the `speakers` column is null.

## Root cause (verified in source)

### The zero-result alternation, in three composing steps

**Step 1 — `safeKeywords` keeps the worst branch and drops the rest**
(`src/lib/mcp/tools/scan-for-pattern.ts`). For `(MR\.|MS\.|THE COURT)` the literal runs are
`MR`, `MS`, `THE`, `COURT`:

- `MR`, `MS` → dropped by `run.text.length < 3`.
- `COURT` → `)` on its right sets `rightClean = false`, so it falls to the rescue test, which runs
  against the **whole pattern**: `` regex.test(`aa ${run.text} zz`) ``. `"aa COURT zz"` can never
  match `(MR\.|MS\.|THE COURT)`. Dropped.
- `THE` → survives.

**Step 2 — the survivor is a stopword.** The FTS index is created with `removeStopWords: true`
(`src/lib/vector/vector-store.ts:257`). `MatchQuery('THE', …)` carries no searchable term, so FTS
returns zero rows. The tool cannot distinguish this from "the term is genuinely absent".

**Step 3 — alternation is barred from the rescue.** `scan-for-pattern.ts:572`:

```ts
const zeroCandidateEligible = !!regex && !/\s/.test(pattern) && !pattern.includes('|');
```

`|` disqualifies the pattern from the zero-candidate full-scan fallback unconditionally. The guard's
*intent* (documented in the comment above it) is to stop bare natural-language dashboard queries from
triggering a pointless linear pass, and that intent is correct.

**The fix is not to loosen this line.** It was left exactly as it stands. Branch coverage decides
*before* the FTS query runs, so a pattern like `(MR\.|MS\.|THE COURT)` full-scans up front and never
reaches this guard. That keeps the guard doing its real job — protecting the dashboard path, where a
fully covered alternation returning zero candidates is trustworthy evidence of absence — while the
uncovered-branch case, which is the one that was losing evidence, no longer depends on it.

### The unsound terminal state

The cap warning and `nextCursor` read different quantities:

- cap warning fires on `searchResults.length >= fetchLimit` (candidate pool truncated)
- `nextCursor` is set on `matchedResults.length > limit` (post-filtered matches remain)

`fetchLimit = (pageOffset + limit) * 5` does grow per page, so paging genuinely widens recall — unlike
`caseId` scoping, which does not (see [task 12](./12-multi-case-scoping-and-param-typing.md)). But the
tool stops offering a cursor at exactly the moment it declares recall bounded, so "no cursor" cannot
be read as "complete".

### The documentation error

`skills/soundsuite-mcp/SKILL.md` §7 asserts speaker attribution "is not retrievable" and that
attribution "must come from the page image or an existing citation". The premise (`speakers` is null)
is true; the conclusion is false. Labels are printed in the chunk text by the reporter's record
itself. Scanning for the label and splitting each chunk on the label boundary yields turns attributed
from the transcript — measured at 268 label-bearing chunks → 104 distinct turns for one speaker.

## Work items

| # | Item | Status |
|---|---|---|
| 1 | ✅ **Per-branch keyword extraction.** Split an alternation at top-level `\|` and extract keywords from **every** branch; the FTS `MatchQuery` ORs the union. A branch that contributes no usable keyword makes the whole pattern full-scan-eligible — never a silent partial recall. Shipped as `hasUncoveredBranch`. | ✅ |
| 2 | ⏸ **Fix the `safeKeywords` rescue test.** *Deferred to a follow-up.* Item 1 already resolves the reported case up front, so this test is never consulted for it; it only improves keyword quality for non-alternation patterns, and it edits `literalRuns`, the most delicate function in the file. Sequence it behind its own tests. Test a non-clean run against **the branch it came from**, not the whole pattern, so a multi-word branch like `THE COURT` can validate. | ⏸ deferred |
| 3 | ✅ **Stopwords belong on the control path.** An earlier draft of this row called stopword detection unnecessary, on the reasoning that a stopword-only keyword set yields zero candidates and the zero-candidate rescue would catch it. That holds only when the *entire* set is stopwords. It fails when *some* branches are stopword-only and others are not: in `\bthe\b\|\bcourt\b` both branches yield a ≥3-char literal, `court` returns candidates so no rescue ever fires, and the `the` branch is silently unreachable. Branch coverage therefore requires a **non-stopword** keyword per branch, via `FTS_STOPWORDS` (tantivy's English set). A superset is the safe direction: an extra word costs a full scan, a missing one costs evidence. | ✅ |
| 4 | ~~**Replace the `\|` exclusion with `looksLikeRegex`.**~~ **Wrong as written — do not implement.** The existing suite pins `\babsentone\b\|\babsenttwo\b` to the FTS path with `scanTextColumn` *not* called, and `looksLikeRegex` would flip it to a linear scan on the dashboard's hot path. That test encodes a correct rule: when every branch contributed a real, non-stopword whole token, zero candidates is *trustworthy* evidence of absence and a linear pass would only be slower. Branch coverage (item 1) is the right discriminator, and it makes this change unnecessary — `zeroCandidateEligible` was left untouched. | ❌ superseded |
| 5 | ✅ **Make exhaustion honest.** When the candidate pool came back capped, either keep emitting `nextCursor` until an uncapped page proves exhaustion, or escalate to `full-scan`. Absence of a cursor must mean the answer is complete. Shipped as escalation, chosen over a paging multiplier because paging a capped pool assumes BM25 returns a stable prefix-superset as `limit` grows, which LanceDB does not guarantee. Escalation fires only when the pool capped **and** the page did not fill, so the common case keeps its cursor and its speed. | ✅ |
| 6 | ☐ **Run the structure backfill.** *Not run — operational, needs a backup and your go-ahead.* `POST /api/admin/structure-backfill` already stamps `speakers` from `PageCache.structuredJson` by printed-line interval, with no re-embedding and byte-identical chunk text. Run it over the corpus and record coverage; text-scanning stays the documented fallback for chunks it cannot align. | ☐ |
| 7 | ✅ **Correct `SKILL.md` §7.** Replace the "not retrievable" claim with the measured method and its real limit (a chunk opening mid-turn loses only its first partial turn). Re-sync the quoted warning strings, which have drifted. Section retitled, since "What the index cannot tell you" contradicted the corrected block. | ✅ |
| 8 | ✅ **Tests, one tripwire per row.** Including: an alternation of short/stopword/`)`-adjacent branches returns matches; a stopword-only extraction full-scans; a capped pool never terminates without a cursor; a bare multi-word phrase still does **not** full-scan. Shipped in `scan-for-pattern-branch-recall.test.ts`; verified 6 of 10 fail against the pre-fix source. | ✅ |

## Risks and open questions

- **Full-scan cost.** Widening full-scan eligibility to alternations increases linear passes. The
  existing time box and `truncated` flag cover it, but item 4 should be measured against the largest
  case before merge.
- **Do not reintroduce stopword detection as a gate.** LanceDB's English stopword set is not exported
  to us, and any hardcoded copy would drift from the index. Item 4 makes detection unnecessary for
  correctness — zero candidates is the signal, whatever produced it. Keep stopwords out of the
  control flow and confine them to warning text.
- **Item 5 changes a contract.** Callers currently treat a missing cursor as done. Emitting more
  cursors is the safe direction (a caller that stops early is no worse off than today), but the
  dashboard's paging loops should be checked for an unbounded `do/while`.
- **Backfill alignment rate is unknown.** The route skips misaligned chunks rather than guessing,
  which is correct. If alignment on reporter's records is poor, item 6 delivers less than item 7's
  documented text-scan method — so do not gate the `SKILL.md` correction on the backfill.

## How to measure success

| Check | Expected |
|---|---|
| `scan_for_pattern` with `(MR\.\|MS\.\|THE COURT)` | non-zero results, strategy `full-scan` or per-branch `fts+regex` |
| Any page carrying a cap warning | also carries a `nextCursor` |
| A scan that ends with no `nextCursor` | carries **no** cap warning |
| A bare multi-word natural-language query | still `fts+regex`, no linear pass |
| `speakers` non-null coverage on reporter's records | reported as a number, before and after item 6 |

## Privacy

Test fixtures synthetic. Speaker-label patterns are transcript boilerplate (`MR\.`, `THE COURT`) and
carry no case data; never commit a surname pattern, a corpus file name, a page number, or a quoted
transcript line.

## Ownership

`mcp-profile-engineer` for items 1–5 and 8 (`src/lib/mcp/tools/scan-for-pattern.ts`). Item 6 is an
operational run against the live index — back up first, and it must not re-embed. Item 7 is
documentation.
