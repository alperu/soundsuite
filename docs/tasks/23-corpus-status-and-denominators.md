# `corpus_status()` — and making every proven-absence claim name its denominator

**Status:** Proposed · **Effort:** S (items 1–4) + S (items 5–6) · **Priority:** P0 · **Created:** 2026-09-08
**Report:** [`../MCP-Improvements/REPORT-v12-mcp-surface-for-fast-correct-answers.md`](../MCP-Improvements/REPORT-v12-mcp-surface-for-fast-correct-answers.md) §2a, §6 item 1

Counts, field names and code citations only in this file and in any report it produces. No case
names, cause numbers, document names or document text.

## Problem

After [task 14](./14-alternation-recall-and-speaker-attribution.md) and
[task 15](./15-branch-coverage-generalisation.md), `scan_for_pattern` reports a qualifying absence as
**proven** — "the absence is proven, not merely unreached"
(`src/lib/mcp/tools/scan-for-pattern.ts:1104-1112`, `:1122-1129`). That sentence is true **of the
index**. It says nothing about the corpus.

No tool and no readable endpoint answers *"how many documents are indexed versus present?"* v12 tried
to establish it from the MCP surface and could not — sampling by scan is useless because rows come
back in table order, so a broad scan returns thousands of chunks from a handful of documents.

The consequence is the report's central finding: an operator reading "the absence is proven" while a
large fraction of documents are unindexed is being misled by a technically correct statement. That is
the same failure shape v8→v11 kept finding, one level up — and it is the shape named in v12 §7: *the
system describes what it intended to do more precisely than it verifies what it did.*

## Measured 2026-09-08 — the premise is confirmed

v12 could not confirm the coverage figure from the MCP surface and said so. It has now been measured
directly against `prisma/data/sound-suite.db`, which is the first time the number comes from data
rather than from a plan document:

```sql
SELECT status, COUNT(*) FROM Document GROUP BY status;
-- DISCOVERED|768
-- INDEXED|96
SELECT (SELECT COUNT(*) FROM 'Case'), (SELECT COUNT(*) FROM Document);
-- 5|864
```

**864 documents across 5 cases; 96 indexed (11.1%); 768 never ingested.** The ETL plan's estimate was
exact.

Two things the raw total hides, both of which change the design:

**1. The only two status values present are `DISCOVERED` and `INDEXED`.** Neither `QUEUED`,
`PROCESSING` nor `ERROR` appears. `DISCOVERED` is **not** among the four conventional values in the UI
type at `src/app/api/progress/route.ts:26-32` — so a tool built against that list would have bucketed
**all 768 unindexed documents as unaccounted for**, silently, because they match nothing. This is why
decision 2 below (`groupBy` observed values, never an assumed list) is load-bearing rather than
defensive.

**2. Per-case coverage ranges from 44.4% to 2.3%:**

| Case | Indexed | Total | Coverage |
|---|---|---|---|
| A | 24 | 54 | 44.4% |
| B | 19 | 64 | 29.7% |
| C | 15 | 54 | 27.8% |
| D | 32 | 434 | 7.4% |
| E | 6 | 258 | **2.3%** |

A corpus-wide 11.1% would let an operator working case E believe they had five times the coverage
they actually have. **The denominator in a proven-absence sentence must therefore be the scoped
case's, not the corpus's** — a scan filtered to one case that quoted the corpus figure would be
precisely the technically-true-but-misread failure this whole task exists to stop.

**Last ingest run:** `JobLog.completedAt` = 2026-08-29, ten days before this measurement.

## What we have

**Document counts are cheap and already indexed.** `prisma/schema.prisma:71-119`:

```prisma
model Document {
  id               String   @id @default(uuid())
  caseId           String
  status           String   @default("QUEUED")
  pageCount        Int?
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt
  @@index([caseId])
  @@index([status])
}
```

`status` is a **bare `String`, not an enum** — `grep -rn "DocumentStatus" src` returns nothing. The
four conventional values (`QUEUED`, `PROCESSING`, `INDEXED`, `ERROR`) are sourced from a UI type at
`src/app/api/progress/route.ts:26-32`. `@@index([status])` (`:114`) makes a `groupBy` cheap.

**Chunk counts are not in SQLite at all.** There is no chunk column on `Document`. The only source is
the LanceDB `chunks` table (`src/app/api/vectors/stats/route.ts:7`), at
`process.env.LANCEDB_PATH || './data/lancedb'` — `LANCEDB_PATH` is unset in `.env`, so the default is
cwd-relative.

Cheapest total (`src/app/api/vectors/stats/route.ts:36-40`):

