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

const INTRINSIC_MARKERS = [
  'person',
  'lawyer',
  'judge',
  'courtClerk',
  'courtReporter',
  'bailiff',
  'proSe',
  'self',
] as const

/**
 * Defensively unwrap a `tags` column value. Handles double-stringify and
 * character-spread corruption (see `recoverTagObject` in haystack/[op]).
 */
function recoverTagObject(raw: unknown): Record<string, unknown> {
  let val: unknown = raw
  for (let i = 0; i < 4; i++) {
    if (val == null) return {}
    if (typeof val === 'object' && !Array.isArray(val)) {
      const keys = Object.keys(val as object)
      const digitKeys = keys.filter(k => /^\d+$/.test(k))
      if (digitKeys.length > 0 && digitKeys.length >= keys.length / 2) {
        const chars: string[] = []
        const n = digitKeys.length
        for (let j = 0; j < n; j++) {
          const c = (val as Record<string, unknown>)[String(j)]
          if (typeof c !== 'string') break
          chars.push(c)
        }
        const tail: Record<string, unknown> = {}
        for (const k of keys) {
          if (!/^\d+$/.test(k)) tail[k] = (val as Record<string, unknown>)[k]
        }
        try {
          const inner = JSON.parse(chars.join(''))
          if (inner && typeof inner === 'object') {
            return { ...(inner as Record<string, unknown>), ...tail }
          }
        } catch {
          /* fall through */
        }
        return tail
      }
      return val as Record<string, unknown>
    }
    if (typeof val === 'string') {
      try { val = JSON.parse(val) } catch { return {} }
      continue
    }
    return {}
  }
  return typeof val === 'object' && val !== null
    ? (val as Record<string, unknown>)
    : {}
}

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

    // Compute per-persona PersonRole counts in a single grouped query.
    const personIds = rows.map((r: PersonRow) => r.id)
    const roleCountMap = new Map<string, number>()
    if (personIds.length > 0) {
      const counts = await prisma.personRole.groupBy({
        by: ['personId'],
        where: { personId: { in: personIds } },
        _count: { _all: true },
      }) as Array<{ personId: string; _count: { _all: number } }>
      for (const c of counts) {
        roleCountMap.set(c.personId, c._count._all)
      }
    }

    return NextResponse.json({
      personas: rows.map((r: PersonRow) => materialize(r, roleCountMap.get(r.id) ?? 0)),
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
      jurisdiction,
      intrinsicTags = {},
      markers,
    } = body ?? {}
    if (!displayName || typeof displayName !== 'string') {
      return NextResponse.json(
        { error: 'invalid_request', message: 'displayName required' },
        { status: 400 },
      )
    }
    const tagBag: Record<string, true> = { person: true }
    // Accept both legacy `intrinsicTags: { lawyer: true }` and the newer
    // `markers: ['lawyer', ...]` shape from the create modal.
    for (const k of ALLOWED_INTRINSIC) {
      if (intrinsicTags && intrinsicTags[k]) tagBag[k] = true
    }
    if (Array.isArray(markers)) {
      for (const k of markers) {
        if ((ALLOWED_INTRINSIC as readonly string[]).includes(k)) {
          tagBag[k as typeof ALLOWED_INTRINSIC[number]] = true
        }
      }
    }
    const created = await prisma.person.create({
      data: {
        displayName: displayName.trim(),
        email: email ?? null,
        barNumber: barNumber ?? null,
        jurisdictionId: (jurisdictionId ?? jurisdiction) ?? null,
        tags: tagBag as Prisma.InputJsonValue,
      },
    })
    return NextResponse.json(
      { persona: materialize(created as unknown as PersonRow, 0) },
      { status: 201 },
    )
  } catch (e) {
    return NextResponse.json(
      { error: 'persona_create_failed', message: (e as Error).message },
      { status: 500 },
    )
  }
}

function materialize(p: PersonRow, rolesCount = 0) {
  const tags = recoverTagObject(p.tags)
  const markers = INTRINSIC_MARKERS.filter(k => tags[k] === true)
  return {
    id: p.id,
    displayName: p.displayName,
    email: p.email,
    barNumber: p.barNumber,
    jurisdictionId: p.jurisdictionId,
    jurisdiction: p.jurisdictionId,
    tags,
    markers,
    rolesCount,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }
}
