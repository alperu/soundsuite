# Two meanings of "draft" in one payload

**Status:** Proposed — **diagnosed, not verified** · **Effort:** XS–S · **Priority:** P2 · **Created:** 2026-09-08
**Report:** [`../MCP-Improvements/REPORT-v12-mcp-surface-for-fast-correct-answers.md`](../MCP-Improvements/REPORT-v12-mcp-surface-for-fast-correct-answers.md) §4e

> **Provenance.** The contradiction is v12's direct observation of a live response. The *cause* below
> is inferred from the report's own description and has **not** been traced in source. Trace it before
> changing anything — the fix differs sharply depending on which field is wrong.

Field names and code citations only. No case data.

## Problem

A single response can carry a citation reading `Draft: Motion` next to `containsDraft: false`.

Per v12, both are internally correct: one derives from **filing detection**, the other from
**`recordStatus`**. They measure different things and happen to share a word. An operator reading one
payload gets two contradictory signals about whether they are looking at a draft.

This is a smaller instance of the pattern in [task 22](./22-rerank-observability.md) (`score` and
`rerankScore` naming two different quantities identically) and
[task 24](./24-completeness-object.md) (`exhaustive` meaning "of the index"): **a name that does not
carry its scope gets read at the broadest scope available.**

## First: trace it, do not guess

The two fields have not been located in source. Before any change:

1. Find where the citation label `Draft: …` is composed.
2. Find where `containsDraft` is computed and what `recordStatus` values feed it.
3. Establish whether they can legitimately disagree, or whether one is simply wrong.

**The fix depends entirely on the answer.** If they legitimately measure different things, this is a
naming and documentation change. If one is wrong, renaming it would entrench a bug behind a clearer
label — the worst available outcome.

## Candidate resolutions, in preference order

| # | Resolution | When it applies |
|---|---|---|
| 1 | **Rename to carry scope** — e.g. `filingLabelDraft` and `recordStatusDraft`, or a single `draft: { byFilingLabel, byRecordStatus }` | they legitimately differ |
| 2 | **State the difference in the response** — a short note on the field, not only in docs | they legitimately differ and renaming is too disruptive |
| 3 | **Fix the wrong one** | one is actually incorrect |
| 4 | Leave both, document in the skill only | last resort — it is what happens today, and it produced this report item |

Prefer 1. `speakerBasis` ([task 28](./28-server-side-speaker-attribution.md)) and
`exhaustiveOverIndex` ([task 24](./24-completeness-object.md)) are the same move, and this codebase
now has three instances of the pattern — which argues for making the qualified-name convention
explicit rather than fixing each case ad hoc.

## Work

| # | Item | Status |
|---|---|---|
| 1 | Locate both derivations in source; record `file:line` for each. | ☐ |
| 2 | Determine whether disagreement is legitimate. Write the answer down before choosing a resolution. | ☐ |
| 3 | Apply the chosen resolution. If renaming, update `skills/soundsuite-mcp/SKILL.md` and any test asserting the old names in the same change. | ☐ |
| 4 | Add a regression test constructing the contradictory case and asserting the payload is unambiguous. | ☐ |
| 5 | Consider documenting the qualified-name convention once, in the MCP README, and pointing tasks 22/24/28/32 at it. | ☐ |

## Risks

- **Renaming is a response-contract change.** `query-case-knowledge-draft.test.ts` exists and asserts
  draft/`recordStatus` labelling; the skill documents the current names. Change them together.
- **Do not rename before item 2.** A clearer name on a wrong value is worse than a confusing name on a
  right one.
- **This is P2 for a reason.** It misleads a reader; it does not produce a wrong search result. Rank it
  below the denominator and rerank work.

## Acceptance

| Check | Expected |
|---|---|
| Both derivations | located, with `file:line` |
| Legitimacy of disagreement | settled in writing |
| The previously contradictory response | reads unambiguously |
| `query-case-knowledge-draft.test.ts` | passes, updated if names changed |
| A regression test | covers the contradictory case |

## References

- `src/lib/mcp/tools/__tests__/query-case-knowledge-draft.test.ts` — asserts draft/`recordStatus` labelling
- [`22-rerank-observability.md`](./22-rerank-observability.md), [`24-completeness-object.md`](./24-completeness-object.md), [`28-server-side-speaker-attribution.md`](./28-server-side-speaker-attribution.md) — the same qualified-name discipline
