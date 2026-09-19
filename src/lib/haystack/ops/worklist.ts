/**
 * `ssWorklist` — the judgment queue (plan §9.2). Thin adapter over
 * `@/lib/scope/worklist`; the selection and the suggester live there and are
 * shared with the browser workbench.
 */
import { loadScopeCases } from '@/lib/scope/scope-graph-data';
import { buildWorklist } from '@/lib/scope/worklist';
import { bareId, clampLimit, offsetOf, pageOf, OpError, type OpContext, type OpResult } from './types';

export interface WorklistParams {
  caseId?: string;
  onlySuggested?: boolean;
  limit?: number;
  offset?: number;
}

export async function ssWorklist(ctx: OpContext, params: WorklistParams): Promise<OpResult> {
  const limit = clampLimit(params.limit, 100, 500);
  const offset = offsetOf(params.offset);
  const caseId = params.caseId ? bareId(params.caseId, 'caseId') : undefined;

  // One case's graph is enough: a suggestion is only ever same-case, so
  // loading the rest of the corpus would change nothing but the cost.
  const cases = await loadScopeCases(ctx.prisma, caseId ? { caseId } : {});
  if (caseId && cases.length === 0) throw new OpError('NOT_FOUND', `case not found: ${caseId}`);

  const { rows, summary } = buildWorklist(cases, { caseId, onlySuggested: params.onlySuggested === true });

  return {
    meta: {
      ...summary,
      ...(caseId ? { caseId } : { cases: cases.length }),
      limit,
      offset,
      note:
        'A row with suggestion=null is a question, not a blank to fill. Confirming a suggestion ' +
        'is a separate gated write; nothing here changes the graph.',
    },
    rows: pageOf(rows, offset, limit).map((r) => ({
      caseId: r.caseId,
      filingId: r.filingId,
      label: r.label,
      kind: r.kind,
      slot: r.slot,
      filingDate: r.filingDate,
      entityMaterialised: r.entityMaterialised,
      legalCandidates: r.legalCandidates,
      suggestion: r.suggestion
        ? {
            targetId: r.suggestion.targetId,
            targetLabel: r.suggestion.targetLabel,
            targetKind: r.suggestion.targetKind,
            reasons: r.suggestion.reasons,
            margin: r.suggestion.margin,
            write: { kind: r.suggestion.plan.kind, id: r.suggestion.plan.id, slot: r.suggestion.plan.slot, targetId: r.suggestion.plan.targetId },
          }
        : null,
      ...(r.noCandidateReason ? { noCandidateReason: r.noCandidateReason } : {}),
    })),
  };
}
