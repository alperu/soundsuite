/** @jest-environment node */
/**
 * OpenRouter as a rerank provider, alongside the existing vLLM one.
 *
 * `rerank()` must:
 *  - route to `rerankDocuments()` (the frozen `@/lib/openrouter/client`
 *    contract) when `config.rerankProvider === 'openrouter'`, reusing the
 *    same result-mapping/score-validation code as the vLLM path;
 *  - fall back to first-stage order (never throw) when `openRouterEnabled`
 *    is false, or when OpenRouter itself fails ('no-providers', 'rate-limit',
 *    'auth', or anything else);
 *  - use a PER-PROVIDER token budget: local vLLM stays pinned to 8192, while
 *    OpenRouter's curated model uses its own (much larger) `contextTokens`;
 *  - never touch the vLLM preflight/candidate-host/lifecycle machinery on the
 *    OpenRouter path — there is no local host to manage.
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

const OPENROUTER_ENABLED = {
  rerankEnabled: true,
  rerankProvider: 'openrouter',
  rerankHost: '', // deliberately empty — OpenRouter has no local host
  rerankModel: 'unused-for-openrouter',
  rerankTopN: 10,
  rerankScoreValidation: false,
  rerankInteractiveTimeoutMs: 500,
  rerankTimeoutMs: 500,
  rerankAutoManage: false,
  rerankIdleTimeoutMin: 5,
  openRouterEnabled: true,
  openRouterRerankModel: OPENROUTER_MODEL,
};

const VLLM_ENABLED = {
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
  openRouterEnabled: false,
};

/**
 * `reranker.ts` caches config in a module-level variable with a TTL, so every
 * case needs a fresh module instance to see its own config (matches the
 * pattern in reranker-outcome.test.ts).
 */
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

describe('rerank() with OpenRouter as provider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    findRerankModel.mockReturnValue({
      id: OPENROUTER_MODEL,
      contextTokens: 40_960,
      pricePerMTokens: 0.2,
      pinProvider: 'Fireworks',
    });
  });

  it('returns reordered results from rerankDocuments() and reports the provider/model', async () => {
    rerankDocuments.mockResolvedValue({
      results: [
        { index: 1, relevance_score: 0.99 },
        { index: 0, relevance_score: 0.11 },
      ],
      usage: { total_tokens: 42 },
    });

    const { items, outcome } = await run(OPENROUTER_ENABLED);

    expect(rerankDocuments).toHaveBeenCalledTimes(1);
    const [query, documents, model] = rerankDocuments.mock.calls[0];
    expect(query).toBe('a query');
    expect(documents).toEqual(['first chunk', 'second chunk']);
    expect(model).toBe(OPENROUTER_MODEL);

    // A real rerank reorders: the second row now leads.
    expect(items[0].text).toBe('second chunk');
    expect(outcome.applied).toBe(true);
    expect(outcome.model).toBe(OPENROUTER_MODEL);

    // Preflight/lifecycle/candidate-host machinery must never run for
    // OpenRouter — there is no local host to probe or manage.
    const { rerankerLifecycle } = require('../reranker-lifecycle');
    expect(rerankerLifecycle.ensureRunning).not.toHaveBeenCalled();
  });

  it('reuses the shared mapping — result shape is identical to the vLLM path', async () => {
    rerankDocuments.mockResolvedValue({
      results: [{ index: 0, relevance_score: 0.5 }],
      usage: { total_tokens: 7 },
    });
    const { items } = await run(OPENROUTER_ENABLED, rows(), 1);
    // Original fields survive the mapping (spread), only `score` is replaced.
    expect(items).toEqual([{ text: 'first chunk', score: 0.5 }]);
  });

  // Spend accounting deliberately does NOT live in reranker.ts. It was moved
  // inside rerankDocuments() (chargeTokens() in @/lib/openrouter/client) so that
  // embeddings and chat are charged too, not just the one call site that
  // remembered. Asserting it here would re-pin the behaviour to the wrong layer;
  // the client's own suite covers the arithmetic.
  it('delegates the priced call to the client rather than accounting locally', async () => {
    rerankDocuments.mockResolvedValue({
      results: [{ index: 0, relevance_score: 0.5 }, { index: 1, relevance_score: 0.4 }],
      usage: { total_tokens: 1_000_000 },
    });
    await run(OPENROUTER_ENABLED);
    expect(rerankDocuments).toHaveBeenCalled();
    expect(recordSpend).not.toHaveBeenCalled();
  });

  it('falls back to first-stage order when openRouterEnabled is false', async () => {
    const input = rows();
    const { items, outcome } = await run({ ...OPENROUTER_ENABLED, openRouterEnabled: false }, input);

    expect(rerankDocuments).not.toHaveBeenCalled();
    expect(items).toEqual(input);
    expect(outcome.applied).toBe(false);
    expect(outcome.message).toBeTruthy();
  });

  it('does NOT exit via the vLLM no-host guard when the host is empty but provider is openrouter', async () => {
    // Regression lock: the no-host guard is scoped to rerankProvider === 'vllm'.
    // An OpenRouter-only deployment legitimately has no rerank.host configured.
    rerankDocuments.mockResolvedValue({
      results: [{ index: 0, relevance_score: 0.7 }, { index: 1, relevance_score: 0.6 }],
      usage: { total_tokens: 10 },
    });
    const { outcome } = await run({ ...OPENROUTER_ENABLED, rerankHost: '' });
    expect(outcome.applied).toBe(true);
    expect(outcome.reason).toBeUndefined();
  });

  it.each([
    ['no-providers', 'model exists but nobody serves it'],
    ['rate-limit', 'daily cap reached'],
    ['auth', 'bad API key'],
  ])('falls back to first-stage order on OpenRouterError kind "%s"', async (kind, message) => {
    const err: any = new Error(message);
    err.kind = kind;
    err.status = kind === 'auth' ? 401 : kind === 'rate-limit' ? 429 : 404;
    rerankDocuments.mockRejectedValue(err);

    const input = rows();
    const { items, outcome } = await run(OPENROUTER_ENABLED, input);

    expect(items).toEqual(input);
    expect(outcome.applied).toBe(false);
    expect(outcome.reason).toBe('degraded');
    expect(outcome.message).toMatch(/first-stage/i);
  });

  it('falls back to first-stage order on an unexpected error shape too (no throw to caller)', async () => {
    rerankDocuments.mockRejectedValue(new Error('socket hang up'));
    const input = rows();
    const { items, outcome } = await run(OPENROUTER_ENABLED, input);
    expect(items).toEqual(input);
    expect(outcome.applied).toBe(false);
  });

  it('uses the curated model context budget (40960) — a large doc is NOT truncated', async () => {
    rerankDocuments.mockResolvedValue({
      results: [{ index: 0, relevance_score: 0.9 }],
      usage: { total_tokens: 1 },
    });
    const bigDoc = 'x'.repeat(50_000);
    await run({ ...OPENROUTER_ENABLED, rerankMaxDocChars: 200_000 }, [{ text: bigDoc, score: 0.5 }], 1);

    const [, documents] = rerankDocuments.mock.calls[0];
    // (40960 - queryTokens - 512) * 2.7 chars/token ≈ 109k — well above 50k,
    // so the 50k doc must survive untouched.
    expect(documents[0]).toBe(bigDoc);
    expect(documents[0].length).toBe(50_000);
  });

  it('does not import findRerankModel’s fallback when config carries no model id', async () => {
    findRerankModel.mockReturnValue(undefined);
    rerankDocuments.mockResolvedValue({ results: [], usage: { total_tokens: 0 } });
    // No assertion on truncation here — just proving the missing-catalogue-entry
    // path doesn't throw; the 40_960 fallback in reranker.ts covers it.
    await expect(run(OPENROUTER_ENABLED, rows())).resolves.toBeDefined();
  });
});

