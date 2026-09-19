/**
 * The judgment queue, server-side.
 *
 * Lifted from the pairing workbench (`components/haystack-block-view/
 * pairing-workbench.tsx`), which selected filings whose DEFINING slot is
 * empty — what a response responds to, what an order rules on. That is the
 * queue the ETL loop wants (docs/PLAN-haystack-mcp-agentic-etl.md §9.2), and
 * it is a different question from `GET /api/scope/unconnected`, whose
 * "unconnected" means *no ref at all*: a response that already carries a
 * `motionRef` but no `respondingTo` is connected by that definition and
 * invisible — and it is precisely the row the agent needs to see.
 *
 * Everything below is pure over the scope-graph payload. The link rules and
 * the suggester are imported from the block view because they ARE the
 * authority on what a link may be; only their commit functions touch a
 * browser, and nothing here calls those.
 *
 * Three semantics from the workbench are preserved because each encodes a
 * safety property:
 *   1. only a row WITH a suggestion is a candidate for an apply — a blank row
 *      is a question, and treating it as a write turns "I don't know" into a fact;
 *   2. a blank row says why (`noCandidateReason`) rather than guessing;
 *   3. a motion never enters the queue — `primarySlotFor` returns null for it,
 *      because a motion is the root every other kind points at.
 */
import {
  buildScopeGraph,
  filingKey,
  type FilingBlock,
  type ScopeGraph,
} from '@/components/haystack-block-view/scope-graph';
import { linkVerdicts, primarySlotFor, type RefLinkPlan } from '@/components/haystack-block-view/link-rules';
import { suggestForSlot } from '@/components/haystack-block-view/suggest-links';
import type { ScopeCase } from '@/components/haystack-block-view/types';

export interface WorklistSuggestion {
  /** The filing the link would point at. */
  targetId: string;
  targetLabel: string | null;
  targetKind: string | null;
  /** Short phrases explaining the pick — "same case", "filed 3d later", "shares …". */
  reasons: string[];
  /** Lead over the runner-up. Small means "barely". */
  margin: number;
  /** The exact write a confirm would make — slot, owning kind, id, target. */
  plan: RefLinkPlan;
}

export interface WorklistRow {
  caseId: string;
  filingId: string;
  label: string;
  /** The kind this filing IS — `response`, `reply`, `order`, `notice`, … */
  kind: string;
  /** The defining slot that is empty. */
  slot: string;
  filingDate: string | null;
  /** Whether any entity row exists at this id. False means `ssEntityEnsure` has
   *  not run — a ref write would still materialise the row, but the reader
   *  should know the filing has never been touched. */
  entityMaterialised: boolean;
  suggestion: WorklistSuggestion | null;
  /** Present when `suggestion` is null: why the deterministic suggester declined. */
  noCandidateReason?: string;
  /** How many candidates the link rules allowed at all, before ranking. */
  legalCandidates: number;
}

export interface WorklistSummary {
  total: number;
  suggested: number;
  noCandidate: number;
  byKind: Record<string, number>;
  bySlot: Record<string, number>;
}

/**
 * Why the suggester said nothing. It is worth being specific: "no legal
 * target exists" is a different next step from "two targets tied".
 */
function explainNoCandidate(
  graph: ScopeGraph,
  key: string,
  slot: string,
  legal: number,
): string {
  const source = graph.filingById.get(key.replace(/^filing:/, ''));
  if (legal === 0) return `no filing in this case is a legal target for ${slot}`;
  if (!source?.filingDate) {
    return `${legal} legal target(s), none clearly ahead — this filing carries no date, so chronology cannot break the tie`;
  }
  return `${legal} legal target(s), none clearly ahead — the lead over the runner-up is below the threshold`;
}

/**
 * The selection itself: every filing whose defining slot is empty, with the
 * slot it is missing. The ONE definition of the queue — the browser workbench
 * and the `ssWorklist` op both call this, so they cannot disagree about which
 * filings need a decision.
 */
export function definingSlotEmptyFilings(
  graph: ScopeGraph,
): Array<{ filing: FilingBlock; slot: string }> {
  const out: Array<{ filing: FilingBlock; slot: string }> = [];
  for (const filing of graph.filings) {
    const slot = primarySlotFor(filing.primaryKind);
    if (!slot) continue;
    if (typeof filing.refs?.[slot] === 'string' && filing.refs[slot]) continue;
    out.push({ filing, slot });
  }
  return out;
}

/** Rows for a graph already built. */
export function worklistRowsForGraph(graph: ScopeGraph): WorklistRow[] {
  const rows: WorklistRow[] = [];
  for (const { filing, slot } of definingSlotEmptyFilings(graph)) {
    const key = filingKey(filing.id);
    const verdicts = linkVerdicts(graph, key, { slot, side: 'output' });
    const legal = verdicts.filter((v) => v.ok).length;
    const suggestion = suggestForSlot(graph, key, slot);

    let mapped: WorklistSuggestion | null = null;
    if (suggestion && suggestion.plan.type === 'ref') {
      const target = graph.filingById.get(suggestion.targetKey.replace(/^filing:/, ''));
      mapped = {
        targetId: suggestion.plan.targetId,
        targetLabel: target?.label ?? null,
        targetKind: target?.primaryKind ?? null,
        reasons: suggestion.reasons,
        margin: suggestion.margin,
        plan: suggestion.plan,
      };
    }

    rows.push({
      caseId: filing.caseId,
      filingId: filing.id,
      label: filing.label,
      kind: filing.primaryKind,
      slot,
      filingDate: filing.filingDate,
      entityMaterialised: filing.entityKinds.length > 0,
      suggestion: mapped,
      ...(mapped ? {} : { noCandidateReason: explainNoCandidate(graph, key, slot, legal) }),
      legalCandidates: legal,
    });
  }
  return rows;
}

export interface BuildWorklistOptions {
  /** Keep only rows in this case. The graph is still built over everything
   *  passed in, because a suggestion is only ever same-case anyway. */
  caseId?: string;
  /** Keep only rows the suggester could answer. */
  onlySuggested?: boolean;
}

export function buildWorklist(
  cases: ScopeCase[],
  options: BuildWorklistOptions = {},
): { rows: WorklistRow[]; summary: WorklistSummary } {
  const graph = buildScopeGraph(cases);
  let rows = worklistRowsForGraph(graph);
  if (options.caseId) rows = rows.filter((r) => r.caseId === options.caseId);
  if (options.onlySuggested) rows = rows.filter((r) => r.suggestion);

  const summary: WorklistSummary = {
    total: rows.length,
    suggested: rows.filter((r) => r.suggestion).length,
    noCandidate: rows.filter((r) => !r.suggestion).length,
    byKind: {},
    bySlot: {},
  };
  for (const r of rows) {
    summary.byKind[r.kind] = (summary.byKind[r.kind] ?? 0) + 1;
    summary.bySlot[r.slot] = (summary.bySlot[r.slot] ?? 0) + 1;
  }
  return { rows, summary };
}

/**
 * The count `ssScopeGraph` and `ssReadCase` report as `unconnected`: filings
 * whose defining slot is empty. Named after what it measures, not after the
 * weaker all-refs-empty definition the `/api/scope/unconnected` route uses.
 */
export function countDefiningSlotEmpty(cases: ScopeCase[]): Map<string, number> {
  const graph = buildScopeGraph(cases);
  const out = new Map<string, number>();
  for (const c of cases) out.set(c.id, 0);
  for (const { filing } of definingSlotEmptyFilings(graph)) {
    out.set(filing.caseId, (out.get(filing.caseId) ?? 0) + 1);
  }
  return out;
}
