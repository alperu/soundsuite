/**
 * Unit tests for OpenAIEmbeddingProvider
 * 
 * Tests the OpenAI-based embedding provider including:
 * - Model configuration and validation
 * - API key validation
 * - Embedding generation
 * - Batching logic
 * - Rate limiting and retry logic
 * - Error handling
 */

import { OpenAIEmbeddingProvider } from '../openai-embedding-provider';
import OpenAI from 'openai';

// Mock the OpenAI client
jest.mock('openai');

describe('OpenAIEmbeddingProvider', () => {
  let mockClient: jest.Mocked<OpenAI>;
  let mockEmbeddings: jest.Mocked<OpenAI['embeddings']>;

  beforeEach(() => {
    jest.clearAllMocks();

    // Create mock embeddings API
    mockEmbeddings = {
      create: jest.fn(),
    } as any;

    // Create mock OpenAI client
    mockClient = {
      embeddings: mockEmbeddings,
    } as any;

    // Mock the OpenAI constructor
    (OpenAI as jest.MockedClass<typeof OpenAI>).mockImplementation(() => mockClient);
  });

  describe('constructor', () => {
    it('should create provider with default model', () => {
      const provider = new OpenAIEmbeddingProvider('test-api-key');
      expect(provider).toBeInstanceOf(OpenAIEmbeddingProvider);
      expect(provider.getDimensions()).toBe(1536); // text-embedding-3-small
    });

    it('should create provider with specified model', () => {
      const provider = new OpenAIEmbeddingProvider('test-api-key', 'text-embedding-3-large');
      expect(provider).toBeInstanceOf(OpenAIEmbeddingProvider);
      expect(provider.getDimensions()).toBe(3072);
    });

    it('should throw error if API key is missing', () => {
      expect(() => new OpenAIEmbeddingProvider('')).toThrow('OpenAI API key is required');
    });

    it('should throw error for unsupported model', () => {
      expect(() => new OpenAIEmbeddingProvider('test-api-key', 'invalid-model')).toThrow(
        'Unsupported model: invalid-model'
      );
    });
  });

  describe('getAvailableModels', () => {
    it('should return list of available models', () => {
      const provider = new OpenAIEmbeddingProvider('test-api-key');
      const models = provider.getAvailableModels();

      expect(models).toContain('text-embedding-3-small');
      expect(models).toContain('text-embedding-3-large');
      expect(models).toContain('text-embedding-ada-002');
      expect(models.length).toBe(3);
    });
  });

  describe('getDimensions', () => {
    it('should return correct dimensions for text-embedding-3-small', () => {
      const provider = new OpenAIEmbeddingProvider('test-api-key', 'text-embedding-3-small');
      expect(provider.getDimensions()).toBe(1536);
    });

    it('should return correct dimensions for text-embedding-3-large', () => {
      const provider = new OpenAIEmbeddingProvider('test-api-key', 'text-embedding-3-large');
      expect(provider.getDimensions()).toBe(3072);
    });

    it('should return correct dimensions for text-embedding-ada-002', () => {
      const provider = new OpenAIEmbeddingProvider('test-api-key', 'text-embedding-ada-002');
      expect(provider.getDimensions()).toBe(1536);
    });
  });

  describe('embed', () => {
    it('should return empty array for empty input', async () => {
      const provider = new OpenAIEmbeddingProvider('test-api-key');
      const result = await provider.embed([]);
      expect(result).toEqual([]);
      expect(mockEmbeddings.create).not.toHaveBeenCalled();
    });

    it('should generate embeddings for single text', async () => {
      const provider = new OpenAIEmbeddingProvider('test-api-key');
      const mockEmbedding = new Array(1536).fill(0.1);

      mockEmbeddings.create.mockResolvedValue({
        data: [{ embedding: mockEmbedding, index: 0 }],
        model: 'text-embedding-3-small',
        usage: { prompt_tokens: 10, total_tokens: 10 },
        object: 'list',
      } as any);

      const result = await provider.embed(['test text']);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(mockEmbedding);
      expect(mockEmbeddings.create).toHaveBeenCalledWith({
        model: 'text-embedding-3-small',
        input: ['test text'],
        encoding_format: 'float',
      });
    });

    it('should generate embeddings for multiple texts', async () => {
      const provider = new OpenAIEmbeddingProvider('test-api-key');
      const mockEmbedding1 = new Array(1536).fill(0.1);
      const mockEmbedding2 = new Array(1536).fill(0.2);

      mockEmbeddings.create.mockResolvedValue({
        data: [
          { embedding: mockEmbedding1, index: 0 },
          { embedding: mockEmbedding2, index: 1 },
        ],
        model: 'text-embedding-3-small',
        usage: { prompt_tokens: 20, total_tokens: 20 },
        object: 'list',
      } as any);

      const result = await provider.embed(['text 1', 'text 2']);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(mockEmbedding1);
      expect(result[1]).toEqual(mockEmbedding2);
    });

    it('should handle embeddings returned in wrong order', async () => {
      const provider = new OpenAIEmbeddingProvider('test-api-key');
      const mockEmbedding1 = new Array(1536).fill(0.1);
      const mockEmbedding2 = new Array(1536).fill(0.2);

      // Return embeddings in reverse order
      mockEmbeddings.create.mockResolvedValue({
        data: [
          { embedding: mockEmbedding2, index: 1 },
          { embedding: mockEmbedding1, index: 0 },
        ],
        model: 'text-embedding-3-small',
        usage: { prompt_tokens: 20, total_tokens: 20 },
        object: 'list',
      } as any);

      const result = await provider.embed(['text 1', 'text 2']);

      // Should be sorted by index
      expect(result[0]).toEqual(mockEmbedding1);
      expect(result[1]).toEqual(mockEmbedding2);
    });

    it('should batch embeddings (100 chunks per batch)', async () => {
      const provider = new OpenAIEmbeddingProvider('test-api-key');
      const texts = new Array(250).fill('test text');

      // Mock responses for each batch
      mockEmbeddings.create.mockImplementation(async (params: any) => {
        const batchSize = params.input.length;
        return {
          data: Array.from({ length: batchSize }, (_, i) => ({
            embedding: new Array(1536).fill(0.1),
            index: i,
          })),
          model: 'text-embedding-3-small',
          usage: { prompt_tokens: batchSize * 10, total_tokens: batchSize * 10 },
          object: 'list',
        } as any;
      });

      const result = await provider.embed(texts);

      expect(result).toHaveLength(250);
      // Should be called 3 times: 100 + 100 + 50
      expect(mockEmbeddings.create).toHaveBeenCalledTimes(3);
    });
  });

  describe('error handling', () => {
    it('should throw error for invalid API key (401)', async () => {
      const provider = new OpenAIEmbeddingProvider('invalid-key');

      mockEmbeddings.create.mockRejectedValue({
        status: 401,
        message: 'Unauthorized',
      });

      await expect(provider.embed(['test'])).rejects.toThrow('Invalid OpenAI API key');
    });

    it('should throw error for rate limit (429)', async () => {
      const provider = new OpenAIEmbeddingProvider('test-api-key');

      mockEmbeddings.create.mockRejectedValue({
        status: 429,
        message: 'Rate limit exceeded',
      });

      await expect(provider.embed(['test'])).rejects.toThrow(
        'Failed to generate embeddings after 3 attempts'
      );

      // Should retry 3 times
      expect(mockEmbeddings.create).toHaveBeenCalledTimes(3);
    });

    it('should throw error for service unavailable (503)', async () => {
      const provider = new OpenAIEmbeddingProvider('test-api-key');

      mockEmbeddings.create.mockRejectedValue({
        status: 503,
        message: 'Service unavailable',
      });

      await expect(provider.embed(['test'])).rejects.toThrow(
        'Failed to generate embeddings after 3 attempts'
      );

      // Should retry 3 times
      expect(mockEmbeddings.create).toHaveBeenCalledTimes(3);
    });

    it('should not retry on client errors (4xx except 429)', async () => {
      const provider = new OpenAIEmbeddingProvider('test-api-key');

      mockEmbeddings.create.mockRejectedValue({
        status: 400,
        message: 'Bad request',
      });

      await expect(provider.embed(['test'])).rejects.toThrow('OpenAI API error');

      // Should not retry
      expect(mockEmbeddings.create).toHaveBeenCalledTimes(1);
    });

    it('should retry and succeed on transient error', async () => {
      const provider = new OpenAIEmbeddingProvider('test-api-key');
      const mockEmbedding = new Array(1536).fill(0.1);

      // Fail twice, then succeed
      mockEmbeddings.create
        .mockRejectedValueOnce({
          status: 503,
          message: 'Service unavailable',
        })
        .mockRejectedValueOnce({
          status: 503,
          message: 'Service unavailable',
        })
        .mockResolvedValueOnce({
          data: [{ embedding: mockEmbedding, index: 0 }],
          model: 'text-embedding-3-small',
          usage: { prompt_tokens: 10, total_tokens: 10 },
          object: 'list',
        } as any);

      const result = await provider.embed(['test']);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(mockEmbedding);
      expect(mockEmbeddings.create).toHaveBeenCalledTimes(3);
    });
  });

  describe('rate limiting', () => {
    it('should respect Retry-After header', async () => {
      const provider = new OpenAIEmbeddingProvider('test-api-key');

      // Mock rate limit error with Retry-After header
      mockEmbeddings.create.mockRejectedValue({
        status: 429,
        message: 'Rate limit exceeded',
        headers: { 'retry-after': '2' }, // 2 seconds
      });

      const startTime = Date.now();
      await expect(provider.embed(['test'])).rejects.toThrow(
        'Failed to generate embeddings after 3 attempts'
      );
      const duration = Date.now() - startTime;

      // Should wait at least 2 seconds between first 2 retries (no wait after last attempt)
      // Total: 2s (after attempt 1) + 2s (after attempt 2) = 4s, but we allow margin for timing
      expect(duration).toBeGreaterThanOrEqual(3000);
    });

    it('should cap Retry-After at 60 seconds', async () => {
      const provider = new OpenAIEmbeddingProvider('test-api-key');

      // Mock rate limit error with very long Retry-After
      mockEmbeddings.create.mockRejectedValue({
        status: 429,
        message: 'Rate limit exceeded',
        headers: { 'retry-after': '120' }, // 120 seconds
      });

      const startTime = Date.now();
      await expect(provider.embed(['test'])).rejects.toThrow(
        'Failed to generate embeddings after 3 attempts'
      );
      const duration = Date.now() - startTime;

      // Should cap at 60 seconds per retry (2 retries = 120 seconds total)
      expect(duration).toBeLessThan(130000); // Allow some margin
    });
  });

  describe('exponential backoff', () => {
    it('should use exponential backoff for retries', async () => {
      const provider = new OpenAIEmbeddingProvider('test-api-key');

      mockEmbeddings.create.mockRejectedValue({
        status: 503,
        message: 'Service unavailable',
      });

      const startTime = Date.now();
      await expect(provider.embed(['test'])).rejects.toThrow(
        'Failed to generate embeddings after 3 attempts'
      );
      const duration = Date.now() - startTime;

      // Should wait 1s + 2s = 3s total (exponential backoff: 1s, 2s, 4s but only 2 waits)
      expect(duration).toBeGreaterThanOrEqual(3000);
      expect(duration).toBeLessThan(5000); // Allow some margin
    });
  });
});
