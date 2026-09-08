# MCP Report v8 — speaker attribution is retrievable, and alternation silently kills recall

**Date:** 2026-09-07 · **Baseline:** `e581586` · **Task doc:** `docs/tasks/14-alternation-recall-and-speaker-attribution.md`
**Source:** an operator's live session report, 2026-09-07 · **Status:** fixed 2026-09-07 (see §8)

All ids and patterns synthetic. No case names, docket numbers, or person names.

---

## 1. The finding that corrects our own documentation

`skills/soundsuite-mcp/SKILL.md` §7 states, as settled fact:

> **Consequence for filings: transcript speaker attribution is not retrievable.** `speakers` is null
> on reporter's-record chunks […] The index shows *that a line appears in a reporter's record*, not
> *who said it*. Attribution must come from the page image or an existing citation.

**That claim is wrong**, and it has been steering operators away from a working method. The premise is
true and the conclusion does not follow. `speakers` is indeed null — the structure backfill has not
run. But the speaker labels were never only in that column. They are in the **chunk text itself**,
because the reporter's record prints them there:

```
MR. <SURNAME>: And this is <name>. I am coming in pro se and I am the
respondent.  THE COURT: Okay. And you're the movant on the motion to …
```

So attribution is recoverable today, with no backfill and no page image:

1. `scan_for_pattern` for the speaker label as a literal.
2. Split each returned chunk on the speaker-label boundary.
3. Keep the turns that *begin* with the label of interest.

That is attribution taken from the transcript itself, not from a filing that quotes the transcript.
Measured on one reporter's record in the corpus: **268 chunks carried one speaker's label, yielding
104 distinct turns attributable to that speaker.** One of those turns expressed inability; the rest
did not.

The mid-chunk-start problem the skill describes is real but bounded: a chunk that opens mid-turn
loses only its *first* partial turn, and every subsequent label in that chunk is intact. It degrades
recall at chunk boundaries. It does not make attribution impossible.

**Consequence.** §7 must be corrected. As written it converts a *sparse column* into a *capability
we do not have*, and an operator who believes it will stop at "the index cannot tell you" when the
index can.

## 2. Alternation silently returns zero, with no full-scan rescue

Measured: the pattern `(MR\.|MS\.|THE COURT)` — ordinary transcript boilerplate, matching a large
fraction of every reporter's record in the corpus — returns **zero results**, with:

```
Keyword recall returned no candidates for [THE].
This is keyword recall, not an exhaustive scan — absence here is not proof of absence.
```

Three independent defects compose to produce that. Each is verified in source.

### 2a. `safeKeywords` discards valid branches, keeping only the worst one

`safeKeywords` (`src/lib/mcp/tools/scan-for-pattern.ts`) walks the pattern's literal runs. For
`(MR\.|MS\.|THE COURT)` the runs are `MR`, `MS`, `THE`, `COURT`, and it keeps exactly one:

| Run | Fate | Why |
|---|---|---|
| `MR` | dropped | `run.text.length < 3` |
| `MS` | dropped | `run.text.length < 3` |
| `THE` | **kept** | flanked by `\|` and a space — both clean |
| `COURT` | dropped | `)` on its right sets `rightClean = false`, then the rescue test fails |

The rescue path for a non-clean run tests the run against the **whole pattern**:

```ts
if (regex && regex.test(`aa ${run.text} zz`)) out.push(run.text);
```

For a multi-word branch like `THE COURT`, `"aa COURT zz"` can never satisfy
`(MR\.|MS\.|THE COURT)`, so a perfectly good whole index token is thrown away. The test should run
against **the branch the run came from**, not the full alternation.

There is a second, deeper issue here. FTS recall for an alternation is only sound if it ORs keywords
from **every** branch. Dropping any branch's keywords means that branch's matches are unreachable —
silently. Today three of four branches contributed nothing.

### 2b. The one surviving keyword is a stopword, so the FTS query is empty

`ftsKeywords` reduces to `['THE']`. The FTS index is built with **`removeStopWords: true`**
(`src/lib/vector/vector-store.ts:257`, inside `ensureFtsIndex`). `THE` is an English stopword. The
`MatchQuery` therefore carries no searchable term and matches nothing — which is exactly the
"returned no candidates for [THE]" the operator saw.

Nothing in the tool notices that its keyword set is entirely stopwords. A stopword-only query is
indistinguishable, downstream, from a query whose terms genuinely appear nowhere.

### 2c. Alternation is categorically barred from the full-scan rescue

> **Read §8 before acting on this section.** The remedy proposed below — swapping the `|` exclusion
> for `looksLikeRegex` — was investigated and **rejected**. It would break the dashboard path. The
> defect described here is real; the fix landed elsewhere, earlier in the flow.

This is the defect that turns a recall miss into a **false negative**. Line 572:

```ts
const zeroCandidateEligible = !!regex && !/\s/.test(pattern) && !pattern.includes('|');
```

A pattern containing `|` can never trigger the zero-candidate full-scan fallback, no matter how
regex-shaped it is. So the tool knows it found nothing, knows a full scan is supported, and returns
an empty result set anyway.

The exclusion is not arbitrary — the comment above it gives the rationale, and it is a real one:

> Multi-word / alternation input never full-scans on (b): those are the natural-language and
> `\bfoo\b|\bbar\b` shapes the dashboard sends, and a linear pass would neither find more nor finish
> quickly.

