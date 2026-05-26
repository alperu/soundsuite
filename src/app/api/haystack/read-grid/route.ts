/**
 * POST /api/haystack/read-grid
 *
 * Thin debug-visibility wrapper around the legal Haystack-filter SQL
 * translator. Designed for the in-app "Haystack" right-panel tab on
 * /search — it lets the operator preview which records match the
 * currently-compiled Haystack filter *before* the AI takes over.
 *
 * Unlike `/api/haystack/[op]` this route:
 *   - Returns plain JSON (not Hayson) for easy client consumption.
 *   - Does not require the HAYSTACK_API_KEY header (it's a same-origin
 *     debug surface; the route is not exported to MCP).
 *   - Picks the Kysely table from a `kind` hint or `impliedKind`.
 *
 * Body: { filter: string, kind?: string, limit?: number }
 * Response: { count: number, rows: any[], table: string, filter: string }
 *           or { error: string } on parse / translator failure.
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/legal/kysely'
import { readByHaystack } from '@/lib/legal/haystack-filter-sql'

const DEFAULT_LIMIT = 50

function kindToTable(kind: string | undefined): keyof typeof TABLES {
  const k = (kind ?? '').toLowerCase()
  switch (k) {
    case 'case': return 'Case'
    case 'motion': return 'Motion'
    case 'motionevent': return 'MotionEvent'
    case 'motionattachment': return 'MotionAttachment'
    case 'person': return 'Person'
    case 'personrole': return 'PersonRole'
    case 'hearing': return 'Hearing'
    default:
      return 'Motion'
  }
}

// Whitelist of valid kysely tables for the grid preview.
const TABLES = {
  Case: 'Case',
  Motion: 'Motion',
  MotionEvent: 'MotionEvent',
  MotionAttachment: 'MotionAttachment',
  Person: 'Person',
  PersonRole: 'PersonRole',
  Hearing: 'Hearing',
} as const

export async function POST(req: NextRequest) {
  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const filter: string = typeof body?.filter === 'string' ? body.filter.trim() : ''
  const kindHint: string | undefined = typeof body?.kind === 'string' ? body.kind : undefined
  const limit: number = Math.min(
    Math.max(1, Number(body?.limit) || DEFAULT_LIMIT),
    200,
  )

  if (!filter) {
    return NextResponse.json({ count: 0, rows: [], table: kindToTable(kindHint), filter: '' })
  }

  const table = kindToTable(kindHint)
  try {
    const rows = await readByHaystack(db as any, table as any, filter, limit)
    return NextResponse.json({
      count: rows.length,
      rows,
      table,
      filter,
    })
  } catch (err: any) {
    return NextResponse.json(
      { error: String(err?.message ?? err), table, filter },
      { status: 500 },
    )
  }
}
