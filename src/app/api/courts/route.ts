/**
 * GET  /api/courts — list with optional `?q=` (name LIKE) and `?type=` filter.
 * POST /api/courts — create a Court.
 *
 * Writes flow through the extended Prisma client so XETO validation runs
 * automatically.
 */
import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'

export const dynamic = 'force-dynamic'

const ALLOWED_TYPES = new Set(['trial', 'appellate', 'supreme', 'magistrate'])

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams
    const q = sp.get('q')?.trim() ?? ''
    const type = sp.get('type')?.trim() ?? ''
    const limit = Math.min(Math.max(parseInt(sp.get('limit') ?? '100', 10) || 100, 1), 500)
    const offset = Math.max(parseInt(sp.get('offset') ?? '0', 10) || 0, 0)

    const where: Prisma.CourtWhereInput = {}
    if (q.length) {
      where.name = { contains: q }
    }
    if (type && ALLOWED_TYPES.has(type)) {
      where.courtType = type
    }

    const [courts, total] = await Promise.all([
      prisma.court.findMany({
        where,
        orderBy: { name: 'asc' },
        take: limit,
        skip: offset,
        include: { _count: { select: { cases: true } } },
      }),
      prisma.court.count({ where }),
    ])

    return NextResponse.json({
      courts: courts.map(materialize),
      total,
      limit,
      offset,
    })
  } catch (e) {
    return NextResponse.json(
      { error: 'court_list_failed', message: (e as Error).message },
      { status: 500 },
    )
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const {
      name,
      shortName,
      jurisdictionId,
      courtType,
      address,
      phone,
      website,
      tags,
    } = body ?? {}

    if (!name || typeof name !== 'string' || !name.trim()) {
      return NextResponse.json(
        { error: 'invalid_request', message: 'name required' },
        { status: 400 },
      )
    }
    if (courtType && !ALLOWED_TYPES.has(courtType)) {
      return NextResponse.json(
        { error: 'invalid_request', message: `courtType must be one of: ${[...ALLOWED_TYPES].join(', ')}` },
        { status: 400 },
      )
    }

    // Base tags carry `court: true` marker plus mirrored hot fields for the
    // VIRTUAL-column indexes (courtType, jurisdictionRef).
    const tagBag: Record<string, unknown> = { court: true, ...(tags && typeof tags === 'object' ? tags : {}) }
    if (courtType) tagBag.courtType = courtType
    if (jurisdictionId) tagBag.jurisdictionRef = `@${jurisdictionId}`

    const created = await prisma.court.create({
      data: {
        name: name.trim(),
        shortName: shortName?.trim() || null,
        jurisdictionId: jurisdictionId || null,
        courtType: courtType || null,
        address: address?.trim() || null,
        phone: phone?.trim() || null,
        website: website?.trim() || null,
        tags: tagBag as Prisma.InputJsonValue,
      },
    })
    return NextResponse.json({ court: materialize(created) }, { status: 201 })
  } catch (e) {
    return NextResponse.json(
      { error: 'court_create_failed', message: (e as Error).message },
      { status: 500 },
    )
  }
}

type CourtWithCount = Prisma.CourtGetPayload<{ include: { _count: { select: { cases: true } } } }>

function materialize(c: Prisma.CourtGetPayload<object> | CourtWithCount) {
  let tags: unknown = c.tags
  if (typeof tags === 'string') {
    try {
      tags = JSON.parse(tags)
    } catch {
      tags = {}
    }
  }
  const out: Record<string, unknown> = {
    id: c.id,
    name: c.name,
    shortName: c.shortName,
    jurisdictionId: c.jurisdictionId,
    courtType: c.courtType,
    address: c.address,
    phone: c.phone,
    website: c.website,
    tags,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  }
  if ('_count' in c && c._count) {
    out.casesCount = c._count.cases
  }
  return out
}