The guard is protecting against bare natural-language queries that happen to contain a pipe. It is
the wrong discriminator for that job. The tool **already computes** the right one: `looksLikeRegex`.
A pattern that is regex-shaped, compiled, returned zero candidates, and has scan support should be
eligible — alternation or not. A bare multi-word phrase stays excluded on `looksLikeRegex` alone.

## 3. An exhausted cursor is not an exhausted corpus

The operator paginated to exhaustion — four pages, no `nextCursor` on the last — and still received
`Keyword recall was capped at 2000 candidates`. Both statements are individually correct, and the
pairing is the problem. They are computed from different quantities:

| Signal | Condition | Reads |
|---|---|---|
| cap warning | `searchResults.length >= fetchLimit` | the **candidate pool** was truncated |
| `nextCursor` | `matchedResults.length > limit` | **post-filtered matches** remain on this page |

Paging does widen the pool — `fetchLimit = (pageOffset + limit) * 5` grows each page — so pagination
is not futile the way *scoping* was (v7). But the terminal state is still unsound: the tool withholds
a cursor at precisely the moment it has just declared its recall bounded. A caller that follows the
documented "page to exhaustion" contract lands on a result set the tool itself flags as incomplete,
with no supported way to continue.

**This is why "he never said X" could not be established as a defensible negative.** The scan covered
a large sample of that speaker's turns. It did not provably cover all of them.

The fix is to make the two signals agree: when the candidate pool came back capped, either keep
emitting a `nextCursor` until an uncapped page proves exhaustion, or escalate the query to
`full-scan`. Absence of a cursor must mean *the answer is complete* — that is the whole contract.

## 4. Warning text has drifted from the documentation

The zero-candidate warning now ends `absence here is not proof of absence`. That is a genuine
improvement on what it used to say and is more honest than the wording quoted in the skill. The skill
was not updated with it. Warning strings are part of the tool's contract with the operator; when they
change, the skill's quoted text should change with them.

## 5. What is affected

| Area | Impact |
|---|---|
| `scan_for_pattern` | any alternation whose branches are short, stopword-only, or `)`-adjacent returns a silent zero |
| Negative findings | "the corpus does not contain X" is not defensible while §3 stands |
| `skills/soundsuite-mcp/SKILL.md` §7 | actively misdirects operators away from a working technique |
| `speakers` column | still null; the backfill route exists and has not been run on this corpus |

## 6. Not defects

- **`removeStopWords: true` is the right setting** for BM25 recall generally. The defect is that
  keyword extraction can reduce a pattern *to* stopwords without noticing.
- **The `|` guard's intent is sound.** Only its discriminator is wrong.
- **`run.text.length < 3`** is reasonable for BM25 noise control. It becomes a problem only when it
  silently empties an entire alternation branch.

## 7. Still open

- **`safeKeywords`'s whole-pattern rescue test (§2a) is unchanged.** Branch coverage resolves the
  reported case earlier in the flow, so the faulty test is never consulted for it. It still degrades
  keyword quality for non-alternation patterns. Deferred because it edits `literalRuns`, which the
  suite pins hardest.
- **`speakers` is still null.** The backfill route exists and was not run: it mutates the live index
  and wants a backup and an explicit go-ahead first.

## 8. What shipped

| Change | Establishes |
|---|---|
| `hasUncoveredBranch` + `FTS_STOPWORDS` in `scan-for-pattern.ts` | an alternation branch that contributes no FTS-reachable keyword forces a full scan, so no branch is silently unreachable |
| Full-scan escalation on a capped, unfilled page | a *truncated* candidate pool can no longer end an answer with no cursor to follow |
| A warning naming the unreachable branch | a scan says *why* it escalated, rather than implying the terms are absent |
| `scan-for-pattern-branch-recall.test.ts` (10 tests) | 6 fail against the pre-fix source; 650 MCP tests pass after |
| `.claude/agents/scan-recall-engineer.md` | the recall-soundness rules are owned rather than rediscovered |

**On reading `scanned` in a full-scan result.** A full scan stops as soon as the page fills, so a
small `scanned` next to a `nextCursor` is correct behaviour, not a truncated scan. Verified live: the
previously-zero alternation returned a full page after reading 8 rows, with a cursor to continue.
`truncated: true` is the flag that means recall was cut short by the time box — `scanned` alone is not.

> **Superseded — see [task #15](../tasks/15-branch-coverage-generalisation.md).** The row above
> originally read “absence of `nextCursor` now means the answer is complete”. That guarantee was
> overstated as shipped in v8: escalation was gated on `poolCapped`, and **an empty pool is never a
> capped pool**, so it covered *truncated* recall and not *absent* recall — the more dangerous
> direction. v8 also applied branch coverage only where a `|` happened to appear, so a single-branch
> pattern that reduced to stopwords (`[Cc]ould not do` → `not`) still returned a cursor-free
> `fts+regex` zero for a phrase that is in the corpus. Task #15 generalises coverage to every pattern
> as a single branch, so an unreachable keyword set escalates *before* the query runs. The rule now
> holds in both directions and is stated that way in the tool's own description.

**One correction to §2c.** That section proposes replacing the `|` exclusion with `looksLikeRegex`.
That would have been wrong, and it was not done. The existing suite pins `\babsentone\b|\babsenttwo\b`
to the FTS path with no linear scan, and it is right to: when every branch contributed a real,
non-stopword whole token, zero candidates *is* trustworthy evidence of absence. `zeroCandidateEligible`
was left untouched. Branch coverage decides earlier and makes the guard irrelevant to the defect.
