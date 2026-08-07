import { NextRequest, NextResponse } from 'next/server';
import * as lancedb from '@lancedb/lancedb';
import { prisma } from '@/lib/db/prisma';

const LANCEDB_PATH = process.env.LANCEDB_PATH || './data/lancedb';
const TABLE_NAME = 'chunks';

export async function GET(request: NextRequest) {
  try {
    const documentId = request.nextUrl.searchParams.get('documentId');
    if (!documentId) {
      return NextResponse.json(
        { error: { message: 'documentId is required' } },
        { status: 400 }
      );
    }

    // 1. Get document metadata from Prisma
    const document = await prisma.document.findUnique({
      where: { id: documentId },
      select: { id: true, fileName: true, pageCount: true },
    });

    if (!document) {
      return NextResponse.json(
        { error: { message: 'Document not found' } },
        { status: 404 }
      );
    }

    const totalPages = document.pageCount || 0;
    if (totalPages === 0) {
      return NextResponse.json({
        documentId: document.id,
        fileName: document.fileName,
        totalPages: 0,
        pages: [],
        summary: { indexedPages: 0, unindexedPages: 0, totalChunks: 0 },
      });
    }

    // 2. Get PageCache entries for this document
    const pageCacheEntries = await (prisma as any).pageCache.findMany({
      where: { documentId },
      select: {
        pageNumber: true,
        text: true,
        textDensity: true,
        source: true,
      },
    });

    // 2b. PageScore rows (readiness v2 Phase 3) — persisted at scoring time,
    // they outlive the PageCache wipe and snapshot density/source, which
    // fixes the all-zeros provenance display for INDEXED documents.
    const pageScoreRows: Array<{ pageNumber: number; score: number; band: string; pageClass: string; flags: string; textDensity: number; source: string }> =
      await (prisma as any).pageScore.findMany({
        where: { documentId },
        select: { pageNumber: true, score: true, band: true, pageClass: true, flags: true, textDensity: true, source: true },
      }).catch(() => []);
    const pageScoreMap = new Map(pageScoreRows.map((r) => [r.pageNumber, r]));

    const pageCacheMap = new Map<number, { text: string; textDensity: number; source: string }>();
    for (const entry of pageCacheEntries) {
      pageCacheMap.set(entry.pageNumber, {
        text: entry.text,
        textDensity: entry.textDensity,
        source: entry.source,
      });
    }

    // 3. Get chunk counts and text per page from LanceDB
    const chunkCountMap = new Map<number, { count: number; hasExhibit: boolean; firstText: string }>();

    try {
      const db = await lancedb.connect(LANCEDB_PATH);
      const tableNames = await db.tableNames();

      if (tableNames.includes(TABLE_NAME)) {
        const table = await db.openTable(TABLE_NAME);
        const escapedDocId = documentId.replace(/'/g, "''");

        const rows = await table.query()
          .select(['page_number', 'is_exhibit', 'text'])
          .where(`document_id = '${escapedDocId}'`)
          .toArray();

        for (const row of rows) {
          const pageNum = row.page_number as number;
          const existing = chunkCountMap.get(pageNum);
          if (existing) {
            existing.count++;
            if (row.is_exhibit) existing.hasExhibit = true;
          } else {
            chunkCountMap.set(pageNum, {
              count: 1,
              hasExhibit: !!row.is_exhibit,
              firstText: (row.text as string) || '',
            });
          }
        }
      }
    } catch {
      // LanceDB may not be available — proceed with empty chunk data
    }

    // 4. Build per-page report
    let indexedPages = 0;
    let unindexedPages = 0;
    let emptyPageCount = 0;
    let totalChunks = 0;

    const pages = [];
    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      const cache = pageCacheMap.get(pageNum);
      const chunks = chunkCountMap.get(pageNum);
      const chunkCount = chunks?.count || 0;
      const hasExhibit = chunks?.hasExhibit || false;

      // Determine status: empty pages are explicitly marked, not counted as unindexed
      const isEmptyPage = cache?.source === 'empty';
      const status = isEmptyPage ? 'empty' : (chunkCount > 0 ? 'indexed' : 'unindexed');

      if (status === 'indexed') indexedPages++;
      else if (status === 'empty') emptyPageCount++;
      else unindexedPages++;
      totalChunks += chunkCount;

      // Text preview: empty pages get explicit label, others fallback to LanceDB
      let textPreview = '';
      if (isEmptyPage) {
        textPreview = '(empty page)';
      } else if (cache && cache.text.trim()) {
        textPreview = cache.text.substring(0, 200);
      } else if (cache && cache.textDensity > 0 && !cache.text.trim()) {
        textPreview = '(whitespace only)';
      } else if (chunks?.firstText) {
        textPreview = chunks.firstText.substring(0, 200);
      }

      const ps = pageScoreMap.get(pageNum);
      let flags: string[] = [];
      try { flags = ps ? JSON.parse(ps.flags) : []; } catch { /* keep [] */ }
      pages.push({
        pageNumber: pageNum,
        textPreview,
        // PageCache wins when present (fresher, mid-ingest); the PageScore
        // snapshot fills in after the cache is wiped.
        textDensity: cache?.textDensity ?? ps?.textDensity ?? 0,
        source: cache?.source ?? ps?.source ?? null,
        chunkCount,
        hasExhibit,
        status,
        score: ps?.score ?? null,
        band: ps?.band ?? null,
        pageClass: ps?.pageClass ?? null,
        flags,
      });
    }

    const scored = pages.filter((p: any) => p.score !== null && p.pageClass !== 'blank');
    const meanPageScore = scored.length > 0
      ? Math.round(scored.reduce((s: number, p: any) => s + p.score, 0) / scored.length)
      : null;
    return NextResponse.json({
      documentId: document.id,
      fileName: document.fileName,
      totalPages,
      pages,
      summary: {
        indexedPages,
        unindexedPages,
        emptyPages: emptyPageCount,
        totalChunks,
        meanPageScore,
        riskyPages: scored.filter((p: any) => p.score < 70 && p.score >= 50).length,
        poorPages: scored.filter((p: any) => p.score < 50).length,
      },
    });
  } catch (error) {
    console.error('Page report error:', error);
    return NextResponse.json(
      { error: { message: error instanceof Error ? error.message : 'Internal server error' } },
      { status: 500 }
    );
  }
}
