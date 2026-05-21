/**
 * POST /api/personas/extract — propose Persona candidates for a document.
 */
import { NextRequest, NextResponse } from 'next/server'
import { extractPersonas } from '@/lib/personas/extract'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const documentId = body?.documentId
    if (typeof documentId !== 'string' || !documentId) {
      return NextResponse.json(
        { error: 'invalid_request', message: 'documentId required' },
        { status: 400 },
      )
    }
    const result = await extractPersonas(documentId)
    return NextResponse.json(result)
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
