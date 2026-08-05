import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { getRedis, isRedisAvailable } from '@/lib/redis';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const caseId = searchParams.get('caseId');

    if (!caseId) {
      return NextResponse.json(
        { error: 'caseId parameter is required' },
        { status: 400 }
      );
    }

    const documents = await prisma.document.findMany({
      where: {
        caseId: caseId,
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

    return NextResponse.json({ documents: enrichedDocuments });
  } catch (error) {
    console.error('Error fetching documents:', error);
    return NextResponse.json(
      { error: 'Failed to fetch documents' },
      { status: 500 }
    );
  }
}
