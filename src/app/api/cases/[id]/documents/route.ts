import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';

/**
 * GET /api/cases/[id]/documents
 *
 * Returns all Documents belonging to a case (joined with their parent Filing)
 * for the tag-panel ref picker (`fileRef` / refTarget==='doc'). The Document
 * table isn't reachable through the Haystack /read filter compiler (Document
 * has no entity marker and isn't wired into `tableFromFilter`'s switch in
 * /api/haystack/[op]/route.ts:1019). Rather than retrofit the haystack
 * pipeline for read-only picker use, expose a small case-scoped listing here.
 *
 * Each row carries enough context to render a readable label:
 *   - `fileName`, `filePath`     → primary line
 *   - `filingTitle`, `filingType` → "linked to <filing>" hint
 *   - `pageCount`, `status`       → tertiary detail
 *
 * No status filter is applied — including DISCOVERED rows so the user can
 * attach files that haven't been indexed yet.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: caseId } = await params;
    if (!caseId) {
      return NextResponse.json({ error: 'caseId required' }, { status: 400 });
    }

    const docs = await (prisma as any).document.findMany({
      where: { caseId },
      orderBy: [
        // INDEXED first (most useful), then by createdAt
        { status: 'asc' },
        { createdAt: 'desc' },
      ],
      select: {
        id: true,
        fileName: true,
        filePath: true,
        status: true,
        pageCount: true,
        documentType: true,
        filingId: true,
        filing: {
          select: { id: true, title: true, filingType: true },
        },
      },
      take: 500,
    });

    const documents = docs.map((d: any) => ({
      id: d.id,
      fileName: d.fileName,
      filePath: d.filePath,
      status: d.status,
      pageCount: d.pageCount,
      documentType: d.documentType,
      filingId: d.filingId,
      filingTitle: d.filing?.title ?? null,
      filingType: d.filing?.filingType ?? null,
    }));

    return NextResponse.json({ documents });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
