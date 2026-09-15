/**
 * @jest-environment node
 *
 * Unit tests for OpenRouterEmbeddingProvider.
 *
 * The shared OpenRouter client (`@/lib/openrouter/client`) is mocked — these
 * tests never touch the network. Focus areas per the dimension-safety
 * contract: correct dims per model, a wrong-width response throwing rather
 * than returning, and pinProvider always present in the request.
 */

import { OpenRouterEmbeddingProvider } from '../openrouter-embedding-provider';
import { embed as openRouterEmbed, OpenRouterError } from '@/lib/openrouter/client';

jest.mock('@/lib/openrouter/client', () => {
  const actual = jest.requireActual('@/lib/openrouter/client');
  return {
    ...actual,
    embed: jest.fn(),
  };
});

const mockEmbed = openRouterEmbed as jest.MockedFunction<typeof openRouterEmbed>;

// Synthetic fixture texts — no case-identifying content.
const SYNTHETIC_TEXTS = ['motion.pdf excerpt one', 'motion.pdf excerpt two'];

function fakeVectors(n: number, dims: number): number[][] {
  return Array.from({ length: n }, (_, i) => Array.from({ length: dims }, (_, j) => (i + j) / 1000));
}

describe('OpenRouterEmbeddingProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('throws for an unsupported model id', () => {
      expect(() => new OpenRouterEmbeddingProvider({ model: 'not/a-real-model' })).toThrow(
        /Unsupported OpenRouter embedding model/,
      );
    });

    it('resolves dims from the curated catalogue for the 4b model', () => {
      const provider = new OpenRouterEmbeddingProvider({ model: 'qwen/qwen3-embedding-4b' });
      expect(provider.getDimensions()).toBe(2560);
    });

    it('resolves dims from the curated catalogue for the 8b model', () => {
      const provider = new OpenRouterEmbeddingProvider({ model: 'qwen/qwen3-embedding-8b' });
      expect(provider.getDimensions()).toBe(4096);
    });
  });

  describe('embed — dimension correctness', () => {
    it('returns 2560-dim vectors for the 4b model', async () => {
      mockEmbed.mockResolvedValue({
        vectors: fakeVectors(2, 2560),
        model: 'qwen/qwen3-embedding-4b',
        dims: 2560,
        totalTokens: 42,
      });

      const provider = new OpenRouterEmbeddingProvider({ model: 'qwen/qwen3-embedding-4b' });
      const vectors = await provider.embed(SYNTHETIC_TEXTS);

      expect(vectors).toHaveLength(2);
      expect(vectors[0]).toHaveLength(2560);
    });

    it('returns 4096-dim vectors for the 8b model', async () => {
      mockEmbed.mockResolvedValue({
        vectors: fakeVectors(2, 4096),
        model: 'qwen/qwen3-embedding-8b',
        dims: 4096,
        totalTokens: 42,
      });

      const provider = new OpenRouterEmbeddingProvider({ model: 'qwen/qwen3-embedding-8b' });
      const vectors = await provider.embed(SYNTHETIC_TEXTS);

      expect(vectors).toHaveLength(2);
      expect(vectors[0]).toHaveLength(4096);
    });

    it('propagates rather than swallows a wrong-width response (the underlying client throws)', async () => {
      // The real embed() enforces expectedDims and throws before returning.
      // Simulate that contract here: the mock rejects the way the real
      // client would when a provider silently returns the wrong width.
      mockEmbed.mockRejectedValue(
        new OpenRouterError(
          'OpenRouter model qwen/qwen3-embedding-4b returned 1024-dim vectors but 2560 was expected. ' +
            'Refusing to continue — writing these would corrupt or destroy the target vector table.',
          500,
          'server',
        ),
      );

      const provider = new OpenRouterEmbeddingProvider({ model: 'qwen/qwen3-embedding-4b' });
      await expect(provider.embed(SYNTHETIC_TEXTS)).rejects.toThrow(/dim vectors but 2560 was expected/);
    });

    it('returns [] for empty input without calling the client', async () => {
      const provider = new OpenRouterEmbeddingProvider({ model: 'qwen/qwen3-embedding-4b' });
      const vectors = await provider.embed([]);
      expect(vectors).toEqual([]);
      expect(mockEmbed).not.toHaveBeenCalled();
    });
  });

  describe('embed — request shape', () => {
    it('always passes pinProvider and expectedDims for the 4b model', async () => {
      mockEmbed.mockResolvedValue({
        vectors: fakeVectors(2, 2560),
        model: 'qwen/qwen3-embedding-4b',
        dims: 2560,
      });

      const provider = new OpenRouterEmbeddingProvider({ model: 'qwen/qwen3-embedding-4b' });
      await provider.embed(SYNTHETIC_TEXTS);

      expect(mockEmbed).toHaveBeenCalledWith(
        SYNTHETIC_TEXTS,
        'qwen/qwen3-embedding-4b',
        expect.objectContaining({ pinProvider: 'DeepInfra', expectedDims: 2560 }),
      );
    });

    it('always passes pinProvider and expectedDims for the 8b model', async () => {
      mockEmbed.mockResolvedValue({
        vectors: fakeVectors(2, 4096),
        model: 'qwen/qwen3-embedding-8b',
        dims: 4096,
      });

      const provider = new OpenRouterEmbeddingProvider({ model: 'qwen/qwen3-embedding-8b' });
      await provider.embed(SYNTHETIC_TEXTS);

      expect(mockEmbed).toHaveBeenCalledWith(
        SYNTHETIC_TEXTS,
        'qwen/qwen3-embedding-8b',
        expect.objectContaining({ pinProvider: 'DeepInfra', expectedDims: 4096 }),
      );
    });
  });

  describe('getModelName / getAvailableModels', () => {
    it('prefixes the model name with openrouter/', () => {
      const provider = new OpenRouterEmbeddingProvider({ model: 'qwen/qwen3-embedding-4b' });
      expect(provider.getModelName()).toBe('openrouter/qwen/qwen3-embedding-4b');
    });

    it('lists the curated catalogue as available models', () => {
      const provider = new OpenRouterEmbeddingProvider({ model: 'qwen/qwen3-embedding-4b' });
      expect(provider.getAvailableModels()).toContain('qwen/qwen3-embedding-4b');
      expect(provider.getAvailableModels()).toContain('qwen/qwen3-embedding-8b');
    });
  });
});
