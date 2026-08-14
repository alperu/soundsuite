/**
 * Haystack `commit` write path — extracted from `api/haystack/[op]/route.ts`.
 *
 * `commitEntity` is the single source of truth for Case and Filing writes:
 * it splits an incoming patch into a column-patch (real Prisma columns) and a
 * tag-patch (the `tags` JSON bag) and persists BOTH in one create/update,
 * auto-materializing Filing-backed rows, busting the ref-label cache, and
 * inlining ref labels + provenance Origin onto the response row.
 *
 * Exported so the route's `opCommit` handler and the legacy `/api/cases/*`
 * endpoints (`fill-haystack-tags`, `revert`) share one write path.
 */
import { errGrid } from '@/lib/legal/hayson'
import { prisma } from '@/lib/db/prisma'
import { PER_FILING_TYPE_KINDS } from '@/lib/filings/classify-entity-kind'
import { enforceFileRefSync } from '@/lib/tag-fill/fileref-sync'
import {
  invalidateLabelCache,
  collectRefIdsFromPatch,
  inlineRefLabels,
  tableForKind,
  ORIGIN_RELEVANT_TABLES,
  applyOrigin,
  deriveOrigin,
  getSelfPersonId,
  recoverTagObject,
  refToId,
  stripSelfRefs,
} from './refs'
import {
  ensureMotionForFiling,
  ensureMotionAttachmentForFiling,
  ensureReportersRecordForFiling,
  ensureClerksRecordForFiling,
  KIND_TO_ATTACHMENT_KIND,
} from './ensure-filing'

// Map EntityKind → Prisma model name (camelCase). Per-filing-type EntityKinds
// (notice/brief/response/…) all serialize to the MotionAttachment Prisma table
// — its `attachmentKind` discriminator (set at row creation) carries the type.
// The full per-filing-type list is pulled from `PER_FILING_TYPE_KINDS` so
// adding a new EntityKind only requires touching one constant.
export const KIND_MODEL_MAP: Record<string, string> = {
  case: 'case',
  motion: 'motion',
  motionEvent: 'motionEvent',
  motionAttachment: 'motionAttachment',
  hearing: 'hearing',
  person: 'person',
  personRole: 'personRole',
  court: 'court',
  clerksRecord: 'clerksRecord',
  reportersRecord: 'reportersRecord',
  ...Object.fromEntries(
    Object.keys(PER_FILING_TYPE_KINDS).map((k) => [k, 'motionAttachment'] as const),
  ),
}

// Columns that hold DateTime values. JSON arrives as ISO strings; Prisma
// requires `Date` instances. Per Prisma model.
const DATE_COLUMNS: Record<string, Set<string>> = {
  motionEvent: new Set(['occurredOn', 'courtFilingDate']),
  personRole: new Set(['appearedOn', 'withdrewOn']),
  hearing: new Set(['scheduledFor', 'heldOn']),
  clerksRecord: new Set(['filedOn']),
  reportersRecord: new Set(['hearingDate']),
}

// Per-kind required column-fields for CREATE. Validated before Prisma so the
// err grid is clear instead of a P2002/P2025 surprise.
const REQUIRED_ON_CREATE: Record<string, string[]> = {
  case: ['name', 'path'],
  motion: ['caseId', 'title'],
  motionEvent: ['motionId', 'caseId', 'kind', 'occurredOn'],
  motionAttachment: ['motionId', 'caseId', 'attachmentKind'],
  person: ['displayName'],
  personRole: ['personId', 'scopeKind', 'scopeId'],
  hearing: ['scheduledFor'],
  court: ['name'],
  clerksRecord: ['caseId'],
  reportersRecord: ['caseId'],
}

/**
 * Per-model set of real DB columns (everything else in a patch is a tag).
 * The tag panel sends back the full draft record (columns + inlined tags),
 * so the patch may contain `name`, `caseNumber`, `path`, etc. — those are
 * real DB columns, not tags, and must not be merged into the JSON.
 */
