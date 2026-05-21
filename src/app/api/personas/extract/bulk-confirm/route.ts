/**
 * POST /api/personas/extract/bulk-confirm — apply confirmed extraction results.
 *
 * Body: { confirmed: ConfirmedItem[] }
 *   ConfirmedItem = {
 *     candidateIdx,                       // index from the extract response
 *     action: 'create' | 'merge-with',
 *     mergeWithPersonId?,                 // required when action='merge-with'
 *     displayName, barNumber?, email?,
 *     intrinsicTags: { ... },
 *     proposedRole?: { scopeKind, scopeId, contextualTags }
 *   }
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

interface ConfirmedItem {
  candidateIdx?: number
  action: 'create' | 'merge-with'
  mergeWithPersonId?: string
  displayName: string
  barNumber?: string
  email?: string
  intrinsicTags?: Record<string, boolean>
  proposedRole?: {
    scopeKind: 'motion' | 'case'
    scopeId: string
    contextualTags?: Record<string, boolean>
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const confirmed: ConfirmedItem[] = Array.isArray(body?.confirmed) ? body.confirmed : []
    if (!confirmed.length) {
      return NextResponse.json(
        { error: 'invalid_request', message: 'confirmed array required' },
        { status: 400 },
      )
    }

    const result = await prisma.$transaction(async (tx) => {
      let created = 0
      let updated = 0
      let rolesAdded = 0

      for (const item of confirmed) {
        if (!item || typeof item !== 'object') continue
        if (typeof item.displayName !== 'string' || !item.displayName.trim()) continue

        const intrinsic: Record<string, true> = { person: true }
        for (const k of ALLOWED_INTRINSIC) {
          if (item.intrinsicTags?.[k]) intrinsic[k] = true
        }

        let personId: string
        if (item.action === 'create') {
          const p = await tx.person.create({
            data: {
              displayName: item.displayName.trim(),
              email: item.email ?? null,
              barNumber: item.barNumber ?? null,
              tags: intrinsic as Prisma.InputJsonValue,
            },
          })
          personId = p.id
          created++
        } else if (item.action === 'merge-with') {
          if (!item.mergeWithPersonId) {
            throw new Error('mergeWithPersonId required for merge-with action')
          }
          const existing = await tx.person.findUnique({
            where: { id: item.mergeWithPersonId },
          })
          if (!existing) throw new Error('merge_target_not_found')
          // Union intrinsic markers + fill missing scalar fields.
          const existingTags = coerceTags(existing.tags)
          const nextTags = { ...existingTags, ...intrinsic, person: true }
          const patch: Record<string, unknown> = {
            tags: nextTags as Prisma.InputJsonValue,
          }
          if (!existing.email && item.email) patch.email = item.email
          if (!existing.barNumber && item.barNumber) patch.barNumber = item.barNumber
          await tx.person.update({ where: { id: existing.id }, data: patch })
          personId = existing.id
          updated++
        } else {
          continue
        }

        if (item.proposedRole) {
          const pr = item.proposedRole
          if (
            (pr.scopeKind === 'motion' || pr.scopeKind === 'case') &&
            typeof pr.scopeId === 'string'
          ) {
            const tagBag: Record<string, unknown> = {
              personRole: true,
              personRef: `@person-${personId}`,
              scopeRef:
                pr.scopeKind === 'motion'
                  ? `@motion-${pr.scopeId}`
                  : `@case-${pr.scopeId}`,
            }
            for (const k of ALLOWED_CONTEXTUAL) {
              if (pr.contextualTags?.[k]) tagBag[k] = true
            }
            await tx.personRole.create({
              data: {
                personId,
                scopeKind: pr.scopeKind,
                scopeId: pr.scopeId,
                tags: tagBag as Prisma.InputJsonValue,
              },
            })
            rolesAdded++
          }
        }
      }

      return { created, updated, rolesAdded }
    })

    return NextResponse.json(result)
  } catch (e) {
    return NextResponse.json(
      { error: 'persona_bulk_confirm_failed', message: (e as Error).message },
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
