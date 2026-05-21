import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { isRedisAvailable } from '@/lib/redis';
import { FolderIndexService } from '@/services/folder-index-service';
import { FilingsCacheService } from '@/services/filings-cache';
import fs from 'fs/promises';
import path from 'path';

interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'folder';
  size?: number;
  children?: FileEntry[];
}

const filingsCache = new FilingsCacheService();

/**
 * Recursively scan a directory for subfolders and PDF files.
 */
async function scanDirectory(dirPath: string): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];

  try {
    const items = await fs.readdir(dirPath, { withFileTypes: true });

    for (const item of items) {
      // Skip hidden files/folders
      if (item.name.startsWith('.')) continue;

      const fullPath = path.join(dirPath, item.name);

      if (item.isDirectory()) {
        const children = await scanDirectory(fullPath);
        // Only include folders that contain PDFs (directly or nested)
        if (children.length > 0) {
          entries.push({
            name: item.name,
            path: fullPath,
            type: 'folder',
            children,
          });
        }
      } else if (item.isFile() && item.name.toLowerCase().endsWith('.pdf')) {
        const stat = await fs.stat(fullPath);
        entries.push({
          name: item.name,
          path: fullPath,
          type: 'file',
          size: stat.size,
        });
      }
    }
  } catch {
    // If we can't read a directory, skip it
  }

  // Sort: folders first, then files, alphabetically
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return entries;
}

/**
 * GET /api/cases/[id]/files - List all PDFs and subfolders in a case directory.
 * Uses Redis cache (FilingsCacheService for response-level caching,
 * FolderIndexService for folder-level caching).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const fresh = request.nextUrl.searchParams.get('fresh') === '1';

    // Check response-level cache first (includes files + trackedFiles)
    if (!fresh) {
      const cachedResponse = await filingsCache.getCaseFiles(id);
      if (cachedResponse) {
        return NextResponse.json(cachedResponse, {
          headers: { 'X-Cache': 'HIT' },
        });
      }
    }

    const caseRecord = await prisma.case.findUnique({
      where: { id },
      include: {
        documents: {
          // Filter out orphan Documents (no associated Filing). These can
          // accumulate as ENOENT/ERROR entries when Case.path is edited and
          // Document.filePath isn't migrated. They shouldn't surface in the
          // user-visible to-index / error queue. Background indexing still
          // sees all rows via the worker poll path.
          where: { filingId: { not: null } },
          select: { id: true, filePath: true, status: true, fileName: true, filingId: true, filing: { select: { slug: true, title: true } } },
        },
      },
    });

    if (!caseRecord) {
      return NextResponse.json({ error: 'Case not found' }, { status: 404 });
    }

    // Try Redis folder cache first, fall back to filesystem scan
    let files: FileEntry[];
    let cacheHit = false;

    if (await isRedisAvailable()) {
      try {
        const indexService = new FolderIndexService();
        const hash = await indexService.generateFolderHash(caseRecord.path);
        const cached = hash ? await indexService.getFolderContent(caseRecord.path, hash) : null;

        if (cached) {
          // Convert CachedFileEntry[] to FileEntry[] preserving nested children
          const mapEntries = (entries: typeof cached): FileEntry[] =>
            entries.map(e => ({
              name: e.name,
              path: e.path,
              type: e.type,
              size: e.size,
              children: e.children ? mapEntries(e.children) : undefined,
            }));
          files = mapEntries(cached);
          cacheHit = true;
        } else {
          // Cache miss — scan filesystem and populate cache
          files = await scanDirectory(caseRecord.path);
          // Async cache population (don't block response)
          indexService.scanAndCacheFolder(caseRecord.path, caseRecord.path).catch(() => {});
        }
      } catch {
        // Redis error — fall back to filesystem
        files = await scanDirectory(caseRecord.path);
      }
    } else {
      files = await scanDirectory(caseRecord.path);
    }

    // Build a map of already-tracked documents for status lookup
    const trackedFiles: Record<string, { status: string; fileName: string; documentId: string; filingId?: string; filingSlug?: string; filingTitle?: string }> = {};
    for (const doc of caseRecord.documents) {
      trackedFiles[doc.filePath] = {
        status: doc.status,
        fileName: doc.fileName,
        documentId: doc.id,
        filingId: doc.filingId || undefined,
        filingSlug: doc.filing?.slug || undefined,
        filingTitle: doc.filing?.title || undefined,
      };
    }

    const responseData = {
      caseId: id,
      casePath: caseRecord.path,
      files,
      trackedFiles,
    };

    // Cache the full response for fast subsequent reads
    filingsCache.setCaseFiles(id, responseData).catch(() => {});

    // Signal UI demand to PID controller (non-blocking)
    try {
      const sm = (await import('@/lib/services-manager')).getServicesManager();
      const pool = sm.getWorkerPoolService();
      if (pool) pool.recordRequestTime().catch(() => {});
    } catch { /* non-critical */ }

    return NextResponse.json(responseData, {
      headers: cacheHit ? { 'X-Cache': 'HIT' } : { 'X-Cache': 'MISS' },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to list files' },
      { status: 500 }
    );
  }
}
