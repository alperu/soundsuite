import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { prisma } from '@/lib/db/prisma';
import { createLogger } from '@/lib/logger';

const logger = createLogger('DocumentRefreshPath');

/**
 * Recursive basename search bounded by depth.
 * Returns the first matching .pdf path found, or null.
 */
async function findByBasename(
  rootDir: string,
  fileName: string,
  depth = 6
): Promise<string | null> {
  if (depth < 0) return null;
  let entries;
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    const full = path.join(rootDir, ent.name);
    if (ent.isFile() && ent.name === fileName) {
      return full;
    }
  }
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    if (ent.isDirectory()) {
      const found = await findByBasename(path.join(rootDir, ent.name), fileName, depth - 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * POST /api/documents/[id]/refresh-path
 *
 * Re-stats the document's path. If missing, tries to find a sibling .pdf
 * with the same basename inside the case's path tree. Updates the row or
 * marks it ERROR if no match is found.
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

    // 1. Try the recorded path first. If it's still valid we DON'T auto-
    //    requeue — the operator may not want to reparse. Just clear any
    //    stale "file missing" error so the row stops being flagged.
    try {
      const stat = await fs.stat(doc.filePath);
      if (stat.isFile()) {
        const wasFileMissingError =
          doc.status === 'ERROR' &&
          !!doc.errorMessage &&
          /folder may have been renamed|File not found on disk|Ambiguous basename/i.test(doc.errorMessage);
        if (wasFileMissingError) {
          await prisma.document.update({
            where: { id },
            data: { status: 'DISCOVERED', errorMessage: null, updatedAt: new Date() },
          });
        }
        return NextResponse.json({
          ok: true,
          action: 'path_still_valid',
          path: doc.filePath,
        });
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        logger.warn('stat failed for non-ENOENT reason', { err, path: doc.filePath });
      }
    }

    // 2. Try to relocate by basename within the case tree. Path-only update
    //    — preserve status (INDEXED stays INDEXED, DISCOVERED stays
    //    DISCOVERED). Only clear ERROR + revert to DISCOVERED if the error
    //    was specifically about the file being missing.
    const fileName = path.basename(doc.filePath);
    const caseRec = await prisma.case.findUnique({ where: { id: doc.caseId } });
    if (!caseRec) {
      return NextResponse.json({ error: 'Case not found for document' }, { status: 404 });
    }

    const found = await findByBasename(caseRec.path, fileName);
    if (found) {
      const wasFileMissingError =
        doc.status === 'ERROR' &&
        !!doc.errorMessage &&
        /folder may have been renamed|File not found on disk|Ambiguous basename/i.test(doc.errorMessage);
      await prisma.document.update({
        where: { id },
        data: wasFileMissingError
          ? { filePath: found, status: 'DISCOVERED', errorMessage: null, updatedAt: new Date() }
          : { filePath: found, updatedAt: new Date() },
      });
      return NextResponse.json({
        ok: true,
        action: 'path_updated',
        oldPath: doc.filePath,
        newPath: found,
      });
    }

    // 3. Give up — mark ERROR
    await prisma.document.update({
      where: { id },
      data: {
        status: 'ERROR',
        errorMessage: 'File not found — folder may have been renamed',
      },
    });
    return NextResponse.json({
      ok: true,
      action: 'marked_error',
      path: doc.filePath,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to refresh document path' },
      { status: 500 }
    );
  }
}
