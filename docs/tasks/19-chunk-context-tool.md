# New MCP tool — `get_chunk_context`

**Status:** ✅ Done 2026-09-08 (items 1-6; item 7 deferred) · **Effort:** S · **Priority:** P1 · **Created:** 2026-09-08
**Owner agent:** `.claude/agents/mcp-profile-engineer.md`
**Report:** [`../MCP-Improvements/REPORT-v10-search-quality-gaps.md`](../MCP-Improvements/REPORT-v10-search-quality-gaps.md) §4

All examples synthetic. No case data.

## Problem

None of the 24 tools in the `local` profile returns the chunk before or after a hit. A caller who
finds a passage cannot see what precedes or follows it without going to the page image.

Three concrete costs, all live today:

1. **Speaker attribution loses turns at boundaries.** The documented method scans printed speaker
   labels and splits on them, so a chunk opening mid-turn loses its first partial turn. With a
   neighbouring chunk the label is one call away.
2. **The digest pattern slices blind.** It cuts a fixed window out of whatever text happens to be in
   the hit, which truncates a quotation that continues past the chunk edge.
3. **A phrase spanning a chunk boundary is unfindable**, the same shape of defect as task 17 at the
   line level. Context does not fix that, but it makes it diagnosable.

## The fix

A small, read-only tool. No LLM, no reindex, both profiles.

```
get_chunk_context({ chunkId, before = 1, after = 1 })
  → { chunks: [{ chunkId, text, page, chunkIndex, documentId, caseId, isTarget }], … }
```

| # | Item | Status |
|---|---|---|
| 1 | Implement the tool over the existing chunk store, ordered by `document_id` then `chunk_index`. | ✅ |
| 2 | Cap `before` and `after` (suggest 3 each) so a caller cannot pull a document through it. | ✅ |
| 3 | **Never cross a document boundary.** Neighbours come from the same `documentId` only; a target at the start or end of a document returns fewer chunks and says so. | ✅ |
| 4 | Mark the target chunk explicitly rather than making the caller infer it by position. | ✅ |
| 5 | Carry the same citation and provenance fields the search tools return, so a quotation assembled across chunks can still be cited. | ✅ |
| 6 | Register in `src/lib/mcp/tools/index.ts`; declare `profiles` per task 06; unknown-key rejection on, matching the other guarded tools. | ✅ |
| 7 | Optionally add a `context` parameter to `scan_for_pattern` that pads each hit, sharing one implementation with this tool. | ☐ **not built** |

## Risks

- **`chunk_index` may not be globally contiguous.** Verify what it actually orders before relying on
  it, and if it is per-document, say so in the tool description rather than assuming.
- **Payload size.** Three chunks either side of a 2,000-character chunk is a large tool result. The
  caps in item 2 are the control, and the description should state the cost.
- **Draft guard.** Neighbouring chunks carry their own `recordStatus`. A neighbour from a draft must
  keep its marker; assembling text across chunks must not launder a draft into the record.

## Acceptance

| Check | Expected |
|---|---|
| A mid-document chunk, `before: 1, after: 1` | three chunks, target marked |
| The first chunk of a document | no preceding chunk, and the response says so |
| The last chunk of a document | no following chunk, and the response says so |
| A neighbour in another document | never returned |
| `before: 99` | clamped, not honoured |
| A draft neighbour | keeps its draft marker |

## Outcome

Shipped as `src/lib/mcp/tools/get-chunk-context.ts` with 32 tests.

**Correction: item 7 is not built.** I closed this task out with a blanket status sweep that marked
every row done, including an optional row nobody had implemented. `scan_for_pattern` has no `context`
parameter. The implementing agent flagged it rather than letting the checkbox stand — the right call,
and the reason to distrust a bulk edit over a status column. Two things turned out harder than
this task assumed:

- **`chunk_index` is per-document AND not unique.** Exhibit chunks restart the counter at 0 and are
  concatenated into the same document. The tool constrains its window to the target's own stream and
  reports `orderingAmbiguous` when a duplicate index still lands inside it, rather than guessing.
- **Fewer rows than requested is not proof of a document edge**, because gaps exist. The boundary
  flags come from their own existence probes, not from a short array.

The draft guard is enforced per chunk rather than inherited from the target, and the response carries
a `containsDraft` flag warning against merging a window into one quotation — the laundering risk is
in assembly, which a per-chunk field alone does not prevent.

## Found by live probing, after the tests were green

Two integration defects that 32 passing tests did not catch, because each lives *between* two tools
rather than inside one.

**1. `scan_for_pattern` did not return `chunkId` — fixed.** This tool's own description tells callers
to pass a chunk id from `scan_for_pattern`, and that field did not exist in its output.
`query_case_knowledge` had it; the scan tool did not. So half the documented entry path was
unreachable. Field added, with the reason in a comment. The lesson is narrow and worth keeping: a
unit test exercises one tool, and this failure only appears when two are called in sequence.

**2. The word "draft" means two different things in one response — open.** A live call returned
chunks whose `filingType` is `Draft: Motion` and whose citation reads `Draft: Motion`, alongside
`containsDraft: false`. Both are internally correct: the flag derives from `recordStatus`, which is
`unknown` for that document, while the filing type comes from filing detection. But an operator
reading a citation that says Draft next to a flag that says no drafts gets contradictory signals from
a single payload.

This is not a defect in this tool alone, and it should not be patched here. It belongs to the
draft-record guard: either the two signals are reconciled, or the response explains that they measure
different things. Worth an audit by `.claude/agents/draft-record-guard.md`.

## Residual limits, as reported by the implementing agent

- **Rows sharing the target's exact index are never returned.** They are neither before nor after it
  and nothing orders them. The tool detects and reports the collision rather than choosing.
- **Stale-generation detection is local.** The twin probe asks only about the target's own index, so
  a unique-index target inside an otherwise damaged document is not flagged. Document-wide detection
  is [task 21](./21-chunk-overlap-defect.md) item 5's territory.
- **The tiebreak is arbitrary when indices collide** — index, then page, then chunk id, which is
  stable but carries no document order. Reported via `orderingAmbiguous`, not resolved.
- **Exhibit pinning degrades on a path containing a quote or backslash**, since that value reaches a
  raw SQL clause. A note says so. No such path exists on the current index.
- **A gap wider than 4,096 indices gives up** and says so. The widest measured gap is 164.
- **No overlap de-duplication** — see the note added to task 21.
- **Three extra queries per call** for the boundary and twin probes, deliberately not folded into the
  window query, because folding them back would reintroduce the length-inference the probes exist to
  avoid.
