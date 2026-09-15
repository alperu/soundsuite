import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { getRedis, isRedisAvailable } from '@/lib/redis';

export const dynamic = 'force-dynamic';

/**
 * A case's document list means "the documents this case actually works with",
 * and that is `filingId != null` — not a status filter.
 *
 * `src/app/page.tsx` has always applied `filingId: { not: null }` to both the
 * grid's initial documents and the per-case status chips. This route did not,
 * and `document-grid.tsx` re-fetches from here on mount and then every 2 s — so
 * the server rendered the right list and the first poll replaced it with every
 * row in the table. One real case rendered 24 documents and then became 488.
 *
 * Why `filingId` and not a status filter: bulk promotion is deliberately
 * *unfiled* (see `PROMOTION_MODE_RATIONALE` in `src/lib/ingestion/promotion.ts`)
 * — it moves documents DISCOVERED → QUEUED → INDEXED while leaving `filingId`
 * NULL. The unwanted rows are therefore spread across every status, and in the
 * case that prompted this fix **zero** of them were DISCOVERED. A status filter
 * would have hidden nothing.
 *
 * `?includeUnfiled=1` opts back in, for pickers that legitimately browse the
 * whole corpus — page-image insertion picks from any indexed PDF whether or not
 * a filing references it. Default-filtered is the point: a caller that forgets
 * the flag gets the case's real documents rather than the disk sweep.
 *
 * `unfiledHidden` is returned so the hidden rows can be counted on screen
 * instead of vanishing — the lesson recorded in `src/lib/document-status.ts`,
 * where DISCOVERED rows once dropped out of the grid with nothing to show that
 * they existed at all.
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const caseId = searchParams.get('caseId');
    const includeUnfiled = searchParams.get('includeUnfiled') === '1';

    if (!caseId) {
      return NextResponse.json(
        { error: 'caseId parameter is required' },
        { status: 400 }
      );
    }

    const unfiledHidden = includeUnfiled
      ? 0
      : await prisma.document.count({ where: { caseId, filingId: null } });

    const documents = await prisma.document.findMany({
      where: {
        caseId: caseId,
        ...(includeUnfiled ? {} : { filingId: { not: null } }),
      },
      select: {
        id: true,
        fileName: true,
        status: true,
        pageCount: true,
        detectedExhibits: true,
        errorMessage: true,
        embeddingModel: true,
        readinessScore: true,
        readinessBand: true,
        readinessWarnings: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    // Enrich PROCESSING documents with stage progress from Redis
    const processingDocs = documents.filter(d => d.status === 'PROCESSING');
    let progressMap: Record<string, { stage: string; detail: string; progress: number; stageIndex: number; totalStages: number }> = {};

    if (processingDocs.length > 0 && await isRedisAvailable()) {
      const redis = getRedis();
      const pipeline = redis.pipeline();
      for (const doc of processingDocs) {
        pipeline.hgetall(`soundsuite:doc_progress:${doc.id}`);
      }
      const results = await pipeline.exec();
      if (results) {
        for (let i = 0; i < processingDocs.length; i++) {
          const [err, data] = results[i] as [Error | null, Record<string, string>];
          if (!err && data && data.stage) {
            progressMap[processingDocs[i].id] = {
              stage: data.stage,
              detail: data.detail || '',
              progress: parseInt(data.progress || '0', 10),
              stageIndex: parseInt(data.stageIndex || '0', 10),
              totalStages: parseInt(data.totalStages || '10', 10),
            };
          }
        }
      }
    }

    const enrichedDocuments = documents.map(doc => ({
      ...doc,
      ...(progressMap[doc.id] ? { stageProgress: progressMap[doc.id] } : {}),
    }));

    return NextResponse.json({ documents: enrichedDocuments, unfiledHidden });
  } catch (error) {
    console.error('Error fetching documents:', error);
    return NextResponse.json(
      { error: 'Failed to fetch documents' },
      { status: 500 }
    );
  }
}
