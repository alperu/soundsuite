// Retrieve-phase instrumentation (report v4, N-8): every sub-query dispatch is
// timed so the next measured run shows whether 11 s/sub-query is fan-out cost
// or downstream queueing.

import { TextEncoder as NodeTextEncoder, TextDecoder as NodeTextDecoder } from 'util';
if (typeof (global as any).TextEncoder === 'undefined') (global as any).TextEncoder = NodeTextEncoder;
if (typeof (global as any).TextDecoder === 'undefined') (global as any).TextDecoder = NodeTextDecoder;

jest.mock('../../mcp/tools/ai-helper', () => ({
  callLLM: jest.fn(),
  callLLMJson: jest.fn(),
  buildContext: jest.fn(),
  getAvailableProvider: jest.fn(),
}));
jest.mock('../../ai/ai-provider', () => ({ streamAI: jest.fn() }));
jest.mock('../reranker', () => ({ rerank: jest.fn(), RerankableResult: class {} }));

import { executeParallelSearches, summariseSubQueryTimings } from '../deep-search';

describe('summariseSubQueryTimings', () => {
  it('reports count, extremes and the summed dispatch time, ignoring untimed rows', () => {
    const t = summariseSubQueryTimings([
      { subQuery: 'scheduling order', sources: [], ms: 400 },
      { subQuery: 'expert designation', sources: [{} as never], ms: 1_200 },
      { subQuery: '[pattern search]', sources: [] },
    ]);
    expect(t).toEqual({
      count: 2,
      slowestMs: 1_200,
      fastestMs: 400,
      totalMs: 1_600,
      perSubQuery: [
        { subQuery: 'scheduling order', ms: 400, sources: 0 },
        { subQuery: 'expert designation', ms: 1_200, sources: 1 },
      ],
    });
  });

  it('is empty-safe', () => {
    expect(summariseSubQueryTimings([])).toMatchObject({ count: 0, slowestMs: 0, totalMs: 0 });
  });
});

describe('executeParallelSearches', () => {
  const registry = {
    execute: jest.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { success: true, data: { results: [{ text: 'synthetic excerpt', document: 'motion.pdf', page: 1, score: 0.7 }] } };
    }),
  };

  it('stamps ms on every dispatch and fans out in parallel', async () => {
    const wall = Date.now();
    const results = await executeParallelSearches(
      ['sub one', 'sub two', 'sub three'],
      undefined,
      registry as never,
    );
    const elapsed = Date.now() - wall;
    const t = summariseSubQueryTimings(results);
    expect(t.count).toBe(3);
    expect(t.slowestMs).toBeGreaterThan(0);
    // Summed dispatch time exceeding the wall clock is what "parallel" means.
    expect(t.totalMs).toBeGreaterThanOrEqual(elapsed);
  });

  it('times a failed dispatch too', async () => {
    const failing = { execute: jest.fn().mockResolvedValue({ success: false, error: 'tool exploded' }) };
    const [only] = await executeParallelSearches(['sub one'], undefined, failing as never);
    expect(only.sources).toEqual([]);
    expect(typeof only.ms).toBe('number');
  });
});
