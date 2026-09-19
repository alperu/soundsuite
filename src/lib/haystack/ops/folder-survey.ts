/**
 * `ssFolderSurvey` — files on disk vs Document rows, for one case.
 *
 * Reconciliation order is path first, hash second: a path the database
 * already knows needs no I/O beyond the stat; only unknown paths are hashed,
 * and a hash hit means the watcher's heal path applies (the file moved). This
 * is the op the plan says to run before costing anything else (§11): it is
 * where "768 documents were discovered and never processed" becomes visible.
 */
import { bareId, clampLimit, offsetOf, pageOf, OpError, type OpContext, type OpResult } from './types';
import { assertDirectory, isUnder, sha256File, walkPdfs } from './fs-walk';

export type Disposition = 'known' | 'moved' | 'new' | 'orphaned' | 'ignored';

export interface FolderSurveyParams {
  caseId: string;
  limit?: number;
  offset?: number;
  disposition?: string;
}

export interface SurveyRow {
  disposition: Disposition;
  path: string;
  name: string;
  relDir: string;
  size: number | null;
  doc: string | null;
  status: string | null;
  filing: string | null;
  /** For `moved`: where the database still thinks the file is. */
  storedPath?: string;
  /** For `moved` / `new`: the hash computed for this survey. */
  hash?: string;
  note?: string;
}

