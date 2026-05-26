/**
 * People ↔ Court linkage for the Person RefPicker court chip filter.
 *
 * Data path: a Person is "attached to" a court when they have a PersonRole
 * row with scopeKind='case' whose Case.courtId matches. (PersonRole.scopeKind
 * in current data is only 'motion'|'case' — no direct 'court' scope rows are
 * ever seeded, so we hop through Case.courtId.)
 *
 * Two modes:
 *   GET /api/people/courts            → { courts: [{id, name}] }
 *     Lists every court that has at least one Person attached via a case.
 *
 *   GET /api/people/courts?courtId=@<id> → { personIds: ['@<id>', ...] }
 *     Returns canonical person ids attached to that specific court.
 *
 * The RefPicker first hits the no-arg form to populate court chips, then
 * the courtId form when the user toggles a chip on, and intersects the
 * personId set with the current Haystack person results client-side.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma as _prisma } from '@/lib/db/prisma'

// The exported `prisma` is the structurally-distinct extended client (see
// src/lib/db/prisma.ts). Cast to a structural any here so we get the
// standard model accessors without dragging in the full extended type.
const prisma = _prisma as unknown as {
  case: { findMany: (args: unknown) => Promise<{ id: string; courtId: string | null }[]> }
  personRole: {
    findMany: (args: unknown) => Promise<{ personId: string; scopeId: string | null }[]>
  }
  court: { findMany: (args: unknown) => Promise<{ id: string; name: string | null }[]> }
}

function stripAt(s: string): string {
  return s.startsWith('@') ? s.slice(1) : s
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const courtIdParam = url.searchParams.get('courtId')

    if (courtIdParam) {
      const courtId = stripAt(courtIdParam)
      // Cases at this court.
      const cases = await prisma.case.findMany({
        where: { courtId },
        select: { id: true },
      })
      if (cases.length === 0) {
        return NextResponse.json({ personIds: [] })
      }
      const caseIds = cases.map((c) => c.id)
      const roles = await prisma.personRole.findMany({
        where: { scopeKind: 'case', scopeId: { in: caseIds } },
        select: { personId: true },
        distinct: ['personId'],
      })
      return NextResponse.json({
        personIds: roles.map((r) => `@${r.personId}`),
      })
    }

    // List courts that have at least one attached person.
    // 1) Person-scoped case ids.
    const caseRoleScopeIds = await prisma.personRole.findMany({
      where: { scopeKind: 'case' },
      select: { scopeId: true },
      distinct: ['scopeId'],
    })
    const caseIds = caseRoleScopeIds
      .map((r) => r.scopeId)
      .filter((s): s is string => typeof s === 'string' && s.length > 0)
    if (caseIds.length === 0) {
      return NextResponse.json({ courts: [] })
    }
    // 2) Distinct courtIds for those cases.
    const cases = await prisma.case.findMany({
      where: { id: { in: caseIds }, courtId: { not: null } },
      select: { courtId: true },
    })
    const courtIds = Array.from(
      new Set(cases.map((c) => c.courtId).filter((s): s is string => !!s)),
    )
    if (courtIds.length === 0) {
      return NextResponse.json({ courts: [] })
    }
    // 3) Court display names.
    const courts = await prisma.court.findMany({
      where: { id: { in: courtIds } },
      select: { id: true, name: true },
    })
    courts.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
    return NextResponse.json({
      courts: courts.map((c) => ({ id: `@${c.id}`, name: c.name ?? c.id })),
    })
  } catch (e) {
    return NextResponse.json(
      { courts: [], personIds: [], error: (e as Error).message },
      { status: 500 },
    )
  }
}
