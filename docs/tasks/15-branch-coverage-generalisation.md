# `scan_for_pattern` — generalise branch coverage beyond alternations

**Status:** Done (2026-09-07) · **Effort:** S · **Priority:** Critical · **Created:** 2026-09-07
**Owner agent:** `.claude/agents/scan-recall-engineer.md`
**Supersedes the guarantee in:** [`../MCP-Improvements/REPORT-v8-…md`](../MCP-Improvements/REPORT-v8-speaker-attribution-and-alternation-recall.md) §8
**Report:** [`../MCP-Improvements/REPORT-v9-branch-coverage-generalisation.md`](../MCP-Improvements/REPORT-v9-branch-coverage-generalisation.md)

All ids and patterns in this file are synthetic. No case names, docket numbers, or person names.

## Problem

Task 14 fixed the reported defect and not the class it belongs to. Measured against the live server:

| Pattern | limit | n | strategy | pool | verdict |
|---|---|---|---|---|---|
| `(MR\.\|MS\.\|THE COURT)` | 20 | 20 | full-scan | — | ✅ fixed by task 14 |
| `[Cc]ould not do` | 20 | 0 | fts+regex | 0 | ❌ **false negative** |
| `[Cc]ould not do` | 100 | 0 | fts+regex | 0 | ❌ same |
| `[Cc]ould [Nn]ot d[o]` | 20 | 1 | full-scan | 35,890 | control — **the phrase exists** |
| `[Tt]he was not` | 20 | 0 | fts+regex | 0 | ❌ keywords `[was, not]` |
| `(unbeknownst\|safeguarding)` | 20 | 20 | full-scan | — | ⚠️ correct, needlessly slow |

The control is the whole finding: **the same phrase, de-tokenised, returns a real hit.** So the zero
is not a fact about the corpus. It is an artefact of keyword extraction, and it presents as a clean,
complete answer — no cursor, no cap warning.

## Root cause

`[Cc]ould not do` reduces to the safe keyword set `['not']`, a stopword the tokenizer removes. Three
gates could have caught it and none is reachable:

| Gate | Why it misses |
|---|---|
| `hasUncoveredBranch` | `if (segments.length < 2) return false` — no `\|`, so it returns before `isReachableKeyword` is ever consulted |
| `noWholeTokenKeyword` | tests `safe.length === 0`, and `safe` has one element |
| `zeroCandidateEligible` | still carries `!/\s/.test(pattern)`, and the pattern has spaces |

`FTS_STOPWORDS` is right there and knows `not` is unreachable. Task 14 applied §2b's analysis only
where a `|` happened to be present. **A pattern with no alternation is a single branch**, and the
same rule should decide it.

`[Tt]he was not` proves it is not a one-word fluke: keywords `[was, not]`, both stopwords, both in the
new set, still no escalation.

## The guarantee in v8 §8 is overstated

> Full-scan escalation on a capped, unfilled page — absence of `nextCursor` now means the answer is
> complete

Escalation is gated on `poolCapped` (`searchResults.length >= fetchLimit`), and **an empty pool is
never a capped pool**. So the contract holds for *truncated* recall and fails for *absent* recall,
which is the more dangerous direction. Fixing the root cause above closes this, because an
unreachable keyword set escalates before the query runs.

## Work items

| # | Item | Status |
|---|---|---|
| 1 | **Write the failing tests first.** Pin case A (`[Cc]ould not do` must not return a cursor-free zero), case G (`[Tt]he was not`), and the control (a de-tokenised variant of the same phrase finds the row). Confirm they fail against current `main` before touching the fix. | ☑ |
| 2 | **Generalise branch coverage.** Drop the `segments.length < 2` early return so a non-alternation pattern is analysed as a single branch. **Do not instead bolt `\|\| !safe.some(isReachableKeyword)` onto `noWholeTokenKeyword`** — that is *not* equivalent, and an earlier draft of this row wrongly said it was. `safe` is computed **with** the rescue regex while segment analysis passes `null`, so on a single-branch pattern where the rescue saves a run the two paths return different coverage verdicts. They agree on `[Cc]ould not do` by coincidence. One rule, one code path. | ☑ |
| 3 | **Stop over-splitting parenthesised alternations.** `(unbeknownst\|safeguarding)` full-scans needlessly: the naive `split('\|')` leaves `(unbeknownst`, whose leading paren makes `leftClean` false with no regex to rescue it. Strip a leading `(` / `(?:` and a *trailing* `)` from each segment before analysis. Do not strip a `)` that is interior — `(foo\|bar)baz` must stay uncovered, because neither `bar` nor `baz` is a whole token. | ☑ |
| 4 | **Pin the `limit`-dependent strategy flip.** `fetchLimit = wanted * 5`, so a pool of 235 caps at `limit: 20` and escalates, but does not cap at `limit: 100`. Add a test asserting that **the verdict is the same at both limits** — whatever strategy proves it. **Note what this did and did not do:** the measured non-zero variant already agreed at both limits, so the test pins *legibility*, not a count divergence. The `wanted * 5` threshold shift is still there. It can no longer flip a verdict between proven and unproven, which was the danger. | ☑ |
| 5 | **Make the warnings distinguish the two kinds of zero.** A zero over a *covered* keyword set with an *uncapped* pool is a **proven** absence and should say so. Today the post-filter warning claims "matches elsewhere in the corpus would not be reached by this strategy", which undersells a complete answer and reads identically to a genuinely bounded one. | ☑ |
| 6 | **Correct v8 §8 and the tool description.** Both assert the completeness guarantee unconditionally. State the real rule: absence of `nextCursor` means complete *because* an unreachable keyword set escalates before the query and a capped pool escalates after it. | ☑ |

## Risks

- **More full scans.** Any regex-shaped pattern whose keywords are all stopwords or fragments now
  scans linearly. This is correct and is the point, but it moves cost onto patterns that previously
  returned instantly by being wrong. The existing time box and `truncated` flag remain the backstop.
- **`/api/search/ai` chips.** A single stopword chip (`\bthe\b`) will now full-scan. Check the
  route's chip construction before merge; if it can emit stopword-only chips, it should drop them.
- **Item 3 touches segment normalisation, not `literalRuns`.** Keep it that way. `literalRuns` stays
  deferred (task 14 item 2).

## How to measure success

| Check | Expected |
|---|---|
| `[Cc]ould not do` | finds the row the de-tokenised control finds, via `full-scan` |
| `[Tt]he was not` | `full-scan`, not a cursor-free `fts+regex` zero |
| `(unbeknownst\|safeguarding)` | `fts+regex` — covered branches, no needless linear pass |
| `\babsentone\b\|\babsenttwo\b` | still `fts+regex`, no scan (dashboard guard) |
| A covered pattern at `limit: 20` and `limit: 100` | same verdict, and both legible as proven |
| Full suite | no new failures against the 77 pre-existing |
