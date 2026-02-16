/**
 * Tests for OllamaEmbeddingProvider
 */

// Mock the ollama module
jest.mock('ollama', () => ({
  Ollama: jest.fn().mockImplementation(() => ({
    embed: jest.fn(),
  })),
}));

import { OllamaEmbeddingProvider } from '../ollama-embedding-provider';

describe('OllamaEmbeddingProvider', () => {
  let provider: OllamaEmbeddingProvider;
  let mockOllamaEmbed: jest.Mock;

  beforeEach(() => {
    // Get the mock embed function from the mock constructor
    const { Ollama } = require('ollama');
    mockOllamaEmbed = jest.fn();
    Ollama.mockImplementation(() => ({
      embed: mockOllamaEmbed,
    }));

    provider = new OllamaEmbeddingProvider({
      host: 'http://localhost:11434',
      model: 'all-minilm',
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('embed', () => {
    it('should embed a batch of texts', async () => {
      // First call is the init test
      mockOllamaEmbed.mockResolvedValueOnce({
        embeddings: [[0.1, 0.2, 0.3]],
      });
      // Second call is the actual embed
      mockOllamaEmbed.mockResolvedValueOnce({
        embeddings: [
          [0.1, 0.2, 0.3],
          [0.4, 0.5, 0.6],
        ],
      });

      const result = await provider.embed(['hello', 'world']);

      expect(result).toEqual([
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
      ]);
    });

    it('should return empty array for empty input', async () => {
      const result = await provider.embed([]);
      expect(result).toEqual([]);
      expect(mockOllamaEmbed).not.toHaveBeenCalled();
    });

    it('should throw if Ollama returns wrong number of embeddings', async () => {
      // Init call
      mockOllamaEmbed.mockResolvedValueOnce({
        embeddings: [[0.1]],
      });
      // Actual call returns wrong count
      mockOllamaEmbed.mockResolvedValueOnce({
        embeddings: [[0.1, 0.2]], // only 1 embedding for 2 inputs
      });

      await expect(provider.embed(['hello', 'world'])).rejects.toThrow(
        /returned 1 embeddings for 2 inputs/
      );
    });

    it('should throw descriptive error on connection failure', async () => {
      mockOllamaEmbed.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await expect(provider.embed(['test'])).rejects.toThrow(/Ollama connection failed/);
    });
  });

  describe('metadata methods', () => {
    it('should return correct dimensions for known models', () => {
      expect(provider.getDimensions()).toBe(384); // all-minilm default

      const nomicProvider = new OllamaEmbeddingProvider({
        host: 'http://localhost:11434',
        model: 'nomic-embed-text',
      });
      expect(nomicProvider.getDimensions()).toBe(768);

      const mxbaiProvider = new OllamaEmbeddingProvider({
        host: 'http://localhost:11434',
        model: 'mxbai-embed-large',
      });
      expect(mxbaiProvider.getDimensions()).toBe(1024);
    });

    it('should return available models', () => {
      const models = provider.getAvailableModels();
      expect(models).toContain('all-minilm');
      expect(models).toContain('nomic-embed-text');
      expect(models).toContain('mxbai-embed-large');
    });

    it('should return model name with ollama/ prefix', () => {
      expect(provider.getModelName()).toBe('ollama/all-minilm');
    });

    it('should default to 384 dimensions for unknown models', () => {
      const unknownProvider = new OllamaEmbeddingProvider({
        host: 'http://localhost:11434',
        model: 'some-unknown-model',
      });
      expect(unknownProvider.getDimensions()).toBe(384);
    });
  });

  describe('testConnection', () => {
    it('should return ok: true on successful connection', async () => {
      mockOllamaEmbed.mockResolvedValue({
        embeddings: [[0.1, 0.2, 0.3]],
      });

      const result = await provider.testConnection();
      expect(result.ok).toBe(true);
    });

    it('should return ok: false with error message on failure', async () => {
      mockOllamaEmbed.mockRejectedValue(new Error('Connection refused'));

      const result = await provider.testConnection();
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Connection refused');
    });
  });

  describe('host normalization', () => {
    it('should strip trailing slash from host', () => {
      const p = new OllamaEmbeddingProvider({
        host: 'http://localhost:11434/',
        model: 'all-minilm',
      });
      expect(p.getModelName()).toBe('ollama/all-minilm');
    });
  });
});
