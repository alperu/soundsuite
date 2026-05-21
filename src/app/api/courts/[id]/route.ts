/**
 * GET    /api/courts/[id] — read with related cases count
 * PUT    /api/courts/[id] — update fields + sync hot tag mirrors
 * DELETE /api/courts/[id] — 409 if cases still reference it
 */
import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'

export const dynamic = 'force-dynamic'

const ALLOWED_TYPES = new Set(['trial', 'appellate', 'supreme', 'magistrate'])

type Ctx = { params: Promise<{ id: string }> }

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { id } = await params
  const court = await prisma.court.findUnique({
    where: { id },
    include: {
      _count: { select: { cases: true } },
      cases: {
        select: { id: true, name: true, caseNumber: true, jurisdiction: true },
        orderBy: { name: 'asc' },
        take: 100,
      },
    },
  })
  if (!court) {
    return NextResponse.json({ error: 'court_not_found' }, { status: 404 })
  }
  return NextResponse.json({ court: materialize(court) })
}

export async function PUT(req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params
    const existing = await prisma.court.findUnique({ where: { id } })
    if (!existing) {
      return NextResponse.json({ error: 'court_not_found' }, { status: 404 })
    }
    const body = await req.json()

    const patch: Prisma.CourtUpdateInput = {}
    if (typeof body.name === 'string') patch.name = body.name.trim()
    if (body.shortName !== undefined) patch.shortName = body.shortName?.trim() || null
    if (body.jurisdictionId !== undefined) {
      patch.jurisdiction = body.jurisdictionId
        ? { connect: { id: body.jurisdictionId } }
        : { disconnect: true }
    }
    if (body.courtType !== undefined) {
      if (body.courtType && !ALLOWED_TYPES.has(body.courtType)) {
        return NextResponse.json(
          { error: 'invalid_request', message: `courtType must be one of: ${[...ALLOWED_TYPES].join(', ')}` },
          { status: 400 },
        )
      }
      patch.courtType = body.courtType || null
    }
    if (body.address !== undefined) patch.address = body.address?.trim() || null
    if (body.phone !== undefined) patch.phone = body.phone?.trim() || null
    if (body.website !== undefined) patch.website = body.website?.trim() || null

    // Tag bag: keep `court:true` marker, mirror hot fields.
    const currentTags: Record<string, unknown> =
      typeof existing.tags === 'string'
        ? safeParse(existing.tags) ?? {}
        : (existing.tags as Record<string, unknown>) ?? {}
    const nextTags: Record<string, unknown> = { ...currentTags, court: true }

    if (body.tags && typeof body.tags === 'object') {
      Object.assign(nextTags, body.tags)
    }
    // Mirror the resolved column values so the VIRTUAL-column indexes stay hot.
    const nextType = body.courtType !== undefined ? body.courtType : existing.courtType
    const nextJur = body.jurisdictionId !== undefined ? body.jurisdictionId : existing.jurisdictionId
    if (nextType) nextTags.courtType = nextType
    else delete nextTags.courtType
    if (nextJur) nextTags.jurisdictionRef = `@${nextJur}`
    else delete nextTags.jurisdictionRef

    patch.tags = nextTags as Prisma.InputJsonValue

    const updated = await prisma.court.update({
      where: { id },
      data: patch,
      include: { _count: { select: { cases: true } } },
    })
    return NextResponse.json({ court: materialize(updated) })
  } catch (e) {
    return NextResponse.json(
      { error: 'court_update_failed', message: (e as Error).message },
      { status: 500 },
    )
  }
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params
    const existing = await prisma.court.findUnique({
      where: { id },
      include: { _count: { select: { cases: true } } },
    })
    if (!existing) {
      return NextResponse.json({ error: 'court_not_found' }, { status: 404 })
    }
    if (existing._count.cases > 0) {
      return NextResponse.json(
        {
          error: 'court_has_cases',
          message: `Court has ${existing._count.cases} case(s); detach them before deleting`,
          casesCount: existing._count.cases,
        },
        { status: 409 },
      )
    }
    await prisma.court.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json(
      { error: 'court_delete_failed', message: (e as Error).message },
      { status: 500 },
    )
  }
}

function safeParse(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

type CourtWithCount = Prisma.CourtGetPayload<{
  include: { _count: { select: { cases: true } } }
}>
type CourtWithCases = Prisma.CourtGetPayload<{
  include: {
    _count: { select: { cases: true } }
    cases: { select: { id: true; name: true; caseNumber: true; jurisdiction: true } }
  }
}>

function materialize(c: CourtWithCount | CourtWithCases) {
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
    casesCount: c._count.cases,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  }
  if ('cases' in c && Array.isArray(c.cases)) {
    out.cases = c.cases
  }
  return out
}
