/**
 * Unit tests for the Haystack `commit` op (`commitEntity`).
 *
 * Covers the core write contract Step-4 refactors must preserve:
 *   - column/tag split: a patch mixing real Prisma columns AND Haystack tag
 *     markers is written as `{ ...columns, tags: { ...markers } }` in ONE call
 *   - column-only patches do NOT touch the `tags` JSON column
 *   - create vs update dispatch + required-field validation
 *   - Prisma error → friendly err-grid mapping (P2002 unique, P2025 not-found)
 *
 * Prisma is fully mocked (no SQLite). We use `case` (not origin-relevant, so
 * no deriveOrigin) and `court` (no path validation, no refs) to keep the
 * downstream label/origin resolution from needing extra mocks.
 *
 * @jest-environment node
 */

// API key set before the route import so module-load auth wiring is happy.
process.env.HAYSTACK_API_KEY = 'test-key-xyz'

// Stable empty prisma object; we mutate per-test via the `mockPrisma` handle.
jest.mock('@/lib/db/prisma', () => ({ prisma: {} }))
// Kysely `db` is only touched by the read path; keep the import resolvable.
jest.mock('@/lib/legal/kysely', () => ({ db: {} }))
// enforceFileRefSync mutates the patch in place for fileRef columns; no-op it.
jest.mock('@/lib/tag-fill/fileref-sync', () => ({ enforceFileRefSync: jest.fn() }))
// Logger — jest.setup.js global mock omits the `logger` named export.
jest.mock('@/lib/logger', () => {
  const l = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: jest.fn().mockReturnThis() }
  return { LogLevel: { DEBUG: 'DEBUG', INFO: 'INFO', WARN: 'WARN', ERROR: 'ERROR' }, Logger: jest.fn(() => l), createLogger: jest.fn(() => l), logger: l }
})
// LanceDB shim in case any transitive import resolves it.
jest.mock('@lancedb/lancedb', () => ({ Occur: {}, Operator: {}, rerankers: {} }))

import { prisma } from '@/lib/db/prisma'
import { commitEntity } from '../[op]/route'

const mockPrisma = prisma as any

/** Build a Prisma-delegate double seeded with `findUnique` rows by id. */
function delegate(rows: Record<string, any> = {}) {
  return {
    findUnique: jest.fn(async ({ where }: any) => rows[where.id] ?? null),
    create: jest.fn(async ({ data }: any) => ({ id: 'created-id', ...data })),
    update: jest.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
  }
}

beforeEach(() => {
  for (const k of Object.keys(mockPrisma)) delete mockPrisma[k]
})

describe('commitEntity — column/tag split', () => {
  it('UPDATE writes columns AND tags in a single update call', async () => {
    mockPrisma.case = delegate({ c1: { id: 'c1', name: 'Old', path: null, tags: null } })

    const result = await commitEntity({
      id: 'c1',
      kind: 'case',
      patch: { name: 'New Name', favorite: true }, // name=column, favorite=tag marker
    })

    expect(result.ok).toBe(true)
    expect(mockPrisma.case.update).toHaveBeenCalledTimes(1)
    const arg = mockPrisma.case.update.mock.calls[0][0]
    expect(arg.where).toEqual({ id: 'c1' })
    expect(arg.data).toEqual(expect.objectContaining({ name: 'New Name', tags: { favorite: true } }))
  })

  it('UPDATE with column-only patch does NOT write the tags column', async () => {
    mockPrisma.case = delegate({ c1: { id: 'c1', name: 'Old', path: null, tags: { keep: true } } })

    const result = await commitEntity({ id: 'c1', kind: 'case', patch: { name: 'Renamed' } })

    expect(result.ok).toBe(true)
    const arg = mockPrisma.case.update.mock.calls[0][0]
    expect(arg.data).toHaveProperty('name', 'Renamed')
    expect(arg.data).not.toHaveProperty('tags')
  })

  it('CREATE writes columns AND tags together', async () => {
    mockPrisma.court = delegate()

    const result = await commitEntity({
      id: 'new',
      kind: 'court',
      patch: { name: 'Supreme Court', motto: 'Justice' }, // name=column, motto=tag
    })

    expect(result.ok).toBe(true)
    expect(mockPrisma.court.create).toHaveBeenCalledTimes(1)
    const arg = mockPrisma.court.create.mock.calls[0][0]
    expect(arg.data).toEqual(expect.objectContaining({ name: 'Supreme Court', tags: { motto: 'Justice' } }))
  })
})

