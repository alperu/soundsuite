/**
 * Tag-aware connectivity reads for the scope editor (`/api/scope/*`).
 *
 * The Haystack graph edges live in two places at once: Prisma FK columns
 * (`parentMotionId`, `amendsId`, `judgeId`, …) and the open tags JSON bag
 * (`respondingTo`, `replyingTo`, and — on live rows — `movantRef` /
 * `respondentRef` / `judgeRef` that were written by the tag panel and never
 * mirrored into columns). Reading columns alone silently misses edges, so
 * every helper here merges both, tags winning, mirroring the read path in
 * `api/haystack/[op]/route.ts`.
 *
 * Two shadow sentinels must be suppressed or every row looks connected:
 *   - `Motion.id === Motion.filingId` — the auto-materialized mirror of a
 *     Filing (see `ensureMotionForFiling`), not a real parent link.
 *   - `MotionAttachment.motionId === MotionAttachment.id` — the FK-satisfying
 *     shadow parent (see `ensureMotionAttachmentForFiling`).
 * Both mirror what `synthesizeRefsFromColumns` already does on the read path.
 *
 * Entity rows adopt `entity.id === Filing.id`, so a filing's connectivity is
 * the union of the Motion and MotionAttachment rows sharing its id. When both
 * exist (attachment-kind filings carry a shadow Motion too), the attachment
 * wins — that's the row the tag panel writes for those kinds.
 */
import { classifyFilingEntityKind } from '@/lib/filings/classify-entity-kind'
import { recoverTagObject, refToId } from '@/lib/haystack/refs'

/** Connectivity edges a filing can carry, all as bare ids. */
export interface ScopeRefs {
  /** Parent motion (Motion.parentMotionId / MotionAttachment.motionId). */
  motionRef?: string
  /** Response → the motion it answers. Tags-only slot. */
  respondingTo?: string
  /** Reply → the response it answers. Tags-only slot. */
  replyingTo?: string
  /** Order / judgment / decree → the motion it rules on. Tags-only slot, and
   *  deliberately distinct from `motionRef`: filed-under is not rules-on. */
  resolves?: string
  amends?: string
  supersedes?: string
  judgeRef?: string
  movantRef?: string
  respondentRef?: string
  authoredBy?: string
}

/** The ref keys the scope graph treats as structural (filing → filing). */
export const STRUCTURAL_REF_KEYS = [
  'motionRef', 'respondingTo', 'replyingTo', 'resolves', 'amends', 'supersedes',
] as const

/** The ref keys the scope graph treats as person attribution. */
export const PERSON_REF_KEYS = [
  'judgeRef', 'movantRef', 'respondentRef', 'authoredBy',
] as const

/** Pull a bare id out of a tags bag for `key`, tolerating every ref shape. */
function tagRef(tags: Record<string, unknown>, key: string): string | undefined {
  const id = refToId(tags[key])
  return id ?? undefined
}

/** Drop undefined/empty entries so `Object.keys(refs).length` means something. */
function compact(refs: ScopeRefs): ScopeRefs {
  for (const k of Object.keys(refs) as Array<keyof ScopeRefs>) {
    if (!refs[k]) delete refs[k]
  }
  return refs
}

/**
 * Minimal row shapes the helpers need. Kept structural (rather than importing
 * Prisma's generated types) so callers can `select` only what they use.
 */
export interface MotionRowLike {
  id: string
  parentMotionId?: string | null
  amendsId?: string | null
  supersedesId?: string | null
  judgeId?: string | null
  movantId?: string | null
  respondentId?: string | null
  tags?: unknown
}

export interface AttachmentRowLike {
  id: string
  motionId?: string | null
  amendsId?: string | null
  supersedesId?: string | null
  authoredById?: string | null
  attachmentKind?: string | null
  tags?: unknown
}

/** Columns + tags for a Motion row. Tags win, per the read path. */
export function refsFromMotion(row: MotionRowLike): ScopeRefs {
  const tags = recoverTagObject(row.tags)
  return compact({
    motionRef: tagRef(tags, 'motionRef') ?? row.parentMotionId ?? undefined,
    respondingTo: tagRef(tags, 'respondingTo'),
    replyingTo: tagRef(tags, 'replyingTo'),
    amends: tagRef(tags, 'amends') ?? row.amendsId ?? undefined,
    supersedes: tagRef(tags, 'supersedes') ?? row.supersedesId ?? undefined,
    judgeRef: tagRef(tags, 'judgeRef') ?? row.judgeId ?? undefined,
    movantRef: tagRef(tags, 'movantRef') ?? row.movantId ?? undefined,
    respondentRef: tagRef(tags, 'respondentRef') ?? row.respondentId ?? undefined,
  })
}

