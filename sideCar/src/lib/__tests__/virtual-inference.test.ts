/** @jest-environment node */
/**
 * Virtual inference — routing a role to OpenRouter when a master has opted
 * it out of local-only, AND actually serving the request with that master's
 * key when routing says to. `global.fetch` is mocked in every test that
 * reaches serveEmbedding/serveRerank — NO live network call is made.
 */
import {
  setOpenRouterConfig,
  clearOpenRouterConfig,
  getOpenRouterStatus,
  resolveRouting,
  isCloudOnly,
  serveEmbedding,
  serveRerank,
  getVirtualContainerStats,
  __resetVirtualInferenceForTest,
} from '@/lib/virtual-inference';

const MASTER_A = 'http://master-a.example:3000';
const MASTER_B = 'http://master-b.example:3000';

/** Installs a mock global.fetch that returns `body` for every call. Inspect
 *  `spy.mock.calls` for the request URL/init (headers, parsed JSON body). */
function mockFetch(body: unknown, status = 200): jest.SpyInstance {
  return jest.spyOn(global, 'fetch').mockImplementation(async () => {
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
    } as Response;
  });
}

function requestBody(spy: jest.SpyInstance, callIndex = 0): Record<string, unknown> {
  const init = spy.mock.calls[callIndex][1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

function requestHeaders(spy: jest.SpyInstance, callIndex = 0): Record<string, string> {
  const init = spy.mock.calls[callIndex][1] as RequestInit;
  return init.headers as Record<string, string>;
}

describe('virtual-inference', () => {
  beforeEach(() => {
    __resetVirtualInferenceForTest();
    jest.restoreAllMocks();
  });

  describe('per-master isolation', () => {
    it("does not leak master A's allow-list or mode to master B", () => {
      setOpenRouterConfig(MASTER_A, {
        apiKey: 'sk-or-a-secret',
        modeByRole: { embedding: 'cloud-only' },
        allowedModels: { embedding: { model: 'qwen/qwen3-embedding-4b', note: '2560d' } },
      });

      // Master B never configured — must resolve as local-only regardless of
      // what master A pushed.
      expect(isCloudOnly('embedding', MASTER_B)).toBe(false);
      const decision = resolveRouting({ role: 'embedding', serverUrl: MASTER_B });
      expect(decision.source).toBe('local');

      // Master A is unaffected and still routes to its own model.
      expect(isCloudOnly('embedding', MASTER_A)).toBe(true);
      const decisionA = resolveRouting({ role: 'embedding', serverUrl: MASTER_A });
      expect(decisionA).toMatchObject({ source: 'openrouter', model: 'qwen/qwen3-embedding-4b' });
    });

    it('a master with no config pushed at all is always local-only, never falls through', () => {
      // Nothing configured for either master.
      expect(getOpenRouterStatus(MASTER_A).openrouter).toBe('unset');
      expect(resolveRouting({ role: 'reranker', serverUrl: MASTER_A, localAvailable: false })).toMatchObject({
        source: 'local',
      });
    });

    it('clearing one master leaves the other master untouched', () => {
      setOpenRouterConfig(MASTER_A, { apiKey: 'key-a', modeByRole: { embedding: 'cloud-only' }, allowedModels: { embedding: { model: 'm-a' } } });
      setOpenRouterConfig(MASTER_B, { apiKey: 'key-b', modeByRole: { embedding: 'cloud-only' }, allowedModels: { embedding: { model: 'm-b' } } });

      clearOpenRouterConfig(MASTER_A);

      expect(getOpenRouterStatus(MASTER_A).openrouter).toBe('unset');
      expect(getOpenRouterStatus(MASTER_B).openrouter).toBe('configured');
      expect(isCloudOnly('embedding', MASTER_B)).toBe(true);
    });
  });

  describe('key hygiene', () => {
    it('getOpenRouterStatus never returns the key or any prefix of it', () => {
      setOpenRouterConfig(MASTER_A, {
        apiKey: 'sk-or-v1-super-secret-value',
        modeByRole: { embedding: 'local-first' },
        allowedModels: { embedding: { model: 'qwen/qwen3-embedding-4b' } },
      });
      const status = getOpenRouterStatus(MASTER_A);
      const serialized = JSON.stringify(status);
      expect(serialized).not.toMatch(/sk-or/);
      expect(status).toEqual({
        openrouter: 'configured',
        modeByRole: { embedding: 'local-first' },
        rolesWithModel: ['embedding'],
      });
    });

    it('resolveRouting decisions never carry the key, only provider and model', () => {
      setOpenRouterConfig(MASTER_A, {
        apiKey: 'sk-or-v1-super-secret-value',
        modeByRole: { rerank: 'cloud-only' },
        allowedModels: { rerank: { model: 'qwen/qwen3-reranker-8b' } },
      });
      const decision = resolveRouting({ role: 'rerank', serverUrl: MASTER_A, detail: '12 docs' });
      expect(JSON.stringify(decision)).not.toMatch(/sk-or/);
      expect(decision).toEqual({
        source: 'openrouter',
        provider: 'openrouter',
        model: 'qwen/qwen3-reranker-8b',
        reason: 'cloud-only',
      });
    });

    it('stores models/modes from a keyless push but reports key-missing', () => {
      // Discarding the whole config made re-push useless after a restart: the
      // master cannot resend a key it never stores, so every re-push was
      // rejected while reporting success. Keep the non-secret parts; routing
      // stays local until a key arrives.
      setOpenRouterConfig(MASTER_A, { modeByRole: { embedding: 'cloud-only' } });
      expect(getOpenRouterStatus(MASTER_A).openrouter).toBe('key-missing');
      expect(getOpenRouterStatus(MASTER_A).modeByRole.embedding).toBe('cloud-only');
      expect(resolveRouting({ role: 'embedding', serverUrl: MASTER_A }).source).toBe('local');
    });

    it('a later push without apiKey keeps the previously pushed key (merge, not replace)', () => {
      setOpenRouterConfig(MASTER_A, {
        apiKey: 'sk-or-v1-first',
        modeByRole: { embedding: 'cloud-only' },
        allowedModels: { embedding: { model: 'm1' } },
      });
      // Master only updates modeByRole on a later push — no apiKey field.
      setOpenRouterConfig(MASTER_A, { modeByRole: { embedding: 'local-first' } });
      expect(getOpenRouterStatus(MASTER_A)).toEqual({
        openrouter: 'configured',
        modeByRole: { embedding: 'local-first' },
        rolesWithModel: ['embedding'],
      });
    });
  });

  describe('routing modes', () => {
    beforeEach(() => {
      setOpenRouterConfig(MASTER_A, {
        apiKey: 'sk-or-v1-test',
        modeByRole: {
          embedding: 'local-first',
          rerank: 'cloud-only',
          completion: 'local-only',
        },
        allowedModels: {
          embedding: { model: 'qwen/qwen3-embedding-4b', note: '2560d' },
          rerank: { model: 'qwen/qwen3-reranker-8b' },
        },
      });
    });

    it('local-only never calls out, even with local unavailable and a model mapped', () => {
      const decision = resolveRouting({ role: 'completion', serverUrl: MASTER_A, localAvailable: false });
      expect(decision.source).toBe('local');
    });

    it('local-first stays local when local is available', () => {
      const decision = resolveRouting({ role: 'embedding', serverUrl: MASTER_A, localAvailable: true });
      expect(decision).toMatchObject({ source: 'local' });
    });

    it('local-first falls back to OpenRouter only when local is unavailable', () => {
      const decision = resolveRouting({
        role: 'embedding',
        serverUrl: MASTER_A,
        localAvailable: false,
        localErrorReason: 'ss-embedding container not running',
      });
      expect(decision).toMatchObject({
        source: 'openrouter',
        provider: 'openrouter',
        model: 'qwen/qwen3-embedding-4b',
      });
      expect(decision.reason).toMatch(/ss-embedding container not running/);
    });

    it('local-first with no local-availability info defaults to local (fails safe)', () => {
      const decision = resolveRouting({ role: 'embedding', serverUrl: MASTER_A });
      expect(decision.source).toBe('local');
    });

    it('cloud-only routes to OpenRouter without any local-availability check', () => {
      expect(isCloudOnly('rerank', MASTER_A)).toBe(true);
      const decision = resolveRouting({ role: 'rerank', serverUrl: MASTER_A, localAvailable: true });
      // Even though localAvailable is true, cloud-only ignores it.
      expect(decision).toMatchObject({ source: 'openrouter', model: 'qwen/qwen3-reranker-8b' });
    });

    it('cloud-only with no model mapped falls back to local rather than erroring opaquely', () => {
      setOpenRouterConfig(MASTER_A, { modeByRole: { completion: 'cloud-only' } });
      const decision = resolveRouting({ role: 'completion', serverUrl: MASTER_A });
      expect(decision.source).toBe('local');
    });

    it('a role with no mode entry defaults to local-only', () => {
      const decision = resolveRouting({ role: 'ocr', serverUrl: MASTER_A, localAvailable: false });
      expect(decision.source).toBe('local');
    });
  });

  describe('serving via OpenRouter (fetch mocked — no live calls)', () => {
    it('serveEmbedding actually calls OpenRouter and returns vectors when routing says cloud', async () => {
      setOpenRouterConfig(MASTER_A, {
        apiKey: 'sk-or-v1-embed-secret',
        modeByRole: { embedding: 'cloud-only' },
        allowedModels: { embedding: { model: 'qwen/qwen3-embedding-4b' } },
      });
      const spy = mockFetch({
        data: [{ index: 0, embedding: new Array(2560).fill(0.1) }],
        usage: { total_tokens: 12 },
      });

      const result = await serveEmbedding({ role: 'embedding', serverUrl: MASTER_A, texts: ['hello world'] });

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/embeddings');
      expect(result).toMatchObject({ source: 'openrouter', model: 'qwen/qwen3-embedding-4b', dims: 2560 });
      if (result.source === 'openrouter') {
        expect(result.embeddings).toHaveLength(1);
        expect(result.embeddings[0]).toHaveLength(2560);
      }
    });

    it('serveEmbedding returns {source:"local"} without calling fetch when routing stays local', async () => {
      setOpenRouterConfig(MASTER_A, {
        apiKey: 'sk-or-v1-x',
        modeByRole: { embedding: 'local-first' },
        allowedModels: { embedding: { model: 'qwen/qwen3-embedding-4b' } },
      });
      const spy = mockFetch({ data: [] });

      const result = await serveEmbedding({ role: 'embedding', serverUrl: MASTER_A, texts: ['x'], localAvailable: true });

      expect(result).toEqual({ source: 'local' });
      expect(spy).not.toHaveBeenCalled();
    });

    it('pins the provider on every embedding call', async () => {
      setOpenRouterConfig(MASTER_A, {
        apiKey: 'sk-or-v1-x',
        modeByRole: { embedding: 'cloud-only' },
        allowedModels: { embedding: { model: 'qwen/qwen3-embedding-4b' } },
      });
      const spy = mockFetch({ data: [{ index: 0, embedding: new Array(2560).fill(0) }] });

      await serveEmbedding({ role: 'embedding', serverUrl: MASTER_A, texts: ['a'] });

      const body = requestBody(spy);
      expect(body.provider).toEqual({ order: ['DeepInfra'], allow_fallbacks: false });
    });

    it('an explicit provider override on the master config wins over the known pin', async () => {
      setOpenRouterConfig(MASTER_A, {
        apiKey: 'sk-or-v1-x',
        modeByRole: { embedding: 'cloud-only' },
        allowedModels: { embedding: { model: 'qwen/qwen3-embedding-4b', provider: 'CustomProvider', dims: 99 } },
      });
      const spy = mockFetch({ data: [{ index: 0, embedding: new Array(99).fill(0) }] });

      await serveEmbedding({ role: 'embedding', serverUrl: MASTER_A, texts: ['a'] });

      const body = requestBody(spy);
      expect(body.provider).toEqual({ order: ['CustomProvider'], allow_fallbacks: false });
    });

    it('refuses (fails closed to local) an embedding model with no known or configured provider pin', async () => {
      setOpenRouterConfig(MASTER_A, {
        apiKey: 'sk-or-v1-x',
        modeByRole: { embedding: 'cloud-only' },
        allowedModels: { embedding: { model: 'some-vendor/unlisted-embedding-model' } },
      });
      const spy = mockFetch({ data: [] });

      const result = await serveEmbedding({ role: 'embedding', serverUrl: MASTER_A, texts: ['a'] });

      expect(result).toEqual({ source: 'local' });
      expect(spy).not.toHaveBeenCalled();
    });

    it('throws when OpenRouter returns the wrong embedding width instead of returning bad vectors', async () => {
      setOpenRouterConfig(MASTER_A, {
        apiKey: 'sk-or-v1-x',
        modeByRole: { embedding: 'cloud-only' },
        allowedModels: { embedding: { model: 'qwen/qwen3-embedding-4b' } }, // expects 2560
      });
      mockFetch({ data: [{ index: 0, embedding: new Array(128).fill(0) }] }); // wrong width

      await expect(
        serveEmbedding({ role: 'embedding', serverUrl: MASTER_A, texts: ['a'] }),
      ).rejects.toThrow(/2560/);
    });

    it('refuses an embedding request for a model outside this master\'s allow-list, even if another master allows it', async () => {
      setOpenRouterConfig(MASTER_A, {
        apiKey: 'sk-or-v1-a',
        modeByRole: { embedding: 'cloud-only' },
        allowedModels: { embedding: { model: 'qwen/qwen3-embedding-4b' } },
      });
      // Master B allows a DIFFERENT model for the same role.
      setOpenRouterConfig(MASTER_B, {
        apiKey: 'sk-or-v1-b',
        modeByRole: { embedding: 'cloud-only' },
        allowedModels: { embedding: { model: 'openai/text-embedding-3-large' } },
      });
      const spy = mockFetch({ data: [] });

      // Master A's request names master B's allowed model — must be refused.
      await expect(
        serveEmbedding({
          role: 'embedding',
          serverUrl: MASTER_A,
          texts: ['a'],
          requestedModel: 'openai/text-embedding-3-large',
        }),
      ).rejects.toThrow(/not allow-listed/);
      expect(spy).not.toHaveBeenCalled();
    });

    it('serveRerank calls OpenRouter without a provider pin (rerank is stateless)', async () => {
      setOpenRouterConfig(MASTER_A, {
        apiKey: 'sk-or-v1-rr',
        modeByRole: { rerank: 'cloud-only' },
        allowedModels: { rerank: { model: 'qwen/qwen3-reranker-8b' } },
      });
      const spy = mockFetch({
        results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.2 }],
        usage: { total_tokens: 40 },
      });

      const result = await serveRerank({
        role: 'rerank',
        serverUrl: MASTER_A,
        query: 'what is the holding?',
        documents: ['doc a', 'doc b'],
      });

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/rerank');
      const body = requestBody(spy);
      expect(body.provider).toBeUndefined();
      expect(result).toMatchObject({ source: 'openrouter', model: 'qwen/qwen3-reranker-8b' });
    });

    it('refuses a rerank request for a model outside the requesting master\'s allow-list', async () => {
      setOpenRouterConfig(MASTER_A, {
        apiKey: 'sk-or-v1-a',
        modeByRole: { rerank: 'cloud-only' },
        allowedModels: { rerank: { model: 'qwen/qwen3-reranker-8b' } },
      });
      const spy = mockFetch({ results: [] });

      await expect(
        serveRerank({
          role: 'rerank',
          serverUrl: MASTER_A,
          query: 'q',
          documents: ['d'],
          requestedModel: 'some-other/reranker',
        }),
      ).rejects.toThrow(/not allow-listed/);
      expect(spy).not.toHaveBeenCalled();
    });

    it('never sends or logs the raw apiKey — only Bearer-prefixed auth header, and status/decisions stay key-free', async () => {
      setOpenRouterConfig(MASTER_A, {
        apiKey: 'sk-or-v1-must-not-leak',
        modeByRole: { embedding: 'cloud-only' },
        allowedModels: { embedding: { model: 'qwen/qwen3-embedding-4b' } },
      });
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const spy = mockFetch({ data: [{ index: 0, embedding: new Array(2560).fill(0) }], usage: { total_tokens: 5 } });

      await serveEmbedding({ role: 'embedding', serverUrl: MASTER_A, texts: ['a'] });

      // The key DOES travel in the Authorization header (that's how OpenRouter
      // authenticates) — but nowhere else: not in the request body, and never
      // through the logger.
      const headers = requestHeaders(spy);
      expect(headers.Authorization).toBe('Bearer sk-or-v1-must-not-leak');
      const body = requestBody(spy);
      expect(JSON.stringify(body)).not.toMatch(/sk-or-v1-must-not-leak/);

      for (const call of logSpy.mock.calls) {
        expect(JSON.stringify(call)).not.toMatch(/sk-or-v1-must-not-leak/);
      }
      logSpy.mockRestore();
    });
  });

  describe('virtual container stats (the sidecar UI data)', () => {
    it('starts idle with zeroed counters once a model is mapped, even before anything is served', () => {
      setOpenRouterConfig(MASTER_A, {
        apiKey: 'sk-or-v1-x',
        modeByRole: { embedding: 'local-first' },
        allowedModels: { embedding: { model: 'qwen/qwen3-embedding-4b' } },
      });
      const stats = getVirtualContainerStats(MASTER_A);
      expect(stats).toHaveLength(1);
      expect(stats[0]).toMatchObject({
        role: 'embedding',
        model: 'qwen/qwen3-embedding-4b',
        provider: 'DeepInfra',
        dims: 2560,
        mode: 'local-first',
        served: 0,
        failures: 0,
        lastServedAt: null,
        lastError: null,
        state: 'idle',
      });
    });

    it('returns an empty array for a master with no OpenRouter config pushed', () => {
      expect(getVirtualContainerStats(MASTER_A)).toEqual([]);
    });

    it('increments served, records duration and tokens, and flips state to idle after a successful call', async () => {
      setOpenRouterConfig(MASTER_A, {
        apiKey: 'sk-or-v1-x',
        modeByRole: { embedding: 'cloud-only' },
        allowedModels: { embedding: { model: 'qwen/qwen3-embedding-4b' } },
      });
      mockFetch({ data: [{ index: 0, embedding: new Array(2560).fill(0) }], usage: { total_tokens: 77 } });

      await serveEmbedding({ role: 'embedding', serverUrl: MASTER_A, texts: ['a', 'b'] });

      const [row] = getVirtualContainerStats(MASTER_A);
      expect(row.served).toBe(1);
      expect(row.failures).toBe(0);
      expect(row.totalTokens).toBe(77);
      expect(row.lastServedAt).not.toBeNull();
      expect(row.lastDurationMs).not.toBeNull();
      expect(row.state).toBe('idle'); // not in flight anymore
      expect(row.lastReason).toBe('cloud-only');

      // A second successful call accumulates rather than resetting.
      mockFetch({ data: [{ index: 0, embedding: new Array(2560).fill(0) }], usage: { total_tokens: 3 } });
      await serveEmbedding({ role: 'embedding', serverUrl: MASTER_A, texts: ['c'] });
      const [row2] = getVirtualContainerStats(MASTER_A);
      expect(row2.served).toBe(2);
      expect(row2.totalTokens).toBe(80);
    });

    it('records a failure and the error message (never the key) when the OpenRouter call errors', async () => {
      setOpenRouterConfig(MASTER_A, {
        apiKey: 'sk-or-v1-must-not-leak',
        modeByRole: { rerank: 'cloud-only' },
        allowedModels: { rerank: { model: 'qwen/qwen3-reranker-8b' } },
      });
      mockFetch({ error: 'upstream exploded' }, 500);

      await expect(
        serveRerank({ role: 'rerank', serverUrl: MASTER_A, query: 'q', documents: ['d1', 'd2'] }),
      ).rejects.toThrow();

      const [row] = getVirtualContainerStats(MASTER_A);
      expect(row.failures).toBe(1);
      expect(row.served).toBe(0);
      expect(row.state).toBe('failed');
      expect(row.lastError).toBeTruthy();
      expect(row.lastError).not.toMatch(/sk-or-v1-must-not-leak/);
    });

    it('records a failure for a refused (not-allow-listed) request without ever calling fetch', async () => {
      setOpenRouterConfig(MASTER_A, {
        apiKey: 'sk-or-v1-x',
        modeByRole: { embedding: 'cloud-only' },
        allowedModels: { embedding: { model: 'qwen/qwen3-embedding-4b' } },
      });
      const spy = mockFetch({ data: [] });

      await expect(
        serveEmbedding({ role: 'embedding', serverUrl: MASTER_A, texts: ['a'], requestedModel: 'nope/not-allowed' }),
      ).rejects.toThrow(/not allow-listed/);

      expect(spy).not.toHaveBeenCalled();
      const [row] = getVirtualContainerStats(MASTER_A);
      expect(row.failures).toBe(1);
      expect(row.state).toBe('failed');
    });

    it('keeps stats fully isolated per master — A serving heavily never touches B\'s counters', async () => {
      setOpenRouterConfig(MASTER_A, {
        apiKey: 'sk-or-v1-a',
        modeByRole: { embedding: 'cloud-only' },
        allowedModels: { embedding: { model: 'qwen/qwen3-embedding-4b' } },
      });
      setOpenRouterConfig(MASTER_B, {
        apiKey: 'sk-or-v1-b',
        modeByRole: { embedding: 'cloud-only' },
        allowedModels: { embedding: { model: 'qwen/qwen3-embedding-8b' } },
      });
      mockFetch({ data: [{ index: 0, embedding: new Array(2560).fill(0) }], usage: { total_tokens: 10 } });

      await serveEmbedding({ role: 'embedding', serverUrl: MASTER_A, texts: ['a'] });
      await serveEmbedding({ role: 'embedding', serverUrl: MASTER_A, texts: ['a'] });
      await serveEmbedding({ role: 'embedding', serverUrl: MASTER_A, texts: ['a'] });

      const [rowA] = getVirtualContainerStats(MASTER_A);
      const [rowB] = getVirtualContainerStats(MASTER_B);
      expect(rowA.served).toBe(3);
      expect(rowB.served).toBe(0);
      expect(rowB.model).toBe('qwen/qwen3-embedding-8b'); // B's own mapping, untouched by A's traffic
    });

    it('clears stats when the master is retired (config cleared) so a reused URL starts fresh', async () => {
      setOpenRouterConfig(MASTER_A, {
        apiKey: 'sk-or-v1-x',
        modeByRole: { embedding: 'cloud-only' },
        allowedModels: { embedding: { model: 'qwen/qwen3-embedding-4b' } },
      });
      mockFetch({ data: [{ index: 0, embedding: new Array(2560).fill(0) }], usage: { total_tokens: 1 } });
      await serveEmbedding({ role: 'embedding', serverUrl: MASTER_A, texts: ['a'] });
      expect(getVirtualContainerStats(MASTER_A)[0].served).toBe(1);

      clearOpenRouterConfig(MASTER_A);
      expect(getVirtualContainerStats(MASTER_A)).toEqual([]);

      // A fresh config push for the same URL (a different master process
      // reusing it) starts with zeroed counters, not the old master's history.
      setOpenRouterConfig(MASTER_A, {
        apiKey: 'sk-or-v1-new-master',
        modeByRole: { embedding: 'cloud-only' },
        allowedModels: { embedding: { model: 'qwen/qwen3-embedding-4b' } },
      });
      expect(getVirtualContainerStats(MASTER_A)[0].served).toBe(0);
    });

    it('never includes the apiKey or any key-derived value in the stats payload', async () => {
      setOpenRouterConfig(MASTER_A, {
        apiKey: 'sk-or-v1-super-secret-stats-key',
        modeByRole: { embedding: 'cloud-only' },
        allowedModels: { embedding: { model: 'qwen/qwen3-embedding-4b' } },
      });
      mockFetch({ data: [{ index: 0, embedding: new Array(2560).fill(0) }], usage: { total_tokens: 1 } });
      await serveEmbedding({ role: 'embedding', serverUrl: MASTER_A, texts: ['a'] });

      const stats = getVirtualContainerStats(MASTER_A);
      expect(JSON.stringify(stats)).not.toMatch(/sk-or-v1-super-secret-stats-key/);
    });
  });
});
