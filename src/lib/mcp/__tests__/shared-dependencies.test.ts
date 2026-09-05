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

import {
  ReadinessHysteresis,
  ollamaAvailable,
  ollamaReadiness,
  resetOllamaProbeCache,
  type OllamaReadiness,
} from '../shared-dependencies';

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
    expect(r).toEqual({
      reachable: true,
      generates: true,
      model: 'synthetic-model:1b',
      degraded: false,
      pendingFailures: 0,
    });
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

  // --- N-4: one failed smoke must not pull tools out of tools/list ---------
  it('serves the last-known-good value on a single failed smoke, then flips on the second', async () => {
    let generateOk = true;
    fetchMock.mockImplementation(async (url) => {
      if (String(url).endsWith('/api/tags')) return jsonResponse({ models: [] });
      if (!generateOk) throw timeoutError();
      return jsonResponse({ done: true });
    });

    const good = await ollamaReadiness({ force: true });
    expect(good.generates).toBe(true);
    expect(good.degraded).toBe(false);

    generateOk = false;
    const degraded = await ollamaReadiness({ force: true });
    expect(degraded.generates).toBe(true); // still serving last-known-good
    expect(degraded.degraded).toBe(true);
    expect(degraded.pendingFailures).toBe(1);
    expect(degraded.pendingReason).toMatch(/did not generate/);
    expect(await ollamaAvailable()).toBe(true);

    const down = await ollamaReadiness({ force: true });
    expect(down.generates).toBe(false);
    expect(down.degraded).toBe(false);
    expect(down.pendingFailures).toBe(2);
    expect(await ollamaAvailable({ force: true })).toBe(false);
  });

  it('recovers on a single success after the flip', async () => {
    let generateOk = false;
    fetchMock.mockImplementation(async (url) => {
      if (String(url).endsWith('/api/tags')) return jsonResponse({ models: [] });
      if (!generateOk) throw timeoutError();
      return jsonResponse({ done: true });
    });

    await ollamaReadiness({ force: true });
    await ollamaReadiness({ force: true });
    expect((await ollamaReadiness()).generates).toBe(false);

    generateOk = true;
    const recovered = await ollamaReadiness({ force: true });
    expect(recovered.generates).toBe(true);
    expect(recovered.degraded).toBe(false);
    expect(recovered.pendingFailures).toBe(0);
  });
});

describe('ReadinessHysteresis', () => {
  const ok: OllamaReadiness = { reachable: true, generates: true, model: 'synthetic-model:1b' };
  const bad: OllamaReadiness = {
    reachable: true,
    generates: false,
    model: 'synthetic-model:1b',
    reason: 'did not generate within 10 s',
  };

  it('reports a cold-start failure immediately — there is no last-known-good to serve', () => {
    const m = new ReadinessHysteresis();
    const r = m.observe(bad);
    expect(r.generates).toBe(false);
    expect(r.degraded).toBe(false);
    expect(r.pendingFailures).toBe(1);
  });

  it('holds last-known-good for one failure and flips on the second', () => {
    const m = new ReadinessHysteresis();
    m.observe(ok);
    expect(m.observe(bad)).toMatchObject({ generates: true, degraded: true, pendingFailures: 1 });
    expect(m.observe(bad)).toMatchObject({ generates: false, degraded: false, pendingFailures: 2 });
  });

  it('recovers on one success and resets the failure count', () => {
    const m = new ReadinessHysteresis();
    m.observe(ok);
    m.observe(bad);
    m.observe(bad);
    expect(m.observe(ok)).toMatchObject({ generates: true, degraded: false, pendingFailures: 0 });
    expect(m.observe(bad)).toMatchObject({ generates: true, degraded: true, pendingFailures: 1 });
  });

  it('carries the failing probe reason as pendingReason while degraded', () => {
    const m = new ReadinessHysteresis();
    m.observe(ok);
    expect(m.observe(bad).pendingReason).toBe('did not generate within 10 s');
  });

  it('survives a module re-evaluation via snapshot/restore', () => {
    // The N-4 flap: a second evaluation of the module (dev HMR) starts with an
    // empty machine, hits the cold-start rule, and reports not-ready on the
    // first failure. Restoring the persisted snapshot keeps the LKG.
    const first = new ReadinessHysteresis();
    first.observe(ok);
    const persisted = first.snapshot();

    const second = new ReadinessHysteresis();
    second.restore(persisted);
    expect(second.observe(bad)).toMatchObject({ generates: true, degraded: true, pendingFailures: 1 });
  });

  it('reset() clears the last-known-good', () => {
    const m = new ReadinessHysteresis();
    m.observe(ok);
    m.reset();
    expect(m.observe(bad)).toMatchObject({ generates: false, degraded: false, pendingFailures: 1 });
  });
});
