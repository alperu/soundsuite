# MCP Report v9 — the fix was right, the rule was too narrow

**Date:** 2026-09-07 · **Task doc:** `docs/tasks/15-branch-coverage-generalisation.md`
**Source:** an operator's live retest of v8, 2026-09-07 · **Tested against the live server**

All ids and patterns synthetic. No case names, docket numbers, or person names.

---

## 1. What the retest found

v8's reported defect is fixed. The class it belongs to is not, and v8 §8's headline guarantee is
disproved by a one-line pattern.

| # | Pattern | limit | n | strategy | pool | verdict |
|---|---|---|---|---|---|---|
| E | `(MR\.\|MS\.\|THE COURT)` | 20 | 20 | full-scan | — | ✅ fixed (was 0) |
| F | `(unbeknownst\|safeguarding)` | 20 | 20 | full-scan | — | works, needlessly slow |
| **A** | **`[Cc]ould not do`** | **20** | **0** | **fts+regex** | **0** | ❌ **false negative** |
| A2 | `[Cc]ould not do` | 100 | 0 | fts+regex | 0 | ❌ same |
| B | `[Cc]ould [Nn]ot d[o]` | 20 | 1 | full-scan | 35,890 | control — **the phrase exists** |
| G | `[Tt]he was not` | 20 | 0 | fts+regex | 0 | ❌ keywords `[was, not]` |
| C | `[Ww]as not able to do` | 20 | 0 | full-scan | 100→capped | ✅ a proven zero |
| C2 | `[Ww]as not able to do` | 100 | 0 | fts+regex | 235 | ⚠️ strategy flips with `limit` |
| D | `[Ww]as [Nn]ot abl[e] t[o]` | 20 | 0 | full-scan | 35,890 | control |

**A is the finding.** `[Cc]ould not do` returns zero with `strategy: "fts+regex"`,
`candidatePool: 0` and no cursor, while control B — the identical phrase, de-tokenised — returns a
real hit via `full-scan`. The zero is not a fact about the corpus. It is an artefact of keyword
extraction presenting as a clean, complete answer.

## 2. Root cause: one early return

```ts
function hasUncoveredBranch(pattern: string): boolean {
  const segments = alternationSegments(pattern);
  if (segments.length < 2) return false;   // ← not an alternation; existing rules apply
```

`[Cc]ould not do` has no `|`, so coverage analysis returns before it starts. Its safe keyword set is
`['not']` — a stopword the tokenizer removes, leaving an empty query. Three gates could have caught
that and none is reachable:

| Gate | Why it misses |
|---|---|
| `hasUncoveredBranch` | returns early on `segments.length < 2`, so `isReachableKeyword` is never consulted |
| `noWholeTokenKeyword` | tests `safe.length === 0`; `safe` has one element |
| `zeroCandidateEligible` | still carries `!/\s/.test(pattern)`, and the pattern has spaces |

`FTS_STOPWORDS` was sitting in the same file, already knowing `not` is unreachable. **v8 applied its
own §2b analysis only where a `|` happened to be present.** A pattern with no alternation is a single
branch, and the same rule should have decided it.

Case G proves it is not a one-word fluke: `[Tt]he was not` reduces to `[was, not]`, two stopwords,
both in the new set, still no escalation.

## 3. v8 §8's guarantee was overstated

> Full-scan escalation on a capped, unfilled page — absence of `nextCursor` now means the answer is
> complete

A, A2 and G all return no cursor on `fts+regex` with `candidatePool: 0`. Escalation is gated on
`poolCapped` (`searchResults.length >= fetchLimit`), and **an empty pool is never a capped pool.** So
the contract held for *truncated* recall and failed for *absent* recall — the more dangerous
direction, because truncation at least announces itself.

The guarantee is recoverable, but only as a conjunction: absence of `nextCursor` means complete
*because* an unreachable keyword set escalates **before** the query and a capped pool escalates
**after** it. v8 stated only the second half.

