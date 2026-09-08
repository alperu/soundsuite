# `scan_for_pattern` — match phrases across transcript line numbers

**Status:** ✅ Done 2026-09-08 · **Effort:** S · **Priority:** P0 · **Created:** 2026-09-08
**Owner agent:** `.claude/agents/scan-recall-engineer.md`
**Report:** [`../MCP-Improvements/REPORT-v10-search-quality-gaps.md`](../MCP-Improvements/REPORT-v10-search-quality-gaps.md) §1

All patterns synthetic. No case data.

## Problem

Reporter's records are stored with their printed line numbers **inline in the chunk text**:

```
110 1 <words words words words words words words>
    2 <words words words words words words words>
    3 A <answer text continuing across the line>
```

A phrase that spans a line break therefore has a number and whitespace inside it. A literal pattern
for that phrase cannot match, no matter how exhaustive the scan.

Measured on a phrase already located by eye in a transcript chunk:

| Pattern | strategy | scanned | result |
|---|---|---|---|
| six words of the phrase | `full-scan` | 35,890 | **0** |
| same phrase with `\s+\d+\s+` at the break | `full-scan` | 35,890 | **1** |

The scan was exhaustive both times and the corpus contains the phrase. Transcript lines run roughly
eight to ten words, so **a phrase longer than about eight words is more likely than not to be
unfindable**, and a shorter one fails whenever it straddles a break.

This silently caps how long a quoted phrase can usefully be — the exact operation a litigation search
exists to perform. And after v9 the answer is a *proven* zero, so it is more convincing than it used
to be.

## The fix — query-time tolerance

| # | Item | Status |
|---|---|---|
| 1 | When compiling a pattern, replace each literal whitespace run with a line-break-tolerant expression, so a phrase matches across a printed line number. | ✅ |
| 2 | Gate it behind `linePermissive`, defaulting **true**. A caller matching a literal digit sequence sets it false. | ✅ |
| 3 | Apply it on both matching paths — the FTS post-filter and the full scan — so the two never disagree about what matched. | ✅ |
| 4 | Report it: when the tolerant form matched something the strict form would not, say so in `warnings[]`. An operator asserting a quotation should know the match crossed a line boundary. | ✅ |
| 5 | Do **not** ship the hand-written workaround as documentation. Telling operators to type `\s+\d+\s+` is undiscoverable and nobody will remember it under time pressure. | ✅ |

### ⚠️ The expression the report proposed is wrong

The v10 report suggests replacing a space with:

```
\s*(?:\d{1,3}\s+)?\s*        ← WRONG
```

Every quantifier is zero-or-more, so **the whitespace becomes optional** and `the court` would match
`thecourt`. That manufactures exactly the false-positive class task 16 exists to remove.

Use a form that still requires at least one whitespace character:

```
\s+(?:\d{1,3}\s+)?           ← at least one space, optionally a line number then more space
```

Bound the digits (one to three) so a long number is not swallowed, and apply the substitution only to
*literal* spaces in the pattern — never inside a character class, and never to whitespace the caller
wrote as `\s` themselves.

## Risks

- **False positives across unrelated lines.** The tolerant form lets a phrase match across a line
  boundary that, in the printed record, separates two speakers. Item 4's warning is the mitigation;
  a stronger one is to refuse to cross a speaker label.
- **Regex construction on caller input.** The substitution runs over a user-supplied pattern, so it
  must not break an already-valid regex. Catastrophic-pattern rejection stays in front of it.
- **Interaction with task 18.** Both rewrite the pattern before compiling. They must compose in one
  place rather than as two independent passes.

## Acceptance

| Check | Expected |
|---|---|
| A six-to-ten-word phrase known to span a line break, plain pattern | returns its hit |
| The same phrase, `linePermissive: false` | returns zero, as today |
| `the court` | does **not** match `thecourt` |
| A pattern containing `\d{4}` | unchanged behaviour |
| Existing exhaustive-scan controls | no regression |

## Outcome

Verified live. A ten-word phrase that spans a line break now matches, and the returned `match` field
shows the newline inside it. The response carries the item-4 warning:

> At least one match on this page spans a printed transcript line number: it matched with
> line-number tolerance, not as contiguous text. Check the line break before quoting it.

The report's proposed expression was **not** used — it made whitespace optional and would have let
`the court` match `thecourt`. The shipped form requires at least one whitespace character, and a test
pins that.

### One wording defect found during verification

The warning says "printed transcript **line number**", but the tolerance also fires on an ordinary
line wrap in a non-transcript filing — which is exactly where it fired in the live check, on an
order. The mechanism is right; the message names a cause that may not apply. It should describe what
happened ("the match spans a line break, and may cross a line number") rather than asserting why.
Small, but an operator reading it on a non-transcript document will be confused about their own
corpus.
