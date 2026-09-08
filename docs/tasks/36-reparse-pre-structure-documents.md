# Re-parse the 74 documents that predate structured parsing

**Status:** Proposed · **Effort:** M · **Priority:** P1 · **Created:** 2026-09-08
**Report:** [`../MCP-Improvements/REPORT-v14-execution-plan-to-working.md`](../MCP-Improvements/REPORT-v14-execution-plan-to-working.md) §5
**Blocked by:** [`35-bulk-promotion.md`](./35-bulk-promotion.md)

Counts and field names only. No case data.

## Problem

Measured 2026-09-08 against the live database:

```sql
SELECT COALESCE(parserVersion,'(null)'), COUNT(*) FROM Document WHERE status='INDEXED' GROUP BY parserVersion;
-- (null)            | 74
-- hybrid-docparse-1 | 22
```

**74 of the 96 indexed documents have no `parserVersion`.** They predate structured parsing. So
`headingPath`, `blockType` and `speakers` are null for them — not because a backfill has not run, but
because the parse that would produce those fields never happened.

That makes **22 of 864 documents — 2.5% of the corpus — the structured slice.**

## This corrects a framing, not just a number

Task 14 item 6 proposes running the structure backfill
(`POST /api/admin/structure-backfill`), which stamps `speakers` from `PageCache.structuredJson` by
printed-line interval. That is the right operation **for documents that were parsed with structure and
lost the projection.**

It is the wrong operation for three quarters of the indexed slice, which has no structured parse to
stamp *from*. Those need **re-parsing**, which is a different cost, a different risk and a different
task.

Two consequences worth stating:

- **[Task 28](./28-server-side-speaker-attribution.md) was right to derive from printed text.** It
  deliberately does not depend on the `speakers` column, so it works today across all 96 documents
  rather than the 22. That decision looked conservative; it was load-bearing.
- **There is only one parser generation.** `hybrid-docparse-1` is the sole non-null value ever
  written, so item 4 below is a genuine question rather than a version-matrix exercise.

## Work

| # | Item | Status |
|---|---|---|
| 1 | **Identify the 74 by absent `parserVersion`** and confirm the count against `corpus_status` before acting. The number will have changed if [task 35](./35-bulk-promotion.md) ran — newly-ingested documents should carry a version, so a rising null count after task 35 is itself a defect worth stopping for. | ☐ |
| 2 | **Re-parse through the current parser.** Renumber `chunk_index` for the **whole document**; do not append a fresh counter beside surviving rows. That is precisely the mechanism task 21 item 5 identifies as the cause of duplicate indices and gaps. | ☐ |
| 3 | **Verify on a sample** that `headingPath`, `blockType` and `speakers` populate, and that existing citations still resolve to the same text. A re-parse that silently moves citations is worse than one that fails loudly. | ☐ |
| 4 | **Decide explicitly whether the 22 need re-parsing too.** They carry `hybrid-docparse-1`; if the current parser writes a newer version, they are a second, smaller cohort. Write the decision down either way. | ☐ |
| 5 | **Re-run the [task 20](./20-measure-chunk-overlap.md) overlap measurement** on re-parsed documents. Re-parsing is a chunking operation, so it is subject to the same defect [task 21](./21-chunk-overlap-defect.md) fixes. | ☐ |
| 6 | **Then reconsider [task 14](./14-alternation-recall-and-speaker-attribution.md) item 6.** Once the corpus is uniformly parsed, the structure backfill becomes the cheap correct operation it was always meant to be, and [task 28](./28-server-side-speaker-attribution.md) item 5 (prefer the `speakers` column when non-null) starts paying off. | ☐ |

## Risks

- **Re-parsing is expensive and this is 74 documents against a backlog of 768.** Sequence matters:
  task 35 raises coverage from 11% to ~100%, this raises structured coverage within it. If effort is
  scarce, task 35 is worth more.
- **Citation stability is the real hazard.** Chunk boundaries move on re-parse, so anything that
  stored a chunk id or index against these documents may dangle. Check before, not after.
- **Do not run this concurrently with task 35.** Both write chunks; interleaving two chunk-writing
  operations over one corpus is how the duplicate-index generation in task 21 item 5 arose in the
  first place.
- **Existing partial-reindex routes are adjacent but not a substitute** —
  `api/documents/[id]/clear-index`, `api/documents/[id]/reindex-pages` and
  `scripts/rechunk-page-only-docs.ts` operate per document or per page. `reindex-pages` is the one
  task 21 item 5 names as producing duplicate indices; read that item before reusing it here.

## Acceptance

| Check | Expected |
|---|---|
| Re-parsed documents | `parserVersion` non-null; `headingPath` / `blockType` / `speakers` populated where the document supports them |
| Citations, before vs after | resolve to the same text on a sampled set |
| `chunk_index` per re-parsed document | contiguous, no duplicates |
| Overlap on re-parsed documents | at the configured size (task 20 method) |
| The 22 | decision recorded, with reasoning |
| `corpus_status` | structured-slice count reported as a measurement, not an estimate |

## References

- Measured: `SELECT parserVersion, COUNT(*) FROM Document WHERE status='INDEXED' GROUP BY parserVersion`
  → 74 null, 22 `hybrid-docparse-1` (2026-09-08)
- [`21-chunk-overlap-defect.md`](./21-chunk-overlap-defect.md) item 5 — the renumbering hazard
- [`20-measure-chunk-overlap.md`](./20-measure-chunk-overlap.md) — the measurement method
- [`14-alternation-recall-and-speaker-attribution.md`](./14-alternation-recall-and-speaker-attribution.md) item 6 — the backfill this unblocks
- [`28-server-side-speaker-attribution.md`](./28-server-side-speaker-attribution.md) — independent of this task by design
