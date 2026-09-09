/** @jest-environment node */
/**
 * `rerank()` must declare whether the cross-encoder actually ran.
 *
 * Every one of its failure paths returns the input array (docs/tasks/22 §3),
 * so first-stage retrieval order is indistinguishable in shape from a
 * cross-encoder ranking. `stats.rerankPool > 0`, the flag previously used as a
 * proxy, only means "at least one source was retrieved". The `onOutcome`
 * channel is the only thing that settles it, so these tests pin every exit.
 *
 * Synthetic fixtures only (CLAUDE.md § Privacy).
 */

const getConfig = jest.fn();

jest.mock('@/lib/db/config', () => ({ getConfig: () => getConfig() }));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));
jest.mock('../reranker-lifecycle', () => ({
  rerankerLifecycle: {
    setEnabled: jest.fn(),
    setIdleTimeout: jest.fn(),
    ensureRunning: jest.fn().mockResolvedValue(true),
    markRequestDone: jest.fn(),
  },
}));

import type { RerankOutcome } from '../reranker';

type Row = { text: string; score: number };
const rows = (): Row[] => [
  { text: 'first chunk', score: 0.9 },
  { text: 'second chunk', score: 0.8 },
];

const ENABLED = {
  rerankEnabled: true,
  rerankProvider: 'vllm',
  rerankHost: 'http://rerank.invalid:8099',
  rerankModel: 'test-reranker',
  rerankTopN: 10,
  rerankScoreValidation: false,
  rerankInteractiveTimeoutMs: 500,
  rerankTimeoutMs: 500,
  rerankAutoManage: false,
  rerankIdleTimeoutMin: 5,
};

/**
 * `reranker.ts` caches the config in a module-level variable with a TTL, so
 * every case needs a fresh module instance to see its own config.
 */
async function loadRerank() {
  jest.resetModules();
  return (await import('../reranker')).rerank;
}

/** Run `rerank` and capture whatever it declares about itself. */
async function run(cfg: Record<string, unknown>, results: Row[] = rows(), topN = 10) {
  getConfig.mockResolvedValue(cfg);
  const rerank = await loadRerank();
  let outcome: RerankOutcome | undefined;
  const items = await rerank('a query', results, topN, undefined, {
    onOutcome: (o) => {
      outcome = o;
    },
  });
  return { items, outcome: outcome! };
}

describe('rerank() reports its outcome', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reports applied:false with reason "empty-results" and ranks nothing', async () => {
    const { items, outcome } = await run(ENABLED, []);
    expect(items).toEqual([]);
    expect(outcome).toMatchObject({ applied: false, reason: 'empty-results', poolIn: 0 });
  });

  it.each([
    ['disabled', { ...ENABLED, rerankEnabled: false }],
    ['provider-none', { ...ENABLED, rerankProvider: 'none' }],
    ['no-host', { ...ENABLED, rerankHost: '' }],
  ])('reports applied:false with reason "%s" and returns first-stage order', async (reason, cfg) => {
    const input = rows();
    const { items, outcome } = await run(cfg, input);

    // The defect this guards: the items are indistinguishable from a rerank.
    expect(items).toEqual(input);
    expect(outcome).toMatchObject({ applied: false, reason, poolIn: 2, poolOut: 2 });
    expect(outcome.message).toBeTruthy();
  });

  it('reports applied:false with reason "degraded" when the host is unreachable', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED')) as any;
    const input = rows();
    const { items, outcome } = await run(ENABLED, input);

    // A refused connection is absorbed per-host inside the candidate loop, so
    // it exits via the all-hosts-failed path (`reranker.ts` "Rerank degraded"),
    // NOT the outer catch. This is docs/tasks/22's acceptance row for "a
    // response with an unreachable rerank host".
    expect(outcome.applied).toBe(false);
    expect(outcome.reason).toBe('degraded');
    expect(outcome.host).toBe(ENABLED.rerankHost);
    // The message must say what the ordering now is, not just that it failed.
    expect(outcome.message).toMatch(/first-stage/i);
    // Graceful degrade is preserved — the caller still gets usable results.
    expect(items).toEqual(input);
  });

  it('reports applied:true with the model that produced the scores', async () => {
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      // Preflight health/warm-up probes precede the rerank POST.
      if (!String(url).includes('/rerank')) {
        return { ok: true, status: 200, json: async () => ({ data: [] }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            { index: 1, relevance_score: 0.99 },
            { index: 0, relevance_score: 0.11 },
          ],
          model: 'test-reranker',
          usage: { total_tokens: 42 },
        }),
      };
    }) as any;

    const { items, outcome } = await run(ENABLED);
    expect(outcome.applied).toBe(true);
    expect(outcome.reason).toBeUndefined();
    expect(outcome.poolIn).toBe(2);
    // A real rerank reorders: the second row now leads.
    expect(items[0].text).toBe('second chunk');
  });

  it('is optional — omitting onOutcome leaves existing call sites unchanged', async () => {
    getConfig.mockResolvedValue({ ...ENABLED, rerankEnabled: false });
    const rerank = await loadRerank();
    const input = rows();
    // deep-search.ts:798 and ai-helper.ts:674 call rerank without the option.
    await expect(rerank('a query', input, 10)).resolves.toEqual(input);
  });
});
