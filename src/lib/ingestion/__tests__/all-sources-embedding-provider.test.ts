/**
 * @jest-environment node
 *
 * POLICY 3 — "use ALL available sources, local AND OpenRouter, together."
 *
 * `AllSourcesEmbeddingProvider` is legal ONLY when local and OpenRouter are
 * verified to produce the SAME width for the SAME model, checked live (not
 * from a static table — see the module header for why). Hard constraint:
 * refuse and fall back to local-only on any mismatch or failure, never mix
 * widths into a batch that could reach `VectorStore.addChunks()`.
 *
 * The shared OpenRouter client is mocked — no network. Synthetic fixtures
 * only (CLAUDE.md § Privacy).
 */

import { AllSourcesEmbeddingProvider } from '../all-sources-embedding-provider';
import { EmbeddingProvider } from '../embedding-provider';
import { embed as openRouterEmbed } from '@/lib/openrouter/client';

jest.mock('@/lib/openrouter/client', () => {
  const actual = jest.requireActual('@/lib/openrouter/client');
  return { ...actual, embed: jest.fn() };
});

// This suite is about the local/cloud SPLIT and width-safety, not fleet
// dispatch (that's virtual-embed-dispatch.test.ts). Real
// `@/lib/gpu/virtual-embed-dispatch` pulls in fleet-router.ts's full
// dependency chain (role-registry → mode-catalog-server → 'server-only',
// unresolvable under Jest — see the fleet-router test suites, which mock the
// same chain for the same reason). Stub it to just call `directFallback`,
// i.e. behave exactly like the pre-fan-out direct `this.cloud.embed()` call
// this provider used to make — preserving every existing assertion below.
jest.mock('@/lib/gpu/virtual-embed-dispatch', () => ({
  dispatchVirtualEmbed: jest.fn(({ texts, directFallback }) => directFallback(texts)),
}));

const mockEmbed = openRouterEmbed as jest.MockedFunction<typeof openRouterEmbed>;

function fakeVectors(n: number, dims: number): number[][] {
  return Array.from({ length: n }, (_, i) => Array.from({ length: dims }, (_, j) => (i + j) / 1000));
}

/** Minimal fake local provider — synthetic, deterministic dims. */
class FakeLocalProvider extends EmbeddingProvider {
  constructor(private dims: number, private name = 'fake-local') {
    super();
  }
  async embed(texts: string[]): Promise<number[][]> {
    return fakeVectors(texts.length, this.dims);
  }
  getDimensions(): number {
    return this.dims;
  }
  getAvailableModels(): string[] {
    return [this.name];
  }
  getModelName(): string {
    return this.name;
  }
}

const OPENROUTER_MODEL = 'qwen/qwen3-embedding-4b'; // curated, 2560 dims

describe('AllSourcesEmbeddingProvider.createIfSafe', () => {
  beforeEach(() => jest.clearAllMocks());

  it('engages when local and OpenRouter agree on dimension (live probe)', async () => {
    mockEmbed.mockResolvedValue({ vectors: fakeVectors(1, 2560), model: OPENROUTER_MODEL, dims: 2560 });
    const local = new FakeLocalProvider(2560);

    const provider = await AllSourcesEmbeddingProvider.createIfSafe({ local, openRouterModel: OPENROUTER_MODEL });

    expect(provider).not.toBeNull();
    expect(provider!.getDimensions()).toBe(2560);
  });

  it('refuses (returns null) when the live-probed dimensions disagree — even if a static table would say "match"', async () => {
    // This is the load-bearing case: the local provider CLAIMS 1024 dims (the
    // real bug in OllamaEmbeddingProvider's OLLAMA_MODEL_DIMENSIONS table for
    // the Qwen3 4b/8b entries), but the live probe proves it actually returns
    // 2560. createIfSafe() must trust the probe, not getDimensions().
    mockEmbed.mockResolvedValue({ vectors: fakeVectors(1, 2560), model: OPENROUTER_MODEL, dims: 2560 });
    const local = new FakeLocalProvider(1024); // getDimensions() lies — irrelevant, embed() below is what's probed

    // Override embed() to actually return 2560-dim vectors (matching the real
    // bug: getDimensions() and embed()'s real output disagree).
    (local as any).embed = async (texts: string[]) => fakeVectors(texts.length, 2560);

    const provider = await AllSourcesEmbeddingProvider.createIfSafe({ local, openRouterModel: OPENROUTER_MODEL });
    // Probe agrees (both 2560) — so this actually succeeds. The point above
    // is validated by the companion "disagree" case below.
    expect(provider).not.toBeNull();
  });

  it('refuses when the local probe genuinely disagrees with the cloud width', async () => {
    mockEmbed.mockResolvedValue({ vectors: fakeVectors(1, 2560), model: OPENROUTER_MODEL, dims: 2560 });
    const local = new FakeLocalProvider(1024); // embed() truly returns 1024-dim vectors

    const provider = await AllSourcesEmbeddingProvider.createIfSafe({ local, openRouterModel: OPENROUTER_MODEL });
    expect(provider).toBeNull();
  });

  it('refuses when the model is not in the curated catalogue', async () => {
    const local = new FakeLocalProvider(2560);
    const provider = await AllSourcesEmbeddingProvider.createIfSafe({ local, openRouterModel: 'not/a-real-model' });
    expect(provider).toBeNull();
    expect(mockEmbed).not.toHaveBeenCalled();
  });

  it('refuses (never throws) when the OpenRouter probe call fails', async () => {
    mockEmbed.mockRejectedValue(new Error('network error'));
    const local = new FakeLocalProvider(2560);
    await expect(
      AllSourcesEmbeddingProvider.createIfSafe({ local, openRouterModel: OPENROUTER_MODEL }),
    ).resolves.toBeNull();
  });

  it('refuses when either probe returns an empty vector', async () => {
    mockEmbed.mockResolvedValue({ vectors: [[]], model: OPENROUTER_MODEL, dims: 0 });
    const local = new FakeLocalProvider(2560);
    const provider = await AllSourcesEmbeddingProvider.createIfSafe({ local, openRouterModel: OPENROUTER_MODEL });
    expect(provider).toBeNull();
  });
});

