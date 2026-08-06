import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { VectorStore } from '@/lib/vector/vector-store';
import { publishDocumentEvent } from '@/lib/sse-events';

/**
 * POST /api/documents/[id]/clear-index
 * Clears the LanceDB vector index for this document and resets status to QUEUED.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const doc = await prisma.document.findUnique({ where: { id } });
    if (!doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }

    // Clear vector index for this document
    const vectorStore = new VectorStore({
      dbPath: process.env.LANCEDB_PATH || './data/lancedb',
      tableName: 'chunks',
    });
    await vectorStore.initialize();
    await vectorStore.deleteByDocument(id);

    // Clear ALL PageCache rows including persisted structure — a re-index is
    // an explicit discard of the previous parse; keeping stale structuredJson
    // would make Meta View report structure a new run never produced
    // (observed 2026-08-06 after the transcript carve-out landed).
    try {
      await (prisma as any).pageCache.deleteMany({ where: { documentId: id } });
    } catch { /* non-fatal */ }

    // Reset document status and clear indexed metadata
    const updated = await prisma.document.update({
      where: { id },
      data: {
        status: 'QUEUED',
        pageCount: null,
        documentType: null,
        documentSummary: null,
        embeddingModel: null,
      },
    });

    publishDocumentEvent({
      type: 'document_status_changed',
      caseId: doc.caseId,
      documentId: id,
      fileName: updated.fileName,
      filePath: updated.filePath,
      status: updated.status,
      filingId: updated.filingId,
    }).catch(() => {});

    return NextResponse.json({ success: true, document: updated });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to clear index' },
      { status: 500 }
    );
  }
}