describe('rerank() token budget is per-provider (local stays 8192, openrouter uses 40960)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    findRerankModel.mockReturnValue({
      id: OPENROUTER_MODEL,
      contextTokens: 40_960,
      pricePerMTokens: 0.2,
      pinProvider: 'Fireworks',
    });
  });

  it('truncates a large document on the local vLLM path (8192-token budget)', async () => {
    const bigDoc = 'x'.repeat(50_000);
    global.fetch = jest.fn().mockImplementation(async (url: string, init: any) => {
      if (!String(url).includes('/v1/rerank')) {
        return { ok: true, status: 200, json: async () => ({ data: [] }) };
      }
      const body = JSON.parse(init.body);
      // Capture what vLLM actually received so the test can assert truncation.
      (global as any).__lastVllmBody = body;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: [{ index: 0, relevance_score: 0.5 }],
          model: VLLM_ENABLED.rerankModel,
          usage: { total_tokens: 1 },
        }),
      };
    }) as any;

    await run({ ...VLLM_ENABLED, rerankMaxDocChars: 200_000 }, [{ text: bigDoc, score: 0.5 }], 1);

    const sentDoc = (global as any).__lastVllmBody.documents[0];
    // (8192 - queryTokens - 512) * 2.7 ≈ 20.7k — well below the 50k input, so
    // it must be truncated (and thus strictly shorter than the original).
    expect(sentDoc.length).toBeLessThan(bigDoc.length);
    expect(sentDoc.length).toBeLessThan(25_000);
  });

  it('does NOT truncate the same-sized document on the OpenRouter path (40960-token budget)', async () => {
    rerankDocuments.mockResolvedValue({
      results: [{ index: 0, relevance_score: 0.5 }],
      usage: { total_tokens: 1 },
    });
    const bigDoc = 'x'.repeat(50_000);
    await run({ ...OPENROUTER_ENABLED, rerankMaxDocChars: 200_000 }, [{ text: bigDoc, score: 0.5 }], 1);

    const [, documents] = rerankDocuments.mock.calls[0];
    expect(documents[0].length).toBe(bigDoc.length);
  });
});

describe('rerank() vLLM path is unchanged by the OpenRouter addition', () => {
  beforeEach(() => jest.clearAllMocks());

  it('still reranks via vLLM and reorders results', async () => {
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
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
          model: VLLM_ENABLED.rerankModel,
          usage: { total_tokens: 42 },
        }),
      };
    }) as any;

    const { items, outcome } = await run(VLLM_ENABLED);
    expect(outcome.applied).toBe(true);
    expect(outcome.model).toBe(VLLM_ENABLED.rerankModel);
    expect(items[0].text).toBe('second chunk');
    // OpenRouter's client must never be touched on the vLLM path.
    expect(rerankDocuments).not.toHaveBeenCalled();
  });

  it('still reports "no-host" (unchanged) when provider is vllm and host is empty', async () => {
    const input = rows();
    const { items, outcome } = await run({ ...VLLM_ENABLED, rerankHost: '' }, input);
    expect(items).toEqual(input);
    expect(outcome.applied).toBe(false);
    expect(outcome.reason).toBe('no-host');
  });

  it('still degrades gracefully to first-stage order when the vLLM host is unreachable', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED')) as any;
    const input = rows();
    const { items, outcome } = await run(VLLM_ENABLED, input);
    expect(outcome.applied).toBe(false);
    expect(outcome.reason).toBe('degraded');
    expect(items).toEqual(input);
  });
});
