import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * POST /api/cases/[id]/fix-paths
 *
 * One-shot rebase of every Document.filePath in this case to match files
 * actually present under Case.path. Used when the path on disk has shifted
 * (rename, trim, move) and the per-document defensive walk in /pdf is too
 * slow to retry document-by-document.
 *
 * Strategy: index the case directory once into basename → fullPath[], then
 * for each document where Document.filePath does not exist on disk, try the
 * indexed basename. Hash-verify when Document.hash is set.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const c = await (prisma as any).case.findUnique({
      where: { id },
      select: { id: true, path: true },
    });
    if (!c) return NextResponse.json({ error: 'case_not_found' }, { status: 404 });
    if (!c.path) return NextResponse.json({ error: 'case_path_empty' }, { status: 400 });
    if (!fs.existsSync(c.path)) {
      return NextResponse.json(
        { error: 'case_path_missing_on_disk', path: c.path },
        { status: 400 },
      );
    }

    const basenameIndex = await indexCaseDirectory(c.path);

    const docs = await (prisma as any).document.findMany({
      where: { caseId: c.id },
      select: { id: true, filePath: true, fileName: true, hash: true },
    });

    let updated = 0;
    let alreadyOk = 0;
    let notFound = 0;
    let multipleAmbiguous = 0;
    const examples: { id: string; from: string; to: string }[] = [];

    for (const d of docs) {
      if (fs.existsSync(d.filePath)) {
        alreadyOk++;
        continue;
      }
      const base = path.basename(d.filePath);
      const candidates = basenameIndex.get(base) || [];
      let target: string | null = null;
      if (candidates.length === 1) {
        if (!d.hash || (await hashFile(candidates[0])) === d.hash) {
          target = candidates[0];
        }
      } else if (candidates.length > 1) {
        if (d.hash) {
          for (const cand of candidates) {
            if ((await hashFile(cand)) === d.hash) {
              target = cand;
              break;
            }
          }
          if (!target) multipleAmbiguous++;
        } else {
          multipleAmbiguous++;
        }
      }
      if (target) {
        await (prisma as any).document.update({
          where: { id: d.id },
          data: { filePath: target },
        });
        if (examples.length < 5) examples.push({ id: d.id, from: d.filePath, to: target });
        updated++;
      } else if (candidates.length === 0) {
        notFound++;
      }
    }

    return NextResponse.json({
      ok: true,
      casePath: c.path,
      totals: {
        scanned: docs.length,
        alreadyOk,
        updated,
        notFound,
        multipleAmbiguous,
        indexedBasenames: basenameIndex.size,
      },
      examples,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'fix_paths_failed' },
      { status: 500 },
    );
  }
}

const MAX_VISITED = 50000;
const MAX_DEPTH = 12;

async function indexCaseDirectory(root: string): Promise<Map<string, string[]>> {
  const index = new Map<string, string[]>();
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root.replace(/\/+$/, ''), depth: 0 }];
  let visited = 0;
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
      if (ent.name.startsWith('.')) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (depth < MAX_DEPTH) stack.push({ dir: full, depth: depth + 1 });
      } else if (ent.isFile()) {
        const list = index.get(ent.name);
        if (list) list.push(full);
        else index.set(ent.name, [full]);
      }
    }
  }
  return index;
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