/** Columns + tags for a MotionAttachment row, with the shadow parent suppressed. */
export function refsFromAttachment(row: AttachmentRowLike): ScopeRefs {
  const tags = recoverTagObject(row.tags)
  const realParent =
    typeof row.motionId === 'string' && row.motionId !== row.id ? row.motionId : undefined
  return compact({
    motionRef: tagRef(tags, 'motionRef') ?? realParent,
    respondingTo: tagRef(tags, 'respondingTo'),
    replyingTo: tagRef(tags, 'replyingTo'),
    resolves: tagRef(tags, 'resolves'),
    amends: tagRef(tags, 'amends') ?? row.amendsId ?? undefined,
    supersedes: tagRef(tags, 'supersedes') ?? row.supersedesId ?? undefined,
    authoredBy: tagRef(tags, 'authoredBy') ?? row.authoredById ?? undefined,
  })
}

/**
 * A Motion is unconnected when it carries no relationship at all: every
 * relationship column null AND no person ref in tags. Note the caller must
 * NOT pre-filter shadow Motions — an attachment-kind filing's shadow Motion
 * is a legitimate worklist row under the research definition.
 */
export function motionIsUnconnected(row: MotionRowLike): boolean {
  const refs = refsFromMotion(row)
  return Object.keys(refs).length === 0
}

/**
 * An attachment is unconnected when it still hangs off its own shadow parent
 * and has none of amends / supersedes / authoredBy / respondingTo /
 * replyingTo / motionRef.
 */
export function attachmentIsUnconnected(row: AttachmentRowLike): boolean {
  const refs = refsFromAttachment(row)
  return Object.keys(refs).length === 0
}

/**
 * Which slots a worklist row is missing, in the order the Editor should badge
 * them. `attachmentKind` drives whether we ask for `respondingTo` (response-
 * kind) or `replyingTo` (reply-kind) rather than both — asking for the wrong
 * one on every row makes the badge meaningless.
 */
export function missingForAttachment(row: AttachmentRowLike): string[] {
  const refs = refsFromAttachment(row)
  const missing: string[] = []
  const kind = (row.attachmentKind ?? '').toLowerCase()
  if (kind === 'response' && !refs.respondingTo) missing.push('respondingTo')
  if (kind === 'reply' && !refs.replyingTo) missing.push('replyingTo')
  // An order-shaped filing states its parentage through `resolves` — badging it
  // for a missing `motionRef` after the user has linked the motion it rules on
  // would leave the row in the worklist forever.
  if (!refs.motionRef && !refs.resolves) missing.push('parent motion')
  if (!refs.authoredBy) missing.push('persons')
  return missing
}

export function missingForMotion(row: MotionRowLike): string[] {
  const refs = refsFromMotion(row)
  const missing: string[] = []
  if (!refs.motionRef) missing.push('parent motion')
  if (!refs.judgeRef && !refs.movantRef && !refs.respondentRef) missing.push('persons')
  return missing
}

/** Rows a filing's id can carry, as the caller found them. */
export interface FilingRowPresence {
  /** `MotionAttachment.attachmentKind` when an attachment shares the filing id. */
  attachmentKind?: string | null
  /** A ClerksRecord row lives at the filing id. */
  hasClerksRecord?: boolean
  /** A ReportersRecord row lives at the filing id. */
  hasReportersRecord?: boolean
}

/**
 * The one kind a filing *is* — what the tag panel opens, what a ref write
 * names, what the block shows. Every consumer used to re-derive this from
 * `entityKinds` with `find(k => k !== 'motion')`, which reads `motion` for
 * every Reporter's/Clerk's Record and for every filing whose entity row
 * hasn't been materialized yet.
 *
 * Precedence: an existing attachment row's discriminator, then the filing
 * type's own classification, then whichever record row is present, then
 * `motion`. Type-before-row matters twice — it names filings that carry no
 * entity row yet (`commitEntity` materializes the right one on first save),
 * and it breaks the tie on ids that carry both a ClerksRecord and a
 * ReportersRecord row.
 */
export function primaryKindForFiling(
  filingType: string | null | undefined,
  rows: FilingRowPresence,
): string {
  if (rows.attachmentKind) return rows.attachmentKind
  const { entityKind } = classifyFilingEntityKind(filingType)
  if (entityKind !== 'other') return entityKind
  if (rows.hasReportersRecord) return 'reportersRecord'
  if (rows.hasClerksRecord) return 'clerksRecord'
  return 'motion'
}
