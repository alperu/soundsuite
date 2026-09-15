/** @jest-environment node */
/**
 * Unit tests for the OpenRouter client (src/lib/openrouter/client.ts).
 *
 * No global mocks exist in this repo (see CLAUDE.md) — `@/lib/db/config` and
 * global `fetch` are mocked in-suite. NEVER make a live network call here:
 * any OpenRouter key configured for local dev is temporary, and a live test
 * would rot the moment it expires or the catalogue changes.
 *
 * Synthetic fixtures only (CLAUDE.md § Privacy) — none needed here, this
 * module has no case-identifying surface.
 */

const getConfig = jest.fn();

jest.mock('@/lib/db/config', () => ({ getConfig: () => getConfig() }));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import {
  redactKey,
  embed,
  validateModel,
  assertDimensionCompatible,
  assertSpendAllowed,
  recordSpend,
  getSpendToday,
  circuitOpen,
  __resetSpendForTest,
  OpenRouterError,
} from '../client';

function jsonResponse(status: number, body: unknown): Response {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  } as unknown as Response;
}

const withKey = (overrides: Record<string, unknown> = {}) => ({
  openRouterApiKey: 'sk-or-v1-abcdefghijklmnopqrstuvwxyz',
  openRouterDailyCapUsd: {},
  ...overrides,
});

describe('redactKey', () => {
  it('never returns the full key', () => {
    const key = 'sk-or-v1-abcdefghijklmnopqrstuvwxyz';
    const redacted = redactKey(key);
    expect(redacted).not.toBe(key);
    expect(redacted).not.toContain(key.slice(10, -4));
  });

  it('handles undefined input', () => {
    expect(redactKey(undefined)).toBe('(unset)');
  });

  it('handles null input', () => {
    expect(redactKey(null)).toBe('(unset)');
  });

  it('handles short input without throwing or leaking it whole', () => {
    expect(redactKey('short')).toBe('****');
  });
});

describe('embed()', () => {
  beforeEach(() => {
    __resetSpendForTest();
    getConfig.mockReset();
    getConfig.mockResolvedValue(withKey());
    (global as any).fetch = jest.fn();
  });

  it('pins the provider with allow_fallbacks:false when pinProvider is given', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      jsonResponse(200, { data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }] }),
    );

    await embed(['hello'], 'qwen/qwen3-embedding-4b', { pinProvider: 'DeepInfra' });

    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.provider).toEqual({ order: ['DeepInfra'], allow_fallbacks: false });
  });

  it('omits provider pinning when no pinProvider is given', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      jsonResponse(200, { data: [{ embedding: [0.1, 0.2], index: 0 }] }),
    );

    await embed(['hello'], 'qwen/qwen3-embedding-4b');

    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.provider).toBeUndefined();
  });

  it('throws when the returned width does not match expectedDims', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      jsonResponse(200, { data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }] }), // 3 dims
    );

    await expect(
      embed(['hello'], 'qwen/qwen3-embedding-4b', { pinProvider: 'DeepInfra', expectedDims: 2560 }),
    ).rejects.toThrow(OpenRouterError);
  });

  it('does not throw when returned width matches expectedDims', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      jsonResponse(200, { data: [{ embedding: [0.1, 0.2], index: 0 }] }),
    );

    await expect(
      embed(['hello'], 'qwen/qwen3-embedding-4b', { expectedDims: 2 }),
    ).resolves.toMatchObject({ dims: 2 });
  });
});

describe('assertDimensionCompatible()', () => {
  it('throws on a dimension mismatch', () => {
    expect(() =>
      assertDimensionCompatible(2560, 1024, { model: 'qwen/qwen3-embedding-4b', table: 'chunks' }),
    ).toThrow(/dimension mismatch/i);
  });

  it('passes when tableDims is null (new/empty table)', () => {
    expect(() =>
      assertDimensionCompatible(2560, null, { model: 'qwen/qwen3-embedding-4b', table: 'chunks' }),
    ).not.toThrow();
  });

  it('passes when dims match', () => {
    expect(() =>
      assertDimensionCompatible(2560, 2560, { model: 'qwen/qwen3-embedding-4b', table: 'chunks' }),
    ).not.toThrow();
  });
});

describe('error classification', () => {
  beforeEach(() => {
    __resetSpendForTest();
    getConfig.mockReset();
    getConfig.mockResolvedValue(withKey());
    (global as any).fetch = jest.fn();
  });

  it('classifies 404 "No endpoints found" as no-providers', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      jsonResponse(404, { error: { message: 'No endpoints found for model' } }),
    );
    await expect(embed(['x'], 'some/model')).rejects.toMatchObject({ kind: 'no-providers' });
  });

  it('classifies 400 "does not exist" as unknown-model', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      jsonResponse(400, { error: { message: 'model does not exist' } }),
    );
    await expect(embed(['x'], 'some/bogus-model')).rejects.toMatchObject({ kind: 'unknown-model' });
  });

  it('classifies 401 as auth', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse(401, { error: { message: 'unauthorized' } }));
    await expect(embed(['x'], 'some/model')).rejects.toMatchObject({ kind: 'auth' });
  });
});