describe('commitEntity — validation & errors', () => {
  it('rejects an unknown kind', async () => {
    const result = await commitEntity({ kind: 'bogus', patch: {} })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errGridJson).toContain('unknown kind')
  })

  it('rejects a CREATE missing required columns', async () => {
    mockPrisma.court = delegate()
    const result = await commitEntity({ id: 'new', kind: 'court', patch: { motto: 'no name' } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errGridJson).toContain('missing required')
    expect(mockPrisma.court.create).not.toHaveBeenCalled()
  })

  it('returns not-found when UPDATE targets a missing row', async () => {
    mockPrisma.case = delegate({}) // findUnique → null
    const result = await commitEntity({ id: 'ghost', kind: 'case', patch: { name: 'X' } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errGridJson).toContain('not found')
  })

  it('materialises the entity row when an order-shaped Filing has none', async () => {
    // Three of the corpus's order blocks are Filing rows with NO Motion and no
    // MotionAttachment — they reach `primaryKind: 'order'` from the filing type
    // alone. Since #94 they render writable motionRef/resolves sockets, so a
    // ref write now lands on a row that does not exist yet. `commitEntity` must
    // upsert it rather than answering "not found" (#98). MotionAttachment.motionId
    // is a required FK, so a parent Motion is created first.
    mockPrisma.motionAttachment = delegate({}) // no attachment row yet
    mockPrisma.motion = delegate({}) // …and no Motion to hang it off
    mockPrisma.filing = delegate({ f1: { id: 'f1', caseId: 'c1', filingType: 'Order', title: 'An order' } })
    mockPrisma.document = { findFirst: jest.fn(async () => null) }
    // Callback form handed the same client, so the creates inside the
    // transaction land on the same jest.fn()s asserted below.
    mockPrisma.$transaction = jest.fn(async (fn: any) => fn(mockPrisma))

    const result = await commitEntity({ id: 'f1', kind: 'order', patch: { motionRef: 'm1' } })

    expect(result.ok).toBe(true)
    expect(mockPrisma.motion.create).toHaveBeenCalledTimes(1)
    expect(mockPrisma.motionAttachment.create).toHaveBeenCalledTimes(1)
    // Both creates are one unit of work — a failed attachment must not leave
    // the shadow Motion behind (#98).
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1)
    // The row is created under the Filing's id, discriminated as an order.
    const created = mockPrisma.motionAttachment.create.mock.calls[0][0]
    expect(created.data).toEqual(expect.objectContaining({ id: 'f1', attachmentKind: 'order' }))
    // …and the ref the user drew lands on it in the same request.
    const updated = mockPrisma.motionAttachment.update.mock.calls[0][0]
    expect(updated.where).toEqual({ id: 'f1' })
    expect(updated.data.tags).toEqual(expect.objectContaining({ motionRef: 'm1' }))
  })

  it('maps Prisma P2002 to a friendly unique-violation grid', async () => {
    const del = delegate({ c1: { id: 'c1', name: 'Old', path: null, tags: null } })
    del.update = jest.fn(async () => {
      throw Object.assign(new Error('unique'), { code: 'P2002', meta: { target: ['caseNumber'] } })
    })
    mockPrisma.case = del

    const result = await commitEntity({ id: 'c1', kind: 'case', patch: { caseNumber: 'dup' } })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errGridJson).toContain('must be unique')
      expect(result.errGridJson).toContain('caseNumber')
    }
  })
})
