# The denominator attaches to the weaker proof, not the stronger one

**Status:** Implemented 2026-09-08 (items 1-6) · **Effort:** XS · **Priority:** P0 · **Created:** 2026-09-08
**Report:** [`../MCP-Improvements/REPORT-v13-corpus-status-shipped-and-v12-corrections.md`](../MCP-Improvements/REPORT-v13-corpus-status-shipped-and-v12-corrections.md) §3a
**Closes a gap left by:** [`23-corpus-status-and-denominators.md`](./23-corpus-status-and-denominators.md) items 5–6

Counts, field names and code citations only. No case data.

## Problem

Task 23 items 5–6 made every proven-absence claim carry its scoped denominator. Verified live, it
does — **on one of the two proof shapes.**

`scan_for_pattern` has two shapes that count as proof (the skill teaches them in this order):

1. **Exhaustive full scan** — `strategy: "full-scan"`, `truncated` falsy, no `nextCursor`. Reads every
   chunk in scope.
2. **Uncapped pass over a fully covered keyword set** — `strategy: "fts+regex"`, pool never capped.

Measured 2026-09-08, all four zero-result paths:

| Path | Warning emitted | Denominator |
|---|---|---|
| Coverage rule (e.g. `[Zz]qxwvu`) → full scan | *"…ran a full regex scan instead."* | **none** |
| Capped-page escalation → full scan | *"…escalated to a full regex scan so the result is exhaustive over the index."* | **none — and worse, see below** |
| Zero-candidate fallback → full scan | *"Keyword recall returned no candidates — ran a full regex scan instead."* | **none** |
| Uncapped `fts+regex` | *"…proven absent from the N indexed chunks of this case, spanning D of T documents (X% indexed)."* | ✅ |

**The inversion is the defect.** Shape 1 is the one the skill teaches first, the one that reads all
~35,890 chunks, and the one that sounds strongest — and it is the one carrying no numbers. The
escalation path is the sharpest case: it says *"exhaustive over the index"*, which is accurate and is
exactly the phrasing that invites a corpus-wide reading when no denominator sits beside it.

This is the same shape the whole series keeps surfacing, one layer along: **the more confident
statement is the less qualified one.**

## The fourth site — a claim asserted before the fact

Found by audit **after** the three-site fix, and it is the worst of the four.

The capped-page escalation warning asserted *"so the result is **exhaustive over the index**"* — and
it is `warnings.push`'d **before** `runFullScan` is called. It declared its own outcome before the
outcome existed. `noteFullScanAbsence` cannot rescue it, because that helper deliberately bails on
exactly the conditions under which the pre-declaration is false.

Two contradictions reachable from code already in the file:

| Case | Result |
|---|---|
| **Truncated escalation** | `warnings[]` carries *both* "…exhaustive over the index." and "Scan stopped after N rows (time box). Results are partial — follow `nextCursor`." Neither has a denominator. |
| **Escalation on a later page** | `willEscalate` is reachable with `cursor` set — the `if (cursor)` de-duplication branch beside it proves the authors knew. `noteFullScanAbsence` returns early and the bare claim stands alone. |

This was the strongest-sounding string in the file and the only one that pre-declared its own
completeness.

**Fix: a warning issued before an outcome must describe the ACTION, not the result.** It now reads
*"escalating to a full regex scan, which is not bounded by that cap. What it covered is reported
below."* What the scan actually proved is then stated afterwards — by `noteFullScanAbsence`, or by the
truncation and cap warnings. Two sentences, two jobs, neither claiming the other's ground.

Guarded by two tests: a source-level assertion (with `' +` continuations collapsed, so a claim cannot
hide across a line break) that the pre-declaring string is gone, and a behavioural one that any
sentence containing "exhaustive" in a capped-escalation answer carries a denominator.

## Why it is cheap

`provenAbsenceClause()` and `getCorpusDenominator()` already exist in
`src/lib/mcp/corpus-denominator.ts`, are already scoped and cached, and are already called from the
`fts+regex` branch. This is calling them on three more branches — no new logic, no new derivation.

## When a full-scan zero is actually provable

A full scan pages. `runFullScan(...)` returns `{ matches, scanned, truncated, nextOffset }`. A
proven-absence claim is only sound when **all four** hold:

| Condition | Why |
|---|---|
| `matchedResults.length === 0` | it is an absence claim |
| `!truncated` | the time box or `SCAN_MAX_ROWS` did not cut it short |
| `scan.nextOffset === null` | no rows remain unscanned |
| `!cursor` | this is a first-and-only page, so the claim covers the whole answer, not one page of it |

The `!cursor` guard matters: on a later page, earlier pages may have returned matches, so a zero here
is not an absence for the query. Omitting it would produce a confident absence claim for a phrase the
tool had already found — the worst available failure.

