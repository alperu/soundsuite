/**
 * Legal-domain repository — single source of truth for Case/Motion/etc.
 *
 * Reads go through Kysely + the Haystack filter compiler (`readByHaystack`).
 * Writes go through Prisma; when Agent 2's `withXetoValidation` extension is
 * merged it gates writes automatically. Until then, callers may import
 * `validateTags` directly from `@/lib/legal/prisma-extensions/validate` once
 * that exists — we soft-import here so this file compiles standalone.
 */
import { db, type DB } from './kysely'
import { readByHaystack } from './haystack-filter-sql'
import { prisma } from '@/lib/db/prisma'

// ---------- read API --------------------------------------------------------

export const findCase = (filter: string, limit?: number) =>
  readByHaystack(db, 'Case', filter, limit)
export const findMotion = (filter: string, limit?: number) =>
  readByHaystack(db, 'Motion', filter, limit)
export const findMotionEvent = (filter: string, limit?: number) =>
  readByHaystack(db, 'MotionEvent', filter, limit)
export const findMotionAttachment = (filter: string, limit?: number) =>
  readByHaystack(db, 'MotionAttachment', filter, limit)
export const findPerson = (filter: string, limit?: number) =>
  readByHaystack(db, 'Person', filter, limit)
export const findPersonRole = (filter: string, limit?: number) =>
  readByHaystack(db, 'PersonRole', filter, limit)
export const findHearing = (filter: string, limit?: number) =>
  readByHaystack(db, 'Hearing', filter, limit)

/**
 * Find a ClerksRecord/ReportersRecord by Haystack filter. These tables don't
 * have a typed Kysely entry (yet), so we route through Prisma directly. v1
 * supports only `id`-based reads via the route's idValue path; tag-filter
 * compilation here is a stub returning the full table (limit applied).
 */
export const findClerksRecord = async (_filter: string, limit?: number) => {
  return (prisma as any).clerksRecord.findMany({ take: limit })
}
export const findReportersRecord = async (_filter: string, limit?: number) => {
  return (prisma as any).reportersRecord.findMany({ take: limit })
}

// ---------- write API -------------------------------------------------------

/**
 * Tagged write. Delegates to Prisma so Agent 2's `query` extension (if loaded)
 * runs XETO `fits()` validation. If the extension isn't merged yet, we
 * best-effort call a `validateTags` function exported from
 * `prisma-extensions/validate` — but soft-fail with a console warning when
 * the file doesn't exist so this module remains usable today.
 */
export async function writeTagged(
  model: string,
  data: Record<string, any>,
): Promise<any> {
  try {
    const mod: any = await (import('@/lib/legal/prisma-extensions/validate' as any) as Promise<any>)
      .catch(() => null)
    if (mod && typeof mod.validateTags === 'function') {
      mod.validateTags(model, data?.tags)
    }
  } catch (e) {
    console.warn('[repo.writeTagged] xeto validate skipped:', (e as Error).message)
  }
  const client = (prisma as any)[lowerFirst(model)]
  if (!client?.create) throw new Error(`No Prisma model named ${model}`)
  return client.create({ data })
}

function lowerFirst(s: string): string {
  return s.length ? s[0].toLowerCase() + s.slice(1) : s
}

// ---------- nav -------------------------------------------------------------

/**
 * Build a Haystack `nav` hierarchy.
 *
 *   no rootRef          → list all Cases (top level)
 *   navId = @case-X     → that case's Motions
 *   navId = @motion-X   → that motion's sub-motions + MotionEvents + MotionAttachments
 *
 * Returned rows always have a `navId` (Haystack convention) so a client can
 * drill in by passing it back as `navId`.
 */
export async function navHierarchy(rootRef?: string): Promise<any[]> {
  // Top level: cases
  if (!rootRef) {
    const rows = await db.selectFrom('Case').selectAll().execute().catch(() => [])
    return rows.map((c: any) => ({
      navId: `@${c.id}`,
      dis: c.name ?? c.caseNumber ?? c.id,
      _case: true,
      caseRef: `@${c.id}`,
    }))
  }
  const id = rootRef.replace(/^@/, '')

  // Try Case → motions
  const motionRows = await db
    .selectFrom('Motion')
    .selectAll()
    .where((eb) =>
      eb.or([
        eb('filingId' as any, '=', id as any),
        eb(
          // tags.caseRef matches @<id>
          require('kysely').sql`json_extract(tags, '$.caseRef')` as any,
          '=',
          `@${id}` as any,
        ),
      ]),
    )
    .execute()
    .catch(() => [])

  if (motionRows.length) {
    return motionRows.map((m: any) => ({
      navId: `@${m.id}`,
      dis: m.title ?? m.id,
      motion: true,
      motionRef: `@${m.id}`,
    }))
  }

  // Else: assume motion → events + attachments + sub-motions
  const [events, attachments, subMotions] = await Promise.all([
    db
      .selectFrom('MotionEvent')
      .selectAll()
      .where('motionId' as any, '=', id as any)
      .execute()
      .catch(() => []),
    db
      .selectFrom('MotionAttachment')
      .selectAll()
      .where('motionId' as any, '=', id as any)
      .execute()
      .catch(() => []),
    db
      .selectFrom('Motion')
      .selectAll()
      .where(
        require('kysely').sql`json_extract(tags, '$.motionRef')` as any,
        '=',
        `@${id}` as any,
      )
      .execute()
      .catch(() => []),
  ])

  return [
    ...subMotions.map((m: any) => ({
      navId: `@${m.id}`,
      dis: m.title ?? m.id,
      motion: true,
    })),
    ...events.map((e: any) => ({
      navId: `@${e.id}`,
      dis: e.kind ?? e.id,
      motionEvent: true,
    })),
    ...attachments.map((a: any) => ({
      navId: `@${a.id}`,
      dis: a.label ?? a.kind ?? a.id,
      motionAttachment: true,
    })),
  ]
}

/**
 * Heuristic: pick the table to read against based on entity markers in the
 * filter string. Returns null if no marker is found.
 */
export function tableFromFilter(filter: string): keyof DB | null {
  // Look for bare-word markers preceded by whitespace/start/`(` or operators.
  const text = ` ${filter.toLowerCase()} `
  const has = (w: string) => new RegExp(`[^a-z_]${w}[^a-z_]`).test(text)
  // Order matters — most-specific first.
  if (has('motionevent')) return 'MotionEvent'
  if (has('motionattachment')) return 'MotionAttachment'
  if (has('personrole')) return 'PersonRole'
  if (has('hearing')) return 'Hearing'
  if (has('clerksrecord')) return 'ClerksRecord' as any
  if (has('reportersrecord')) return 'ReportersRecord' as any
  if (has('motion')) return 'Motion'
  if (has('person')) return 'Person'
  if (has('case')) return 'Case'
  // Ref-picker aliases — the picker's refTarget strings don't always carry an
  // entity marker; they may name the *ref tag* directly (e.g. `attachment`,
  // `documentref`, `transcriptref`). Map these onto the correct entity table
  // so a ref-picker query like `filter=attachment` doesn't err out.
  if (has('attachment')) return 'MotionAttachment'
  if (has('transcript') || has('transcriptref')) return 'Hearing'
  if (has('document') || has('documentref') || has('fileref')) return 'Document'
  return null
}
