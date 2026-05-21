import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { publishDocumentEvent } from '@/lib/sse-events';
import { FilingsCacheService } from '@/services/filings-cache';
import { VectorStore } from '@/lib/vector/vector-store';

/**
 * DELETE /api/documents/[id] - Remove a document from the database
 * Also cleans up vector store data if available.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const doc = await prisma.document.findUnique({ where: { id } });
    if (!doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }

    // Clean up vectors from LanceDB
    try {
      const vectorStore = new VectorStore({
        dbPath: process.env.LANCEDB_PATH || './data/lancedb',
        tableName: 'chunks',
      });
      await vectorStore.initialize();
      await vectorStore.deleteByDocument(id);
    } catch {
      // Vector table may not exist — not fatal
    }

    // Delete the document record
    await prisma.document.delete({ where: { id } });

    return NextResponse.json({ success: true, deletedDocument: doc.fileName });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete document' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/documents/[id] - Get a single document with case info
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const doc = await prisma.document.findUnique({
      where: { id },
      include: { case: true, filing: true },
    });

    if (!doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }

    return NextResponse.json({ document: doc });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to get document' },
      { status: 500 }
    );
  }
}
/**
 * PATCH /api/documents/[id] - Update document fields (e.g. fileName)
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();

    const doc = await prisma.document.findUnique({ where: { id } });
    if (!doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }

    const updateData: Record<string, any> = {};
    if (body.fileName && typeof body.fileName === 'string') {
      updateData.fileName = body.fileName.trim();
    }
    if (body.status && typeof body.status === 'string' && ['QUEUED', 'PROCESSING', 'INDEXED', 'ERROR', 'STOPPED'].includes(body.status)) {
      updateData.status = body.status;
    }
    if (body.filingId !== undefined) {
      if (body.filingId === null) {
        updateData.filingId = null;
        updateData.exhibitLabel = null;
      } else if (typeof body.filingId === 'string') {
        updateData.filingId = body.filingId;
      }
    }
    if (body.exhibitLabel !== undefined) {
      if (body.exhibitLabel === null) {
        updateData.exhibitLabel = null;
      } else if (typeof body.exhibitLabel === 'string') {
        updateData.exhibitLabel = body.exhibitLabel.trim() || null;
      }
    }

    if (Object.keys(updateData).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
    }

    // When re-queuing for reparse, clear stale caches so text is re-extracted from the PDF
    if (updateData.status === 'QUEUED') {
      // Clear PageCache unless caller wants to preserve it (smart retry skips OCR)
      if (!body.preserveCache) {
        try {
          await (prisma as any).pageCache.deleteMany({ where: { documentId: id } });
        } catch { /* table may not exist */ }
      }
      // Clear ingest checkpoint so pipeline starts fresh
      updateData.ingestCheckpoint = null;
      // Clear vectors from LanceDB so they get regenerated
      try {
        const vectorStore = new VectorStore({
          dbPath: process.env.LANCEDB_PATH || './data/lancedb',
          tableName: 'chunks',
        });
        await vectorStore.initialize();
        await vectorStore.deleteByDocument(id);
      } catch { /* vector table may not exist */ }
    }

    const updated = await prisma.document.update({
      where: { id },
      data: updateData,
    });

    // Invalidate Redis filings cache when filingId OR exhibitLabel changes so
    // sidebar/detail-page reflect the move between Documents and Exhibits.
    if (updateData.filingId !== undefined || updateData.exhibitLabel !== undefined) {
      const filingsCache = new FilingsCacheService();
      filingsCache.invalidateCaseFilings(doc.caseId).catch(() => {});
      // Also invalidate the old filing's case if document moved between cases (unlikely but safe)
      if (doc.filingId) {
        const oldFiling = await prisma.filing.findUnique({ where: { id: doc.filingId }, select: { caseId: true } });
        if (oldFiling && oldFiling.caseId !== doc.caseId) {
          filingsCache.invalidateCaseFilings(oldFiling.caseId).catch(() => {});
        }
      }
    }

    // Publish SSE event for real-time updates
    if (updateData.status && updateData.status !== doc.status) {
      publishDocumentEvent({
        type: 'document_status_changed',
        caseId: doc.caseId,
        documentId: id,
        fileName: updated.fileName,
        filePath: updated.filePath,
        status: updated.status,
        filingId: updated.filingId,
      }).catch(() => {});
    }

    return NextResponse.json({ document: updated });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update document' },
      { status: 500 }
    );
  }
}

