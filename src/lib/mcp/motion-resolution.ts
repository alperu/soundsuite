/**
 * Motion resolution for retrieved chunks (REPORT-discovery-tools §5).
 *
 * A chunk maps to a motion by `(filingId, page ∈ [startPage, endPage])`.
 * Shared by `query_case_knowledge` and `scan_for_pattern` so both projections
 * carry the same `motionId` — the seed `query_case_graph` needs, and the
 * reason it showed zero executions before this landed.
 */

import type { ToolExecutionContext } from './tool-types';

export interface MotionRange {
  id: string;
  filingId: string;
  startPage: number;
  endPage: number | null;
}
/**
 * Pick the motion a page belongs to.
 *
 * Motions nest (`parentMotionId`), so a page can fall inside both a parent and
 * a child, and `endPage` is nullable. The rule — stated because this task
 * exists to stop tools silently picking wrong ids:
 *   1. only motions whose range contains the page are candidates;
 *   2. the NARROWEST range wins (the most specific / innermost motion);
 *   3. an open-ended motion (`endPage: null`) is the least specific and ranks
 *      last, never beating a bounded one;
 *   4. ties break on `id` ascending, so the choice is deterministic.
 */
export function pickMotionForPage(motions: MotionRange[], page: number): MotionRange | undefined {
  let best: MotionRange | undefined;
  let bestSpan = Number.POSITIVE_INFINITY;
  for (const m of motions) {
    if (page < m.startPage) continue;
    if (m.endPage !== null && m.endPage !== undefined && page > m.endPage) continue;
    const span =
      m.endPage === null || m.endPage === undefined
        ? Number.POSITIVE_INFINITY
        : m.endPage - m.startPage;
    // `best === undefined` first: two open-ended motions both have span
    // Infinity, so a `span < bestSpan` test alone never accepts either.
    if (best === undefined || span < bestSpan || (span === bestSpan && m.id < best.id)) {
      best = m;
      bestSpan = span;
    }
  }
  return best;
}

/**
 * Stamp `motionId` on every enriched result whose page falls inside a motion.
 * One `motion.findMany` for the whole result set — never one query per item.
 * Best-effort: a failure leaves `motionId` absent rather than failing the query.
 */
export async function attachMotionIds(
  context: ToolExecutionContext,
  results: Array<{ page?: number; documentId?: string; motionId?: string }>,
  docFilingIds: Map<string, string>,
): Promise<void> {
  const filingIds = Array.from(new Set(docFilingIds.values()));
  if (filingIds.length === 0) return;

  let motions: MotionRange[] = [];
  try {
    motions = (await (context.database as any).motion.findMany({
      where: { filingId: { in: filingIds } },
      select: { id: true, filingId: true, startPage: true, endPage: true },
    })) as MotionRange[];
  } catch {
    return; // Motion table absent or unreadable — ship results without motionId.
  }
  if (!motions?.length) return;

  const byFiling = new Map<string, MotionRange[]>();
  for (const m of motions) {
    const bucket = byFiling.get(m.filingId);
    if (bucket) bucket.push(m);
    else byFiling.set(m.filingId, [m]);
  }

  for (const r of results) {
    if (typeof r.page !== 'number' || !r.documentId) continue;
    const filingId = docFilingIds.get(r.documentId);
    if (!filingId) continue;
    const hit = pickMotionForPage(byFiling.get(filingId) ?? [], r.page);
    if (hit) r.motionId = hit.id;
  }
}

