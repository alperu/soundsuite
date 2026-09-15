# Case document list showed every swept-up PDF, not the case's filed documents

**Status:** Part 1 fixed (list predicate) · Part 2 open (deletion does not stick) · Part 3 flagged only
**Effort:** S (done) / M (tombstone) · **Priority:** P2
**Created:** 2026-09-15
**Related:** [task 35 bulk promotion](./35-bulk-promotion.md) · `src/lib/document-status.ts` · `src/lib/ingestion/promotion.ts`

Counts only — no case names, cause numbers or file names.

## The complaint

A case view listed hundreds of documents the operator never added: "we don't
need discovered PDFs in the list, they have no meaning for us, we don't know why
they are there." Deleting them did not help — "I delete it, they come back."

The measurement that defined the fix: one case rendered **488 documents against
24 filings**. The operator's own statement of intent was "we only need PDFs that
have filings."

## What was actually wrong

Two surfaces disagreed about what a case's document list means.

`src/app/page.tsx` has always been right. Both its queries — the grid's initial
documents and the per-case status chips — filter `filingId: { not: null }`.

`src/app/api/documents/route.ts` did not filter at all. And
`document-grid.tsx` re-fetches from that route on mount **and then every two
seconds**. So the server rendered 24 documents and the first poll, a few hundred
milliseconds later, replaced them with all 488. The list was correct for exactly
one frame.

That is also why it looked like a data problem rather than a display one: the
number was never stable, and nothing the operator deleted changed the shape of
it.

## The predicate, and the one that would have failed

The filter is **`filingId != null`**. It is not a status filter, and reaching
for `status === 'DISCOVERED'` — the obvious reading of the complaint, and the
first design attempted here — would have hidden **nothing**.

Measured breakdown of the reported case:

| status | filed | unfiled |
|---|---|---|
| QUEUED | — | 455 |
| INDEXED | 23 | 5 |
| PROCESSING | 1 | 4 |
| **DISCOVERED** | — | **0** |

Zero DISCOVERED rows. The cause is `PROMOTION_MODE_RATIONALE` in
`src/lib/ingestion/promotion.ts`: bulk promotion is *deliberately unfiled* — it
moves documents DISCOVERED → QUEUED → INDEXED and sets `status` and nothing
else. The unwanted rows had therefore already been promoted out of DISCOVERED
long before anyone looked at the list.

`23 INDEXED-filed + 1 PROCESSING-filed = 24`, reproducing the filing count
exactly. That arithmetic is what confirmed the predicate.

## Fix applied (part 1)

`src/app/api/documents/route.ts` now defaults to `filingId: { not: null }`,
matching `page.tsx`. Verified live: **488 → 24**.

Two things deliberately included:

- **`?includeUnfiled=1`** for callers that legitimately browse the whole corpus.
  `image-insert-modal.tsx` is the one real case — page images are read from the
  PDF itself, so any indexed document is a valid source whether or not a filing
  references it. It passes the flag and is unchanged.
- **`unfiledHidden`** in the response, rendered by `document-grid.tsx` as
  "24 filed · 464 not attached to a filing", and as an explanatory line in the
  empty state. The count must stay on screen: `document-status.ts` exists
  because DISCOVERED rows once dropped out of the grid with nothing to show they
  existed, and hiding 464 files with no trace would be the same defect in a new
  place.

The default is filtered rather than the grid passing an opt-in flag, so that a
future caller which forgets the parameter gets the case's real documents instead
of the disk sweep. That was the operator's actual question — "what can we do so
this does not happen again."

Guard: `src/app/api/documents/__tests__/filed-only-listing.test.ts`, which pins
the predicate, pins that it is *not* a status filter, and pins that only the
exact opt-in string disables it.

## Part 2 — open: deletion does not stick

Still unfixed, and it is the other half of the complaint.

`DELETE /api/documents/[id]` hard-deletes the row. The file remains on disk, and
`findCaseForFile` re-attributes it on the next `add` event — which
`POST /api/cases/[id]/rescan` triggers deliberately by **restarting the
FileWatcher so chokidar re-walks every path**. `onFileAdded` guards against
duplicates by `hash` and by `filePath`, but only against *rows that still
exist*; once deleted there is nothing left to match, so it is recreated.

Proposed: an `IgnoredFile` tombstone table — a new model rather than a
soft-delete flag on `Document`, so that every existing counting query
(corpus-status, corpus-denominator, page.tsx chips, promotion planning) stays
correct with no changes, because the rows are genuinely gone.

Design constraints established:

- **Key on path OR hash.** Path alone resurrects on rename; hash alone
  resurrects on any re-save.
- **Both watcher write paths need the check.** `onFileAdded` creates, and
  `onFileChanged` upserts with an unconditional `update: { status: 'DISCOVERED' }`.
- **Migration:** back up `prisma/data/sound-suite.db` (not `data/`), hand-write
  the SQL, apply with `migrate deploy`. Never `migrate dev`, never `db push` —
  23 tracked migrations already exist.

Note that part 1 lowers the urgency of this considerably: with the list showing
only filed documents, there is no longer a reason to delete anything just to
clean up the view. The tombstone becomes the answer for genuinely unwanted
files, not the workaround for a broken list.

## Part 3 — flagged, not fixed: unfiled documents are being ingested

Across the corpus: **1,374 documents, 92 with filings.** Of the remainder,
**537 are QUEUED** — sitting in the ingestion queue, consuming OCR and embedding
work, for documents no filing references.

This is plausibly a large share of the pipeline load. It is out of scope for the
list fix and needs an explicit decision, because draining that queue is a
destructive-ish operation on 537 rows.

Related: **174 documents are INDEXED but unfiled.** They keep their vectors and
still surface in search results. Hiding them from the case list does not remove
them from the corpus — that is a consequence of the requested change, not a
defect in it.

## Separate latent defect found while diagnosing

`findCaseForFile` (`src/services/file-watcher.ts:459`) attributes a file with a
raw string prefix and no path boundary:

```ts
if (filePath.startsWith(watchPath)) { … }
```

A case rooted at `/corpus/alpha` therefore also swallows
`/corpus/alpha-archive/scan.pdf` — a different directory whose name merely
extends the first. Combined with first-match-wins over `watchPaths`, a nested
case path can also be shadowed by an ancestor. Fix:

```ts
const rel = path.relative(watchPath, filePath);
if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) { /* contained */ }
```

…and match the longest watch path rather than the first.

Also noted while reading that file: `onFileChanged`'s upsert sets
`status: 'DISCOVERED'` unconditionally, so touching a filed, indexed document's
file on disk demotes it back to DISCOVERED. Untested and unfixed — recorded
here because it is adjacent, not because it is in scope.
