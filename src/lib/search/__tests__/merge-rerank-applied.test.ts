/** @jest-environment node */
/**
 * `deduplicateAndMerge` must report whether the cross-encoder ran.
 *
 * This is the consumer half of docs/tasks/22 item 3. `gather-evidence.ts`
 * previously decided whether to attach a `rerankScore` to every evidence item
 * from `stats.rerankPool > 0` — which is true whenever *anything* was
 * retrieved, so it labelled rows the cross-encoder had never seen. It now
 * reads `stats.rerankApplied`, which only these stats can supply.
 *
 * Synthetic fixtures only (CLAUDE.md § Privacy).
 */

const rerankMock = jest.fn();

jest.mock('../reranker', () => ({
  rerank: (...args: unknown[]) => rerankMock(...args),
}));
jest.mock('@/lib/db/config', () => ({ getConfig: jest.fn().mockResolvedValue({ rerankPoolSize: 150 }) }));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import { deduplicateAndMerge } from '../deep-search';

/** One sub-query result carrying two distinct synthetic chunks. */
const subQueryResults = [
  {
    subQuery: 'mediation',
    ms: 1,
    sources: [
      { document: 'motion.pdf', page: 1, text: 'first chunk', score: 0.9, matchedSubQueries: ['mediation'] },
      { document: 'motion.pdf', page: 2, text: 'second chunk', score: 0.8, matchedSubQueries: ['mediation'] },
    ],
  },
] as any;

describe('deduplicateAndMerge reports rerankApplied', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reports rerankApplied:true when the cross-encoder scored the pool', async () => {
    rerankMock.mockImplementation(async (_q, results: any[], _topN, _w, opts) => {
      opts?.onOutcome?.({ applied: true, model: 'test-reranker', poolIn: results.length, poolOut: results.length });
      return results;
    });

    const { stats } = await deduplicateAndMerge(subQueryResults, 'mediation');
    expect(stats.rerankApplied).toBe(true);
    expect(stats.rerankSkipReason).toBeUndefined();
  });

  it('reports rerankApplied:false with a reason when the reranker degraded', async () => {
    rerankMock.mockImplementation(async (_q, results: any[], _topN, _w, opts) => {
      opts?.onOutcome?.({
        applied: false,
        reason: 'degraded',
        message: 'reranker unavailable',
        poolIn: results.length,
        poolOut: results.length,
      });
      return results;
    });

    const { stats } = await deduplicateAndMerge(subQueryResults, 'mediation');
    expect(stats.rerankApplied).toBe(false);
    expect(stats.rerankSkipReason).toBe('degraded');

    // The defect this closes: the old proxy said "reranked" here, because it
    // only ever asked whether anything had been retrieved.
    expect(stats.rerankPool).toBeGreaterThan(0);
    expect(stats.rerankPool > 0).not.toBe(stats.rerankApplied);
  });

  it('does not claim a rerank when there was nothing to merge', async () => {
    const { stats } = await deduplicateAndMerge([{ subQuery: 'q', ms: 1, sources: [] }] as any, 'q');
    // rerank() is never called on an empty pool, so nothing can have applied.
    expect(rerankMock).not.toHaveBeenCalled();
    expect(stats.rerankApplied).toBe(false);
  });
});
