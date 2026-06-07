/**
 * Unit tests for GET /api/exhibits.
 *
 * The route searches LanceDB (via VectorStore) for exhibit chunks, dedupes by
 * exhibitPath, joins document/case names from Prisma, and returns them sorted
 * newest-first. Both VectorStore and Prisma are mocked so the test exercises
 * the route's logic without a real DB / LanceDB.
 *
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

const mockSearch = jest.fn()
const mockInitialize = jest.fn(async () => {})
jest.mock('@/lib/vector/vector-store', () => ({
  VectorStore: jest.fn().mockImplementation(() => ({
    initialize: mockInitialize,
    search: mockSearch,
  })),
}))
jest.mock('@/lib/db/prisma', () => ({ prisma: { document: { findMany: jest.fn() } } }))

import { prisma } from '@/lib/db/prisma'
import { GET } from '../route'

const mockFindMany = (prisma as any).document.findMany as jest.Mock

function chunk(chunkId: string, exhibitPath: string, opts: Partial<any> = {}) {
  return {
    chunkId,
    text: opts.text ?? `OCR ${chunkId}`,
    metadata: {
      documentId: opts.documentId ?? 'doc1',
      caseId: opts.caseId ?? 'case1',
      pageNumber: opts.pageNumber ?? 1,
      isExhibit: true,
      exhibitPath,
    },
  }
}

function req(query = '') {
  return new NextRequest(`http://localhost:3000/api/exhibits${query}`)
}

beforeEach(() => {
  mockSearch.mockReset()
  mockInitialize.mockReset().mockResolvedValue(undefined)
  mockFindMany.mockReset()
})

describe('GET /api/exhibits', () => {
  it('formats, dedupes by exhibitPath, and joins document/case names', async () => {
    mockSearch.mockResolvedValueOnce([
      chunk('c1', '/exhibits/e1.png', { pageNumber: 1 }),
      chunk('c2', '/exhibits/e2.png', { pageNumber: 3 }),
      chunk('c3', '/exhibits/e1.png', { pageNumber: 1 }), // duplicate path → deduped
    ])
    mockFindMany.mockResolvedValueOnce([
      { id: 'doc1', fileName: 'test-doc.pdf', createdAt: new Date('2024-01-02T00:00:00Z'), case: { name: 'Test Case' } },
    ])

    const res = await GET(req())
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.exhibits).toHaveLength(2)
    const paths = data.exhibits.map((e: any) => e.imagePath).sort()
    expect(paths).toEqual(['/exhibits/e1.png', '/exhibits/e2.png'])
    expect(data.exhibits[0].documentName).toBe('test-doc.pdf')
    expect(data.exhibits[0].caseName).toBe('Test Case')
  })

  it('passes the caseId filter through to the vector search', async () => {
    mockSearch.mockResolvedValueOnce([])
    mockFindMany.mockResolvedValueOnce([])

    await GET(req('?caseId=case-42'))

    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({ filter: expect.objectContaining({ isExhibit: true, caseId: 'case-42' }) }),
    )
  })

  it('returns an empty array when there are no exhibits', async () => {
    mockSearch.mockResolvedValueOnce([])
    mockFindMany.mockResolvedValueOnce([])

    const res = await GET(req())
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.exhibits).toEqual([])
  })

  it('returns 500 when the vector search fails', async () => {
    mockSearch.mockRejectedValueOnce(new Error('lancedb down'))

    const res = await GET(req())
    const data = await res.json()

    expect(res.status).toBe(500)
    expect(data.error).toContain('Failed to fetch exhibits')
  })
})
