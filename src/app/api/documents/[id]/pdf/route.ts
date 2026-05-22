import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * GET /api/documents/[id]/pdf — Stream the PDF file from disk.
 * Returns the raw PDF bytes with appropriate content headers.
 *
 * If the stored Document.filePath does not exist on disk, attempt a
 * defensive resolution against the parent Case.path (handles the case
 * where Case.path was edited but Document.filePath was never migrated).
 * On a successful resolution, silently update Document.filePath.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const doc = await prisma.document.findUnique({
      where: { id },
      select: {
        id: true,
        filePath: true,
        fileName: true,
        hash: true,
        caseId: true,
      },
    });

    if (!doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }

    const storedPath = doc.filePath;
    const tried: string[] = [storedPath];
    let resolvedPath: string | null = fs.existsSync(storedPath) ? storedPath : null;

    if (!resolvedPath) {
      const fallback = await resolveFallbackPath(doc, tried);
      if (fallback) {
        resolvedPath = fallback;
        // Silently migrate the row so subsequent requests are O(1).
        try {
          await prisma.document.update({
            where: { id: doc.id },
            data: { filePath: fallback },
          });
        } catch {
          // Unique-constraint collision — leave row alone, still serve file.
        }
      }
    }

    if (!resolvedPath) {
      return NextResponse.json(
        {
          error: 'document_file_not_found',
          tried,
          hint: 'Document.filePath does not exist on disk and could not be resolved under the parent Case.path. Verify the case path or re-ingest the file.',
        },
        { status: 404 },
      );
    }

    const stat = fs.statSync(resolvedPath);
    const fileBuffer = fs.readFileSync(resolvedPath);

    return new NextResponse(new Uint8Array(fileBuffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Length': stat.size.toString(),
        'Content-Disposition': `inline; filename="${encodeURIComponent(doc.fileName)}"`,
        'Cache-Control': 'private, max-age=3600',
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to serve PDF' },
      { status: 500 }
    );
  }
}

/**
 * Try to locate the file under the current Case.path. Strategy:
 *  1. Case.path + basename(filePath)
 *  2. Bounded recursive walk under Case.path, matching basename then
 *     (if doc has a hash) verifying SHA-256.
 * Records every path attempted in `tried`.
 */
async function resolveFallbackPath(
  doc: { id: string; filePath: string; hash: string | null; caseId: string | null },
  tried: string[],
): Promise<string | null> {
  if (!doc.caseId) return null;
  const c = await prisma.case.findUnique({
    where: { id: doc.caseId },
    select: { path: true },
  });
  if (!c?.path) return null;
  const casePath = c.path.replace(/\/+$/, '');
  const basename = path.basename(doc.filePath);

  // Cheap attempt: same basename directly under casePath.
  const direct = path.join(casePath, basename);
  if (!tried.includes(direct)) tried.push(direct);
  if (fs.existsSync(direct)) {
    if (!doc.hash || (await hashFile(direct)) === doc.hash) return direct;
  }

  // Walk the case directory looking for a matching basename. Bounded so
  // a giant directory tree doesn't melt the request.
  const MAX_VISITED = 5000;
  const MAX_DEPTH = 8;
  const matches: string[] = [];
  let visited = 0;
  const stack: Array<{ dir: string; depth: number }> = [{ dir: casePath, depth: 0 }];
  while (stack.length && visited < MAX_VISITED) {
    const { dir, depth } = stack.pop()!;
    let entries: import('fs').Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      visited++;
      if (visited >= MAX_VISITED) break;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (depth < MAX_DEPTH) stack.push({ dir: full, depth: depth + 1 });
      } else if (ent.isFile() && ent.name === basename) {
        matches.push(full);
      }
    }
  }

  if (matches.length === 1) {
    tried.push(matches[0]);
    if (!doc.hash || (await hashFile(matches[0])) === doc.hash) return matches[0];
    return null;
  }
  if (matches.length > 1 && doc.hash) {
    // Multiple basename matches — disambiguate by hash.
    for (const m of matches) {
      tried.push(m);
      if ((await hashFile(m)) === doc.hash) return m;
    }
  } else if (matches.length > 1) {
    for (const m of matches) tried.push(m);
  }
  return null;
}

async function hashFile(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const stream = fs.createReadStream(p);
    stream.on('data', (chunk) => h.update(chunk));
    stream.on('end', () => resolve(h.digest('hex')));
    stream.on('error', reject);
  });
}
