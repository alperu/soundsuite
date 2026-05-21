/**
 * GET / PUT / DELETE /api/personas/[id]
 *
 * DELETE is intentionally a 405 in v1 — use `/api/personas/merge` to combine
 * dupes. We return 409 if there are any PersonRole bindings, just to make the
 * UI aware.
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

type Ctx = { params: Promise<{ id: string }> }

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { id } = await params
  const persona = await prisma.person.findUnique({ where: { id } })
  if (!persona) {
    return NextResponse.json({ error: 'persona_not_found' }, { status: 404 })
  }
  return NextResponse.json({ persona })
}

export async function PUT(req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params
    const existing = await prisma.person.findUnique({ where: { id } })
    if (!existing) {
      return NextResponse.json({ error: 'persona_not_found' }, { status: 404 })
    }
    const body = await req.json()
    const patch: Record<string, unknown> = {}
    if (typeof body.displayName === 'string') patch.displayName = body.displayName.trim()
    if (body.email !== undefined) patch.email = body.email ?? null
    if (body.barNumber !== undefined) patch.barNumber = body.barNumber ?? null
    if (body.jurisdictionId !== undefined) patch.jurisdictionId = body.jurisdictionId ?? null

    // Merge intrinsic tags. `person` marker is sticky.
    const currentTags = (typeof existing.tags === 'string'
      ? JSON.parse(existing.tags as unknown as string)
      : (existing.tags as Record<string, unknown>)) ?? {}
    const nextTags: Record<string, unknown> = { ...currentTags, person: true }
    if (body.intrinsicTags && typeof body.intrinsicTags === 'object') {
      for (const k of ALLOWED_INTRINSIC) {
        if (k in body.intrinsicTags) {
          if (body.intrinsicTags[k]) nextTags[k] = true
          else delete nextTags[k]
        }
      }
    }
    patch.tags = nextTags as Prisma.InputJsonValue

    const updated = await prisma.person.update({ where: { id }, data: patch })
    return NextResponse.json({ persona: updated })
  } catch (e) {
    return NextResponse.json(
      { error: 'persona_update_failed', message: (e as Error).message },
      { status: 500 },
    )
  }
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const { id } = await params
  const roleCount = await prisma.personRole.count({ where: { personId: id } })
  if (roleCount > 0) {
    return NextResponse.json(
      {
        error: 'persona_has_roles',
        message: `Persona has ${roleCount} role binding(s); merge instead`,
        roleCount,
      },
      { status: 409 },
    )
  }
  return NextResponse.json(
    { error: 'method_not_allowed', message: 'Persona deletion not supported in v1' },
    { status: 405 },
  )
}
