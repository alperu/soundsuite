# Partial-index repair: the list, tested one by one

**Status:** 13 defects fixed · 24 of 25 original documents cleared · 2 open
**Dates:** 2026-09-15 (survey and repair) · 2026-09-16 (OCR truth-telling)

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

## Part two — what a page's failure actually means (2026-09-16)

The survey above cleared the repairable pages. What remained forced a
correction: the pipeline could not distinguish a page with no text from a page
whose OCR had been thrown away, and it blamed the page for both.

### The conflation

`OCRResult.text === ''` meant two different things:

- the page genuinely has no text, and
- OCR read the page fine and the quality gate discarded its output.

Acting on that, four pages of a tax schedule were labelled "image-only, no
extractable text". The model had in fact returned 11,766–32,467 characters of
correct form data before degenerating into a repetition loop. Two of those
pages later extracted at density 1132 and 1362.

`OCRResult` now carries `rejected`, `rejectionReasons` and
`rejectedTextLength` — the last being the evidence the page HAS text.

### Three page states, not one

| state | meaning | terminal? |
|---|---|---|
| `blank by design` | ink below threshold, OCR empty — no text exists | yes, and not a gap |
| `image-only` | ink present, OCR genuinely returned nothing — a photograph | yes, a fact about the page |
| `ocr-quality-rejected` | OCR read it, the gate discarded the output | **no** — keeps its retry budget |

The operator's page-by-page read is what proved all three are real: of four
pages in one volume, one "has only image" and another "has some document but
it is hard to parse". The classifier now agrees, and the second page indexed on
retry at density 654 — it would have stayed unindexed forever under the
previous terminal `image-only` label.

`image-only` is persisted as a PageCache source so detection can see it, which
required fixing three consumers that each treated an unknown source as a
defect: `indexing-verifier` counted it as a gap, `readiness/collect` scored it
`missing`, and `readiness-backfill` would have **erased every mark** on its
next run.

A document whose only gaps are unindexable now reads **"Indexed (Nothing to
repair)"** in a lighter green and keeps its Fix Partial button — the panel is
how an operator sees which pages hold no text and why.

### Salvaging the discarded text

856 of 1,578 gate rejections were pure `repetition-loop`. The gate is right
that garbage must not reach the index, but discarding everything lost pages
that were largely correct, so the good prefix is now kept when repetition is
the *only* defect. A combined verdict salvages nothing: an output that is also
CJK soup was never trustworthy.

Getting the objective right took three attempts, each corrected by evidence
rather than reasoning:

1. **Longest prefix that passes the gate** — maximises length, so it kept
   repetition up to the detector's tolerance: 2,571 characters returned for
   663 characters of real text.
2. **Last line that said something new** — dragged to the end of the output by
   a single late novel line.
3. **Local dead run of 24-char windows** — what finally worked, because two
   real captures showed the loops are *intra-line*: one had 18 lines averaging
   1,442 characters each, which every line-granularity measure calls healthy.

Verified on those captures: 25,954 → 5,540 chars kept (21%), and 32,467 →
1,893 (6%), where both had previously been discarded whole. Each result is
re-checked against the full gate, is a true prefix, and ends on whitespace.

Capture is gated on `data/ocr-captures/` existing (a directory, not an env
var, so it can be switched on mid-run). **A capture is verbatim OCR of a real
litigation page and must never be committed**; `/data` is gitignored and the
replay test takes its path from `OCR_REJECT_FIXTURE`, skips when unset, and
asserts only on shape.

### Reliability defects found by using the thing

- **A hung embed never threw.** `embed()` was a bare `await`; the error path
  restores status but only runs if something throws.
- **A big repair orphaned itself.** 41 OCR pages in one request ran ~370s and
  died with `TypeError: fetch failed` while the server kept working headless
  for 13 more minutes, holding the repair lock.
- **An SSE stream with no heartbeat** was killed at exactly 300s by undici's
  body timeout. A keepalive comment every 15s fixed it (survived 5m43s).
- **A lock with no owner.** `FIXING_PARTIAL` is the lock; nothing released it
  when the holder vanished, and every later repair was refused 409 forever.
  Now reclaimed after 10 minutes of no progress, failing closed on an
  unparseable timestamp.
- **Blank classification is skipped above 25 gaps** — silently, on exactly the
  documents that need it most. Now logged.

---

## Open

1. **`4740bf99`** — 160 pages under repair as of 2026-09-16 13:09; 72 done in
   the first 9 rounds with zero failures, ~23s/page.
2. **Stop repairing is not dependable** (task #18). It relies on
   `request.signal.aborted`, which fired on a clean socket close and not when
   the client process was killed — the run then continued headless. Needs an
   explicit server-side cancel flag rather than inferring intent from the
   transport.
3. **OCR has no cloud fallback** (task #17). It is the only role without a
   `virtualInference.mode` entry, so it runs solely on a LAN PaddleOCR model
   that has discarded 1,578 outputs. The salvage weakens this case
   considerably — re-measure the rejection rate after a full run before
   spending on a vision model.
4. `ingestion-pipeline.test.ts` was already failing before this work, so the
   zero-vector guard has **no test covering it**. Verified by reasoning and
   against the live corpus, not by a green suite.
5. `9eb1600e` completed: 420 missing → 12 (1205/1220 indexed).
