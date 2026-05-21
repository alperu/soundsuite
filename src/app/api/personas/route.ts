/**
 * GET  /api/personas — list with tag filters, displayName search, pagination.
 * POST /api/personas — create a Persona (Person with intrinsic markers).
 */
import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'

export const dynamic = 'force-dynamic'

const ALLOWED_INTRINSIC = [
  'lawyer',
  'judge',
  'courtClerk',
  'courtReporter',
  'bailiff',
  'proSe',
  'self',
] as const

type PersonRow = {
  id: string
  displayName: string
  email: string | null
  barNumber: string | null
  jurisdictionId: string | null
  tags: unknown
  createdAt: Date
  updatedAt: Date
}

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams
    const tags = sp.getAll('tag')
    const q = sp.get('q')?.trim() ?? ''
    const limit = Math.min(Math.max(parseInt(sp.get('limit') ?? '50', 10) || 50, 1), 500)
    const offset = Math.max(parseInt(sp.get('offset') ?? '0', 10) || 0, 0)

    // SQLite: filter via json_extract on each requested intrinsic marker.
    // Personas always carry the `person` marker; we AND every requested tag.
    const wheres: Prisma.Sql[] = [Prisma.sql`json_extract(tags, '$.person') = 1`]
    for (const t of tags) {
      if (!ALLOWED_INTRINSIC.includes(t as typeof ALLOWED_INTRINSIC[number])) continue
      // safe: only ALLOWED_INTRINSIC values reach here, so the path is bounded.
      wheres.push(
        Prisma.sql`json_extract(tags, ${'$.' + t}) = 1`,
      )
    }
    if (q.length) {
      wheres.push(Prisma.sql`LOWER(displayName) LIKE ${'%' + q.toLowerCase() + '%'}`)
    }
    const whereSql = Prisma.sql`${Prisma.join(wheres, ' AND ')}`

    const rows = await prisma.$queryRaw<PersonRow[]>(
      Prisma.sql`
        SELECT id, displayName, email, barNumber, jurisdictionId, tags, createdAt, updatedAt
        FROM "Person"
        WHERE ${whereSql}
        ORDER BY displayName COLLATE NOCASE ASC
        LIMIT ${limit} OFFSET ${offset}
      `,
    )

    const totalRows = await prisma.$queryRaw<Array<{ c: number }>>(
      Prisma.sql`SELECT COUNT(*) AS c FROM "Person" WHERE ${whereSql}`,
    )
    const total = Number(totalRows[0]?.c ?? 0)

    return NextResponse.json({
      personas: rows.map(materialize),
      total,
    })
  } catch (e) {
    return NextResponse.json(
      { error: 'persona_list_failed', message: (e as Error).message },
      { status: 500 },
    )
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const {
      displayName,
      email,
      barNumber,
      jurisdictionId,
      intrinsicTags = {},
    } = body ?? {}
    if (!displayName || typeof displayName !== 'string') {
      return NextResponse.json(
        { error: 'invalid_request', message: 'displayName required' },
        { status: 400 },
      )
    }
    const tagBag: Record<string, true> = { person: true }
    for (const k of ALLOWED_INTRINSIC) {
      if (intrinsicTags[k]) tagBag[k] = true
    }
    const created = await prisma.person.create({
      data: {
        displayName: displayName.trim(),
        email: email ?? null,
        barNumber: barNumber ?? null,
        jurisdictionId: jurisdictionId ?? null,
        tags: tagBag as Prisma.InputJsonValue,
      },
    })
    return NextResponse.json({ persona: created }, { status: 201 })
  } catch (e) {
    return NextResponse.json(
      { error: 'persona_create_failed', message: (e as Error).message },
      { status: 500 },
    )
  }
}

function materialize(p: PersonRow) {
  // SQLite returns JSON columns as strings; better-sqlite3 sometimes parses,
  // sometimes not. Coerce defensively.
  let tags: unknown = p.tags
  if (typeof tags === 'string') {
    try {
      tags = JSON.parse(tags)
    } catch {
      tags = {}
    }
  }
  return {
    id: p.id,
    displayName: p.displayName,
    email: p.email,
    barNumber: p.barNumber,
    jurisdictionId: p.jurisdictionId,
    tags,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }
}
