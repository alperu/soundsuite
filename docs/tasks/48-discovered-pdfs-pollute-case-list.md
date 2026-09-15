# DISCOVERED PDFs pollute the case document list

**Status:** Open — needs a scoping decision before implementation · **Effort:** S (display) / M (ingestion scope) · **Priority:** P2
**Created:** 2026-09-15
**Reported as:** a case view listing "a bunch of files that are discovered that I don't need … we don't know why they are there"
**Related:** [task 35 bulk promotion](./35-bulk-promotion.md) · `src/lib/document-status.ts`

No case data. Paths below are generic.

## The complaint

Opening a case at `/?case=<id>` lists a large number of documents in
`DISCOVERED` state that the operator never added and cannot account for. They
carry no meaning for the work being done in that view, and they bury the
documents that do.

## Why they are there

`DISCOVERED` is not junk and not an error state. It is the deliberate resting
state of the watcher (`src/services/file-watcher.ts:202`):

> Create Document record with DISCOVERED status — documents are **NOT**
> automatically queued for indexing. They only transition to QUEUED when a user
> explicitly files them through the UI.

So every PDF the watcher can attribute to a case becomes a row. What decides
attribution is `findCaseForFile` (`src/services/file-watcher.ts:459`):

```ts
for (const watchPath of this.config.watchPaths) {
  if (filePath.startsWith(watchPath)) {
    return await this.prisma.case.findUnique({ where: { path: watchPath } });
  }
}
```

That is **unbounded recursive containment**. Any PDF at any depth beneath a
case's directory becomes a `DISCOVERED` document for that case — scratch
folders, export dumps, downloaded copies, vendor productions staged for later,
duplicates saved beside the original. Nothing about the operator's intent is
consulted, only the path prefix. That fully answers "we don't know why they are
there": nobody put them there for this case; the directory tree did.

The list then shows them by deliberate choice
(`src/app/api/cases/[id]/documents/route.ts:19`):

> No status filter is applied — including DISCOVERED rows so the user can […]

## Two constraints any fix must respect

**1. `document-status.ts` exists because DISCOVERED once vanished, and that fix
must stand.** Its header records the original defect: `DISCOVERED` "appeared in
none of the four hand-copied status unions", so those rows silently dropped out
of the grid, counted toward no badge, and rendered with `undefined` class names.
The lesson taken was "treat an unknown status as *displayable*, never as a
reason to drop a row."

That is **not** in conflict with this task, and the distinction is the whole
design point: the old defect was **silence** — rows disappearing because four
copies of a union drifted apart. What is wanted here is **deliberate,
labelled exclusion from one surface**, with the count still visible and one
click away. An explicit named filter does not reintroduce a copy-paste drift
bug. Do not implement this by removing `DISCOVERED` from a status union.

**2. The promotion planner reads live DISCOVERED counts.**
`src/lib/ingestion/promotion.ts` orders promotion waves by re-reading the
current per-case `DISCOVERED` backlog on every call — deliberately computed,
never stored, because a stored table went stale within hours. Therefore:

- **do not delete these rows**, and
- **do not stop the watcher creating them**

without redesigning bulk promotion at the same time. Either would silently
break wave ordering. This constraint is what pushes the fix toward the **list**
rather than toward ingestion.

## Separate latent defect found while diagnosing this

`filePath.startsWith(watchPath)` is a raw string prefix test with no path
boundary. A case rooted at `/corpus/alpha` therefore also swallows
`/corpus/alpha-archive/scan.pdf` and `/corpus/alphaXX/…` — a *different*
directory whose name merely extends the first. Combined with first-match-wins
over `watchPaths` order, a nested case path can also be shadowed by an ancestor
watch path depending on array order.

This is worth fixing regardless of which option below is chosen:

```ts
const rel = path.relative(watchPath, filePath);
if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) { /* contained */ }
```

Matching the longest watch path rather than the first would fix the shadowing.

## Options

**A — filter the list (recommended).** Default the case document list to hide
`DISCOVERED`, with an explicit `Show discovered (N)` control that reveals them.
The count stays on screen, so nothing goes silent; the rows stay in the
database, so promotion is untouched. Cheapest, reversible, and the only option
that satisfies both constraints above as written.

**B — scope ingestion.** Give a case an opt-in depth limit or an exclude-glob
so the watcher stops attributing unrelated subtrees at all. Addresses the root
cause rather than the symptom, but changes what promotion sees and needs its
own decision about existing rows.

**C — both.** A now, B as a follow-up once the operator can say which
subdirectories were never meant to be case content.

## Open question for the operator

Are the unwanted files in **subdirectories** that should never have been case
content (→ B is the real fix, A is a stopgap), or are they scattered through
the case directory proper and simply not yet filed (→ A is the whole fix)?
The answer decides whether B is worth building, and it cannot be determined
from the code.

## Acceptance

- Opening a case shows only filed/queued/indexed work by default.
- The discovered count remains visible and one interaction away.
- `DISCOVERED` stays in `DOCUMENT_STATUSES` and stays rendered by
  `document-status.ts` helpers — no status union loses a member.
- `planPromotion` still returns the same wave order for the same corpus.
