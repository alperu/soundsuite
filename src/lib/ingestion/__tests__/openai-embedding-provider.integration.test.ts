/**
 * Integration tests for OpenAIEmbeddingProvider
 * 
 * These tests verify that the OpenAI provider correctly implements
 * the EmbeddingProvider interface and can be used interchangeably
 * with other providers.
 * 
 * Note: These tests use mocks and don't require a real API key.
 */

import { OpenAIEmbeddingProvider } from '../openai-embedding-provider';
import { EmbeddingProvider } from '../embedding-provider';
import OpenAI from 'openai';

// Mock the OpenAI client
jest.mock('openai');

describe('OpenAIEmbeddingProvider Integration', () => {
  let mockClient: jest.Mocked<OpenAI>;
  let mockEmbeddings: jest.Mocked<OpenAI['embeddings']>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockEmbeddings = {
      create: jest.fn(),
    } as any;

    mockClient = {
      embeddings: mockEmbeddings,
    } as any;

    (OpenAI as jest.MockedClass<typeof OpenAI>).mockImplementation(() => mockClient);
  });

  describe('EmbeddingProvider interface compliance', () => {
    it('should implement EmbeddingProvider abstract class', () => {
      const provider = new OpenAIEmbeddingProvider('test-api-key');
      expect(provider).toBeInstanceOf(EmbeddingProvider);
    });

    it('should have embed method', () => {
      const provider = new OpenAIEmbeddingProvider('test-api-key');
      expect(typeof provider.embed).toBe('function');
    });

    it('should have getDimensions method', () => {
      const provider = new OpenAIEmbeddingProvider('test-api-key');
      expect(typeof provider.getDimensions).toBe('function');
    });

    it('should have getAvailableModels method', () => {
      const provider = new OpenAIEmbeddingProvider('test-api-key');
      expect(typeof provider.getAvailableModels).toBe('function');
    });
  });

  describe('Polymorphic usage', () => {
    it('should work when assigned to EmbeddingProvider type', async () => {
      const provider: EmbeddingProvider = new OpenAIEmbeddingProvider('test-api-key');
      const mockEmbedding = new Array(1536).fill(0.1);

      mockEmbeddings.create.mockResolvedValue({
        data: [{ embedding: mockEmbedding, index: 0 }],
        model: 'text-embedding-3-small',
        usage: { prompt_tokens: 10, total_tokens: 10 },
        object: 'list',
      } as any);

      const result = await provider.embed(['test']);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(mockEmbedding);
    });

    it('should be interchangeable with other providers', () => {
      const providers: EmbeddingProvider[] = [
        new OpenAIEmbeddingProvider('test-api-key', 'text-embedding-3-small'),
        new OpenAIEmbeddingProvider('test-api-key', 'text-embedding-3-large'),
        new OpenAIEmbeddingProvider('test-api-key', 'text-embedding-ada-002'),
      ];

      providers.forEach((provider) => {
        expect(provider).toBeInstanceOf(EmbeddingProvider);
        expect(typeof provider.embed).toBe('function');
        expect(typeof provider.getDimensions).toBe('function');
        expect(typeof provider.getAvailableModels).toBe('function');
      });
    });
  });

  describe('Model-specific behavior', () => {
    it('should produce correct dimensions for each model', () => {
      const smallProvider = new OpenAIEmbeddingProvider('test-api-key', 'text-embedding-3-small');
      const largeProvider = new OpenAIEmbeddingProvider('test-api-key', 'text-embedding-3-large');
      const adaProvider = new OpenAIEmbeddingProvider('test-api-key', 'text-embedding-ada-002');

      expect(smallProvider.getDimensions()).toBe(1536);
      expect(largeProvider.getDimensions()).toBe(3072);
      expect(adaProvider.getDimensions()).toBe(1536);
    });

    it('should use correct model name in API calls', async () => {
      const provider = new OpenAIEmbeddingProvider('test-api-key', 'text-embedding-3-large');
      const mockEmbedding = new Array(3072).fill(0.1);

      mockEmbeddings.create.mockResolvedValue({
        data: [{ embedding: mockEmbedding, index: 0 }],
        model: 'text-embedding-3-large',
        usage: { prompt_tokens: 10, total_tokens: 10 },
        object: 'list',
      } as any);

      await provider.embed(['test']);

      expect(mockEmbeddings.create).toHaveBeenCalledWith({
        model: 'text-embedding-3-large',
        input: ['test'],
        encoding_format: 'float',
      });
    });
  });

  describe('Real-world usage patterns', () => {
    it('should handle typical document chunking scenario', async () => {
      const provider = new OpenAIEmbeddingProvider('test-api-key');
      
      // Simulate chunks from a document
      const chunks = [
        'This is the first chunk of text from a legal document.',
        'This is the second chunk with some overlap from the previous chunk.',
        'This is the third chunk continuing the document content.',
      ];

      mockEmbeddings.create.mockResolvedValue({
        data: chunks.map((_, i) => ({
          embedding: new Array(1536).fill(0.1 * (i + 1)),
          index: i,
        })),
        model: 'text-embedding-3-small',
        usage: { prompt_tokens: 30, total_tokens: 30 },
        object: 'list',
      } as any);

      const embeddings = await provider.embed(chunks);

      expect(embeddings).toHaveLength(3);
      expect(embeddings[0]).toHaveLength(1536);
      expect(embeddings[1]).toHaveLength(1536);
      expect(embeddings[2]).toHaveLength(1536);
    });

    it('should handle large batch of chunks', async () => {
      const provider = new OpenAIEmbeddingProvider('test-api-key');
      
      // Simulate 250 chunks (will be split into 3 batches)
      const chunks = Array.from({ length: 250 }, (_, i) => `Chunk ${i + 1}`);

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

      const embeddings = await provider.embed(chunks);

      expect(embeddings).toHaveLength(250);
      // Should batch into 100 + 100 + 50
      expect(mockEmbeddings.create).toHaveBeenCalledTimes(3);
    });

    it('should handle empty chunks gracefully', async () => {
      const provider = new OpenAIEmbeddingProvider('test-api-key');
      
      const chunks = ['', 'valid text', ''];

      mockEmbeddings.create.mockResolvedValue({
        data: [
          { embedding: new Array(1536).fill(0), index: 0 },
          { embedding: new Array(1536).fill(0.1), index: 1 },
          { embedding: new Array(1536).fill(0), index: 2 },
        ],
        model: 'text-embedding-3-small',
        usage: { prompt_tokens: 10, total_tokens: 10 },
        object: 'list',
      } as any);

      const embeddings = await provider.embed(chunks);

      expect(embeddings).toHaveLength(3);
    });
  });

  describe('Error recovery patterns', () => {
    it('should recover from transient network errors', async () => {
      const provider = new OpenAIEmbeddingProvider('test-api-key');
      const mockEmbedding = new Array(1536).fill(0.1);

      // Simulate transient error followed by success
      mockEmbeddings.create
        .mockRejectedValueOnce({
          status: 503,
          message: 'Service temporarily unavailable',
        })
        .mockResolvedValueOnce({
          data: [{ embedding: mockEmbedding, index: 0 }],
          model: 'text-embedding-3-small',
          usage: { prompt_tokens: 10, total_tokens: 10 },
          object: 'list',
        } as any);

      const result = await provider.embed(['test']);

      expect(result).toHaveLength(1);
      expect(mockEmbeddings.create).toHaveBeenCalledTimes(2);
    });

    it('should fail fast on authentication errors', async () => {
      const provider = new OpenAIEmbeddingProvider('invalid-key');

      mockEmbeddings.create.mockRejectedValue({
        status: 401,
        message: 'Invalid API key',
      });

      await expect(provider.embed(['test'])).rejects.toThrow('Invalid OpenAI API key');
      
      // Should not retry on auth errors
      expect(mockEmbeddings.create).toHaveBeenCalledTimes(1);
    });
  });
});
