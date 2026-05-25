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

function withMarkers<T extends { tags: unknown; id: string }>(p: T, rolesCount = 0) {
  const tags = recoverTagObject(p.tags)
  const markers = INTRINSIC_MARKERS.filter(k => tags[k] === true)
  return { ...p, tags, markers, rolesCount }
}

type Ctx = { params: Promise<{ id: string }> }

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { id } = await params
  const persona = await prisma.person.findUnique({ where: { id } })
  if (!persona) {
    return NextResponse.json({ error: 'persona_not_found' }, { status: 404 })
  }
  const rolesCount = await prisma.personRole.count({ where: { personId: id } })
  return NextResponse.json({ persona: withMarkers(persona, rolesCount) })
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
    //
    // Two body shapes are accepted:
    //   1. `markers: string[]`  — the authoritative array of intrinsic
    //      markers the persona should carry. Any ALLOWED_INTRINSIC key not
    //      in the array is removed; keys in the array are set to `true`.
    //      This is what the persona edit UI (`updatePersona` in
    //      lib/personas/client.ts) sends.
    //   2. `intrinsicTags: { [marker]: boolean }` — legacy per-key patch
    //      shape: only the keys present are modified, others left alone.
    const currentTags = (typeof existing.tags === 'string'
      ? JSON.parse(existing.tags as unknown as string)
      : (existing.tags as Record<string, unknown>)) ?? {}
    const nextTags: Record<string, unknown> = { ...currentTags, person: true }
    if (Array.isArray(body.markers)) {
      const wanted = new Set(
        body.markers.filter((m: unknown): m is string => typeof m === 'string'),
      )
      for (const k of ALLOWED_INTRINSIC) {
        if (wanted.has(k)) nextTags[k] = true
        else delete nextTags[k]
      }
    } else if (body.intrinsicTags && typeof body.intrinsicTags === 'object') {
      for (const k of ALLOWED_INTRINSIC) {
        if (k in body.intrinsicTags) {
          if (body.intrinsicTags[k]) nextTags[k] = true
          else delete nextTags[k]
        }
      }
    }
    patch.tags = nextTags as Prisma.InputJsonValue

    const updated = await prisma.person.update({ where: { id }, data: patch })
    const rolesCount = await prisma.personRole.count({ where: { personId: id } })
    return NextResponse.json({ persona: withMarkers(updated, rolesCount) })
  } catch (e) {
    return NextResponse.json(
      { error: 'persona_update_failed', message: (e as Error).message },
      { status: 500 },
    )
  }
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const { id } = await params
  const existing = await prisma.person.findUnique({ where: { id }, select: { id: true } })
  if (!existing) {
    return NextResponse.json(
      { error: 'persona_not_found' },
      { status: 404 },
    )
  }
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
  try {
    await prisma.person.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json(
      { error: 'delete_failed', message: e instanceof Error ? e.message : 'delete failed' },
      { status: 500 },
    )
  }
}