export const NON_TAG_COLUMNS: Record<string, Set<string>> = {
  case: new Set(['id', 'tags', 'name', 'path', 'caseNumber', 'jurisdiction', 'country', 'state', 'county', 'createdAt', 'updatedAt']),
  motion: new Set(['id', 'tags', 'filingId', 'caseId', 'parentMotionId', 'amendsId', 'supersedesId', 'revisionSeq', 'judgeId', 'movantId', 'respondentId', 'title', 'description', 'startPage', 'endPage', 'createdAt', 'updatedAt']),
  motionEvent: new Set(['id', 'tags', 'motionId', 'caseId', 'kind', 'occurredOn', 'courtFilingDate', 'causeNoStamp', 'documentId', 'authoredById', 'servedOnId', 'courtClerkId', 'courtReporterId', 'hearingId', 'createdAt', 'updatedAt']),
  motionAttachment: new Set(['id', 'tags', 'motionId', 'caseId', 'attachmentKind', 'documentId', 'amendsId', 'supersedesId', 'revisionSeq', 'authoredById', 'createdAt', 'updatedAt']),
  person: new Set(['id', 'tags', 'displayName', 'email', 'barNumber', 'jurisdictionId', 'createdAt', 'updatedAt']),
  personRole: new Set(['id', 'tags', 'personId', 'scopeKind', 'scopeId', 'appearedOn', 'withdrewOn', 'createdAt', 'updatedAt']),
  hearing: new Set(['id', 'tags', 'judgeId', 'courtReporterId', 'courtClerkId', 'scheduledFor', 'heldOn', 'durationMin', 'location', 'transcriptDocumentId', 'hearingType', 'createdAt', 'updatedAt']),
  court: new Set(['id', 'tags', 'name', 'shortName', 'jurisdictionId', 'courtType', 'address', 'phone', 'website', 'createdAt', 'updatedAt']),
  clerksRecord: new Set(['id', 'tags', 'caseId', 'volume', 'filedOn', 'documentId', 'createdAt', 'updatedAt']),
  reportersRecord: new Set(['id', 'tags', 'caseId', 'reporterId', 'volume', 'hearingDate', 'documentId', 'createdAt', 'updatedAt']),
}

/**
 * Split an incoming patch into `columnPatch` (real Prisma columns) and
 * `tagPatch` (everything else, destined for the `tags` JSON bag). Also
 * coerces dates from ISO strings → `Date`. Drops structural keys
 * (`id`/`tags`/`createdAt`/`updatedAt`) from the column patch.
 */
export function splitPatch(
  model: string,
  patch: any,
): { columnPatch: Record<string, unknown>; tagPatch: Record<string, unknown> } {
  const columnPatch: Record<string, unknown> = {}
  const tagPatch: Record<string, unknown> = {}
  if (!patch || typeof patch !== 'object') return { columnPatch, tagPatch }

  const colSet = NON_TAG_COLUMNS[model] ?? new Set(['id', 'tags', 'createdAt', 'updatedAt'])
  const structural = new Set(['id', 'tags', 'createdAt', 'updatedAt'])
  const dateCols = DATE_COLUMNS[model] ?? new Set<string>()
  /** A `caseRef` seen in the patch, translated to `caseId` after the loop. */
  let caseRefValue: unknown = undefined

  for (const [k, vRaw] of Object.entries(patch)) {
    if (structural.has(k)) continue
    // Read-only server-inlined ref-label siblings (`caseRefLabel`, …) must
    // never reach the tags JSON. The client strips these too; this is belt-
    // and-suspenders for any other caller of commitEntity.
    if (k.endsWith('Label')) continue
    // `dis` is server-synthesized on read (via computeDis) — never persist it.
    if (k === 'dis') continue
    // `origin` is server-synthesized on read (via deriveOrigin) — never
    // persist the scalar discriminator. The four marker keys (selfFiled,
    // opposingFiled, courtIssued, thirdParty) still flow through to tagPatch
    // below — that's the manual-override persistence path.
    if (k === 'origin') continue
    // `orderRefs` is the derived inverse of the orders' `resolves` slot,
    // recomputed on every Motion read. The panel posts back the whole inlined
    // record, so without this the list freezes into tags JSON — and the read
    // path layers tags OVER synthesized values, so that stale copy would then
    // beat the live derivation. The edge is written on the order, never here.
    if (k === 'orderRefs') continue
    // `caseRef` is the panel's case picker, and it TRANSLATES to the
    // authoritative `caseId` column rather than persisting as a tag. Reads
    // synthesize caseRef from that column, so a tag copy would be a second
    // writable source of truth for one fact — and since reads layer tags OVER
    // synthesized refs, a stale tag would win and show the row under a case it
    // doesn't belong to. Translating instead of dropping is what turns the
    // picker into a real "move this filing" control. Deferred until after the
    // loop so an explicit `caseId` in the same patch still wins.
    if (k === 'caseRef') {
      caseRefValue = vRaw
      continue
    }
    if (colSet.has(k)) {
      let v = vRaw
      // Normalize empty strings on nullable columns to null so the form's
      // "clear the field" UX actually clears the column.
      if (typeof v === 'string') v = v.trim()
      if (v === '') v = null
      // Coerce ISO date strings to Date for DateTime columns.
      if (dateCols.has(k) && typeof v === 'string') {
        const d = new Date(v)
        v = isNaN(d.getTime()) ? null : d
      } else if (dateCols.has(k) && v != null && (v as any) instanceof Date === false) {
        // Hayson date wrappers like { _kind: 'dateTime', val: '...' }
        const inner = (v as any)?.val
        if (typeof inner === 'string') {
          const d = new Date(inner)
          v = isNaN(d.getTime()) ? null : d
        }
      }
      columnPatch[k] = v
    } else {
      tagPatch[k] = vRaw
    }
  }

  // Land the translated case pointer. Only for models that actually own a
  // `caseId` column (Case itself doesn't), only when the patch didn't set the
  // column explicitly, and only for a resolvable id — clearing the picker is
  // not a move, and `caseId` is a required FK on most of these models, so a
  // null would fail the write rather than express anything the user meant.
  if (caseRefValue !== undefined && colSet.has('caseId') && columnPatch.caseId === undefined) {
    const caseId = refToId(caseRefValue)
    if (caseId) columnPatch.caseId = caseId
  }

  return { columnPatch, tagPatch }
}