describe('spend guard', () => {
  beforeEach(() => {
    __resetSpendForTest();
    getConfig.mockReset();
  });

  it('blocks once the daily cap is exceeded', async () => {
    getConfig.mockResolvedValue(withKey({ openRouterDailyCapUsd: { embedding: 1 } }));
    recordSpend('embedding', 1.5);
    await expect(assertSpendAllowed('embedding')).rejects.toMatchObject({ kind: 'rate-limit' });
  });

  it('allows when under the daily cap', async () => {
    getConfig.mockResolvedValue(withKey({ openRouterDailyCapUsd: { embedding: 10 } }));
    recordSpend('embedding', 1);
    await expect(assertSpendAllowed('embedding')).resolves.toBeUndefined();
  });

  it('allows when no cap is configured for the role', async () => {
    getConfig.mockResolvedValue(withKey({ openRouterDailyCapUsd: {} }));
    recordSpend('embedding', 1000);
    await expect(assertSpendAllowed('embedding')).resolves.toBeUndefined();
  });

  it('tracks spend per role via getSpendToday', () => {
    recordSpend('embedding', 0.5);
    recordSpend('reranker', 0.25);
    expect(getSpendToday('embedding')).toBeCloseTo(0.5);
    expect(getSpendToday('reranker')).toBeCloseTo(0.25);
    expect(getSpendToday()).toBeCloseTo(0.75);
  });

  it('opens the circuit breaker after 5 consecutive failures', async () => {
    getConfig.mockResolvedValue(withKey());
    (global as any).fetch = jest.fn().mockResolvedValue(
      jsonResponse(500, { error: { message: 'upstream error' } }),
    );

    expect(circuitOpen()).toBe(false);
    for (let i = 0; i < 5; i++) {
      await expect(embed(['x'], 'some/model')).rejects.toThrow();
    }
    expect(circuitOpen()).toBe(true);

    // Once open, the very next call is rejected by the breaker itself, not a
    // fresh network call.
    (global.fetch as jest.Mock).mockClear();
    await expect(embed(['x'], 'some/model')).rejects.toMatchObject({ kind: 'server' });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('validateModel()', () => {
  beforeEach(() => {
    (global as any).fetch = jest.fn();
  });

  it('returns available:false with reason no-providers for an empty endpoints array', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse(200, { data: { endpoints: [] } }));
    const result = await validateModel('qwen/qwen3-reranker-0.6b');
    expect(result).toMatchObject({ available: false, reason: 'no-providers', providers: [] });
  });

  it('returns available:true with providers and price when endpoints exist', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      jsonResponse(200, {
        data: {
          endpoints: [
            { provider_name: 'DeepInfra', pricing: { prompt: '0.00000002' } },
            { provider_name: 'Fireworks', pricing: { prompt: '0.00000005' } },
          ],
        },
      }),
    );
    const result = await validateModel('qwen/qwen3-embedding-4b');
    expect(result.available).toBe(true);
    expect(result.providers).toEqual(['DeepInfra', 'Fireworks']);
    expect(result.pricePerMTokens).toBeCloseTo(0.02, 2);
  });

  it('returns reason unknown-model on a 400 "does not exist" response', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      jsonResponse(400, { error: { message: 'model does not exist' } }),
    );
    const result = await validateModel('bogus/model');
    expect(result).toMatchObject({ available: false, reason: 'unknown-model' });
  });
});

/**
 * Spend RECORDING (distinct from the spend guard above, which only reads the
 * total). This lives in the client rather than in each caller: `rerank()` in
 * reranker.ts used to do its own accounting, which meant embeddings and chat
 * were never charged and their daily caps could never be reached. Centralising
 * it is what makes `assertSpendAllowed()` more than decorative.
 *
 * Prices come from the curated catalogue, NOT from the `/endpoints` API, which
 * reports `prompt: "0"` for rerank and would silently charge nothing.
 */
describe('spend recording', () => {
  beforeEach(() => {
    __resetSpendForTest();
    getConfig.mockResolvedValue(withKey());
  });

  it('charges an embedding call at the curated per-M rate', async () => {
    // qwen3-embedding-4b is $0.02/M; 1M tokens => $0.02
    (global.fetch as jest.Mock) = jest.fn().mockResolvedValue(
      jsonResponse(200, {
        data: [{ index: 0, embedding: new Array(2560).fill(0.1) }],
        usage: { total_tokens: 1_000_000 },
      }),
    );
    await embed(['synthetic fixture text'], 'qwen/qwen3-embedding-4b', {
      pinProvider: 'DeepInfra',
      expectedDims: 2560,
      role: 'embedding',
    });
    expect(getSpendToday('embedding')).toBeCloseTo(0.02, 6);
  });

  it('does not charge when the response reports no usage', async () => {
    (global.fetch as jest.Mock) = jest.fn().mockResolvedValue(
      jsonResponse(200, { data: [{ index: 0, embedding: new Array(2560).fill(0.1) }] }),
    );
    await embed(['synthetic fixture text'], 'qwen/qwen3-embedding-4b', {
      pinProvider: 'DeepInfra',
      expectedDims: 2560,
      role: 'embedding',
    });
    expect(getSpendToday('embedding')).toBe(0);
  });

  it('accumulates across calls so a daily cap is actually reachable', async () => {
    (global.fetch as jest.Mock) = jest.fn().mockResolvedValue(
      jsonResponse(200, {
        data: [{ index: 0, embedding: new Array(2560).fill(0.1) }],
        usage: { total_tokens: 1_000_000 },
      }),
    );
    const args = ['qwen/qwen3-embedding-4b', { pinProvider: 'DeepInfra', expectedDims: 2560, role: 'embedding' }] as const;
    await embed(['a'], ...args);
    await embed(['b'], ...args);
    expect(getSpendToday('embedding')).toBeCloseTo(0.04, 6);

    // And once past the cap the guard refuses — the loop that bills forever
    // is exactly the failure this pairing prevents.
    getConfig.mockResolvedValue(withKey({ openRouterDailyCapUsd: { embedding: 0.03 } }));
    await expect(assertSpendAllowed('embedding')).rejects.toThrow(/daily cap reached/i);
  });
});
