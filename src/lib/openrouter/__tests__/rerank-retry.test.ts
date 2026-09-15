/**
 * @jest-environment node
 *
 * The rerank call must survive a transient 503.
 *
 * `qwen/qwen3-reranker-8b` is served by exactly ONE provider (Fireworks —
 * verified against OpenRouter's endpoints API 2026-09-16; the 4b and 0.6b
 * variants have ZERO), and the catalogue lists no alternative rerank model. So
 * there is nothing to fail over TO: when Fireworks answers
 *
 *   503 {"message":"service overloaded, please try again later"}
 *
 * the only remaining option is to ask it again. Before this retry existed, one
 * such response took rerank out for the whole query and search silently fell
 * back to first-stage order — the answer still rendered, just ranked worse,
 * with nothing in the UI to say so.
 *
 * Observed live on 2026-09-16:
 *   [Reranker] Rerank degraded — all hosts failed { candidatesTried: ['openrouter'] }
 */

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

jest.mock('@/lib/db/config', () => ({
  getConfig: jest.fn().mockResolvedValue({ openRouterApiKey: 'sk-test', openRouterEnabled: true }),
}));

import { rerankDocuments, OpenRouterError } from '../client';

const ok = (body: unknown) =>
  Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify(body) } as Response);
const fail = (status: number, msg: string) =>
  Promise.resolve({ ok: false, status, text: async () => JSON.stringify({ error: { message: msg } }) } as Response);

const RESULT = { results: [{ index: 0, relevance_score: 0.9 }], usage: { total_tokens: 10 } };

beforeEach(() => {
  fetchMock.mockReset();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('rerankDocuments — transient failures', () => {
  jest.setTimeout(20_000);

  it('recovers when the single provider 503s once', async () => {
    fetchMock
      .mockReturnValueOnce(fail(503, 'service overloaded, please try again later'))
      .mockReturnValueOnce(ok(RESULT));

    const out = await rerankDocuments('q', ['a', 'b'], 'qwen/qwen3-reranker-8b');
    expect(out.results[0].relevance_score).toBe(0.9);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('recovers on the third attempt', async () => {
    fetchMock
      .mockReturnValueOnce(fail(503, 'overloaded'))
      .mockReturnValueOnce(fail(503, 'overloaded'))
      .mockReturnValueOnce(ok(RESULT));

    await expect(rerankDocuments('q', ['a'], 'qwen/qwen3-reranker-8b')).resolves.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries a 429 rate limit too', async () => {
    fetchMock.mockReturnValueOnce(fail(429, 'rate limited')).mockReturnValueOnce(ok(RESULT));
    await expect(rerankDocuments('q', ['a'], 'qwen/qwen3-reranker-8b')).resolves.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after 3 attempts rather than retrying forever', async () => {
    // A rerank that lands after the answer has rendered is worthless — the
    // reranker runs inside a 40s interactive budget.
    fetchMock.mockReturnValue(fail(503, 'overloaded'));
    await expect(rerankDocuments('q', ['a'], 'qwen/qwen3-reranker-8b')).rejects.toThrow(OpenRouterError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('rerankDocuments — permanent failures are NOT retried', () => {
  it('does not retry a bad key', async () => {
    fetchMock.mockReturnValue(fail(401, 'invalid api key'));
    await expect(rerankDocuments('q', ['a'], 'qwen/qwen3-reranker-8b')).rejects.toThrow();
    // Burning three attempts on an auth failure just spends the caller's
    // latency budget to reach the same answer.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry a model nobody serves', async () => {
    // This is the 4b/0.6b case: listed, zero providers. Retrying cannot help.
    fetchMock.mockReturnValue(fail(404, 'no endpoints found'));
    await expect(rerankDocuments('q', ['a'], 'qwen/qwen3-reranker-4b')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
