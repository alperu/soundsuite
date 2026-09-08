# Server-side `speaker` + `speakerBasis` on transcript rows

**Status:** Proposed — **diagnosed, not verified** · **Effort:** M · **Priority:** P1 · **Created:** 2026-09-08
**Report:** [`../MCP-Improvements/REPORT-v12-mcp-surface-for-fast-correct-answers.md`](../MCP-Improvements/REPORT-v12-mcp-surface-for-fast-correct-answers.md) §4b, §6 item 8
**Builds on:** [`14-alternation-recall-and-speaker-attribution.md`](./14-alternation-recall-and-speaker-attribution.md)

> **Provenance.** The *method* is verified — task 14 implemented and measured it (268 label-bearing
> chunks → 104 distinct turns for one speaker). What is unverified is that server-side derivation
> reproduces the caller-side result at corpus scale. Measure agreement before switching callers over.

Patterns in this file are transcript boilerplate (`MR\.`, `THE COURT`). No party names, no case data.

## Problem

Attribution is a caller-side ritual today: scan for a printed label, split chunks on label boundaries,
walk backwards to the nearest `Q`/`A` marker, then scan the volume's witness index to turn an `A` into
a name. v12 performed it by hand and it worked — and that is the problem. **Every caller who needs it
will rewrite it, slightly differently, and some will get it wrong.**

Task 14 established the premise and corrected the documentation: speaker labels live in the chunk
text even though the `speakers` column is null. It made attribution *possible*. This task makes it a
**field rather than a recipe**.

## Why this is not simply task 14 item 6

Task 14 item 6 is the **structure backfill** (`POST /api/admin/structure-backfill`), which stamps
`speakers` from `PageCache.structuredJson` by printed-line interval. It is **not run** — it is
operational, needs a backup and a go-ahead.

This task is the **derivation from printed text**, which works today with no backfill and no
re-embedding. The two are complementary:

| | Source | Available | Coverage |
|---|---|---|---|
| Task 14 item 6 | `PageCache.structuredJson` | after an operator runs it | chunks it can align |
| This task | printed labels in chunk text | now | chunks carrying a label |

`speakerBasis` is what lets them coexist without either lying about the other.

## Proposed shape

Projected onto scan and semantic rows for transcript chunks:

```jsonc
"speaker": "THE COURT",
"speakerBasis": "colloquy-label" | "witness-index" | "structure-backfill" | "unknown"
```

**`speakerBasis` is not decoration, it is the point.** An unqualified `speaker` invites the reader to
treat a text-derived guess and a structurally-backfilled fact as the same thing. This is the same
naming discipline as `exhaustiveOverIndex` in [task 24](./24-completeness-object.md) and the
three-way score split in [task 22](./22-rerank-observability.md): when a field's confidence varies,
the field says so, or the reader supplies their own assumption and it will be the optimistic one.

Emit `speaker` **only** when a basis exists. An absent field is honest; `"unknown"` as a *value* is
acceptable only where the row is known to be a transcript turn whose speaker could not be resolved —
never as a default for non-transcript rows.

## Work

| # | Item | Status |
|---|---|---|
| 1 | **Lift task 14's method into a module** with a single tested entry point over chunk text. It exists as documented prose and caller-side code; it needs one home. | ☐ |
| 2 | **Derive on transcript chunks only.** Detect the transcript shape first; running colloquy-label heuristics over motions and exhibits will manufacture speakers that do not exist. | ☐ |
| 3 | **Resolve `Q`/`A` via the witness index**, per task 14's method, and set `speakerBasis: 'witness-index'`. Where only a printed label is available, `'colloquy-label'`. | ☐ |
| 4 | **Project onto rows** in `scan_for_pattern` and `query_case_knowledge`. Additive; no existing field changes. | ☐ |
| 5 | **Prefer the `speakers` column when non-null**, with `speakerBasis: 'structure-backfill'`, so this degrades gracefully into task 14 item 6 rather than competing with it. | ☐ |
| 6 | **Measure agreement** between derived and backfilled attribution on chunks where both exist. A disagreement rate is the honest quality figure for this feature, and it belongs in the report. | ☐ |
| 7 | **Update the skill.** `skills/soundsuite-mcp/SKILL.md` §7 documents the caller-side ritual; replace it with the field, and keep the manual method documented as the fallback for chunks with no basis. | ☐ |

## Risks

- **A wrong speaker is worse than no speaker.** Misattributing a statement in a filing context is the
  highest-consequence error this surface can make. Prefer omission at every ambiguity.
- **Chunk boundaries cut turns in half.** With a median chunk near 20 words
  ([task 21](./21-chunk-overlap-defect.md)), a chunk can open mid-turn with no label in it. Walking
  backwards requires adjacent chunks — the same window
  [task 26](./26-batched-chunk-context.md) fetches. Deriving per-chunk in isolation will silently
  under-attribute, and the under-attribution will not look like a bug.
- **Cost.** If derivation needs neighbouring chunks, it is not free per row. Measure before projecting
  it onto every scan row; consider deriving only for returned rows.
- **Do not let `speaker` become a filter param in this task.** Filtering on a derived field with a
  measured disagreement rate is a different, larger commitment.

## Acceptance

| Check | Expected |
|---|---|
| A transcript row with a printed label | `speaker` set, `speakerBasis: 'colloquy-label'` |
| A `Q`/`A` row in a volume with a witness index | `speaker` resolved, basis `'witness-index'` |
| A non-transcript row | no `speaker` field at all |
| A chunk opening mid-turn with no label | omitted, not guessed |
| Rows where `speakers` is non-null | basis `'structure-backfill'`, column preferred |
| Derived vs backfilled, where both exist | agreement rate reported as a number |
| Task 14's measured figures | reproduced by the server-side path |

## References

- [`14-alternation-recall-and-speaker-attribution.md`](./14-alternation-recall-and-speaker-attribution.md) — the method, and item 6's backfill
- `src/lib/vector/vector-store.ts:257` — FTS built with `removeStopWords: true`
- `skills/soundsuite-mcp/SKILL.md` §7 — the caller-side ritual to replace
- [`24-completeness-object.md`](./24-completeness-object.md), [`22-rerank-observability.md`](./22-rerank-observability.md) — the same qualified-field discipline
