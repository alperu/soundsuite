# `scan_for_pattern` — verify the phrase, or say you did not

**Status:** ✅ Done 2026-09-08 · **Effort:** S · **Priority:** P0 · **Created:** 2026-09-08
**Owner agent:** `.claude/agents/scan-recall-engineer.md`
**Report:** [`../MCP-Improvements/REPORT-v10-search-quality-gaps.md`](../MCP-Improvements/REPORT-v10-search-quality-gaps.md) §2

All patterns synthetic. No case data.

## Problem

A pattern with no regex metacharacters — *the default shape a person types when searching for a
quoted sentence* — is never checked against the rows returned.

Measured on a six-word phrase occurring zero times in the corpus in that exact form:

```
→ 20 rows returned, candidatePool 21, nextCursor present
→ rows actually containing the phrase: 0 / 20
```

Every row was a bag-of-words match. The rows carry the same citation and page fields a verified hit
carries, so an operator asking "where was this said" gets twenty citations to passages where it was
not said.

## Root cause, and why it is worse than "no warning"

`src/lib/mcp/tools/scan-for-pattern.ts:770`:

```ts
const allMatches = looksLikeRegex && regex
  ? searchResults.filter((result) => regex!.test(result.text))
  : searchResults;          // ← raw BM25, never verified
```

Neither warning branch can fire on this path. The zero-candidate branch needs
`searchResults.length === 0`; the post-filter branch needs `looksLikeRegex && regex`. So the call
returns `warnings: []`.

**That is not silence. It is a false assurance.** The field's own contract in `ScanForPatternResult`
reads: *"Non-fatal recall caveats. Empty array = the answer is believed complete."* An empty array on
an unverified keyword result actively asserts the answer is good.

This is the mirror of the v8/v9 work. Those closed the false-negative path and left the
false-positive path open — and the false-positive path is the default input shape.

## The fix

**Verify by default. Do not merely warn.**

`scan_for_pattern` exists to find exact text. Bag-of-words results are a mis-feature here, not an
undocumented mode; callers who want semantic or keyword behaviour have `query_case_knowledge`.

`looksLikeRegex` may keep deciding **strategy** — v9's reasoning holds and the dashboard path must not
start linear-scanning. It must stop deciding **verification**. Those are different questions that got
collapsed into one flag.

| # | Item | Status |
|---|---|---|
| 1 | Always post-filter returned rows against the pattern. For a non-regex pattern, compile it as an escaped literal and test candidates against it. | ✅ |
| 2 | Add `mode: 'phrase' \| 'keyword'`, defaulting to `'phrase'`. `'keyword'` restores the old behaviour explicitly and **must** then emit a warning that rows are unverified. | ✅ |
| 3 | When the post-filter empties a non-empty pool on the non-regex path, emit the same style of warning the regex path already emits. | ✅ |
| 4 | Never return rows with `warnings: []` unless they were verified. Assert this in a test. | ✅ |
| 5 | Check `/api/search/ai` and any deep-search caller before merging: if one relies on unverified keyword rows, it must pass `mode: 'keyword'` explicitly rather than inherit it. | ✅ |

## Risks

- **A caller may depend on the loose behaviour.** Item 5 is the gate. Do not change the default until
  the callers are enumerated by grep, not assumption.
- **A literal phrase that is present will now return fewer rows** — correctly. Expect result counts
  to drop, and do not read that as a regression.
- **Interacts with task 17.** A transcript phrase spanning a line break will verify to zero once this
  lands. Task 17 is what stops that being a new false negative, so land them together or land 17
  first.

## Acceptance

| Check | Expected |
|---|---|
| A six-word phrase absent in exact form | zero rows, or rows explicitly labelled unverified |
| A phrase present in exact form | returned |
| Any result with `warnings: []` | every row provably contains the pattern |
| `mode: 'keyword'` | old behaviour, plus an unverified warning |
| Dashboard search path | unchanged, verified by its existing tests |

## Outcome

Verified live. A phrase whose words are common but whose exact form is absent from the corpus now
returns **zero rows** and escalates to a full scan of all 35,890 chunks to prove it. Before this
change the same query returned ~20 unverified keyword rows carrying real citations.

**Caller audit (item 5), completed before the default flipped.** Four call sites. Three build
word-boundary alternations and were already regex-verified, so they are unaffected. The fourth,
`src/app/api/search/pattern/route.ts`, passes a raw user query and *is* affected — deliberately. Its
own UI reads "Regex pattern matching for exact searches", so verification is what it already
advertises; no `mode: 'keyword'` escape was added there.

One existing test was edited: a citation-formatting fixture in `case-scoping.test.ts` used a row that
did not contain the scan pattern, so verification correctly dropped it before there was a citation to
compare. I checked this myself rather than taking it on trust — the pattern is `trust fund` and the
old fixture text lacked it. Legitimate fixture repair, not a masked regression.
