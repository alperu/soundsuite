# Partial-index repair: the list, tested one by one

**Status:** 7 defects fixed · 18 of 25 documents cleared · 2 items still open
**Date:** 2026-09-16

Documents are identified by the first 8 characters of their UUID and a page
count only — no titles, cause numbers or party names (see CLAUDE.md).

---

## Why "repair does not work"

The complaint was a 33-page motion with one missing page that would not
repair. It turned out to be four independent defects stacked on one page.

| # | Defect | Fix |
|---|---|---|
| 1 | Repair chose its embedding provider from a **stale hand-copy** of worker-init's switch. On an OpenRouter-only install every repair died on a local Ollama model the host never had. | `ac67a077` |
| 2 | The failure was classified `reindex-request-failed` and **burned all 3 attempts**, so fixing the routing did not revive the page — it stayed permanently "given up". | `b0e65640` |
| 3 | `partial-status` filtered `status: 'INDEXED'`, so a document **mid-repair vanished from the list** that would flag it. A stuck repair looked like a fixed document. | `48dc8f7e` |
| 4 | Repair **reported success having written nothing**, after deleting the pages' existing vectors. | `ac67a077` |

After the fixes, that page repaired in **2.4 seconds**.

---

## The list, and what each one did

Original survey: **25 documents, 390 missing pages**, verified by counting
rows in LanceDB (not by asking the repair endpoint).

### Cleared — 18 documents

| doc | pages | missing | result |
|---|---|---|---|
| `375c8a06` | 146 | 9 | fixed — all 9 had been terminal with `unknown` |
| `56443035` | 105 | 18 | fixed, incl. a density-0 page, 131s |
| `d527cd91` | 49 | 3 | fixed |
| `3ed5e41d` | 101 | 3 | fixed |
| `87795df2` | 1403 | 2 | fixed, 175s |
| `10750cc2` | 39 | 2 | fixed, 91s |
| `54bd38d2` | 51 | 2 | fixed |
| `d74939ee` | 82 | 2 | fixed |
| `8a447e60` | 39 | 2 | fixed |
| `68643a84` | 43 | 2 | fixed |
| `77fcdd16` | 106 | 2 | fixed |
| `36fd1aec` | 32 | 1 | fixed — 46s, the time is an OCR pass |
| `da4894e7` | 52 | 1 | fixed |
| `5860af0b` | 13 | 1 | fixed |
| `f7a14e18` | 52 | 1 | fixed |
| `a1717d27` | 46 | 1 | fixed |
| `d51c9fad` | 230 | 1 | fixed |
| `1f289e4e` | 15 | 1 | fixed |
| `b1fd4915` | 33 | 1 | fixed — the reported document |

`1067fb90` (665p) went 41 → 2 and `f9046761` (154p) 28 → 4.

### Still open — 6 documents, 308 pages

Marked `INDEXED` with **zero vectors anywhere**. Not a partial-index gap:
nothing was ever written, and per-page repair cannot fix it.

`457d12a8` 198p · `c2256da8` 49p · `f6731412` 31p · `83738a6d` 20p ·
`032289d1` 8p · `a8a47761` 2p

Discriminator run: 30,961 LanceDB rows, 90 distinct `document_id`, 92
`Document` rows. Orphaned ids: 5, all `filing-index-*` synthetics with one
row each. **No id-remap**, no page-count match to any of the six. The files
are all still on disk.

Cause: `ingestion-pipeline.ts` stamped `INDEXED` without checking that any
vectors were written. `verifyIndexing` runs immediately above that write but
is explicitly non-fatal, so its finding never reached the decision. Now
guarded (`29514e21`): 0 chunks with `pageCount > 0` → `ERROR`, with a message
saying it needs re-ingestion.

**These six need re-ingesting.** Not done — 308 pages of OCR/embedding, and
it needs a quiet queue.

### Genuinely unfixable — 4 pages

`f9046761` pages 141, 142, 143, 145: `ocr-empty`. OCR ran through every
extraction path and found no text. This is the correct terminal class.

---

## Defects found by testing rather than by reading

**Density 0 does not mean "no text."** Two pages reported
`textDensity: 0, source: 'extract', textPreview: ''`. Repairing them anyway
took 5s and they came back indexed at density **938 and 524 via plain
extraction** — no OCR. `page-report` reads density from `PageCache`, wiped
after ingestion, then falls back to a `PageScore` snapshot that can predate
the page. A heuristic built on that signal would have abandoned 69
recoverable pages. Corrected in `85a94350`; the runner now attempts the page
and lets the attempt decide.

**A big repair orphaned itself.** 41 OCR pages in one request ran ~370s and
died with a bare `TypeError: fetch failed`. The request was orphaned, not
cancelled — the server was still OCRing page 244 **thirteen minutes** after
the client gave up, holding the document in `FIXING_PARTIAL` with its repair
lock while nothing watched. A later attempt was refused with "A repair is
already running for this document." That is the reported "it says fixing but
nothing is happening". Requests are now chunked to 8 pages (~75s) in both the
runner (`29514e21`) and the panel (`f2446231`).

**A hung embed never threw.** `embeddingProvider.embed()` was a bare `await`.
The error path correctly restores the previous status, but it can only run if
something throws, so a hung host left the document in `FIXING_PARTIAL`
forever. Per-batch deadline added (`ac67a077`).

---

## What was built

- **`partial-repair-runner.ts`** — loops (the route deliberately does not) and
  verifies each document against `page-report` row counts rather than the
  repair endpoint's own claim. Pages the endpoint claims but the index denies
  are reported as `unverified`. Zero-vector documents are classified
  `needs-reingest` and skipped, so a 198-page document does not become 198
  futile one-page repairs.
- **`Repair All Partials` button** — immediately left of the stop button, plus
  the always-visible toolbar (the stop button only exists while documents are
  selected). SSE-streamed; the button becomes its own stop control and the run
  stops at a document boundary, never mid-document — `reindex-pages` deletes a
  page's old vectors before inserting new ones.
- **23 tests** across `partial-repair-runner` (12) and `repair-tracking` (6
  new), plus one route assertion corrected because it encoded defect 2.

Test suites in the touched areas are at baseline parity: 7 pre-existing
failures before this work, 7 after.

---

## Open

1. **Re-ingest the six zero-vector documents** (308 pages). Needs a quiet queue.
2. **`9eb1600e`** (1220p) finished ingesting with **420 unindexed pages** — a
   fresh instance of ordinary partial indexing, repairable via the new button.
3. `ingestion-pipeline.test.ts` was already failing before this work, so the
   new zero-vector guard has **no test covering it**. The guard is verified by
   reasoning and by the live corpus, not by a green suite.
