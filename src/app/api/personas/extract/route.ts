/**
 * POST /api/personas/extract — propose Persona candidates.
 *
 * Body: { documentId } OR { motionId }
 *
 * When motionId is supplied, runs extraction across every Document linked
 * to that Motion via MotionAttachment, merging candidates with dedup so
 * the same person seen in multiple docs collapses into one proposal.
 * Proposed role bindings get pre-scoped to the motion.
 */
import { NextRequest, NextResponse } from 'next/server'
import { extractPersonas } from '@/lib/personas/extract'
import { prisma } from '@/lib/db/prisma'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const documentId: string | undefined =
      typeof body?.documentId === 'string' && body.documentId ? body.documentId : undefined
    const motionId: string | undefined =
      typeof body?.motionId === 'string' && body.motionId ? body.motionId : undefined

    if (!documentId && !motionId) {
      return NextResponse.json(
        { error: 'invalid_request', message: 'documentId or motionId required' },
        { status: 400 },
      )
    }

    if (documentId) {
      const result = await extractPersonas(documentId)
      return NextResponse.json(result)
    }

    // motionId path: fan out across all attached documents, merge candidates by dedup key.
    const attachments = await (prisma as unknown as {
      motionAttachment: {
        findMany(args: unknown): Promise<Array<{ documentId: string | null }>>
      }
    }).motionAttachment.findMany({
      where: { motionId },
      select: { documentId: true },
    })
    const docIds = Array.from(
      new Set(
        attachments
          .map(a => a.documentId)
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
      ),
    )

    if (docIds.length === 0) {
      return NextResponse.json({
        motionId,
        documentId: null,
        documentName: null,
        caseId: null,
        candidates: [],
        recommendation: 'manual' as const,
        stagesRun: ['motion-no-documents'],
      })
    }

    const results = await Promise.all(docIds.map(id => extractPersonas(id)))
    type Candidate = (typeof results)[number]['candidates'][number]
    const candidates: Map<string, Candidate> = new Map()
    const stagesRun = new Set<string>()
    let firstCaseId: string | null = null
    for (const r of results) {
      for (const s of r.stagesRun ?? []) stagesRun.add(s)
      if (!firstCaseId && r.caseId) firstCaseId = r.caseId
      for (const c of r.candidates ?? []) {
        // Dedup key: prefer barNumber, then email, then normalized displayName.
        const key =
          (c.barNumber && `bar:${c.barNumber}`) ||
          (c.email && `email:${c.email.toLowerCase()}`) ||
          `name:${c.displayName.trim().toLowerCase()}`
        const prior = candidates.get(key)
        if (!prior) {
          // When the candidate has no role scope, pin it to this motion as
          // the proposed role binding (we know which motion the user invoked).
          if (!c.proposedRole) {
            c.proposedRole = {
              scopeKind: 'motion',
              scopeId: motionId!,
              contextualTags: {},
            }
          }
          candidates.set(key, c)
        } else {
          // Merge intrinsicTags (union) and keep the higher-quality source quote.
          prior.intrinsicTags = { ...prior.intrinsicTags, ...c.intrinsicTags }
          if (!prior.barNumber && c.barNumber) prior.barNumber = c.barNumber
          if (!prior.email && c.email) prior.email = c.email
          if ((c.sourceQuote?.length ?? 0) > (prior.sourceQuote?.length ?? 0)) {
            prior.sourceQuote = c.sourceQuote
            prior.sourceChunkId = c.sourceChunkId
          }
        }
      }
    }

    return NextResponse.json({
      motionId,
      documentId: null,
      documentName: `motion (${docIds.length} documents)`,
      caseId: firstCaseId,
      candidates: Array.from(candidates.values()),
      recommendation:
        candidates.size > 0 ? ('review' as const) : ('manual' as const),
      stagesRun: Array.from(stagesRun),
    })
  } catch (e) {
    const msg = (e as Error).message
    if (msg.startsWith('document_not_found')) {
      return NextResponse.json({ error: 'document_not_found' }, { status: 404 })
    }
    return NextResponse.json(
      { error: 'persona_extract_failed', message: msg },
      { status: 500 },
    )
  }
}

