/**
 * POST /api/personas/admin/manual-define — admin fallback when extraction
 * finds nothing. Re-uses the bulk-confirm transaction by computing
 * dedupMatches first so the UI can present them, then accepting the same
 * shape via the user's `action` ('create' | 'merge-with').
 *
 * Body: { documentId, candidates: ConfirmedItem[] }
 *   We tolerate the same payload shape as `bulk-confirm`; if a candidate
 *   carries no action we default to 'create'.
 */
import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { findDedupMatches } from '@/lib/personas/dedup'

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

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const documentId = body?.documentId
    const candidates = Array.isArray(body?.candidates) ? body.candidates : []
    if (typeof documentId !== 'string' || !documentId) {
      return NextResponse.json(
        { error: 'invalid_request', message: 'documentId required' },
        { status: 400 },
      )
    }
    if (!candidates.length) {
      return NextResponse.json(
        { error: 'invalid_request', message: 'candidates array required' },
        { status: 400 },
      )
    }
    const doc = await prisma.document.findUnique({ where: { id: documentId } })
    if (!doc) return NextResponse.json({ error: 'document_not_found' }, { status: 404 })

    // Compute dedup matches up-front for any candidate without an explicit action.
    const pool = await prisma.person.findMany({
      select: { id: true, displayName: true, email: true, barNumber: true },
    })

    const enriched = await Promise.all(
      candidates.map(async (c: Record<string, unknown>) => {
        const action =
          c.action === 'merge-with' || c.action === 'create' ? c.action : 'create'
        const displayName = typeof c.displayName === 'string' ? c.displayName : ''
        const dedupMatches = await findDedupMatches(
          {
            displayName,
            barNumber: typeof c.barNumber === 'string' ? c.barNumber : undefined,
            email: typeof c.email === 'string' ? c.email : undefined,
          },
          pool,
        )
        return { ...c, action, dedupMatches }
      }),
    )

    const result = await prisma.$transaction(async (tx) => {
      let created = 0
      let updated = 0
      let rolesAdded = 0
      const dedupReport: Array<{ displayName: string; matches: typeof enriched[number]['dedupMatches'] }> = []

      for (const item of enriched) {
        if (typeof item.displayName !== 'string' || !item.displayName.trim()) continue
        dedupReport.push({ displayName: item.displayName, matches: item.dedupMatches })

        const intrinsic: Record<string, true> = { person: true }
        for (const k of ALLOWED_INTRINSIC) {
          if ((item.intrinsicTags as Record<string, boolean> | undefined)?.[k]) {
            intrinsic[k] = true
          }
        }

        let personId: string
        if (item.action === 'merge-with' && typeof item.mergeWithPersonId === 'string') {
          const existing = await tx.person.findUnique({
            where: { id: item.mergeWithPersonId },
          })
          if (!existing) throw new Error('merge_target_not_found')
          const existingTags = coerceTags(existing.tags)
          await tx.person.update({
            where: { id: existing.id },
            data: {
              tags: {
                ...existingTags,
                ...intrinsic,
                person: true,
              } as Prisma.InputJsonValue,
              email:
                existing.email ?? (typeof item.email === 'string' ? item.email : null),
              barNumber:
                existing.barNumber ??
                (typeof item.barNumber === 'string' ? item.barNumber : null),
            },
          })
          personId = existing.id
          updated++
        } else {
          const p = await tx.person.create({
            data: {
              displayName: item.displayName.trim(),
              email: typeof item.email === 'string' ? item.email : null,
              barNumber: typeof item.barNumber === 'string' ? item.barNumber : null,
              tags: intrinsic as Prisma.InputJsonValue,
            },
          })
          personId = p.id
          created++
        }

        const pr = item.proposedRole as
          | { scopeKind?: string; scopeId?: string; contextualTags?: Record<string, boolean> }
          | undefined
        if (pr && (pr.scopeKind === 'motion' || pr.scopeKind === 'case') && pr.scopeId) {
          const tagBag: Record<string, unknown> = {
            personRole: true,
            personRef: `@person-${personId}`,
            scopeRef:
              pr.scopeKind === 'motion' ? `@motion-${pr.scopeId}` : `@case-${pr.scopeId}`,
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
      return { created, updated, rolesAdded, dedupReport }
    })

    return NextResponse.json(result)
  } catch (e) {
    return NextResponse.json(
      { error: 'persona_manual_define_failed', message: (e as Error).message },
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
