/**
 * Integration test for the Haystack `about` op.
 *
 * Hits the route handler directly with a NextRequest, validates bearer auth
 * and the grid shape.
 *
 * @jest-environment node
 */
import { NextRequest } from 'next/server'

// Set the API key BEFORE importing the route so checkAuth sees it.
process.env.HAYSTACK_API_KEY = 'test-key-xyz'

import { GET } from '../[op]/route'

function mkReq(op: string, opts: { auth?: string; accept?: string } = {}) {
  const headers: Record<string, string> = {}
  if (opts.auth !== undefined) headers.authorization = opts.auth
  if (opts.accept) headers.accept = opts.accept
  return new NextRequest(`http://localhost/api/haystack/${op}`, { headers })
}

describe('haystack /about', () => {
  test('401 when no auth header', async () => {
    const res = await GET(mkReq('about'), { params: Promise.resolve({ op: 'about' }) } as any)
    expect(res.status).toBe(401)
  })

  test('401 when wrong token', async () => {
    const res = await GET(
      mkReq('about', { auth: 'BEARER authToken=wrong' }),
      { params: Promise.resolve({ op: 'about' }) } as any,
    )
    expect(res.status).toBe(401)
  })

  test('200 grid shape with valid bearer', async () => {
    const res = await GET(
      mkReq('about', { auth: 'BEARER authToken=test-key-xyz' }),
      { params: Promise.resolve({ op: 'about' }) } as any,
    )
    expect(res.status).toBe(200)
    const text = await res.text()
    const grid = JSON.parse(text)
    expect(grid._kind).toBe('grid')
    expect(grid.meta?.ver).toBe('4.0')
    expect(Array.isArray(grid.cols)).toBe(true)
    expect(Array.isArray(grid.rows)).toBe(true)
    expect(grid.rows.length).toBe(1)
    const row = grid.rows[0]
    expect(row.productName).toBe('Sound Suite')
    expect(row.vendorName).toBe('Sound Suite')
    expect(row.haystackVersion).toBe('4.0')
    expect(row.tz).toBe('UTC')
  })

  test('415 when Zinc requested', async () => {
    const res = await GET(
      mkReq('about', { auth: 'BEARER authToken=test-key-xyz', accept: 'text/zinc' }),
      { params: Promise.resolve({ op: 'about' }) } as any,
    )
    expect(res.status).toBe(415)
  })

  test('unknown op returns 404 err grid', async () => {
    const res = await GET(
      mkReq('does-not-exist', { auth: 'BEARER authToken=test-key-xyz' }),
      { params: Promise.resolve({ op: 'does-not-exist' }) } as any,
    )
    expect(res.status).toBe(404)
  })
})
