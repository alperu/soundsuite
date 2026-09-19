/**
 * Kysely client over the same SQLite file Prisma uses.
 *
 * We attach a sibling `better-sqlite3` connection to `prisma/data/sound-suite.db`
 * so the Haystack filter compiler can emit typed `Expression<boolean>` nodes
 * against `json_extract(tags, '$.x')` paths. Prisma stays the writer; Kysely is
 * the dynamic-filter read lane (§12.2 of docs/xeto-haystack-research.md).
 *
 * The `DB` interface is hand-written (one type per Prisma model). When Agent 1's
 * schema lands, `tags` will become a JSON column; for now the column type is
 * `string` (raw JSON text). Tables Agent 1 will add (Motion tags expansion,
 * MotionEvent, MotionAttachment, Person, PersonRole, Hearing) are declared here
 * optimistically so the filter compiler type-checks. Queries against missing
 * tables fail at runtime — `repo.ts` and the route layer catch this and emit
 * an err grid.
 */
import path from 'node:path'
import { activeProfile, activeProfileName } from '@/lib/profiles/registry'
// better-sqlite3 ships no .d.ts in this repo; type as any to avoid TS2307.
 
const Database: any = require('better-sqlite3')
import { Kysely, SqliteDialect } from 'kysely'

// ---------- DB type ---------------------------------------------------------

export interface CaseRow {
  id: string
  name: string
  path: string
  caseNumber: string | null
  jurisdiction: string | null
  country: string | null
  state: string | null
  county: string | null
  createdAt: string
  updatedAt: string
  /** JSON text. Present once Agent 1's schema migration runs. */
  tags: string | null
}

export interface MotionRow {
  id: string
  filingId: string
  title: string
  startPage: number
  endPage: number | null
  description: string | null
  createdAt: string
  updatedAt: string
  tags: string | null
}

export interface MotionEventRow {
  id: string
  motionId: string
  kind: string
  occurredOn: string | null
  createdAt: string
  updatedAt: string
  tags: string | null
}

export interface MotionAttachmentRow {
  id: string
  motionId: string
  kind: string | null
  label: string | null
  createdAt: string
  updatedAt: string
  tags: string | null
}

export interface PersonRow {
  id: string
  displayName: string
  createdAt: string
  updatedAt: string
  tags: string | null
}

export interface PersonRoleRow {
  id: string
  personId: string
  scopeRef: string | null
  role: string
  createdAt: string
  updatedAt: string
  tags: string | null
}

export interface HearingRow {
  id: string
  caseId: string
  scheduledOn: string | null
  createdAt: string
  updatedAt: string
  tags: string | null
}

export interface DocumentRow {
  id: string
  caseId: string
  filingId: string | null
  filePath: string
  fileName: string
  hash: string
  status: string
  documentType: string | null
  createdAt: string
  updatedAt: string
  tags: string | null
}

export interface DB {
  Case: CaseRow
  Motion: MotionRow
  MotionEvent: MotionEventRow
  MotionAttachment: MotionAttachmentRow
  Person: PersonRow
  PersonRole: PersonRoleRow
  Hearing: HearingRow
  Document: DocumentRow
}

// ---------- client singleton ------------------------------------------------

function resolveSqlitePath(url: string): string {
  const stripped = url.startsWith('file:') ? url.slice('file:'.length) : url
  if (path.isAbsolute(stripped)) return stripped
  return path.resolve(process.cwd(), 'prisma', stripped)
}

const globalForKysely = globalThis as unknown as {
  kyselyClients: Map<string, { dbPath: string; db: Kysely<DB>; handle: any }> | undefined
}

const kyselyClients: Map<string, { dbPath: string; db: Kysely<DB>; handle: any }> =
  globalForKysely.kyselyClients ?? new Map()
globalForKysely.kyselyClients = kyselyClients

function activeSqlitePath(): string {
  const p = activeProfile()
  if (!p.legacy) return p.sqlite
  return resolveSqlitePath(process.env.DATABASE_URL ?? 'file:./data/sound-suite.db')
}

function makeKysely(dbPath: string): { db: Kysely<DB>; handle: any } {
  const handle = new Database(dbPath, { fileMustExist: false })
  // Match Prisma's pragmas so we don't fight WAL.
  try {
    handle.pragma('journal_mode = WAL')
    handle.pragma('busy_timeout = 5000')
  } catch {
    /* ignore */
  }
  return { db: new Kysely<DB>({ dialect: new SqliteDialect({ database: handle }) }), handle }
}

function kyselyForActiveProfile(): Kysely<DB> {
  const name = activeProfileName()
  const dbPath = activeSqlitePath()
  const cached = kyselyClients.get(name)
  if (cached && cached.dbPath === dbPath) return cached.db
  const made = makeKysely(dbPath)
  kyselyClients.set(name, { dbPath, ...made })
  return made.db
}

/**
 * The Kysely read lane — a proxy over the active profile's connection, the
 * same way `lib/db/prisma.ts` exports `prisma`. Importers keep `import { db }`.
 */
export const db: Kysely<DB> = new Proxy({} as Kysely<DB>, {
  get(_target, prop) {
    const real = kyselyForActiveProfile() as unknown as Record<PropertyKey, unknown>
    const value = real[prop]
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(real) : value
  },
})

/** Close and forget the connection for `profileName` (profile switch). */
export function releaseKysely(profileName: string): void {
  const entry = kyselyClients.get(profileName)
  if (!entry) return
  kyselyClients.delete(profileName)
  try {
    entry.handle.close()
  } catch {
    /* already closed */
  }
}
