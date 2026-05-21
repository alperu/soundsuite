/**
 * POST /api/personas/merge — merge `mergeIds` into `keepId`.
 *
 * Reassigns every PersonRole binding to `keepId`, unions intrinsic markers,
 * then deletes the merged Person rows. Wrapped in a transaction so a partial
 * failure rolls back.
 */
import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { keepId, mergeIds } = body ?? {}
    if (typeof keepId !== 'string' || !Array.isArray(mergeIds) || !mergeIds.length) {
      return NextResponse.json(
        { error: 'invalid_request', message: 'keepId + non-empty mergeIds required' },
        { status: 400 },
      )
    }
    if (mergeIds.includes(keepId)) {
      return NextResponse.json(
        { error: 'invalid_request', message: 'keepId cannot appear in mergeIds' },
        { status: 400 },
      )
    }

    const result = await prisma.$transaction(async (tx) => {
      const keeper = await tx.person.findUnique({ where: { id: keepId } })
      if (!keeper) throw new Error('keep_person_not_found')
      const merged = await tx.person.findMany({ where: { id: { in: mergeIds } } })
      if (merged.length !== mergeIds.length) throw new Error('merge_person_missing')

      // Union intrinsic markers.
      const keeperTags = coerceTags(keeper.tags)
      for (const m of merged) {
        const mt = coerceTags(m.tags)
        for (const [k, v] of Object.entries(mt)) {
          if (v && !(k in keeperTags)) keeperTags[k] = v
        }
      }
      keeperTags.person = true

      // Reassign PersonRole bindings + denormalised Motion FKs.
      const rolesUpdated = await tx.personRole.updateMany({
        where: { personId: { in: mergeIds } },
        data: { personId: keepId },
      })
      await tx.motion.updateMany({
        where: { judgeId: { in: mergeIds } },
        data: { judgeId: keepId },
      })
      await tx.motion.updateMany({
        where: { movantId: { in: mergeIds } },
        data: { movantId: keepId },
      })
      await tx.motion.updateMany({
        where: { respondentId: { in: mergeIds } },
        data: { respondentId: keepId },
      })

      // Update keeper with union tags + fill missing scalar fields.
      const patch: Record<string, unknown> = { tags: keeperTags as Prisma.InputJsonValue }
      if (!keeper.email) {
        const firstEmail = merged.find((m) => m.email)?.email
        if (firstEmail) patch.email = firstEmail
      }
      if (!keeper.barNumber) {
        const firstBar = merged.find((m) => m.barNumber)?.barNumber
        if (firstBar) patch.barNumber = firstBar
      }
      await tx.person.update({ where: { id: keepId }, data: patch })

      const deleted = await tx.person.deleteMany({ where: { id: { in: mergeIds } } })
      return {
        kept: keepId,
        rolesReassigned: rolesUpdated.count,
        personsDeleted: deleted.count,
      }
    })

    return NextResponse.json(result)
  } catch (e) {
    return NextResponse.json(
      { error: 'persona_merge_failed', message: (e as Error).message },
      { status: 500 },
    )
  }
}

function coerceTags(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw)
    } catch {
      return {}
    }
  }
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>
  return {}
}
