/**
 * Folder totals from file-system sidecars (`folder-status` profile).
 *
 * One row per (sidecar, root, folder path) in the `FolderStat` table of the
 * active profile's database, next to `Case`. A root can map to a local base
 * path (`FS_SIDECAR_ROOTS`); when `<base>/<path>` is a `Case.path`, the row
 * carries that `caseId` so the case views can show the totals.
 */
import path from 'path';

export interface FolderStatRow {
  root: string;
  path: string;
  fileCount: number;
  totalBytes: bigint;
  latestMtimeNs: bigint;
  dirCount: number;
  recFileCount: number;
  recTotalBytes: bigint;
  recLatestMtimeNs: bigint;
  deleted: boolean;
}

/** The part of the Prisma client the store uses (lets tests pass their own client). */
export interface FolderStatDb {
  folderStat: {
    upsert(args: unknown): Promise<unknown>;
    deleteMany(args: unknown): Promise<unknown>;
    findMany(args: unknown): Promise<unknown[]>;
  };
  case?: { findMany(args: unknown): Promise<Array<{ id: string; path: string }>> };
  $transaction?(ops: Promise<unknown>[]): Promise<unknown>;
}

export interface FolderStatStore {
  applyBatch(sidecarId: string, stats: FolderStatRow[]): Promise<void>;
}

/** Root name -> local base path, from `FS_SIDECAR_ROOTS` (JSON object). */
export function rootsFromEnv(env = process.env): Record<string, string> {
  try {
    const v = JSON.parse(env.FS_SIDECAR_ROOTS || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

const n = (b: bigint) => Number(b > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : b);

export class PrismaFolderStatStore implements FolderStatStore {
  constructor(private db: FolderStatDb, private roots: Record<string, string> = {}) {}

  private async caseIds(rows: FolderStatRow[]): Promise<Map<string, string>> {
    const want = new Map<string, string>();
    for (const r of rows) {
      const base = this.roots[r.root];
      if (base && !r.deleted) want.set(path.join(base, r.path), `${r.root}\0${r.path}`);
    }
    const out = new Map<string, string>();
    if (!want.size || !this.db.case) return out;
    const cases = await this.db.case.findMany({ where: { path: { in: [...want.keys()] } }, select: { id: true, path: true } });
    for (const c of cases) {
      const k = want.get(c.path);
      if (k) out.set(k, c.id);
    }
    return out;
  }

  async applyBatch(sidecarId: string, stats: FolderStatRow[]): Promise<void> {
    const cases = await this.caseIds(stats);
    for (const s of stats) {
      if (s.deleted) {
        const under = s.path === '' ? {} : { OR: [{ path: s.path }, { path: { startsWith: `${s.path}/` } }] };
        await this.db.folderStat.deleteMany({ where: { sidecarId, root: s.root, ...under } });
        continue;
      }
      const data = {
        fileCount: n(BigInt(s.fileCount)),
        totalBytes: s.totalBytes,
        latestMtimeNs: s.latestMtimeNs,
        dirCount: n(BigInt(s.dirCount)),
        recFileCount: n(BigInt(s.recFileCount)),
        recTotalBytes: s.recTotalBytes,
        recLatestMtimeNs: s.recLatestMtimeNs,
        caseId: cases.get(`${s.root}\0${s.path}`) ?? null,
      };
      await this.db.folderStat.upsert({
        where: { sidecarId_root_path: { sidecarId, root: s.root, path: s.path } },
        create: { sidecarId, root: s.root, path: s.path, ...data },
        update: data,
      });
    }
  }
}

/** JSON-safe row for the API and UI. */
export interface FolderStatJson {
  sidecarId: string;
  root: string;
  path: string;
  caseId: string | null;
  fileCount: number;
  totalBytes: number;
  latestMtimeMs: number;
  dirCount: number;
  recFileCount: number;
  recTotalBytes: number;
  recLatestMtimeMs: number;
  updatedAt: string;
}

type DbRow = Omit<FolderStatJson, 'totalBytes' | 'recTotalBytes' | 'latestMtimeMs' | 'recLatestMtimeMs' | 'updatedAt'> & {
  totalBytes: bigint;
  recTotalBytes: bigint;
  latestMtimeNs: bigint;
  recLatestMtimeNs: bigint;
  updatedAt: Date;
};

export function toJson(r: DbRow): FolderStatJson {
  const ms = (ns: bigint) => Number(ns / BigInt(1_000_000));
  return {
    sidecarId: r.sidecarId,
    root: r.root,
    path: r.path,
    caseId: r.caseId ?? null,
    fileCount: r.fileCount,
    totalBytes: Number(r.totalBytes),
    latestMtimeMs: ms(r.latestMtimeNs),
    dirCount: r.dirCount,
    recFileCount: r.recFileCount,
    recTotalBytes: Number(r.recTotalBytes),
    recLatestMtimeMs: ms(r.recLatestMtimeNs),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function listFolderStats(
  db: FolderStatDb,
  where: { sidecarId?: string; root?: string; caseId?: string; maxDepth?: number },
  take = 500,
): Promise<FolderStatJson[]> {
  const rows = (await db.folderStat.findMany({
    where: {
      ...(where.sidecarId ? { sidecarId: where.sidecarId } : {}),
      ...(where.root ? { root: where.root } : {}),
      ...(where.caseId ? { caseId: where.caseId } : {}),
    },
    orderBy: [{ sidecarId: 'asc' }, { root: 'asc' }, { path: 'asc' }],
    take: where.maxDepth === undefined ? take : undefined,
  })) as DbRow[];
  const depth = (p: string) => (p === '' ? 0 : p.split('/').length);
  return rows
    .filter((r) => where.maxDepth === undefined || depth(r.path) <= where.maxDepth)
    .slice(0, take)
    .map(toJson);
}