## 4. The `limit`-dependent strategy flip

`fetchLimit = wanted * 5`, so the cap threshold moves with the caller's page size:

| `limit` | `fetchLimit` | pool 235 | outcome |
|---|---|---|---|
| 20 | 100 | capped | escalates to full-scan |
| 100 | 500 | not capped | stays `fts+regex` |

Same query, same corpus, different strategy. Both reach zero, and — once branch coverage is
general — both zeros are sound. The soundness argument is worth stating precisely, because it is the
same shape as defect A one level up, and it holds only as a conjunction:

1. The FTS query ORs `ftsKeywords`, which is the union of safe keywords across the **whole** pattern.
2. A chunk matching the regex must contain every literal the regex requires, so it contains each safe
   keyword drawn from the branch it matched.
3. Branch coverage guarantees that branch contributed at least one **reachable** (non-stopword)
   keyword, so the chunk satisfies the OR query.
4. An **uncapped** pool means FTS returned every such chunk.

Drop any one of those and the zero is not proof. In particular, step 3 is exactly what was missing
for single-branch patterns — which is why A's zero was worthless and C2's is not.

What the caller cannot see is *which* of these two runs proved it, because they report different
strategies and the same result reads as proven in one and unproven in the other. The defect is in
what the tool *says*, and it is worth a pinned test either way.

## 5. Two smaller notes

**F contradicts v8 §8's stated invariant.** `(unbeknownst|safeguarding)` — every branch a real,
non-stopword whole token — full-scanned anyway, reading 11,807 chunks. The naive `split('|')` leaves
`(unbeknownst`, whose leading paren makes `leftClean` false with no regex to rescue it, so the branch
reads as uncovered. v8's pinned test passes only because `\babsentone\b|\babsenttwo\b` has no
parentheses. This is cost, not correctness — over-splitting was documented as the safe direction —
but "must stay on the FTS path" is not true of *any* parenthesised alternation, and v8 should have
said so.

**A correction the reviewer made to their own earlier review.** An earlier pass reported
`[Ww]as [Nn]ot abl[e] t[o]` → 1 hit. Measured again it is 0 (control D); the earlier per-pattern
attribution was mistaken, because that run's 9 hits were never broken out by pattern. C's zero is a
true negative, now properly proven rather than merely asserted. Recording it here because a report
that revises its own numbers is worth more than one that doesn't.

## 6. The fix

A two-line generalisation of what v8 already shipped: a non-alternation pattern is a single branch,
so drop the `segments.length < 2` early return rather than adding a parallel rule beside it.
Work items, risks and success criteria are in
[`../tasks/15-branch-coverage-generalisation.md`](../tasks/15-branch-coverage-generalisation.md).

## 7. What shipped, and how it was checked

Implemented by the `scan-recall-engineer` agent against task 15, then verified independently rather
than on the agent's report.

| Change | Establishes |
|---|---|
| Dropped the `segments.length < 2` early return | one rule decides every pattern: a pattern with no `\|` is a single branch |
| `stripGroupDelimiters` | a leading `(` / `(?:` and a *trailing* `)` come off each segment; an interior `)` stays, so `(foo\|bar)baz` remains correctly uncovered |
| Warnings separate a proven absence from a bounded one | a complete zero no longer reads like a truncated one |
| Tool description states the mechanism | it no longer asserts completeness unconditionally |

**Independent verification.** Re-inserting only the early return makes the two core tests fail —
case A and case G — and removing it makes them pass. So the tests are tripwires for this defect
rather than descriptions of the new code.

Live re-measurement against the server:

| # | Pattern | before | after |
|---|---|---|---|
| A | `[Cc]ould not do` | 0, fts+regex, no cursor | **1 hit**, full-scan, 35,890 scanned, no cursor |
| G | `[Tt]he was not` | 0, fts+regex, pool 0 | 0, full-scan, 35,890 scanned — a **proven** zero |
| F | `(unbeknownst\|safeguarding)` | full-scan, 11,807 chunks | **fts+regex**, pool 25 (capped), cursor present |

