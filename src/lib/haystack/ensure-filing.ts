/**
 * Filing → entity auto-materializers, extracted from `api/haystack/[op]/route.ts`.
 *
 * The case-management UI keys tag edits by `Filing.id`, but tags live on the
 * XETO entity rows (Motion / MotionAttachment / ReportersRecord / ClerksRecord).
 * For a fresh Filing no entity row exists yet, so the read and commit paths call
 * these helpers to upsert one on first touch, adopting the convention
 * `<entity>.id === Filing.id`. All are idempotent (catch unique-violation races
 * and re-read).
 *
 * Only Prisma + the per-filing-type kind map are needed here — no grid/ref logic.
 */
import { prisma } from '@/lib/db/prisma'
import { PER_FILING_TYPE_KINDS } from '@/lib/filings/classify-entity-kind'

/**
 * Auto-upsert a Motion row mirroring a motion-typed Filing.
 *
 * Background: the case-management UI keys filings (events) by `Filing.id`,
 * but tags live on the XETO entity (Motion / MotionAttachment / etc.). For
 * motion-typed Filings we adopt the convention `Motion.id === Filing.id`, so
 * the panel can read/write tags against the Filing id without the caller
 * needing to know whether a Motion row has been materialized yet.
 *
 * Returns the (possibly freshly-created) Motion row, or null if no Filing
 * exists for `filingId` or the Filing isn't motion-typed.
 *
 * Idempotency: races between two concurrent saves can both reach the
 * `create` call. We catch the unique-violation on the second one and
 * re-read the row.
 *
 * `opts.client` lets a caller run this inside an open transaction — see
 * `ensureMotionAttachmentForFiling`, which needs the Motion and the attachment
 * to land or fail together. Defaults to the ambient client, so every existing
 * caller is unaffected.
 */
export async function ensureMotionForFiling(
  filingId: string,
  opts: { anyFilingType?: boolean; client?: any } = {},
): Promise<any | null> {
  const db = opts.client ?? (prisma as any)
  const existing = await db.motion.findUnique({ where: { id: filingId } })
  if (existing) return existing
  const filing = await db.filing.findUnique({ where: { id: filingId } })
  if (!filing) return null
  // Default behavior (motion-typed Filings only): preserves Task #10 semantics
  // where `kind:'motion'` reads/commits materialize a Motion row.
  //
  // When called from `ensureMotionAttachmentForFiling` (anyFilingType: true)
  // we relax this so per-filing-type kinds (notice/brief/letter/…) can hang
  // their MotionAttachment row off a parent Motion. `MotionAttachment.motionId`
  // is a required FK, so we need a Motion regardless of filing type. The
  // Motion's `motion` marker is still seeded — for non-motion filings it's a
  // structural shadow row, but harmless: the panel reads MotionAttachment for
  // those kinds, not Motion.
  if (!opts.anyFilingType && !/motion/i.test(filing.filingType ?? '')) return null
  try {
    return await db.motion.create({
      data: {
        id: filing.id,
        filingId: filing.id,
        caseId: filing.caseId,
        title: filing.title ?? '',
        description: filing.description ?? null,
        // schema requires startPage (Int). Use 1 as a benign default; the
        // real page range is on the underlying Document, not the Motion
        // entity-level container.
        startPage: 1,
        endPage: null,
        // XETO Motion spec requires the `motion` marker. Seed it so the
        // create passes validation; if the caller's patch also sets it
        // (the common case for the "tag motion=true" panel save), the
        // tag merge is idempotent.
        tags: { motion: { _kind: 'marker' } } as any, // marker; `dict()` also accepts `true` but Hayson form is explicit
      },
    })
  } catch (e: any) {
    // Inside a transaction a failed statement can poison the rest of it, so
    // recovery does not belong here — rethrow and let the caller re-read once
    // its transaction has rolled back.
    if (opts.client) throw e
    // Likely a unique-violation race — another request created it first.
    const row = await (prisma as any).motion.findUnique({ where: { id: filingId } })
    if (row) return row
    throw e
  }
}

/**
 * EntityKind → MotionAttachment.attachmentKind. Identity mapping for the 22
 * per-filing-type kinds. `motion` is NOT in here — that goes through
 * `ensureMotionForFiling`, not MotionAttachment.
 *
 * Single source of truth: `PER_FILING_TYPE_KINDS` in
 * `src/lib/filings/classify-entity-kind.ts`. Both this map and
 * `tableFromFilter` import from there so the read-side and commit-side stay
 * in sync.
 */
export const KIND_TO_ATTACHMENT_KIND: Record<string, string> = PER_FILING_TYPE_KINDS

/**
 * Auto-upsert a `MotionAttachment` row mirroring a non-motion-typed Filing.
 * Parallel to `ensureMotionForFiling` for the Motion case.
 *
 * The tag panel keys per-filing-type tag edits by `Filing.id`, but tags live
 * on `MotionAttachment.tags` (rows discriminated by `attachmentKind`). For a
 * fresh Notice / Brief / Letter / … Filing no MotionAttachment row exists
 * yet, so the panel's `read?filter=notice&id=@<filing-id>` returns an empty
 * grid and the subsequent `commit` finds nothing to update.
 *
 * We adopt the convention `MotionAttachment.id === Filing.id` (same trick as
 * Motion). Because `MotionAttachment.motionId` is a required FK, we also
 * materialize a parent Motion row using the relaxed `ensureMotionForFiling`
 * (anyFilingType: true). The shadow Motion exists only to satisfy the FK;
 * the tag panel reads MotionAttachment for these kinds.
 *
 * Idempotent — catches unique-violation races and re-reads.
 *
 * The two creates run in ONE transaction. They used to be sequential awaits, so
 * an attachment create that failed for any reason other than the unique race
 * left the shadow Motion behind while the caller was told the row did not
 * exist — an orphan nobody would go looking for (#98). Either both rows exist
 * afterwards or neither does.
 */
