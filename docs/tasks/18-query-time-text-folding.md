# `scan_for_pattern` — fold quotes, dashes and diacritics before comparing

**Status:** ✅ Done 2026-09-08 · **Effort:** S · **Priority:** P1 · **Created:** 2026-09-08
**Owner agent:** `.claude/agents/scan-recall-engineer.md`
**Report:** [`../MCP-Improvements/REPORT-v10-search-quality-gaps.md`](../MCP-Improvements/REPORT-v10-search-quality-gaps.md) §3

All patterns synthetic. No case data.

## Problem

Two measured misses, same cause — the regex is compared against raw stored text with no folding:

| Variant | Result |
|---|---|
| A name spelled **with** diacritics | present, 20+ rows |
| The same name spelled **without** | also present, 5 rows |
| A contraction with a **straight** apostrophe | found — the corpus form |
| The same contraction with a **curly** apostrophe | **0, reported as a proven absence** |

**Both spellings of the name are in the corpus**, because different filings transliterate
differently. So a search for either form silently returns a subset, and anyone counting mentions is
wrong by construction.

The curly-quote case is the operationally dangerous one: macOS and Word autocorrect straight quotes
to curly, so an operator pasting a quotation out of a brief searches for a glyph the corpus does not
use.

## Scope — smaller than the report assumed

The report proposes folding "at index and query time". **Index-side folding is largely already
there**: the FTS index is built with `asciiFolding: true` (`src/lib/vector/vector-store.ts:264`), and
smart quotes are punctuation the tokenizer drops anyway. Keyword *recall* is therefore not the
problem.

The gap is entirely in the **regex comparison** — the FTS post-filter and the full scan — which tests
a raw pattern against raw text. That makes this a small, self-contained change with **no reindex**.

A normalised text column remains the better long-term shape and would also fix task 17 structurally,
but it is a separate, larger piece of work and is not required here.

## The fix

| # | Item | Status |
|---|---|---|
| 1 | Add a `foldText` helper: Unicode NFKD, strip combining marks, map the curly quote family (`' ' " "`) to ASCII `'` and `"`, map dash variants (`‐ – — ―`) to `-`, and map non-breaking and thin spaces to a plain space. | ✅ |
| 2 | Apply it to **both sides** of every comparison — the compiled pattern and the candidate text — on the post-filter path and the full-scan path alike. | ✅ |
| 3 | **Return the raw text**, never the folded form. Folding is a comparison detail; the operator must see and cite what the document actually says. | ✅ |
| 4 | Gate behind `fold`, defaulting **true**. A caller hunting a specific glyph sets it false. | ✅ |
| 5 | Compose with task 17 in one pattern-preparation step, not two independent passes. | ✅ |
| 6 | Fold the extracted FTS keywords too, so recall and verification agree on spelling. | ✅ |

## Risks

- **Offsets shift.** Folding can change string length (NFKD decomposition, a wide dash to a hyphen).
  Anything that reports a match position or slices a snippet must map back to raw offsets, or it will
  cite the wrong span. This is the one part that needs care.
- **Over-folding.** Do not case-fold here; the regex already runs case-insensitive, and folding case
  as well would silently widen matches beyond what the caller asked.
- **A proven absence must stay honest.** Once folding is on, a folded zero is a stronger claim than
  before. That is fine, but the wording must not imply the *unfolded* form was searched.

## Acceptance

| Check | Expected |
|---|---|
| A contraction with a curly apostrophe | finds the straight-apostrophe corpus form |
| A name without diacritics | finds both spellings |
| The same name with diacritics | finds both spellings |
| Returned `text` and `match` | raw, unfolded |
| `fold: false` | exact-glyph behaviour, as today |
| Existing scan tests | no regression |

## Outcome

Shipped alongside tasks 16 and 17, composed into a single pattern-preparation step rather than three
independent passes.

Folding is applied to both sides of every comparison, and the match is located in folded space then
sliced from **raw** text through an index map — so a decomposing fold cannot cite the wrong span.
That offset mapping was the one part flagged as needing care, and it is the part most likely to
regress silently; it is now the reason the snippet fallback also folds.
