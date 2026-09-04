/** @jest-environment node */

/**
 * Ollama readiness probe (report M-1): `/api/tags` alone is not readiness —
 * the completion model must also produce tokens within 10 s.
 */

jest.mock('../../db/config', () => ({
  getConfig: jest.fn().mockResolvedValue({
    ollamaCompletionHost: 'http://ollama.test:11434',
    ollamaCompletionModel: 'synthetic-model:1b',
  }),
}));

import { ollamaAvailable, ollamaReadiness, resetOllamaProbeCache } from '../shared-dependencies';

type FetchMock = jest.Mock<Promise<Response>, [string, RequestInit?]>;

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

function timeoutError(): Error {
  const err = new Error('The operation was aborted due to timeout');
  err.name = 'TimeoutError';
  return err;
}

describe('ollamaReadiness', () => {
  let fetchMock: FetchMock;
  const originalFetch = global.fetch;

  beforeEach(() => {
    resetOllamaProbeCache();
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('is true when /api/tags answers and the model generates', async () => {
    fetchMock.mockImplementation(async (url) => {
      if (String(url).endsWith('/api/tags')) return jsonResponse({ models: [{ name: 'synthetic-model:1b' }] });
      return jsonResponse({ done: true, response: 'OK' });
    });
    const r = await ollamaReadiness();
    expect(r).toEqual({ reachable: true, generates: true, model: 'synthetic-model:1b' });
    expect(await ollamaAvailable()).toBe(true);

    const gen = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/api/generate'))!;
    const body = JSON.parse(String(gen[1]?.body));
    expect(body).toMatchObject({ model: 'synthetic-model:1b', prompt: 'OK', stream: false, options: { num_predict: 5 } });
    expect(body.keep_alive).toBeUndefined();
    expect(gen[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('is false when /api/tags is OK but /api/generate times out, with a specific reason', async () => {
    fetchMock.mockImplementation(async (url) => {
      if (String(url).endsWith('/api/tags')) return jsonResponse({ models: [] });
      throw timeoutError();
    });
    const r = await ollamaReadiness();
    expect(r.reachable).toBe(true);
    expect(r.generates).toBe(false);
    expect(r.model).toBe('synthetic-model:1b');
    expect(r.reason).toBe('ollama reachable but synthetic-model:1b did not generate within 10 s');
    expect(await ollamaAvailable()).toBe(false);
  });

  it('is false with an unreachable reason when /api/tags fails', async () => {
    fetchMock.mockRejectedValue(new Error('fetch failed'));
    const r = await ollamaReadiness();
    expect(r.reachable).toBe(false);
    expect(r.generates).toBe(false);
    expect(r.reason).toMatch(/unreachable/);
    expect(fetchMock.mock.calls.every(([u]) => String(u).endsWith('/api/tags'))).toBe(true);
  });

  it('caches the result so the generation smoke runs at most once per window', async () => {
    fetchMock.mockImplementation(async (url) => {
      if (String(url).endsWith('/api/tags')) return jsonResponse({ models: [] });
      return jsonResponse({ done: true });
    });
    await ollamaReadiness();
    await ollamaReadiness();
    await ollamaAvailable();
    const generates = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/api/generate'));
    expect(generates).toHaveLength(1);
    await ollamaReadiness({ force: true });
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/api/generate'))).toHaveLength(2);
  });
});
