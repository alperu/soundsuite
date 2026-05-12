import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { prisma } from '@/lib/db/prisma';
import { getServicesManager } from '@/lib/services-manager';
import { FolderIndexService } from '@/services/folder-index-service';
import { createLogger } from '@/lib/logger';

const logger = createLogger('CaseRescan');

/**
 * POST /api/cases/[id]/rescan
 *
 * Triggers a folder rescan for the case:
 *   1. Invalidates Redis folder-index cache for the case path
 *   2. Restarts the FileWatcher so chokidar re-walks all watch paths
 *      (picks up folder renames / new files without master restart)
 *   3. Marks any documents whose paths no longer exist as ERROR with
 *      a helpful message so they are visible in the UI.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const caseRecord = await prisma.case.findUnique({ where: { id } });
    if (!caseRecord) {
      return NextResponse.json({ error: 'Case not found' }, { status: 404 });
    }

    // 1. Invalidate folder-index cache
    let invalidatedCache = false;
    try {
      const folderIndex = new FolderIndexService();
      await folderIndex.invalidate(caseRecord.path);
      await folderIndex.invalidateContent(caseRecord.path);
      invalidatedCache = true;
    } catch (err) {
      logger.warn('Folder cache invalidation failed', { err });
    }

    // 2. Restart FileWatcher so chokidar picks up renames
    let restartedWatcher = false;
    const sm = getServicesManager();
    const watcher = sm.getFileWatcher();
    if (watcher) {
      try {
        if (watcher.isWatcherRunning()) {
          await watcher.stop();
        }
        await watcher.start();
        restartedWatcher = true;
      } catch (err) {
        logger.error('FileWatcher restart failed', err);
      }
    }

    // 3. Reconcile DB vs disk:
    //    - Build a Set of existing paths + a basename → path index from the
    //      current disk state.
    //    - For each DB document whose stored filePath is missing on disk:
    //        a) If the basename matches exactly one file in the tree → relocate
    //           (update filePath + requeue). Folder rename is the common case.
    //        b) If basename has multiple matches OR none → mark ERROR with a
    //           hint to right-click → Update file path.
    let scannedFiles = 0;
    let relocated = 0;
    let markedMissing = 0;
    let crossCaseOrphans = 0;
    try {
      const existingPaths = new Set<string>();
      const byBasename = new Map<string, string[]>();
      const walk = async (dir: string, depth: number): Promise<void> => {
        if (depth < 0) return;
        let entries;
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const ent of entries) {
          if (ent.name.startsWith('.')) continue;
          const full = path.join(dir, ent.name);
          if (ent.isDirectory()) {
            await walk(full, depth - 1);
          } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.pdf')) {
            existingPaths.add(full);
            scannedFiles++;
            const arr = byBasename.get(ent.name) ?? [];
            arr.push(full);
            byBasename.set(ent.name, arr);
          }
        }
      };
      await walk(caseRecord.path, 8);

      const docs = await prisma.document.findMany({
        where: { caseId: id },
        select: { id: true, filePath: true, status: true, errorMessage: true },
      });
      // Normalize case path for prefix checks (handle trailing slash).
      const casePathPrefix = caseRecord.path.endsWith(path.sep)
        ? caseRecord.path
        : caseRecord.path + path.sep;
      for (const d of docs) {
        if (existingPaths.has(d.filePath)) continue; // still valid

        // Skip docs whose filePath isn't under this case's tree at all —
        // those are cross-case orphans (wrong caseId in DB). The walk above
        // can't find them because we only walked THIS case. Don't flag them
        // as "missing because of rename" — surfacing the count separately
        // tells the operator they have a data-integrity issue to investigate.
        if (!d.filePath.startsWith(casePathPrefix) && d.filePath !== caseRecord.path) {
          crossCaseOrphans++;
          continue;
        }

        const basename = path.basename(d.filePath);
        const candidates = byBasename.get(basename) ?? [];

        if (candidates.length === 1) {
          // Unambiguous basename match — update path only. Preserve the
          // existing status (INDEXED stays INDEXED, DISCOVERED stays
          // DISCOVERED) so we don't auto-reparse files the operator never
          // queued. If the doc was previously flagged ERROR because the
          // file was missing, clear that errorMessage and revert to
          // DISCOVERED so the UI no longer shows it as red — but never
          // set QUEUED here (that's the operator's call via Parse Selected).
          const wasFileMissing =
            d.status === 'ERROR' &&
            !!d.errorMessage &&
            /folder may have been renamed|File not found on disk|Ambiguous basename/i.test(d.errorMessage);
          await prisma.document.update({
            where: { id: d.id },
            data: wasFileMissing
              ? { filePath: candidates[0], status: 'DISCOVERED', errorMessage: null }
              : { filePath: candidates[0] },
          });
          relocated++;
        } else if (d.status !== 'ERROR') {
          // 0 or multiple matches — mark ERROR so operator can disambiguate
          const reason = candidates.length === 0
            ? 'File not found on disk — folder may have been renamed. Right-click → Update file path.'
            : `Ambiguous basename — ${candidates.length} files match "${basename}". Right-click → Update file path to choose.`;
          await prisma.document.update({
            where: { id: d.id },
            data: { status: 'ERROR', errorMessage: reason },
          });
          markedMissing++;
        }
      }
    } catch (err) {
      logger.warn('Disk-scan reconciliation failed', { err });
    }

    return NextResponse.json({
      ok: true,
      restartedWatcher,
      invalidatedCache,
      scannedFiles,
      relocated,
      markedMissing,
      crossCaseOrphans,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to rescan case' },
      { status: 500 }
    );
  }
}
