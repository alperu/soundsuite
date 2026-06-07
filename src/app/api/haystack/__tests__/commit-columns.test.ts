/**
 * Integration test for the unified `commit` op writing BOTH Prisma columns
 * AND the `tags` JSON bag in a single update.
 *
 * Marked describe.skip by default — it talks to a real Prisma client and
 * SQLite db file. To run locally: remove `.skip`, ensure the dev db exists
 * (`prisma/data/sound-suite.db`), and either point at a scratch DB or accept
 * that one Case row will be created/mutated.
 *
 * Smoke check via curl (validated 2026-05-21):
 *   curl -s -X PUT http://localhost:3000/api/haystack-proxy/commit \
 *     -H 'Content-Type: application/json' \
 *     -d '{"id":"<case-id>","kind":"case","patch":{"name":"Test","jurisdiction":"Texas","case":true,"jurisdictionTx":true}}'
 *   sqlite3 prisma/data/sound-suite.db \
 *     "SELECT name, jurisdiction, tags FROM Case WHERE id='<case-id>';"
 *
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

process.env.HAYSTACK_API_KEY = 'test-key-xyz'

// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { PUT } from '../[op]/route'
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { prisma } from '@/lib/db/prisma'

function mkReq(op: string, body: any) {
  return new NextRequest(`http://localhost/api/haystack/${op}`, {
    method: 'PUT',
    headers: {
      authorization: 'BEARER authToken=test-key-xyz',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

describe.skip('haystack commit — column + tag split', () => {
  let caseId: string

  beforeAll(async () => {
    const c = await prisma.case.create({
      data: { name: 'pre-test', path: `/tmp/_test_${Date.now()}`, country: 'United States' },
    })
    caseId = c.id
  })

  afterAll(async () => {
    await prisma.case.delete({ where: { id: caseId } }).catch(() => {})
  })

  test('writes column AND tag in one call', async () => {
    const res = await PUT(
      mkReq('commit', {
        id: caseId,
        kind: 'case',
        // path is intentionally omitted (no fs.stat check needed)
        patch: { name: 'Renamed', jurisdiction: 'California', case: true, jurisdictionCa: true },
      }),
      { params: Promise.resolve({ op: 'commit' }) } as any,
    )
    expect(res.status).toBe(200)
    const grid = JSON.parse(await res.text())
    expect(grid.meta?.err).toBeUndefined()

    const row = await prisma.case.findUnique({ where: { id: caseId } })
    expect(row?.name).toBe('Renamed')
    expect(row?.jurisdiction).toBe('California')
    const tags = typeof row?.tags === 'string' ? JSON.parse(row!.tags as any) : row?.tags
    expect(tags?.case).toBeTruthy()
    expect(tags?.jurisdictionCa).toBeTruthy()
  })

  test('caseNumber unique violation returns err grid (not 500)', async () => {
    const a = await prisma.case.create({
      data: { name: 'a', path: `/tmp/_a_${Date.now()}`, caseNumber: 'UNIQ-CN-1' },
    })
    const b = await prisma.case.create({
      data: { name: 'b', path: `/tmp/_b_${Date.now()}`, caseNumber: 'UNIQ-CN-2' },
    })
    try {
      const res = await PUT(
        mkReq('commit', { id: b.id, kind: 'case', patch: { caseNumber: 'UNIQ-CN-1' } }),
        { params: Promise.resolve({ op: 'commit' }) } as any,
      )
      expect(res.status).toBe(200)
      const grid = JSON.parse(await res.text())
      expect(grid.meta?.err).toBeDefined()
      expect(String(grid.meta?.dis)).toMatch(/unique/i)
    } finally {
      await prisma.case.delete({ where: { id: a.id } }).catch(() => {})
      await prisma.case.delete({ where: { id: b.id } }).catch(() => {})
    }
  })
})