/**
 * Strip column-level fields from a patch, returning only the tag fields.
 */
export function filterToTagFields(model: string, patch: any): Record<string, unknown> {
  if (!patch || typeof patch !== 'object') return {}
  const skip = NON_TAG_COLUMNS[model] ?? new Set(['id', 'tags', 'createdAt', 'updatedAt'])
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch)) {
    if (skip.has(k)) continue
    out[k] = v
  }
  return out
}

/**
 * Post-commit hooks for Case path changes. Mirrors the legacy
 * `PATCH /api/cases/[id]` behavior: when `path` changes (or a new case is
 * created), reconcile the FileWatcher.
 *
 * Errors from the reattach call are swallowed and logged — a saved path
 * change with a stale watcher is still better than rolling back the commit.
 * Operators can recover by restarting the service.
 */
async function applyCaseSideEffects(
  before: { path?: string | null } | null,
  after: { id?: string | null; path?: string | null } | null,
): Promise<void> {
  const afterRaw = typeof after?.path === 'string' ? after.path : null
  const afterPath = afterRaw?.trim() || null
  if (!afterPath) return
  const beforeRaw = typeof before?.path === 'string' ? before.path : null
  const beforePath = beforeRaw?.trim() || null
  // Migrator trigger uses raw before vs raw after so that whitespace-only
  // edits (e.g. trimming a trailing space) still rebase Document.filePath.
  // Watcher uses the trimmed paths.
  const rawChanged = !!beforeRaw && beforeRaw !== afterRaw
  try {
    const { getServicesManager } = await import('@/lib/services-manager')
    const fileWatcher = getServicesManager().getFileWatcher()
    if (!fileWatcher) {
      console.log(
        `[haystack/commit] case-path change: file-watcher not registered, skipping reattach (case=${after?.id ?? '?'} new=${JSON.stringify(afterPath)})`,
      )
      return
    }
    if (!before) {
      console.log(`[haystack/commit] case create: attaching file-watcher (case=${after?.id ?? '?'} path=${JSON.stringify(afterPath)})`)
      await fileWatcher.reattachCase({ oldPath: null, newPath: afterPath, caseId: after?.id ?? null })
    } else if (rawChanged) {
      const oldForWatcher = beforePath && beforePath !== afterPath ? beforePath : null
      if (oldForWatcher) {
        console.log(`[haystack/commit] case-path changed, reattach: ${JSON.stringify(beforePath)} -> ${JSON.stringify(afterPath)} (case=${after?.id ?? '?'})`)
        await fileWatcher.reattachCase({ oldPath: oldForWatcher, newPath: afterPath, caseId: after?.id ?? null })
      } else {
        console.log(`[haystack/commit] case-path whitespace-only edit: ${JSON.stringify(beforeRaw)} -> ${JSON.stringify(afterRaw)} (case=${after?.id ?? '?'}); skipping watcher reattach, running doc-migrate`)
      }
      if (after?.id && beforeRaw) {
        try {
          const { migrateDocumentsForCasePath } = await import('@/services/document-path-migrator')
          const result = await migrateDocumentsForCasePath(after.id, beforeRaw, afterPath)
          console.log(`[doc-migrate] case=${after.id} updated=${result.updated} skipped=${result.skipped}`)
        } catch (e) {
          console.warn(`[doc-migrate] failed case=${after?.id ?? '?'}: ${e instanceof Error ? e.message : e}`)
        }
      }
    }
  } catch (e: any) {
    console.log(`[haystack/commit] file-watcher reattach failed (case=${after?.id ?? '?'}): ${e?.message ?? e}`)
  }
}

