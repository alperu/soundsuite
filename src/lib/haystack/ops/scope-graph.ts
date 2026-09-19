/**
 * `ssScopeGraph` — the case structure, summary by default, drilled by case.
 *
 * The canvas payload is a few hundred KB because it needs the whole structure
 * to compute cascade selection. A model does not; it needs counts to decide
 * whether to look further, then one case's filings. Meta carries the counts,
 * rows page (plan §8, "the scope graph cannot be a passthrough").
 */
import { loadScopeCases, type ScopeCaseData } from '@/lib/scope/scope-graph-data';
import { countDefiningSlotEmpty } from '@/lib/scope/worklist';
import { bareId, clampLimit, offsetOf, pageOf, OpError, type OpContext, type OpResult } from './types';

export interface ScopeGraphParams {
  caseId?: string;
  limit?: number;
  offset?: number;
}

function summarise(c: ScopeCaseData, unconnected: number) {
  const byKind: Record<string, number> = {};
  let docs = c.unfiledDocCount;
  let indexed = c.unfiledIndexedCount;
  let withoutEntity = 0;
  for (const f of c.filings) {
    byKind[f.primaryKind] = (byKind[f.primaryKind] ?? 0) + 1;
    docs += f.docCount;
    indexed += f.indexedCount;
    if (f.entityKinds.length === 0) withoutEntity += 1;
  }
  return {
    id: c.id,
    name: c.name,
    caseNumber: c.caseNumber,
    path: c.path,
    filings: c.filings.length,
    filingsWithoutEntityRow: withoutEntity,
    unconnected,
    documents: docs,
    indexed,
    unfiledDocuments: c.unfiledDocCount,
    unfiledIndexed: c.unfiledIndexedCount,
    byKind,
  };
}

export async function ssScopeGraph(ctx: OpContext, params: ScopeGraphParams): Promise<OpResult> {
  const limit = clampLimit(params.limit, 200, 1000);
  const offset = offsetOf(params.offset);

  if (!params.caseId) {
    const cases = await loadScopeCases(ctx.prisma);
    const unconnected = countDefiningSlotEmpty(cases);
    const rows = cases.map((c) => summarise(c, unconnected.get(c.id) ?? 0));
    const totals = rows.reduce(
      (t, r) => ({
        filings: t.filings + r.filings,
        documents: t.documents + r.documents,
        indexed: t.indexed + r.indexed,
        unconnected: t.unconnected + r.unconnected,
      }),
      { filings: 0, documents: 0, indexed: 0, unconnected: 0 },
    );
    return {
      meta: { mode: 'summary', cases: rows.length, ...totals, limit, offset },
      rows: pageOf(rows, offset, limit),
    };
  }

  const caseId = bareId(params.caseId, 'caseId');
  const [c] = await loadScopeCases(ctx.prisma, { caseId });
  if (!c) throw new OpError('NOT_FOUND', `case not found: ${caseId}`);
  const unconnected = countDefiningSlotEmpty([c]).get(c.id) ?? 0;
  const summary = summarise(c, unconnected);

  const rows = c.filings.map((f) => ({
    id: f.id,
    label: f.label,
    filingType: f.filingType,
    primaryKind: f.primaryKind,
    entityKinds: f.entityKinds,
    filingDate: f.filingDate,
    docCount: f.docCount,
    indexedCount: f.indexedCount,
    refs: f.refs,
    documentIds: f.documents.map((d) => d.id),
  }));

  return {
    meta: { mode: 'case', ...summary, limit, offset },
    rows: pageOf(rows, offset, limit),
  };
}