Case A now returns the same row control B found. F's pool came back *capped* at 25 with a cursor —
that is the intended behaviour, not a residual defect: the caller has a way to continue, so the cap
warning and the cursor together are honest. It is not exhaustive in one call, and was never meant to
be. Full suite: 77 pre-existing failures, unchanged from the pre-v8 baseline; 2,175 passing, up 9.

## 7a. Still open

Recorded in full because an undocumented hole is worse than a documented one.

**The proven-absence claim rests on two hardcoded thresholds.** It is only as good as
`FTS_STOPWORDS` matching the index's real stopword set and the three-character floor in
`safeKeywords`. A stopword missing from that list now yields a wrongly *proven* zero where it
previously yielded a wrongly *hedged* one — **strictly the worse failure mode**, and the reverse of
v8's error. Mitigations: the list is a deliberate superset of tantivy's English set; `ensureFtsIndex`
carries a comment pointing back at it; and a test now reads the real source and fails if
`removeStopWords: true` or the English analyzer is ever changed. That closes the silent-drift path,
not the list-accuracy one. A probe of the live tokenizer would retire it properly.

**A proven absence is only proven for a scan that ran to the end of the table.** The time box
(`SCAN_TIME_BUDGET_MS` / `SCAN_MAX_ROWS`) is the outer bound on any full scan. A scan cut short sets
`truncated` and emits a cursor, so it is loud rather than silent — but "proven" and "truncated" must
never be read together. Both live controls here scanned all 35,890 rows untruncated.

**Natural-language input is exempt from coverage, by design.** The rule is gated on
`looksLikeRegex`, so a plain phrase whose words are all stopwords is neither proven nor escalated,
only hedged. That path runs no regex post-filter, so a linear pass looking for a contiguous string
would return a confident zero for a phrase whose words are all present — worse than hedging. The
hole is real and the alternative is worse.

**Two different rules can now send a pattern to a full scan.** `zeroCandidateEligible` keeps its
`!/\s/.test(pattern)` and no-pipe conditions, because an existing test pins a single-token zero to a
full scan. The guard can only over-scan, so it is not a recall hole, but only one of the two rules is
the coverage rule and a future reader should know which.

**Paren stripping is single-level and edge-only.** A segment ending in more than one delimiter, such
as one closing a nested group, keeps the inner paren and stays uncovered, so it full-scans. Over-
escalation is the safe direction, but nested alternations of whole tokens do not get the fast path
that a single-level one now gets.

**Lookaround prefixes are not normalised.** A segment beginning `(?=` or `(?!` has only its `(`
stripped, so a literal inside a lookahead can be credited as a whole token. Unchanged from before
this work; a lookaround's contents usually do appear as adjacent text, so the credit is usually right.

**A mid-answer strategy change can repeat rows.** Pre-existing. When a capped page escalates while
the caller holds a cursor, escalation restarts the scan at offset zero rather than mapping the old
cursor onto the new strategy. The tool warns and asks the caller to de-duplicate.

**Carried over.** `safeKeywords`'s whole-pattern rescue (v8 §2a, task 14 item 2) is still unfixed and
`literalRuns` is untouched by design; the `fetchLimit = wanted * 5` threshold shift still exists,
now unable to flip a verdict; `speakers` is still null because the structure backfill was not run.

## 8. The lesson worth keeping

v8 diagnosed the general principle correctly in its §2b — *a keyword set the index cannot reach means
recall is zero* — and then implemented it against the specific pattern that had been reported. The
test suite passed, 650 tests, because every test asked about alternations. **A rule derived in
general and applied in particular will pass a suite written from the same examples.** The retest that
caught this used a pattern shape nobody had written a test for, and the control that made it
undeniable was the same phrase spelled so the extractor could not tokenise it.

That is the technique to keep: when a scan returns zero, re-run it de-tokenised. If the two disagree,
the zero was never about the corpus.