/**
 * Map Prisma errors → user-friendly err grids. P2002 is unique-violation,
 * P2025 is record-not-found, etc.
 */
export function prismaErrToGrid(e: any, kind: string): string {
  const code = e?.code
  if (code === 'P2002') {
    const tgt = e?.meta?.target
    const fields = Array.isArray(tgt) ? tgt.join(', ') : String(tgt ?? 'unique field')
    return errGrid(`${kind} ${fields} must be unique (constraint violation)`)
  }
  if (code === 'P2025') return errGrid(`${kind} not found`)
  if (code === 'P2003') return errGrid(`${kind} foreign key constraint failed: ${e?.meta?.field_name ?? ''}`)
  return errGrid(`commit failed: ${e?.message ?? e}`)
}

/** Merge a row's `tags` JSON bag up to the top level for the response row. */
function inlineRow(updated: any): any {
  const tags = recoverTagObject(updated.tags)
  return { ...updated, ...tags, tags }
}

/**
 * Validate that a Case.path points at an existing directory.
 * Returns `true` on success, or an error string on failure.
 */
async function validateCasePath(p: unknown): Promise<true | string> {
  if (typeof p !== 'string' || p.trim() === '') return 'case path is required'
  const fs = await import('fs/promises')
  try {
    const stat = await fs.stat(p.trim())
    if (!stat.isDirectory()) return `path is not a directory: ${p}`
    return true
  } catch {
    return `folder does not exist: ${p}`
  }
}

/**
 * Core commit function — exported so the route's `opCommit` and the legacy
 * `/api/cases/*` endpoints can call into the same write path.
 *
 * Accepts `{ id, kind, patch }`. Splits the patch into a column-patch (real
 * Prisma columns) and a tag-patch (everything else), and writes BOTH in one
 * create/update. When `id` is missing OR equals "new", an INSERT is performed
 * with per-kind required-field validation.
 */
