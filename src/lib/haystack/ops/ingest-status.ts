/**
 * `ssIngestStatus` — where every document stands, per case.
 *
 * `DISCOVERED` is the bucket nobody expects (plan §3.3): the watcher creates
 * rows there and nothing promotes them. The op names it in every row so a
 * reader cannot mistake "89% discovered" for "89% ingested".
 */
import { bareId, clampLimit, offsetOf, pageOf, OpError, type OpContext, type OpResult } from './types';

export const DOC_STATUSES = ['DISCOVERED', 'QUEUED', 'PROCESSING', 'INDEXED', 'ERROR'] as const;
export type DocStatus = (typeof DOC_STATUSES)[number];

export interface IngestStatusParams {
  caseId?: string;
  limit?: number;
  offset?: number;
}

export interface CaseIngestCounts {
  caseId: string;
  name: string;
  caseNumber: string | null;
  total: number;
  discovered: number;
  queued: number;
  processing: number;
  indexed: number;
  errored: number;
  /** INDEXED rows carrying a parserVersion — structured parse ran. */
  structured: number;
  /** INDEXED rows without one — ingested before structured parsing existed. */
  legacyIndexed: number;
  other: number;
}

export async function ingestCountsByCase(
  prisma: OpContext['prisma'],
  caseId?: string,
): Promise<CaseIngestCounts[]> {
  const cases = await prisma.case.findMany({
    where: caseId ? { id: caseId } : {},
    select: { id: true, name: true, caseNumber: true },
    orderBy: { name: 'asc' },
  });
  if (cases.length === 0) return [];

  const where = caseId ? { caseId } : {};
  const [byStatus, structured] = await Promise.all([
    prisma.document.groupBy({ by: ['caseId', 'status'], where, _count: { _all: true } }),
    prisma.document.groupBy({
      by: ['caseId'],
      where: { ...where, status: 'INDEXED', parserVersion: { not: null } },
      _count: { _all: true },
    }),
  ]);

  const structuredByCase = new Map(structured.map((g) => [g.caseId, g._count._all]));
  const out = new Map<string, CaseIngestCounts>();
  for (const c of cases) {
    out.set(c.id, {
      caseId: c.id, name: c.name, caseNumber: c.caseNumber ?? null,
      total: 0, discovered: 0, queued: 0, processing: 0, indexed: 0, errored: 0,
      structured: structuredByCase.get(c.id) ?? 0, legacyIndexed: 0, other: 0,
    });
  }
  for (const g of byStatus) {
    const row = out.get(g.caseId);
    if (!row) continue;
    const n = g._count._all;
    row.total += n;
    switch (g.status) {
      case 'DISCOVERED': row.discovered += n; break;
      case 'QUEUED': row.queued += n; break;
      case 'PROCESSING': row.processing += n; break;
      case 'INDEXED': row.indexed += n; break;
      case 'ERROR': row.errored += n; break;
      default: row.other += n;
    }
  }
  for (const row of out.values()) row.legacyIndexed = Math.max(0, row.indexed - row.structured);
  return [...out.values()];
}

export async function ssIngestStatus(ctx: OpContext, params: IngestStatusParams): Promise<OpResult> {
  const limit = clampLimit(params.limit, 100, 1000);
  const offset = offsetOf(params.offset);
  const caseId = params.caseId ? bareId(params.caseId, 'caseId') : undefined;

  const counts = await ingestCountsByCase(ctx.prisma, caseId);
  if (caseId && counts.length === 0) throw new OpError('NOT_FOUND', `case not found: ${caseId}`);

  const totals = counts.reduce(
    (t, c) => {
      for (const k of ['total', 'discovered', 'queued', 'processing', 'indexed', 'errored', 'structured', 'legacyIndexed'] as const) {
        t[k] += c[k];
      }
      return t;
    },
    { total: 0, discovered: 0, queued: 0, processing: 0, indexed: 0, errored: 0, structured: 0, legacyIndexed: 0 },
  );

  if (!caseId) {
    return {
      meta: { mode: 'corpus', cases: counts.length, ...totals, limit, offset, statusVocabulary: [...DOC_STATUSES] },
      rows: pageOf(counts, offset, limit),
    };
  }

  // One case: the counts go in meta, the errored documents are the rows —
  // they are the ones a caller can act on.
  const errored = await ctx.prisma.document.findMany({
    where: { caseId, status: 'ERROR' },
    select: { id: true, fileName: true, filePath: true, filingId: true, errorMessage: true, updatedAt: true },
    orderBy: { updatedAt: 'asc' },
  });
  return {
    meta: { mode: 'case', ...counts[0], limit, offset, rowsAre: 'errored documents', statusVocabulary: [...DOC_STATUSES] },
    rows: pageOf(errored, offset, limit).map((d) => ({
      id: d.id,
      fileName: d.fileName,
      filePath: d.filePath,
      filingId: d.filingId,
      errorMessage: d.errorMessage,
      erroredAt: d.updatedAt.toISOString(),
    })),
  };
}
