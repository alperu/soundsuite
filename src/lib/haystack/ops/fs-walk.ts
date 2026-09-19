/**
 * Folder walking and hashing shared by `ssFolderSurvey` and `ssAutoIngestPlan`.
 * Same shape as the walk in `api/cases/[id]/rescan`: bounded depth, PDFs only,
 * hidden entries skipped, streamed SHA-256 (the watcher's dedup key).
 */
import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import fs from 'fs/promises';
import path from 'path';

export const WALK_MAX_DEPTH = 8;

export interface WalkedFile {
  path: string;
  name: string;
  /** Directory relative to the walk root; '' for the root itself. */
  relDir: string;
  size: number;
  mtime: string;
}

export async function assertDirectory(p: string): Promise<string> {
  const trimmed = (p ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('path is required');
  let stat;
  try {
    stat = await fs.stat(trimmed);
  } catch {
    throw new Error(`folder does not exist: ${trimmed}`);
  }
  if (!stat.isDirectory()) throw new Error(`path is not a directory: ${trimmed}`);
  return trimmed;
}

export async function walkPdfs(root: string, maxDepth = WALK_MAX_DEPTH): Promise<WalkedFile[]> {
  const out: WalkedFile[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth < 0) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth - 1);
        continue;
      }
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.pdf') continue;
      try {
        const stat = await fs.stat(full);
        out.push({
          path: full,
          name: entry.name,
          relDir: path.relative(root, dir),
          size: stat.size,
          mtime: stat.mtime.toISOString(),
        });
      } catch {
        /* vanished between readdir and stat — not ours to report */
      }
    }
  };
  await walk(root, maxDepth);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/** `/a/b` contains `/a/b/c` but not `/a/bc`. */
export function isUnder(parent: string, child: string): boolean {
  const p = parent.replace(/\/+$/, '');
  return child === p || child.startsWith(p + path.sep);
}