export async function commitEntity(input: {
  id?: string | null
  kind: string
  patch: Record<string, unknown>
}): Promise<{ ok: true; row: any } | { ok: false; errGridJson: string }> {
  const { kind } = input
  let id = input.id
  if (typeof id === 'string') id = id.replace(/^@/, '')
  if (id === 'new' || id === '') id = null

  const model = KIND_MODEL_MAP[kind]
  if (!model) return { ok: false, errGridJson: errGrid(`unknown kind: ${kind}`) }
  const client = (prisma as any)[model]
  if (!client?.update || !client?.create) {
    return { ok: false, errGridJson: errGrid(`Prisma model ${model} not available`) }
  }

  const patch = input.patch ?? {}
  if (!patch || typeof patch !== 'object') {
    return { ok: false, errGridJson: errGrid('commit requires a patch object') }
  }

  const { columnPatch, tagPatch } = splitPatch(model, patch)
  enforceFileRefSync(model, columnPatch, tagPatch)

  // ─── CREATE ─────────────────────────────────────────────────────────────
  if (!id) {
    const required = REQUIRED_ON_CREATE[kind] ?? []
    const missing = required.filter((k) => {
      const v = columnPatch[k]
      return v == null || (typeof v === 'string' && v === '')
    })
    if (missing.length) {
      return { ok: false, errGridJson: errGrid(`${kind} create missing required: ${missing.join(', ')}`) }
    }

    // Case-specific defaults & path validation
    if (kind === 'case') {
      if (columnPatch.country == null) columnPatch.country = 'United States'
      const pathOk = await validateCasePath(columnPatch.path as string)
      if (pathOk !== true) return { ok: false, errGridJson: errGrid(pathOk) }
      // Trim trailing slashes
      columnPatch.path = (columnPatch.path as string).replace(/\/+$/, '')
    }

    const createData: any = { ...columnPatch }
    if (Object.keys(tagPatch).length) createData.tags = tagPatch

    try {
      const created = await client.create({ data: createData })
      if (kind === 'case') await applyCaseSideEffects(null, created)
      // Bust any cached "(missing)" labels for ids the patch attached, so the
      // resolver below picks up the freshly-created targets instead of stale
      // negatives.
      invalidateLabelCache(collectRefIdsFromPatch(patch))
      // Inline ref labels into the response so the panel can render display
      // names immediately after save (without forcing a follow-up read).
      const row = await inlineRefLabels(inlineRow(created), tableForKind(kind))
      // Materialize Origin marker on the commit response so the panel sees
      // the freshly-derived provenance without a follow-up read.
      const tableForOrigin = tableForKind(kind)
      if (ORIGIN_RELEVANT_TABLES.has(tableForOrigin)) {
        applyOrigin(row, await deriveOrigin(row, tableForOrigin, await getSelfPersonId()))
      }
      return { ok: true, row }
    } catch (e: any) {
      return { ok: false, errGridJson: prismaErrToGrid(e, kind) }
    }
  }

  // ─── UPDATE ─────────────────────────────────────────────────────────────
  try {
    let existing = await client.findUnique({ where: { id } })
    if (!existing && kind === 'motion') {
      existing = await ensureMotionForFiling(id)
    }
    if (!existing && model === 'motionAttachment') {
      // Per-filing-type kinds (notice/brief/letter/…) all resolve to the
      // motionAttachment Prisma model. Auto-upsert the row from the Filing
      // on first save so the panel doesn't have to pre-create it.
      const ak = KIND_TO_ATTACHMENT_KIND[kind]
      if (ak) existing = await ensureMotionAttachmentForFiling(id, ak)
    }
    if (!existing && kind === 'reportersRecord') {
      existing = await ensureReportersRecordForFiling(id)
    }
    if (!existing && kind === 'clerksRecord') {
      existing = await ensureClerksRecordForFiling(id)
    }
    if (!existing) {
      return { ok: false, errGridJson: errGrid(`${kind} ${id} not found`) }
    }

    // Case path validation only when path actually changed
    if (kind === 'case' && typeof columnPatch.path === 'string' && columnPatch.path !== existing.path) {
      const pathOk = await validateCasePath(columnPatch.path)
      if (pathOk !== true) return { ok: false, errGridJson: errGrid(pathOk) }
      columnPatch.path = (columnPatch.path as string).replace(/\/+$/, '')
    }

    const currentTags = recoverTagObject(existing.tags)
    const merged: Record<string, unknown> = { ...currentTags, ...tagPatch }
    for (const k of Object.keys(merged)) {
      if (merged[k] == null) delete merged[k]
    }
    // Drop self-referential refs (motionRef: @<own-id>, etc.) before persisting.
    // Same guard as the read path — keeps tags JSON free of self-loops so
    // future reads don't have to filter them.
    if (id) {
      (merged as Record<string, unknown>).id = id
      stripSelfRefs(merged as Record<string, unknown>)
      delete (merged as Record<string, unknown>).id
    }

    const data: any = { ...columnPatch }
    // Only write the `tags` column when the patch actually contains tag
    // fields. Otherwise leave it untouched — the legacy PATCH /api/cases
    // path never touched tags, and re-sending the existing tag bag would
    // re-trigger the XETO validator on legacy/un-migrated tag keys.
    if (Object.keys(tagPatch).length > 0) {
      data.tags = merged
      // Re-send the row's own discriminator with a tag write so the XETO
      // extension can pick the concrete subtype spec (Notice, Order, …) —
      // it only ever sees `args.data`. Same value that's already stored, so
      // the column is unchanged; the alternative is a pre-read inside the
      // extension, which would import the client it extends.
      if (model === 'motionAttachment' && existing.attachmentKind && data.attachmentKind == null) {
        data.attachmentKind = existing.attachmentKind
      }
    }

    const updated = await client.update({ where: { id }, data })
    if (kind === 'case') await applyCaseSideEffects(existing, updated)
    // Bust label-cache for any ref id the patch touched. The read-side LRU
    // ages at 60s, but if a previously-empty Person row was just attached
    // here, an earlier "(missing)" sentinel would still hide the new label
    // until TTL — fix by dropping the entry before re-resolving.
    invalidateLabelCache(collectRefIdsFromPatch(patch))
    // Re-resolve labels on the returned row so the client's `setRecord(rec)`
    // after `hsCommit` lands rows with `<refName>Label` arrays present — the
    // bug that made plaintiffRefs render as UUIDs immediately post-save.
    const row = await inlineRefLabels(inlineRow(updated), tableForKind(kind))
    // Materialize Origin marker on update response too — keeps panel rendering
    // identical to a follow-up read.
    const tableForOrigin = tableForKind(kind)
    if (ORIGIN_RELEVANT_TABLES.has(tableForOrigin)) {
      applyOrigin(row, await deriveOrigin(row, tableForOrigin, await getSelfPersonId()))
    }
    return { ok: true, row }
  } catch (e: any) {
    return { ok: false, errGridJson: prismaErrToGrid(e, kind) }
  }
}
