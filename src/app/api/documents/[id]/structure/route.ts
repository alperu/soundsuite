/**
 * GET /api/documents/[id]/structure           → document structure summary
 * GET /api/documents/[id]/structure?page=N    → full blocks for one page
 *
 * Reads the docparse structure persisted by the ingestion structure stage
 * (PageCache.structuredJson — PLAN-ss-docparse §5). Powers the /vectors
 * Meta View troubleshooting tool. Reads SQLite directly — the LanceDB
 * five-projection chain does not apply here.
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const pageParam = request.nextUrl.searchParams.get('page');

    const doc = await prisma.document.findUnique({
      where: { id },
      select: { id: true, fileName: true, pageCount: true, filePath: true } as any,
    }) as any;
    if (!doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }
    const parserVersion = (await (prisma as any).document.findUnique({
      where: { id },
      select: { parserVersion: true },
    }))?.parserVersion ?? null;

    if (pageParam) {
      const pageNumber = parseInt(pageParam, 10);
      const row = await (prisma as any).pageCache.findUnique({
        where: { documentId_pageNumber: { documentId: id, pageNumber } },
        select: { structuredJson: true, parseMethod: true, source: true, textDensity: true },
      });
      if (!row?.structuredJson) {
        return NextResponse.json({
          pageNumber,
          structured: false,
          parseMethod: row?.parseMethod ?? null,
          blocks: [],
        });
      }
      const parsed = JSON.parse(row.structuredJson);
      // Page dimensions (PDF points) for bbox → percentage overlay math
      let pageDims: { width: number; height: number } | null = null;
      try {
        const { getPageDimensions } = await import('@/lib/pdf-page-renderer');
        pageDims = await getPageDimensions(doc.filePath, pageNumber);
      } catch { /* overlay degrades gracefully without dims */ }
      return NextResponse.json({
        pageNumber,
        structured: true,
        parseMethod: row.parseMethod,
        source: row.source,
        textDensity: row.textDensity,
        producer: parsed.producer,
        blocks: parsed.blocks,
        pageDims,
      });
    }

    // Summary: per-page block-type counts
    const rows = await (prisma as any).pageCache.findMany({
      where: { documentId: id, structuredJson: { not: null } },
      select: { pageNumber: true, parseMethod: true, structuredJson: true },
      orderBy: { pageNumber: 'asc' },
    });
    const pages = rows.map((r: any) => {
      let producer: string | null = null;
      const counts: Record<string, number> = {};
      let headings: string[] = [];
      try {
        const parsed = JSON.parse(r.structuredJson);
        producer = parsed.producer ?? null;
        for (const b of parsed.blocks ?? []) {
          counts[b.type] = (counts[b.type] ?? 0) + 1;
          if (b.type === 'heading' && headings.length < 12) headings.push(b.text.slice(0, 80));
        }
      } catch { /* corrupt row — surface as empty */ }
      return { pageNumber: r.pageNumber, parseMethod: r.parseMethod, producer, counts, headings };
    });

    return NextResponse.json({
      documentId: id,
      fileName: doc.fileName,
      pageCount: doc.pageCount,
      parserVersion,
      structuredPages: pages.length,
      pages,
    });
  } catch (error) {
    console.error('Structure API error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