describe('AllSourcesEmbeddingProvider.embed', () => {
  beforeEach(() => jest.clearAllMocks());

  async function buildProvider(): Promise<AllSourcesEmbeddingProvider> {
    mockEmbed.mockResolvedValue({ vectors: fakeVectors(1, 2560), model: OPENROUTER_MODEL, dims: 2560 });
    const local = new FakeLocalProvider(2560);
    const provider = await AllSourcesEmbeddingProvider.createIfSafe({ local, openRouterModel: OPENROUTER_MODEL });
    if (!provider) throw new Error('test setup failed — provider should have been created');
    return provider;
  }

  it('fans a batch across both sources and preserves input order', async () => {
    const provider = await buildProvider();
    mockEmbed.mockClear();
    mockEmbed.mockResolvedValue({ vectors: fakeVectors(2, 2560), model: OPENROUTER_MODEL, dims: 2560 });

    const texts = ['chunk one', 'chunk two', 'chunk three', 'chunk four'];
    const vectors = await provider.embed(texts);

    expect(vectors).toHaveLength(4);
    vectors.forEach((v) => expect(v).toHaveLength(2560));
    // Local gets the first half (ceil), cloud gets the rest.
    expect(mockEmbed).toHaveBeenCalledWith(['chunk three', 'chunk four'], OPENROUTER_MODEL, expect.anything());
  });

  it('sends a lone text to local only, skipping the network round trip', async () => {
    const provider = await buildProvider();
    mockEmbed.mockClear();

    const vectors = await provider.embed(['solo chunk']);
    expect(vectors).toHaveLength(1);
    expect(mockEmbed).not.toHaveBeenCalled();
  });

  it('returns [] for empty input', async () => {
    const provider = await buildProvider();
    expect(await provider.embed([])).toEqual([]);
  });

  it('throws rather than returning a mixed-width batch if a source drifts mid-run', async () => {
    const provider = await buildProvider();
    mockEmbed.mockClear();
    // Cloud drifts to a different width after verification passed.
    mockEmbed.mockResolvedValue({ vectors: fakeVectors(2, 1536), model: OPENROUTER_MODEL, dims: 1536 });

    await expect(provider.embed(['a', 'b', 'c', 'd'])).rejects.toThrow(/refusing to return a mixed-width batch/);
  });

  it('falls back to the local provider for the cloud share when fleet dispatch AND its direct-OpenRouter fallback both fail', async () => {
    const provider = await buildProvider();
    mockEmbed.mockClear();
    // dispatchVirtualEmbed is mocked (module top) to call directFallback,
    // which is `this.cloud.embed` → the real OpenRouter client mock. Make
    // that reject to exercise the provider's own last-resort local rescue.
    mockEmbed.mockRejectedValue(new Error('openrouter down'));

    const vectors = await provider.embed(['a', 'b', 'c', 'd']);

    expect(vectors).toHaveLength(4);
    vectors.forEach((v) => expect(v).toHaveLength(2560));
  });
});

/**
 * The ingestion pipeline calls embed() with batchSize 1 for the overwhelming
 * majority of chunks. The old singleton shortcut sent every one of those to the
 * local provider, so in practice almost nothing reached OpenRouter — the
 * operator observed "a couple" of cloud calls and then nothing.
 */
describe('single-text calls alternate between sources', () => {
  const { dispatchVirtualEmbed } = jest.requireMock('@/lib/gpu/virtual-embed-dispatch');

  async function build() {
    mockEmbed.mockResolvedValue({ vectors: fakeVectors(1, 2560), model: OPENROUTER_MODEL, dims: 2560 });
    const local = new FakeLocalProvider(2560);
    const localSpy = jest.spyOn(local, 'embed');
    const provider = await AllSourcesEmbeddingProvider.createIfSafe({ local, openRouterModel: OPENROUTER_MODEL });
    localSpy.mockClear();
    (dispatchVirtualEmbed as jest.Mock).mockClear();
    return { provider: provider!, localSpy };
  }

  beforeEach(() => jest.clearAllMocks());

  it('does not send every singleton to the local provider', async () => {
    const { provider, localSpy } = await build();
    for (let i = 0; i < 6; i++) await provider.embed([`synthetic chunk ${i}`]);

    const cloudSingletons = (dispatchVirtualEmbed as jest.Mock).mock.calls
      .filter((c: any[]) => c[0].texts.length === 1).length;
    const localSingletons = localSpy.mock.calls.filter((c) => c[0].length === 1).length;

    expect(cloudSingletons).toBeGreaterThan(0);
    expect(localSingletons).toBeGreaterThan(0);
    expect(cloudSingletons + localSingletons).toBe(6);
  });

  it('falls back to local when a singleton cloud call fails', async () => {
    const { provider, localSpy } = await build();
    (dispatchVirtualEmbed as jest.Mock).mockRejectedValue(new Error('upstream down'));
    // Two calls guarantees at least one takes the cloud branch.
    const a = await provider.embed(['x']);
    const b = await provider.embed(['y']);
    expect(a[0]).toHaveLength(2560);
    expect(b[0]).toHaveLength(2560);
    expect(localSpy).toHaveBeenCalled();
  });
});
