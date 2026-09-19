/**
 * Vendor ops over the HTTP route: the `ops` grid carries params, a vendor op
 * dispatches through the adapter, and domain failures are err grids.
 *
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

process.env.HAYSTACK_API_KEY = 'test-key-xyz'

const prismaMock = {
  case: { findMany: jest.fn() },
  filing: { findMany: jest.fn() },
  document: { findMany: jest.fn(), groupBy: jest.fn() },
  motion: { findMany: jest.fn() },
  motionAttachment: { findMany: jest.fn() },
  clerksRecord: { findMany: jest.fn() },
  reportersRecord: { findMany: jest.fn() },
}
jest.mock('@/lib/db/prisma', () => ({ prisma: prismaMock }))

import { GET, POST } from '../[op]/route'

const AUTH = { authorization: 'BEARER authToken=test-key-xyz' }

function get(op: string, query = '') {
  return GET(new NextRequest(`http://localhost/api/haystack/${op}${query}`, { headers: AUTH }), { params: Promise.resolve({ op }) } as any)
}
function post(op: string, body: unknown) {
  return POST(
    new NextRequest(`http://localhost/api/haystack/${op}`, { method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ op }) } as any,
  )
}

describe('haystack vendor ops', () => {
  beforeEach(() => {
    for (const m of Object.values(prismaMock)) for (const fn of Object.values(m)) (fn as jest.Mock).mockReset().mockResolvedValue([])
  })

  test('ops grid describes every op with params and exposure', async () => {
    const res = await get('ops')
    const grid = JSON.parse(await res.text())
    const byName = new Map(grid.rows.map((r: any) => [r.name, r]))
    const survey: any = byName.get('ssFolderSurvey')
    expect(survey.ssExposure).toBe('read')
    expect(survey.params.caseId.required).toBe(true)
    expect(survey.doc).toMatch(/Dispositions/)
    const read: any = byName.get('read')
    expect(read.params.filter.required).toBe(true)
    expect(read.ssExposure).toBeUndefined()
    const apply: any = byName.get('ssAutoIngestApply')
    expect(apply.ssExposure).toBe('write')
  })

  test('a vendor op runs through the adapter and answers with meta + rows', async () => {
    prismaMock.case.findMany.mockResolvedValue([{ id: 'c1', name: 'Case One', caseNumber: null, path: '/tmp/c1' }])
    const res = await get('ssScopeGraph')
    expect(res.status).toBe(200)
    const grid = JSON.parse(await res.text())
    expect(grid.meta.op).toBe('ssScopeGraph')
    expect(grid.meta.mode).toBe('summary')
    expect(grid.meta.cases).toBe(1)
    expect(grid.rows[0].name).toBe('Case One')
    expect(grid.rows[0].unconnected).toBe(0)
  })

  test('a bad parameter is an err grid, not a 500', async () => {
    const res = await get('ssReadCase', '?status=DONE&caseId=c1')
    expect(res.status).toBe(200)
    const grid = JSON.parse(await res.text())
    expect(grid.meta.err).toBeDefined()
    expect(grid.meta.dis).toMatch(/status must be one of/)
    expect(grid.meta.errTrace).toBe('INVALID_PARAMS')
  })

  test('a write with dryRun=false over the bearer API is refused while the gate is closed', async () => {
    delete process.env.SS_HAYSTACK_WRITE
    const res = await post('ssPromoteDiscovered', { limit: 2, dryRun: false })
    const grid = JSON.parse(await res.text())
    expect(grid.meta.errTrace).toBe('WRITE_DISABLED')
    expect(prismaMock.document.groupBy).not.toHaveBeenCalled()
  })

  test('unknown vendor op is still a 404', async () => {
    const res = await get('ssNothing')
    expect(res.status).toBe(404)
  })
})
