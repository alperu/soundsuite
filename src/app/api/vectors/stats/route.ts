import { NextResponse } from 'next/server';
import * as lancedb from '@lancedb/lancedb';
import { prisma } from '@/lib/db/prisma';
import { getConfig } from '@/lib/db/config';

const LANCEDB_PATH = process.env.LANCEDB_PATH || './data/lancedb';
const TABLE_NAME = 'chunks';

export async function GET() {
  try {
    const config = await getConfig();
    const db = await lancedb.connect(LANCEDB_PATH);
    const tableNames = await db.tableNames();

    const embeddingInfo = {
      provider: config.embeddingProvider,
      model: config.embeddingModel,
      dbPath: LANCEDB_PATH,
    };

    if (!tableNames.includes(TABLE_NAME)) {
      return NextResponse.json({
        totalChunks: 0,
        totalDocuments: 0,
        totalCases: 0,
        exhibitChunks: 0,
        textChunks: 0,
        avgChunksPerDoc: 0,
        vectorDimensions: null,
        embedding: embeddingInfo,
        caseBreakdown: [],
        documentBreakdown: [],
      });
    }

    const table = await db.openTable(TABLE_NAME);

    // Counts
    const totalChunks = await table.countRows();
    const exhibitChunks = await table.countRows('is_exhibit = true');
    const textChunks = totalChunks - exhibitChunks;

    // Detect vector dimensions from first row
    let vectorDimensions: number | null = null;
    try {
      const sampleRows = await table.query().select(['vector']).limit(1).toArray();
      if (sampleRows.length > 0 && sampleRows[0].vector) {
        vectorDimensions = sampleRows[0].vector.length;
      }
    } catch {
      // Non-critical
    }

    // Aggregate by case and document
    const metaRows = await table.query()
      .select(['case_id', 'document_id'])
      .toArray();

    const caseChunkCounts: Record<string, number> = {};
    const docChunkCounts: Record<string, number> = {};

    for (const row of metaRows) {
      caseChunkCounts[row.case_id] = (caseChunkCounts[row.case_id] || 0) + 1;
      docChunkCounts[row.document_id] = (docChunkCounts[row.document_id] || 0) + 1;
    }

    const uniqueCaseIds = Object.keys(caseChunkCounts);
    const uniqueDocIds = Object.keys(docChunkCounts);

    // Enrich with Prisma data
    const cases = await prisma.case.findMany({
      where: { id: { in: uniqueCaseIds } },
      select: { id: true, name: true },
    });

    const documents = await prisma.document.findMany({
      where: { id: { in: uniqueDocIds } },
      select: { id: true, fileName: true, caseId: true },
    });

    const caseMap = Object.fromEntries(cases.map(c => [c.id, c.name]));
    const docMap = Object.fromEntries(documents.map(d => [d.id, { name: d.fileName, caseId: d.caseId }]));

    const caseBreakdown = Object.entries(caseChunkCounts)
      .map(([id, chunks]) => ({ id, name: caseMap[id] || id, chunks }))
      .sort((a, b) => b.chunks - a.chunks);

    const documentBreakdown = Object.entries(docChunkCounts)
      .map(([id, chunks]) => ({
        id,
        name: docMap[id]?.name || id,
        caseId: docMap[id]?.caseId || '',
        chunks,
      }))
      .sort((a, b) => b.chunks - a.chunks);

    return NextResponse.json({
      totalChunks,
      totalDocuments: uniqueDocIds.length,
      totalCases: uniqueCaseIds.length,
      exhibitChunks,
      textChunks,
      avgChunksPerDoc: uniqueDocIds.length > 0
        ? Math.round((totalChunks / uniqueDocIds.length) * 10) / 10
        : 0,
      vectorDimensions,
      embedding: embeddingInfo,
      caseBreakdown,
      documentBreakdown,
    });
  } catch (error) {
    console.error('Vector stats error:', error);
    return NextResponse.json(
      { error: { message: error instanceof Error ? error.message : 'Internal server error' } },
      { status: 500 }
    );
  }
}
