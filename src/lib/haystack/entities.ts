/**
 * Single source of truth for haystack entity dispatch.
 *
 * Collapses the duplicated `switch (table)` blocks from the read path into two
 * lookup maps: which repo finder serves each entity table, and which Prisma
 * client delegate backs each ref-target table. Adding an entity means adding a
 * row here rather than editing several parallel switches.
 */
import {
  findCase,
  findMotion,
  findMotionEvent,
  findMotionAttachment,
  findPerson,
  findPersonRole,
  findHearing,
  findClerksRecord,
  findReportersRecord,
} from '@/lib/legal/repo'

/**
 * Read-path finder per entity table, keyed by the table name `tableFromFilter`
 * produces. `ClerksRecord` / `ReportersRecord` aren't in the Kysely `DB` type
 * map; their repo finders go through Prisma instead.
 */
export const ENTITY_FINDERS: Record<string, (filter: string, limit?: number) => Promise<any[]>> = {
  Motion: findMotion,
  MotionEvent: findMotionEvent,
  MotionAttachment: findMotionAttachment,
  Person: findPerson,
  PersonRole: findPersonRole,
  Hearing: findHearing,
  Case: findCase,
  ClerksRecord: findClerksRecord,
  ReportersRecord: findReportersRecord,
}

/**
 * Ref-target table (a value of `REF_TARGET_TABLE`) → the Prisma client delegate
 * key used by `inlineRefLabels` to batch-fetch label rows.
 */
export const REF_TARGET_MODEL: Record<string, string> = {
  Case: 'case',
  Motion: 'motion',
  Person: 'person',
  Court: 'court',
  Hearing: 'hearing',
  Document: 'document',
}
