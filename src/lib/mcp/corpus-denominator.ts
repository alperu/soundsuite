/**
 * The denominator that makes "proven" honest (task 23 items 5–6, REPORT-v12 §2a).
 *
 * `scan_for_pattern` can report an absence as proven. That claim is true *of the
 * index* and says nothing about the corpus. Measured 2026-09-08: 96 of 864
 * documents are indexed (11.1%), and per-case coverage ranges from 44.4% down to
 * 2.3% — so an operator scoped to the sparsest case who reads a corpus-wide
 * figure is off by roughly 5x. The denominator therefore has to be *scoped*:
 * this module resolves it for exactly the cases a scan actually covered.
 *
 * One source, deliberately. Task 24 will surface the same numbers in a
 * structured `completeness` object, and the report's requirement is that the
 * prose and the field agree. Two independent derivations would drift, and a
 * caller comparing them would trust the wrong one.
 *
 * ## The wording rule this module exists to enforce
 *
 * The word "proven" NEVER appears without its subject. `"the absence is proven"`
 * is banned outright; the sentence always names what the absence was proven
 * *from*. A coverage threshold was considered and rejected in principle: an
 * absence is proven of the corpus only at complete coverage, so any threshold
 * below 1.0 creates a cliff where the wording turns confident while the claim is
 * still false. The clause below has the same shape at 11% and at 100% — only the
 * numbers move, and at full coverage it reads as a corpus-wide proof on its own.
 */

import type { ToolExecutionContext } from './tool-types';

const CHUNKS_TABLE = 'chunks';

/** Denominators are stable over a scan's paging window; re-reading per page is waste. */
const CACHE_TTL_MS = 60_000;

export interface CorpusDenominator {
  documentsIndexed: number;
  documentsTotal: number;
  /** Indexed chunks in scope. `null` when the vector table could not be read. */
  indexedChunks: number | null;
  /** documentsIndexed / documentsTotal, 3 dp. `null` when the scope has no documents. */
  coverage: number | null;
  scope: 'corpus' | 'case' | 'cases';
  /** When these numbers were read. They are cached briefly, so this is not "now". */
  asOf: string;
}

interface CacheEntry {
  value: CorpusDenominator;
  expires: number;
}

const cache = new Map<string, CacheEntry>();

/** Exposed for tests — the cache is process-wide and would otherwise leak between cases. */
export function clearCorpusDenominatorCache(): void {
  cache.clear();
}

function scopeKey(caseIds: string[] | undefined): string {
  if (!caseIds || caseIds.length === 0) return 'corpus';
  return [...caseIds].sort().join(',');
}

function sqlList(caseIds: string[]): string {
  return caseIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ');
}

/**
 * Documents indexed vs present, and indexed chunks, for the scope a scan covered.
 *
 * Never throws: a caller that cannot get a denominator must still be able to
 * answer, and the clause builder below degrades to wording that makes the
 * missing denominator explicit rather than omitting it silently.
 */
export async function getCorpusDenominator(
  context: ToolExecutionContext,
  caseIds?: string[],
): Promise<CorpusDenominator | null> {
  const key = scopeKey(caseIds);
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  try {
    const where = caseIds && caseIds.length > 0 ? { caseId: { in: caseIds } } : {};

    // Grouped by observed status, never an assumed list. `Document.status` is a
    // bare String with no enum, and the live corpus uses `DISCOVERED` — which is
    // absent from the four conventional values. Counting only the four would
    // drop 768 of 864 documents from the denominator.
    const groups: any[] = await context.database.document.groupBy({
      by: ['status'],
      _count: { _all: true },
      ...(caseIds && caseIds.length > 0 ? { where } : {}),
    } as any);

    let documentsTotal = 0;
    let documentsIndexed = 0;
    for (const g of groups) {
      const n = g._count?._all ?? 0;
      documentsTotal += n;
      if (String(g.status) === 'INDEXED') documentsIndexed += n;
    }

    const value: CorpusDenominator = {
      documentsIndexed,
      documentsTotal,
      indexedChunks: await countChunks(context, caseIds),
      coverage: documentsTotal ? Math.round((documentsIndexed / documentsTotal) * 1000) / 1000 : null,
      scope: !caseIds || caseIds.length === 0 ? 'corpus' : caseIds.length === 1 ? 'case' : 'cases',
      asOf: new Date().toISOString(),
    };

    cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
    return value;
  } catch (err) {
    context.logger?.warn?.('corpus denominator unavailable', {
      reason: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function countChunks(
  context: ToolExecutionContext,
  caseIds?: string[],
): Promise<number | null> {
  try {
    const lancedb = await import('@lancedb/lancedb');
    const conn = await lancedb.connect(process.env.LANCEDB_PATH || './data/lancedb');
    const table = await conn.openTable(CHUNKS_TABLE);

    const total =
      caseIds && caseIds.length > 0
        ? await table.countRows(`case_id IN (${sqlList(caseIds)})`)
        : await table.countRows();

    // A zero chunk count where documents are indexed is a contradiction between
    // two stores, not a measurement. Reporting it would put a zero denominator
    // into a sentence a reader is meant to rely on. See corpus-status.ts.
    return total === 0 ? null : total;
  } catch (err) {
    context.logger?.warn?.('corpus denominator could not count chunks', {
      reason: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * The clause that replaces `"the absence is proven, not merely unreached"`.
 *
 * Always names the subject. Shapes, in order of how much is known:
 *
 *  - full coverage  → "proven absent from all 35,890 indexed chunks, spanning all 54 documents in this case"
 *  - partial        → "proven absent from the 380 indexed chunks of this case, spanning 6 of 258 documents (2.3% indexed)"
 *  - chunks unknown → "proven absent from the indexed chunks of 6 of 258 documents (2.3% indexed)"
 *  - nothing known  → "proven absent from the index that was searched, whose coverage of the corpus could not be determined"
 *
 * The last shape is deliberately awkward: a denominator that could not be read
 * should read as a gap, not as an unqualified proof.
 */
export function provenAbsenceClause(den: CorpusDenominator | null): string {
  if (!den || den.documentsTotal === 0) {
    return (
      'proven absent from the index that was searched, whose coverage of the corpus ' +
      'could not be determined'
    );
  }

  const noun =
    den.scope === 'corpus' ? 'the corpus' : den.scope === 'case' ? 'this case' : 'these cases';
  const docs = den.documentsTotal.toLocaleString('en-US');
  const idx = den.documentsIndexed.toLocaleString('en-US');
  const chunks = den.indexedChunks?.toLocaleString('en-US');
  const complete = den.documentsIndexed === den.documentsTotal;

  if (complete) {
    // Reads as a corpus-wide proof on its own, with no rule firing.
    return chunks
      ? `proven absent from all ${chunks} indexed chunks, spanning all ${docs} documents in ${noun}`
      : `proven absent from the index, which covers all ${docs} documents in ${noun}`;
  }

  const pct = den.coverage === null ? null : `${(den.coverage * 100).toFixed(1)}% indexed`;
  const tail = `spanning ${idx} of ${docs} documents${pct ? ` (${pct})` : ''}`;

  return chunks
    ? `proven absent from the ${chunks} indexed chunks of ${noun}, ${tail}`
    : `proven absent from the indexed chunks of ${noun}, ${tail}`;
}
