import { NextResponse } from 'next/server';
import * as lancedb from '@lancedb/lancedb';
import { prisma } from '@/lib/db/prisma';

const LANCEDB_PATH = process.env.LANCEDB_PATH || './data/lancedb';
const TABLE_NAME = 'chunks';

/**
 * GET /api/documents/partial-status
 * Returns IDs of INDEXED documents that have incomplete page coverage
 * (fewer distinct pages in LanceDB than the document's pageCount).
 */
export async function GET() {
  try {
    // 1. Get all INDEXED documents with a known pageCount
    const indexedDocs = await prisma.document.findMany({
      where: {
        status: 'INDEXED',
        pageCount: { not: null, gt: 0 },
      },
      select: { id: true, pageCount: true },
    });

    if (indexedDocs.length === 0) {
      return NextResponse.json({ partialDocumentIds: [] });
    }

    // 2. Query LanceDB for distinct page numbers per document
    const db = await lancedb.connect(LANCEDB_PATH);
    const tableNames = await db.tableNames();

    if (!tableNames.includes(TABLE_NAME)) {
      // No chunks table means all indexed docs are partial
      return NextResponse.json({
        partialDocumentIds: indexedDocs.map(d => d.id),
      });
    }

    const table = await db.openTable(TABLE_NAME);

    // Build IN clause for all indexed document IDs
    const docIds = indexedDocs.map(d => d.id);
    const escaped = docIds.map(id => `'${id.replace(/'/g, "''")}'`).join(', ');

    const rows = await table.query()
      .select(['document_id', 'page_number'])
      .where(`document_id IN (${escaped})`)
      .toArray();

    // 3. Count distinct pages per document
    const pagesByDoc = new Map<string, Set<number>>();
    for (const row of rows) {
      const docId = row.document_id as string;
      const pageNum = row.page_number as number;
      if (!pagesByDoc.has(docId)) {
        pagesByDoc.set(docId, new Set());
      }
      pagesByDoc.get(docId)!.add(pageNum);
    }

    // 4. Compare against expected pageCount
    const partialDocumentIds: string[] = [];
    for (const doc of indexedDocs) {
      const distinctPages = pagesByDoc.get(doc.id)?.size ?? 0;
      if (distinctPages < doc.pageCount!) {
        partialDocumentIds.push(doc.id);
      }
    }

    return NextResponse.json({ partialDocumentIds });
  } catch (error) {
    console.error('Partial status error:', error);
    return NextResponse.json(
      { error: { message: error instanceof Error ? error.message : 'Internal server error' } },
      { status: 500 }
    );
  }
}
