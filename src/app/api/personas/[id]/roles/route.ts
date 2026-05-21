/**
 * GET  /api/personas/[id]/roles — every PersonRole for this Persona.
 * POST /api/personas/[id]/roles — add a new PersonRole binding.
 */
import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'

export const dynamic = 'force-dynamic'

const ALLOWED_CONTEXTUAL = [
  'movant',
  'respondent',
  'defendant',
  'plaintiff',
  'intervenor',
  'lawyerMovant',
  'lawyerRespondent',
  'judge',
] as const

type Ctx = { params: Promise<{ id: string }> }

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { id } = await params
  const roles = await prisma.personRole.findMany({
    where: { personId: id },
    orderBy: { createdAt: 'asc' },
  })
  const motionIds = roles.filter((r) => r.scopeKind === 'motion').map((r) => r.scopeId)
  const caseIds = roles.filter((r) => r.scopeKind === 'case').map((r) => r.scopeId)
  const [motions, cases] = await Promise.all([
    motionIds.length
      ? prisma.motion.findMany({
          where: { id: { in: motionIds } },
          select: { id: true, title: true },
        })
      : Promise.resolve([] as Array<{ id: string; title: string }>),
    caseIds.length
      ? prisma.case.findMany({
          where: { id: { in: caseIds } },
          select: { id: true, name: true, caseNumber: true },
        })
      : Promise.resolve(
          [] as Array<{ id: string; name: string; caseNumber: string | null }>,
        ),
  ])
  const motionLabel = new Map(motions.map((m) => [m.id, m.title]))
  const caseLabel = new Map(
    cases.map((c) => [c.id, c.caseNumber ?? c.name]),
  )
  return NextResponse.json({
    roles: roles.map((r) => ({
      id: r.id,
      scopeKind: r.scopeKind,
      scopeId: r.scopeId,
      scopeLabel:
        r.scopeKind === 'motion'
          ? motionLabel.get(r.scopeId) ?? r.scopeId
          : caseLabel.get(r.scopeId) ?? r.scopeId,
      tags: coerceTags(r.tags),
      appearedOn: r.appearedOn,
      withdrewOn: r.withdrewOn,
    })),
  })
}

export async function POST(req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params
    const person = await prisma.person.findUnique({ where: { id } })
    if (!person) {
      return NextResponse.json({ error: 'persona_not_found' }, { status: 404 })
    }
    const body = await req.json()
    const { scopeKind, scopeId, contextualTags = {}, appearedOn, withdrewOn } = body ?? {}
    if (scopeKind !== 'motion' && scopeKind !== 'case') {
      return NextResponse.json(
        { error: 'invalid_request', message: "scopeKind must be 'motion' or 'case'" },
        { status: 400 },
      )
    }
    if (!scopeId || typeof scopeId !== 'string') {
      return NextResponse.json(
        { error: 'invalid_request', message: 'scopeId required' },
        { status: 400 },
      )
    }
    // Verify scope exists.
    const scopeRow =
      scopeKind === 'motion'
        ? await prisma.motion.findUnique({ where: { id: scopeId }, select: { id: true } })
        : await prisma.case.findUnique({ where: { id: scopeId }, select: { id: true } })
    if (!scopeRow) {
      return NextResponse.json({ error: 'scope_not_found' }, { status: 404 })
    }
    const tagBag: Record<string, unknown> = {
      personRole: true,
      personRef: `@person-${id}`,
      scopeRef: scopeKind === 'motion' ? `@motion-${scopeId}` : `@case-${scopeId}`,
    }
    for (const k of ALLOWED_CONTEXTUAL) {
      if (contextualTags[k]) tagBag[k] = true
    }
    const created = await prisma.personRole.create({
      data: {
        personId: id,
        scopeKind,
        scopeId,
        tags: tagBag as Prisma.InputJsonValue,
        appearedOn: appearedOn ? new Date(appearedOn) : null,
        withdrewOn: withdrewOn ? new Date(withdrewOn) : null,
      },
    })
    return NextResponse.json({ role: created }, { status: 201 })
  } catch (e) {
    return NextResponse.json(
      { error: 'role_create_failed', message: (e as Error).message },
      { status: 500 },
    )
  }
}

function coerceTags(raw: unknown): unknown {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw)
    } catch {
      return {}
    }
  }
  return raw
}
