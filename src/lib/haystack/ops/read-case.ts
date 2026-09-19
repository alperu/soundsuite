/**
 * `ssReadCase` — one case as a grid (plan §6.4 worked example).
 *
 * Meta is the truth for the whole case; rows are the documents, paged. The
 * `unconnected` field is REAL here: it is the defining-slot-empty count from
 * the lifted worklist, not the weaker any-ref definition the old route used.
 */
import { loadScopeCases } from '@/lib/scope/scope-graph-data';
import { countDefiningSlotEmpty } from '@/lib/scope/worklist';
import { ingestCountsByCase, DOC_STATUSES, type DocStatus } from './ingest-status';
import { bareId, clampLimit, offsetOf, OpError, type OpContext, type OpResult } from './types';

export interface ReadCaseParams {
  caseId: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export async function ssReadCase(ctx: OpContext, params: ReadCaseParams): Promise<OpResult> {
  const caseId = bareId(params.caseId, 'caseId');
  const limit = clampLimit(params.limit, 200, 2000);
  const offset = offsetOf(params.offset);
  const status = params.status ? String(params.status).toUpperCase() : undefined;
  if (status && !(DOC_STATUSES as readonly string[]).includes(status)) {
    throw new OpError('INVALID_PARAMS', `status must be one of ${DOC_STATUSES.join(', ')}`);
  }

  const [scope, counts] = await Promise.all([
    loadScopeCases(ctx.prisma, { caseId }),
    ingestCountsByCase(ctx.prisma, caseId),
  ]);
  const c = scope[0];
  if (!c || counts.length === 0) throw new OpError('NOT_FOUND', `case not found: ${caseId}`);

  const filingById = new Map(c.filings.map((f) => [f.id, f]));
  const unconnected = countDefiningSlotEmpty([c]).get(c.id) ?? 0;

  const where = { caseId, ...(status ? { status: status as DocStatus } : {}) };
  const [matching, docs] = await Promise.all([
    ctx.prisma.document.count({ where }),
    ctx.prisma.document.findMany({
      where,
      orderBy: [{ status: 'asc' }, { fileName: 'asc' }],
      skip: offset,
      take: limit,
      select: {
        id: true, fileName: true, filePath: true, status: true, filingId: true,
        parserVersion: true, errorMessage: true, readinessBand: true, pageCount: true,
      },
    }),
  ]);

  const cnt = counts[0];
  return {
    meta: {
      case: c.id,
      dis: c.name,
      caseNumber: c.caseNumber,
      path: c.path,
      filings: c.filings.length,
      filingsWithoutEntityRow: c.filings.filter((f) => f.entityKinds.length === 0).length,
      unconnected,
      documents: cnt.total,
      discovered: cnt.discovered,
      queued: cnt.queued,
      processing: cnt.processing,
      indexed: cnt.indexed,
      errored: cnt.errored,
      structured: cnt.structured,
      legacyIndexed: cnt.legacyIndexed,
      unfiledDocuments: c.unfiledDocCount,
      ...(status ? { statusFilter: status, matching } : {}),
      limit,
      offset,
    },
    rows: docs.map((d) => {
      const filing = d.filingId ? filingById.get(d.filingId) : undefined;
      return {
        doc: d.id,
        dis: d.fileName,
        filePath: d.filePath,
        status: d.status,
        filing: d.filingId,
        filingLabel: filing?.label ?? null,
        kind: filing?.primaryKind ?? null,
        // null here means "ingested before structured parsing", which the
        // status column already distinguishes from "not ingested".
        parserVersion: d.parserVersion,
        pageCount: d.pageCount,
        readinessBand: d.readinessBand,
        errorMessage: d.errorMessage,
      };
    }),
  };
}