export async function ensureMotionAttachmentForFiling(
  filingId: string,
  attachmentKind: string,
): Promise<any | null> {
  const existing = await (prisma as any).motionAttachment.findUnique({ where: { id: filingId } })
  if (existing) return existing
  const filing = await (prisma as any).filing.findUnique({ where: { id: filingId } })
  if (!filing) return null

  // Auto-link the Filing's primary indexed Document into documentId so the
  // tag-panel's `fileRef` field shows the actual PDF without manual picking
  // (Task #3). Typical filings have exactly one PDF; we pick the oldest by
  // createdAt to be deterministic. Read before the transaction opens — it
  // writes nothing, and holding a write transaction across it buys nothing.
  const primaryDoc = await (prisma as any).document.findFirst({
    where: { filingId },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  })

  try {
    return await (prisma as any).$transaction(async (tx: any) => {
      // Ensure a parent Motion row exists for the FK — inside the transaction,
      // so it rolls back with the attachment if the attachment cannot be made.
      const motion = await ensureMotionForFiling(filingId, { anyFilingType: true, client: tx })
      if (!motion) return null

      return await tx.motionAttachment.create({
        data: {
          id: filingId,
          motionId: motion.id,
          caseId: filing.caseId,
          attachmentKind,
          revisionSeq: filing.supplementalOrder ?? 1,
          documentId: primaryDoc?.id ?? null,
          // Seed XETO markers so the row passes any future validator hooks. The
          // `attachment` umbrella marker plus the specific kind marker mirror
          // what the tag-spec entries for each kind define.
          tags: {
            attachment: { _kind: 'marker' },
            [attachmentKind]: { _kind: 'marker' },
          } as any,
        },
      })
    })
  } catch (e: any) {
    // The transaction has rolled back by now, so this read sees committed state
    // only: a concurrent request that won the race, or nothing at all. Same
    // unique-violation recovery as before, just outside the aborted transaction.
    const row = await (prisma as any).motionAttachment.findUnique({ where: { id: filingId } })
    if (row) return row
    throw e
  }
}

/**
 * Auto-upsert a `ReportersRecord` row mirroring a Reporter's Record-typed
 * Filing. Parallel to `ensureMotionForFiling` / `ensureMotionAttachmentForFiling`.
 *
 * `ReportersRecord` has its own dedicated Prisma table (not the
 * `MotionAttachment` umbrella). We adopt the same convention as Motion:
 * `ReportersRecord.id === Filing.id`, so the panel can read/commit tags
 * against the Filing id without the caller needing to know whether the row
 * has been materialized yet.
 *
 * Required FK on the Prisma model is `caseId`, which we copy from
 * `Filing.caseId`. Seeds the `reportersRecord` XETO marker in tags so the
 * row passes any future validator hooks. Idempotent — catches unique-
 * violation races and re-reads.
 *
 * Returns the row, or null if no Filing exists for `filingId`. Does NOT
 * gate on filingType: callers (the read+commit paths) only reach this
 * helper after the panel resolved the Filing to entityKind=reportersRecord,
 * so the filingType check is redundant noise that would prevent legitimate
 * reads if a Filing's `filingType` string didn't pass a regex.
 */
export async function ensureReportersRecordForFiling(filingId: string): Promise<any | null> {
  const existing = await (prisma as any).reportersRecord.findUnique({ where: { id: filingId } })
  if (existing) return existing
  const filing = await (prisma as any).filing.findUnique({ where: { id: filingId } })
  if (!filing) return null
  try {
    return await (prisma as any).reportersRecord.create({
      data: {
        id: filing.id,
        caseId: filing.caseId,
        tags: { reportersRecord: { _kind: 'marker' } } as any,
      },
    })
  } catch (e: any) {
    const row = await (prisma as any).reportersRecord.findUnique({ where: { id: filingId } })
    if (row) return row
    throw e
  }
}

/**
 * Auto-upsert a `ClerksRecord` row mirroring a Clerk's Record-typed Filing.
 * Twin of `ensureReportersRecordForFiling`. Same id-mirroring convention
 * and idempotency.
 */
export async function ensureClerksRecordForFiling(filingId: string): Promise<any | null> {
  const existing = await (prisma as any).clerksRecord.findUnique({ where: { id: filingId } })
  if (existing) return existing
  const filing = await (prisma as any).filing.findUnique({ where: { id: filingId } })
  if (!filing) return null
  try {
    return await (prisma as any).clerksRecord.create({
      data: {
        id: filing.id,
        caseId: filing.caseId,
        tags: { clerksRecord: { _kind: 'marker' } } as any,
      },
    })
  } catch (e: any) {
    const row = await (prisma as any).clerksRecord.findUnique({ where: { id: filingId } })
    if (row) return row
    throw e
  }
}
