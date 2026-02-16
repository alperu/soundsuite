export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { getRedis, isRedisAvailable } from '@/lib/redis';

/**
 * GET /api/admin/cache — Returns cache & document index status.
 */
export async function GET() {
  try {
    // Redis stats
    let redis: Record<string, any> = { available: false };
    if (await isRedisAvailable()) {
      const r = getRedis();
      const allKeys = await r.keys('soundsuite:*');

      const filingKeys = allKeys.filter(k => k.startsWith('soundsuite:case:'));
      const folderKeys = allKeys.filter(k => k.startsWith('soundsuite:folder:'));
      const progressKeys = allKeys.filter(k => k.startsWith('soundsuite:doc_progress:'));
      const otherKeys = allKeys.filter(k =>
        !k.startsWith('soundsuite:case:') &&
        !k.startsWith('soundsuite:folder:') &&
        !k.startsWith('soundsuite:doc_progress:')
      );

      redis = {
        available: true,
        filings: { keyCount: filingKeys.length, description: 'Case filings & file trees' },
        folders: { keyCount: folderKeys.length, description: 'Directory listings' },
        progress: { keyCount: progressKeys.length, description: 'Ingestion progress' },
        other: { keyCount: otherKeys.length, description: 'Other cached keys' },
        totalKeys: allKeys.length,
      };
    }

    // Document counts by status
    const statusCounts = await prisma.document.groupBy({
      by: ['status'],
      _count: { status: true },
    });
    const documents: Record<string, number> = {};
    for (const s of statusCounts) {
      documents[s.status.toLowerCase()] = s._count.status;
    }

    // Documents with active checkpoints
    const checkpointDocs = await prisma.document.findMany({
      where: { ingestCheckpoint: { not: null } },
      select: { id: true, fileName: true, status: true, pageCount: true, ingestCheckpoint: true },
    });

    // PageCache stats per document
    const pageCacheStats = await (prisma as any).pageCache.groupBy({
      by: ['documentId', 'source'],
      _count: { id: true },
    });
    const pageCache: Record<string, { extract: number; ocr: number; total: number }> = {};
    for (const row of pageCacheStats) {
      if (!pageCache[row.documentId]) pageCache[row.documentId] = { extract: 0, ocr: 0, total: 0 };
      const count = row._count.id;
      if (row.source === 'extract') pageCache[row.documentId].extract = count;
      else if (row.source === 'ocr') pageCache[row.documentId].ocr = count;
      pageCache[row.documentId].total += count;
    }

    // Total page cache count
    const totalPageCacheRows = await (prisma as any).pageCache.count();

    // All documents with filing info for the Document Index Manager table
    const allDocuments = await prisma.document.findMany({
      select: {
        id: true,
        fileName: true,
        status: true,
        pageCount: true,
        embeddingModel: true,
        documentType: true,
        ingestCheckpoint: true,
        filing: { select: { id: true, title: true, filingType: true } },
        case: { select: { id: true, name: true } },
      },
      orderBy: [{ case: { name: 'asc' } }, { fileName: 'asc' }],
    });

    return NextResponse.json({ redis, documents, checkpointDocs, pageCache, totalPageCacheRows, allDocuments });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to get cache status' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/admin/cache — Cache operations (clear redis, reindex, etc.).
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { action, documentIds } = body;

    switch (action) {
      case 'clear_redis_filings': {
        if (!(await isRedisAvailable())) return NextResponse.json({ error: 'Redis not available' }, { status: 503 });
        const r = getRedis();
        const keys = await r.keys('soundsuite:case:*');
        if (keys.length > 0) await r.del(...keys);
        return NextResponse.json({ cleared: keys.length, category: 'filings' });
      }

      case 'clear_redis_folders': {
        if (!(await isRedisAvailable())) return NextResponse.json({ error: 'Redis not available' }, { status: 503 });
        const r = getRedis();
        const keys = await r.keys('soundsuite:folder:*');
        if (keys.length > 0) await r.del(...keys);
        return NextResponse.json({ cleared: keys.length, category: 'folders' });
      }

      case 'clear_redis_progress': {
        if (!(await isRedisAvailable())) return NextResponse.json({ error: 'Redis not available' }, { status: 503 });
        const r = getRedis();
        const keys = await r.keys('soundsuite:doc_progress:*');
        if (keys.length > 0) await r.del(...keys);
        return NextResponse.json({ cleared: keys.length, category: 'progress' });
      }

      case 'clear_redis_all': {
        if (!(await isRedisAvailable())) return NextResponse.json({ error: 'Redis not available' }, { status: 503 });
        const r = getRedis();
        const keys = await r.keys('soundsuite:*');
        if (keys.length > 0) await r.del(...keys);
        return NextResponse.json({ cleared: keys.length, category: 'all' });
      }

      case 'reindex_documents': {
        if (!documentIds || !Array.isArray(documentIds) || documentIds.length === 0) {
          return NextResponse.json({ error: 'documentIds array required' }, { status: 400 });
        }
        // Set documents to QUEUED (preserve checkpoint for resume)
        await prisma.document.updateMany({
          where: { id: { in: documentIds } },
          data: { status: 'QUEUED', errorMessage: null },
        });
        return NextResponse.json({ requeued: documentIds.length });
      }

      case 'reindex_all': {
        const result = await prisma.document.updateMany({
          where: { status: 'INDEXED' },
          data: { status: 'QUEUED', errorMessage: null },
        });
        return NextResponse.json({ requeued: result.count });
      }

      case 'delete_and_recache': {
        if (!documentIds || !Array.isArray(documentIds) || documentIds.length === 0) {
          return NextResponse.json({ error: 'documentIds array required' }, { status: 400 });
        }
        // 1. Clear vector index for each document
        const { VectorStore } = await import('@/lib/vector/vector-store');
        const vectorStore = new VectorStore({
          dbPath: process.env.LANCEDB_PATH || './data/lancedb',
          tableName: 'chunks',
        });
        await vectorStore.initialize();
        let vectorsDeleted = 0;
        for (const docId of documentIds) {
          try {
            await vectorStore.deleteByDocument(docId);
            vectorsDeleted++;
          } catch { /* vector table may not exist yet */ }
        }
        // 2. Clear page cache
        await (prisma as any).pageCache.deleteMany({
          where: { documentId: { in: documentIds } },
        });
        // 3. Clear checkpoints and reset metadata, re-queue
        await prisma.document.updateMany({
          where: { id: { in: documentIds } },
          data: {
            status: 'QUEUED',
            errorMessage: null,
            ingestCheckpoint: null,
            pageCount: null,
            documentType: null,
            documentSummary: null,
            embeddingModel: null,
          },
        });
        return NextResponse.json({
          action: 'delete_and_recache',
          documentsRequeued: documentIds.length,
          vectorsDeleted,
        });
      }

      case 'clear_checkpoint': {
        if (!documentIds || !Array.isArray(documentIds) || documentIds.length === 0) {
          return NextResponse.json({ error: 'documentIds array required' }, { status: 400 });
        }
        await prisma.document.updateMany({
          where: { id: { in: documentIds } },
          data: { ingestCheckpoint: null },
        });
        // Also clear page cache for these documents
        await (prisma as any).pageCache.deleteMany({
          where: { documentId: { in: documentIds } },
        });
        return NextResponse.json({ cleared: documentIds.length });
      }

      case 'clear_all_vectors': {
        console.log('[cache/route] clear_all_vectors: starting');
        // Nuclear option: drop the entire LanceDB chunks table and re-queue all docs
        const lancedb = await import('@lancedb/lancedb');
        const dbPath = process.env.LANCEDB_PATH || './data/lancedb';
        console.log('[cache/route] clear_all_vectors: connecting to LanceDB at', dbPath);
        const db = await lancedb.connect(dbPath);
        const tables = await db.tableNames();
        console.log('[cache/route] clear_all_vectors: existing tables:', tables);
        let dropped = 0;
        if (tables.includes('chunks')) {
          await db.dropTable('chunks');
          dropped = 1;
          console.log('[cache/route] clear_all_vectors: dropped chunks table');
        } else {
          console.log('[cache/route] clear_all_vectors: no chunks table found');
        }
        // Reset INDEXED documents that have a filing to QUEUED (unfiled docs stay as-is)
        const resetResult = await prisma.document.updateMany({
          where: { status: 'INDEXED', filingId: { not: null } },
          data: {
            status: 'QUEUED',
            errorMessage: null,
            ingestCheckpoint: null,
            pageCount: null,
            documentType: null,
            documentSummary: null,
            embeddingModel: null,
          },
        });
        // Clear metadata on unfiled docs but don't queue them
        const unfiledResult = await prisma.document.updateMany({
          where: { status: 'INDEXED', filingId: null },
          data: {
            ingestCheckpoint: null,
            pageCount: null,
            documentType: null,
            documentSummary: null,
            embeddingModel: null,
          },
        });
        console.log('[cache/route] clear_all_vectors: re-queued', resetResult.count, 'filed documents, skipped', unfiledResult.count, 'unfiled');
        return NextResponse.json({
          action: 'clear_all_vectors',
          tablesDropped: dropped,
          documentsRequeued: resetResult.count,
        });
      }

      case 'clear_page_cache': {
        if (documentIds && Array.isArray(documentIds) && documentIds.length > 0) {
          const result = await (prisma as any).pageCache.deleteMany({
            where: { documentId: { in: documentIds } },
          });
          return NextResponse.json({ cleared: result.count, scope: 'selected' });
        }
        // Clear all page cache
        const result = await (prisma as any).pageCache.deleteMany();
        return NextResponse.json({ cleared: result.count, scope: 'all' });
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Cache operation failed' },
      { status: 500 }
    );
  }
}
