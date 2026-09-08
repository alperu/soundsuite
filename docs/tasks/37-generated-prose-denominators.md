# Denominators in generated prose — the surface no sweep can see

**Status:** Proposed · **Effort:** M · **Priority:** P1 · **Created:** 2026-09-08
**Report:** [`../MCP-Improvements/REPORT-v14-execution-plan-to-working.md`](../MCP-Improvements/REPORT-v14-execution-plan-to-working.md) §5
**Blocked by:** [`24-completeness-object.md`](./24-completeness-object.md)

Field names and code citations only. No case data.

## Problem

Every completeness defect this series found was found by reading **string literals**. That method has
now been run twice across all 61 non-test files under `src/lib/mcp` — line-wise, and again with `' +`
continuations collapsed so a claim could not hide across a concatenation break. The static surface is
clean.

**Two surfaces emit absence prose that no such sweep can ever see, because a model writes it at
runtime:**

- `research_evidence` emits **`gaps`**
- `src/lib/mcp/routed/run-report.ts` emits **report prose**

A model writing *"no evidence found for section X"* is an undenominated corpus-absence claim by
construction. It is also **the sentence most likely to be pasted into something that matters** — a
memo, a filing, an email to a client — because it is written in prose a person can use directly,
unlike a `warnings[]` entry.

At 11.1% corpus coverage ([task 23](./23-corpus-status-and-denominators.md)), such a sentence is
wrong in the most consequential possible way.

## Why this is not solved by task 24

[Task 24](./24-completeness-object.md) puts a `completeness` object on tool responses. That is
necessary and it does not close this. A structured field would sit **beside** prose that already
over-claims, and the person reading the report reads the prose. The field helps a machine; the
sentence is what reaches a human.

This is the inverse of the rest of the series. Everywhere else, the prose was honest and the machine
had to string-match to learn it. Here the machine will be honest and the prose will not.

## Approach

Two mechanisms, and the second is the one that actually holds.

**1. Inject the denominator into generation context.** `corpus-denominator.ts` already resolves a
scoped denominator (`getCorpusDenominator`) and renders it (`provenAbsenceClause`). Both surfaces know
their case scope, so both can be given the numbers before generating.

**2. Check the output.** A model can ignore its context; it cannot ignore a validator. Scan generated
text for absence assertions and flag any that carry no denominator nearby.

**Do not rely on (1) alone.** Context is a suggestion; the check is the guarantee. Shipping only the
injection would be this series' own recurring defect committed one last time — describing an intent
more precisely than verifying the outcome.

## Work

| # | Item | Status |
|---|---|---|
| 1 | **Locate both generation sites precisely** and confirm what each is given today: `research_evidence`'s `gaps` production, and `run-report.ts`'s prose. Establish whether either already receives coverage information. | ☐ |
| 2 | **Inject the resolved denominator** into both generation contexts, scoped to the case(s) the job actually covered — not the corpus figure, since per-case coverage ranges 2.3%–44.4% and quoting the corpus average to a sparse case is off by ~5x. | ☐ |
| 3 | **Build the post-generation validator.** Detect absence assertions ("no evidence", "nothing found", "does not appear", "is absent", "no mention of") and require a denominator within the same sentence or the adjacent one. Keep the pattern list in one place, tested. | ☐ |
| 4 | **Decide the failure mode, explicitly: block, annotate, or warn.** Annotating is probably right — refusing to emit a whole report because one sentence over-claims is worse than the over-claim, and a blocked report teaches operators to route around the check. Whatever is chosen, write down why. | ☐ |
| 5 | **Extend the banned-phrase guard to the generated surface.** `"the absence is proven"` is gone from `src/` and asserted absent by test; a model can reintroduce it verbatim in prose, where no source test looks. | ☐ |
| 6 | **Decide what a validator failure means for the job's result envelope** — does the caller learn that prose was flagged? A silently-annotated report is better than a silently-over-claiming one, but a caller that cannot see the flag cannot act on it. | ☐ |

## Risks

- **False positives will be common and annoying.** "No evidence of tampering was alleged" is not a
  corpus-absence claim. A validator that flags everything gets disabled, which is worse than no
  validator. Tune on real output, and prefer annotation over blocking (item 4).
- **This is unbounded pattern-matching against natural language.** It will never be complete. Treat it
  as raising the floor, not closing the hole, and say so in the acceptance criteria rather than
  claiming coverage it cannot have.
- **The denominator moves.** After [task 35](./35-bulk-promotion.md) the figures change from ~11% to
  ~100%. Injected text must read the live value, never a constant — the `~35,890` in the skill was
  exactly this mistake at the documentation layer.
- **Do not let the validator's own message over-claim.** "No undenominated absence claims found" is
  itself a completeness statement about a pattern list that cannot be complete.

## Acceptance

| Check | Expected |
|---|---|
| A report section that found nothing | says so **with** a denominator naming what was searched |
| A synthetic over-claiming string | caught by the validator |
| `"the absence is proven"` in generated prose | caught |
| A legitimate non-corpus absence ("no objection was raised") | **not** flagged |
| The denominator in generated text | matches `corpus_status` at generation time, not a constant |
| Validator coverage | stated honestly as a floor, with the known gap named |

## References

- `src/lib/mcp/corpus-denominator.ts` — `getCorpusDenominator()`, `provenAbsenceClause()`
- `src/lib/mcp/routed/run-report.ts` — report prose generation
- `src/lib/mcp/tools/research-evidence.ts` — `gaps`
- [`24-completeness-object.md`](./24-completeness-object.md) — the structured half; must land first
- [`23-corpus-status-and-denominators.md`](./23-corpus-status-and-denominators.md) — the wording rule this extends
- [`33-full-scan-denominator-gap.md`](./33-full-scan-denominator-gap.md) — the static-surface equivalent, closed