```ts
const table = await db.openTable(TABLE_NAME);
const totalChunks = await table.countRows();
```

Cheapest filtered (`src/app/api/vectors/route.ts:48-65`):

```ts
conditions.push(`document_id = '${documentId.replace(/'/g, "''")}'`);
const total = await table.countRows(whereClause);
```

`VectorStore` exposes no counter and its `table` is private (`src/lib/vector/vector-store.ts:185`);
`findByDocument` (`:738`) caps at 60 rows and materialises them, so it cannot be used as a count.
Every existing count path opens `lancedb` directly.

**There is no faithful last-ingest timestamp.** `Document` carries only `createdAt`/`updatedAt`
(`:103-104`). `max(updatedAt)` over-reports — `updatedAt` bumps on readiness backfill, case
reassignment, and the config-driven requeue at `src/app/api/config/route.ts:234`. The honest signal is
`JobLog.completedAt` (`prisma/schema.prisma:121-131`), which also carries `documentsQueued`,
`documentsProcessed` and `documentsFailed`.

**Tool registration is generic.** `src/lib/mcp/tools/index.ts` is the only file to touch — three
lines (`:17` import, `:51` instantiation, `:77` re-export). `get-tool-registry.ts:118-119` does
`getAllTools()` → `registry.registerAll(tools)`. Neither `tool-registry.ts` nor `get-tool-registry.ts`
names individual tools.

## Design decisions to make before writing code

**1. `chunked` requires opening LanceDB, so the tool is not purely a SQLite read.** v12 promised
"read-only, no LLM, trivially cheap". It stays read-only and LLM-free, but a per-case chunk breakdown
is N× `countRows("case_id = '…'")`. The only alternative is a full column scan
(`src/app/api/vectors/stats/route.ts:55-57`), which is worse. Decide: per-case chunk counts behind an
opt-in parameter (`includeChunks`, default the cheap path), or always paid. Recommend opt-in, with
the corpus total always returned since it is one `countRows()`.

**2. Count distinct status values actually present, not the four conventional ones.** Because
`status` is an unconstrained string, a `groupBy(['status'])` is the only shape that cannot silently
drop a stray value from the denominator — which is precisely the failure this task exists to prevent.

**3. Return both timestamps, labelled.** `lastJobCompletedAt` from `JobLog` and
`lastDocumentUpdatedAt` from `Document`, each named for what it measures. A single "last ingest" field
would be the same over-claim in miniature.

**4. Guard the table name.** `data/lancedb/` holds ~33 sibling `chunks_chat_session_*.lance` tables
plus `filing-types.lance`. Only `chunks` is the corpus. Do not glob.

## Work

| # | Item | Status |
|---|---|---|
| 1 | **Add `src/lib/mcp/tools/corpus-status.ts`**, modelled on `list-cases.ts`. Declare `profiles: ['local', 'routed']` (`list-cases.ts:54`) and **`category: 'search'`** — `tool-registry.ts:156-157` sets `toolNeedsLlm = category !== 'search'`, and under the `local` profile a non-`search` tool requires reachable Ollama (`:177`). A status tool that needs an LLM to answer would be absurd, and would fail closed on exactly the degraded fleet where you most want it. | ☐ |
| 2 | **Document counts via `groupBy`**, overall and per case, from distinct observed `status` values. Include `pageCount` sums where non-null, and the count of documents with `pageCount` null (an ingest-completeness signal in its own right). | ☐ |
| 3 | **Corpus chunk total** via one `countRows()` on the `chunks` table. Per-case/per-document chunk counts behind `includeChunks`, using `countRows(where)` with the existing quote-escaping idiom. Handle a missing/unopenable table by returning `chunks: null` with a reason — never by throwing, and never by reporting `0`. | ☐ |
| 4 | **Both timestamps**, named as in decision 3, plus the last `JobLog` row's queued/processed/failed triple. | ☐ |
| 5 | **Name the denominator in `scan_for_pattern`.** Feed `documentsTotal` (and `documentsIndexed`) into the completeness work in [task 24](./24-completeness-object.md) so that a proven-absence claim reads *"proven across N chunks spanning D of T documents"*. The prose and the structured field must agree. | ☑ **Done 2026-09-08.** `src/lib/mcp/corpus-denominator.ts` is the single source; `scan-for-pattern.ts` calls it at both proven-absence sites. The denominator is **scoped** — a `caseId` scan quotes that case's numbers, which matters because per-case coverage ranges 2.3%–44.4%. Task 24 must consume this module rather than re-deriving. |
| 6 | **The word "proven" must never appear without its subject.** Not a threshold, not a suppression rule — a wording rule that holds unconditionally, at every coverage fraction. `"the absence is proven"` is banned outright; the sentence always names what the absence was proven *from*: *"proven absent from the 35,890 indexed chunks, spanning 96 of 864 documents."* A threshold-based suppression was considered and rejected: it needs a number someone must defend, and it still emits the bare word above the line. Attaching the noun removes the failure instead of bounding it. Three existing tests assert on that prose (see Risks) — changing it is a deliberate, test-visible act, not a drive-by edit. | ☑ **Done 2026-09-08.** `provenAbsenceClause()` enforces it; `grep -rn "absence is proven" src/` returns only the comments and the test that assert the ban. All three prose suites passed **unchanged** — they match `/exhaustive\|complete\|proven/i` and a `BOUNDED` negative, and the new wording satisfies both. |
| 7 | **Register and test.** `tools/index.ts` at `:17`/`:51`/`:77`. Test modelled on `src/lib/mcp/tools/__tests__/discovery-list-tools.test.ts` — docblock ` * @jest-environment node`, prisma supplied as a plain object through the `./discovery-harness` `makeContext({ ... })` helper rather than `jest.mock`. | ☐ |

## Risks

- **Changing the proven-absence prose breaks three tests, by design.**
  `scan-for-pattern-branch-recall.test.ts` asserts the proven-vs-bounded strings including a negative
  `BOUNDED` regex; `scan-for-pattern-phrase-matching.test.ts` asserts a capped filtered page never
  claims proven/exhaustive; `scan-for-pattern-regex.test.ts` asserts the bounded-recall prose. Update
  them in the same change, and do not weaken what they assert.
- **A per-case chunk breakdown on a large case count is N round trips to LanceDB.** Measure it before
  making it the default. This is why item 3 gates it.
- **`countRows` on a 984.9 MB database is not free.** Measure the corpus-total call once and record
  the figure in the report; if it is slow, cache it with an explicit `asOf` timestamp rather than
  quietly serving a stale number.
- **Do not report `chunks: 0` when LanceDB is unreachable.** A zero denominator is worse than a null
  one, because a caller will divide by it and print something confident.
- **This tool will make the coverage gap legible for the first time.** Expect the first output to look
  alarming. That is the tool working, not a regression it introduced.

## Acceptance

| Check | Expected |
|---|---|
| `corpus_status()` with no arguments | documents total / per observed status / per case, corpus chunk total, both timestamps — in one call, no LLM |
| Same, on a fleet with Ollama down | still answers (proves the `category: 'search'` gate is right) |
| Same, with LanceDB unavailable | `chunks: null` plus a reason; document counts still returned |
| `includeChunks: true` | per-case chunk counts; wall-clock recorded in the report |
| A stray `status` value present in the DB | appears in the breakdown rather than being dropped |
| A proven-absence answer from `scan_for_pattern` | names its document denominator, in prose and in `completeness` |
| `grep -c "absence is proven"` over `src/` | `0` — the bare form exists nowhere |
| Every emitted sentence containing "proven" | also contains its chunk count and its document denominator |
| Indexed fraction | reported as a measured number in the follow-up report, not quoted from a plan |

## References

- `prisma/schema.prisma:71-119` (Document), `:121-131` (JobLog), `:15-47` (Case)
- `.env:2` → `DATABASE_URL="file:./data/sound-suite.db"`, resolved relative to `prisma/`
  (`src/lib/db/prisma.ts:36`) — the live file is `prisma/data/sound-suite.db`. Prisma 7: the
  datasource block at `prisma/schema.prisma:12` carries no `url`; runtime comes from the adapter
  (`src/lib/db/prisma.ts:48`), migrate from `prisma.config.ts:20`.
- `src/app/api/vectors/stats/route.ts:7, 36-40, 55-57` — chunk counting idioms
- `src/app/api/vectors/route.ts:48-65` — filtered `countRows` with quote escaping
- `src/lib/mcp/tools/list-cases.ts:54` — `profiles` declaration
- `src/lib/mcp/tool-types.ts:58` — `profiles?: McpProfile[]`
- `src/lib/mcp/tool-registry.ts:145-147, 156-157, 177, 206, 295` — profile filter and the LLM gate
- `src/lib/mcp/tools/scan-for-pattern.ts:1104-1112, 1122-1129` — the claims needing a denominator
- [`24-completeness-object.md`](./24-completeness-object.md) — where the denominator is surfaced
- [`21-chunk-overlap-defect.md`](./21-chunk-overlap-defect.md) — the other correctness floor under
  every negative finding