export async function ssFolderSurvey(ctx: OpContext, params: FolderSurveyParams): Promise<OpResult<SurveyRow>> {
  const caseId = bareId(params.caseId, 'caseId');
  const limit = clampLimit(params.limit, 200, 2000);
  const offset = offsetOf(params.offset);
  const filter = params.disposition ? String(params.disposition) : undefined;

  const c = await ctx.prisma.case.findUnique({ where: { id: caseId }, select: { id: true, name: true, path: true } });
  if (!c) throw new OpError('NOT_FOUND', `case not found: ${caseId}`);

  let root: string;
  try {
    root = await assertDirectory(c.path);
  } catch (err) {
    // A registered path that no longer resolves is the finding itself.
    return {
      meta: { case: c.id, dis: c.name, path: c.path, reachable: false, error: (err as Error).message, limit, offset },
      rows: [],
    };
  }

  const [files, docs, allCases] = await Promise.all([
    walkPdfs(root),
    ctx.prisma.document.findMany({
      where: { caseId },
      select: { id: true, filePath: true, fileName: true, hash: true, status: true, filingId: true },
    }),
    ctx.prisma.case.findMany({ select: { id: true, name: true, path: true } }),
  ]);

  // Nested case folders: another Case.path under this one. The watcher
  // attributes a file to the FIRST prefix match, so files under the nested
  // folder may land on either case depending on registration order.
  const nested = allCases
    .filter((other) => other.id !== c.id && isUnder(root, other.path))
    .map((other) => ({ id: other.id, name: other.name, path: other.path }));
  const nestedRoots = nested.map((n) => n.path);

  const docByPath = new Map(docs.map((d) => [d.filePath, d]));
  const onDisk = new Set(files.map((f) => f.path));
  /** Rows whose content turned up at a new path: `moved`, so not `orphaned`. */
  const movedDocIds = new Set<string>();

  const rows: SurveyRow[] = [];
  const counts: Record<Disposition | 'nestedFiles', number> = {
    known: 0, moved: 0, new: 0, orphaned: 0, ignored: 0, nestedFiles: 0,
  };
  const byStatus: Record<string, number> = {};

  // Hash lookups for unknown paths, batched: hash first, then one query.
  const unknown = files.filter((f) => !docByPath.has(f.path));
  const hashes = new Map<string, string>();
  for (const f of unknown) {
    try {
      hashes.set(f.path, await sha256File(f.path));
    } catch {
      /* unreadable — reported as new with a note below */
    }
  }
  const hashList = [...new Set(hashes.values())];
  const [byHash, tombstones] = await Promise.all([
    hashList.length
      ? ctx.prisma.document.findMany({
          where: { hash: { in: hashList } },
          select: { id: true, filePath: true, hash: true, status: true, filingId: true, caseId: true },
        })
      : Promise.resolve([]),
    // IgnoredFile is the operator's "never re-create this" memory.
    (async () => {
      try {
        const rowsIgnored = await (ctx.prisma as any).ignoredFile.findMany({
          where: { OR: [{ filePath: { in: unknown.map((f) => f.path) } }, ...(hashList.length ? [{ hash: { in: hashList } }] : [])] },
          select: { filePath: true, hash: true },
        });
        return rowsIgnored as Array<{ filePath: string; hash: string }>;
      } catch {
        return [] as Array<{ filePath: string; hash: string }>;
      }
    })(),
  ]);
  const docByHash = new Map(byHash.map((d) => [d.hash, d]));
  const ignoredPaths = new Set(tombstones.map((t) => t.filePath));
  const ignoredHashes = new Set(tombstones.map((t) => t.hash));

  for (const f of files) {
    const inNested = nestedRoots.some((n) => isUnder(n, f.path));
    if (inNested) counts.nestedFiles += 1;
    const known = docByPath.get(f.path);
    if (known) {
      counts.known += 1;
      byStatus[known.status] = (byStatus[known.status] ?? 0) + 1;
      rows.push({
        disposition: 'known', path: f.path, name: f.name, relDir: f.relDir, size: f.size,
        doc: known.id, status: known.status, filing: known.filingId,
        ...(inNested ? { note: 'inside a nested case folder' } : {}),
      });
      continue;
    }
    const hash = hashes.get(f.path);
    if (!hash) {
      counts.new += 1;
      rows.push({ disposition: 'new', path: f.path, name: f.name, relDir: f.relDir, size: f.size, doc: null, status: null, filing: null, note: 'could not be read for hashing' });
      continue;
    }
    if (ignoredPaths.has(f.path) || ignoredHashes.has(hash)) {
      counts.ignored += 1;
      rows.push({ disposition: 'ignored', path: f.path, name: f.name, relDir: f.relDir, size: f.size, doc: null, status: null, filing: null, hash, note: 'operator tombstone (IgnoredFile) — the watcher will not re-create it' });
      continue;
    }
    const moved = docByHash.get(hash);
    if (moved) {
      counts.moved += 1;
      movedDocIds.add(moved.id);
      rows.push({
        disposition: 'moved', path: f.path, name: f.name, relDir: f.relDir, size: f.size,
        doc: moved.id, status: moved.status, filing: moved.filingId, storedPath: moved.filePath, hash,
        ...(moved.caseId !== caseId ? { note: `same content is registered under another case (${moved.caseId})` } : {}),
      });
      continue;
    }
    counts.new += 1;
    rows.push({
      disposition: 'new', path: f.path, name: f.name, relDir: f.relDir, size: f.size,
      doc: null, status: null, filing: null, hash,
      ...(inNested ? { note: 'inside a nested case folder — the watcher may attribute it to that case' } : {}),
    });
  }

  for (const d of docs) {
    if (onDisk.has(d.filePath)) continue;
    // Its content was found at a new path: that is the `moved` row above, and
    // the watcher's heal path repoints it. Listing it here too would make one
    // file look like two problems.
    if (movedDocIds.has(d.id)) continue;
    counts.orphaned += 1;
    rows.push({
      disposition: 'orphaned', path: d.filePath, name: d.fileName, relDir: '', size: null,
      doc: d.id, status: d.status, filing: d.filingId,
      note: 'Document row whose file is not on disk under Case.path',
    });
  }

  const filtered = filter ? rows.filter((r) => r.disposition === filter) : rows;

  return {
    meta: {
      case: c.id,
      dis: c.name,
      path: root,
      reachable: true,
      filesOnDisk: files.length,
      documentRows: docs.length,
      ...counts,
      knownByStatus: byStatus,
      nestedCases: nested,
      ...(filter ? { dispositionFilter: filter, matching: filtered.length } : {}),
      limit,
      offset,
    },
    rows: pageOf(filtered, offset, limit),
  };
}