## Work

| # | Item | Status |
|---|---|---|
| 1 | Add one helper in `scan-for-pattern.ts` that emits the proven clause when the four conditions above hold, and call it after each of the three `full-scan` invocations. | ☑ `noteFullScanAbsence()`, called at all three `runFullScan` sites. |
| 2 | **Report `scanned` alongside the denominator**, not instead of it. A divergence between chunks actually read and `indexedChunks` from the vector store is itself a finding — it would mean the scan and the count disagree about the corpus. Quoting both makes that visible rather than hiding it behind one number. | ☑ Both quoted. Measured 2026-09-08 they agree exactly: 35,890 = 35,890 corpus-wide, 380 = 380 scoped. |
| 3 | Leave the existing "ran a full regex scan instead" / escalation warnings in place. They explain *why* the strategy changed; the new clause states *what was proven*. Two different jobs. | ☑ Both retained; asserted by test. |
| 4 | Regression tests: one per full-scan path, plus negatives for each of the four conditions (truncated, `nextOffset` present, cursor present, non-zero matches) asserting **no** proven claim is emitted. | ☑ `scan-for-pattern-full-scan-denominator.test.ts`, 10 tests. See the note below on reaching the `!cursor` state. |
| 6 | **The fourth site.** Stop the capped-page escalation warning pre-declaring exhaustiveness before the scan runs. | ☑ Now states the action; outcome stated afterwards. Two tests, incl. a source-level one. |
| 5 | Re-sync `skills/soundsuite-mcp/SKILL.md` — remove the interim ⚠️ telling callers to pair a `full-scan` zero with their own `corpus_status` call, once it is no longer true. | ☑ Replaced with the shipped behaviour and the three silence conditions. |

## Risks

- **Do not claim absence on a truncated or paged scan.** Items 1's four conditions are the whole
  safety of this change; loosening any one produces exactly the over-claim being fixed.
- **Do not delete the "why we escalated" warnings.** They are diagnostics, not claims.
- **`getCorpusDenominator` is cached for 60 s.** On a long paging session the numbers could be
  slightly stale; that is why it carries `asOf`. Acceptable — documents do not get ingested mid-scan
  in this system today, and the alternative is a re-read per page.
- **This does not make full-scan answers more complete.** At 11.1% corpus coverage the scan still
  reads only the indexed fraction. The fix makes the sentence honest, nothing more.

## The structural argument for task 24

A caller should not have to know **which of four warning strings it got** in order to learn whether
an answer was exhaustive and over what denominator. A machine gating on a structured
`completeness` object would be indifferent to which prose branch fired — and this gap would have been
impossible to introduce. That is the case for
[task 24](./24-completeness-object.md), strengthened.

## Acceptance

| Check | Expected |
|---|---|
| `[Zz]qxwvu`-style coverage-rule scan, zero results | warning carries the scoped denominator |
| Zero-candidate fallback scan, zero results | same |
| Capped-page escalation, zero results | same |
| A truncated full scan | **no** proven claim; `truncated` and `nextCursor` still reported |
| A full scan on a later page (`cursor` present) | **no** proven claim |
| A full scan that found matches | **no** absence claim |
| A scoped scan | denominator is that case's, not the corpus's |
| `scanned` vs `indexedChunks` | both visible; a divergence is legible |
| All four zero-result paths | quote the same denominator for the same scope |

## References

- `src/lib/mcp/corpus-denominator.ts` — `getCorpusDenominator()`, `provenAbsenceClause()`
- `src/lib/mcp/tools/scan-for-pattern.ts` — the three `runFullScan` call sites and the `fts+regex`
  branch that already carries the clause
- [`23-corpus-status-and-denominators.md`](./23-corpus-status-and-denominators.md) items 5–6
- [`24-completeness-object.md`](./24-completeness-object.md) — the structural fix this gap argues for

## Note added during implementation — the `!cursor` guard is narrower than it looks

`runFullScan` sets `nextOffset` **only when it meets a (limit+1)-th match**
(`scan-for-pattern.ts`, the `matches.length === limit` branch). So a resumed full-scan page always
opens *on* a matching row and cannot normally be empty. The state the `!cursor` guard defends against
— cursor present, scan complete, zero matches — is therefore reachable only when **the corpus changes
between pages** (a reindex, or an ingest landing mid-answer).

That makes the guard defensive rather than load-bearing on today's code paths. It is kept, and tested
by simulating a row ceasing to match between page 1 and page 2, because the alternative is a claim
that a phrase is absent when the tool returned it one page earlier — and because
[task 21](./21-chunk-overlap-defect.md) item 5 shows partial reindex is a thing that actually happens
here.
