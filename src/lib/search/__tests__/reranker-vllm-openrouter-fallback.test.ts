/** @jest-environment node */
/**
 * POLICY 1 — reranker: "if no reranker is available locally, use OpenRouter."
 *
 * `rerank()` with `rerankProvider === 'vllm'` must, ONLY after every local
 * candidate host has failed, fall back to OpenRouter when `openRouterEnabled`
 * AND `openRouterRerankModel` are both configured. If OpenRouter also fails
 * (or isn't configured), today's behaviour is preserved exactly: first-stage
 * order, never throw.
 *
 * Synthetic fixtures only (CLAUDE.md § Privacy).
 */

const getConfig = jest.fn();
const rerankDocuments = jest.fn();
const recordSpend = jest.fn();
const findRerankModel = jest.fn();

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
jest.mock('@/lib/openrouter/client', () => ({
  rerankDocuments: (...args: unknown[]) => rerankDocuments(...args),
  recordSpend: (...args: unknown[]) => recordSpend(...args),
}));
jest.mock('@/lib/openrouter/models', () => ({
  findRerankModel: (...args: unknown[]) => findRerankModel(...args),
}));

import type { RerankOutcome } from '../reranker';

type Row = { text: string; score: number };
const rows = (): Row[] => [
  { text: 'first chunk', score: 0.9 },
  { text: 'second chunk', score: 0.8 },
];

const OPENROUTER_MODEL = 'qwen/qwen3-reranker-8b';

const VLLM_DOWN_OPENROUTER_READY = {
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
  openRouterEnabled: true,
  openRouterRerankModel: OPENROUTER_MODEL,
};

async function loadRerank() {
  jest.resetModules();
  return (await import('../reranker')).rerank;
}

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

describe('rerank() vLLM → OpenRouter fallback (Policy 1)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    findRerankModel.mockReturnValue({
      id: OPENROUTER_MODEL,
      contextTokens: 40_960,
      pricePerMTokens: 0.2,
      pinProvider: 'Fireworks',
    });
    // Every local vLLM host is unreachable — simulates a Mac with no local
    // reranker (CUDA-vLLM-only) and no other fleet candidates.
    global.fetch = jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED')) as any;
  });

  it('falls back to OpenRouter once every local candidate has failed', async () => {
    rerankDocuments.mockResolvedValue({
      results: [
        { index: 1, relevance_score: 0.99 },
        { index: 0, relevance_score: 0.11 },
      ],
      usage: { total_tokens: 42 },
    });

    const { items, outcome } = await run(VLLM_DOWN_OPENROUTER_READY);

    expect(rerankDocuments).toHaveBeenCalledTimes(1);
    const [, , model] = rerankDocuments.mock.calls[0];
    expect(model).toBe(OPENROUTER_MODEL);
    expect(items[0].text).toBe('second chunk');
    expect(outcome.applied).toBe(true);
    expect(outcome.model).toBe(OPENROUTER_MODEL);
  });

  it('does NOT fall back when openRouterEnabled is false — keeps today’s degrade', async () => {
    const input = rows();
    const { items, outcome } = await run({ ...VLLM_DOWN_OPENROUTER_READY, openRouterEnabled: false }, input);

    expect(rerankDocuments).not.toHaveBeenCalled();
    expect(items).toEqual(input);
    expect(outcome.applied).toBe(false);
    expect(outcome.reason).toBe('degraded');
  });

  it('does NOT fall back when no OpenRouter rerank model is configured', async () => {
    const input = rows();
    const { items, outcome } = await run(
      { ...VLLM_DOWN_OPENROUTER_READY, openRouterRerankModel: undefined },
      input,
    );

    expect(rerankDocuments).not.toHaveBeenCalled();
    expect(items).toEqual(input);
    expect(outcome.applied).toBe(false);
    expect(outcome.reason).toBe('degraded');
  });

  it('falls back to first-stage order (never throws) when OpenRouter fails too', async () => {
    rerankDocuments.mockRejectedValue(Object.assign(new Error('no providers'), { kind: 'no-providers' }));
    const input = rows();
    const { items, outcome } = await run(VLLM_DOWN_OPENROUTER_READY, input);

    expect(rerankDocuments).toHaveBeenCalledTimes(1);
    expect(items).toEqual(input);
    expect(outcome.applied).toBe(false);
    expect(outcome.reason).toBe('degraded');
  });

  it('does not touch OpenRouter at all when a local host succeeds', async () => {
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (!String(url).includes('/rerank')) {
        return { ok: true, status: 200, json: async () => ({ data: [] }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: [{ index: 0, relevance_score: 0.7 }, { index: 1, relevance_score: 0.6 }],
          model: VLLM_DOWN_OPENROUTER_READY.rerankModel,
          usage: { total_tokens: 10 },
        }),
      };
    }) as any;

    const { outcome } = await run(VLLM_DOWN_OPENROUTER_READY);
    expect(outcome.applied).toBe(true);
    expect(outcome.model).toBe(VLLM_DOWN_OPENROUTER_READY.rerankModel);
    expect(rerankDocuments).not.toHaveBeenCalled();
  });
});
