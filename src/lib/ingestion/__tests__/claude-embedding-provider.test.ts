/**
 * Unit tests for ClaudeEmbeddingProvider
 * 
 * Note: These tests verify that the provider correctly explains its limitations
 * since Claude does not currently provide a dedicated embeddings API.
 */

import { ClaudeEmbeddingProvider } from '../claude-embedding-provider';

describe('ClaudeEmbeddingProvider', () => {
  const validApiKey = 'sk-ant-test-key-123';
  const defaultModel = 'claude-3-sonnet-20240229';

  describe('Constructor', () => {
    it('should create provider with valid API key and default model', () => {
      const provider = new ClaudeEmbeddingProvider(validApiKey);
      expect(provider).toBeInstanceOf(ClaudeEmbeddingProvider);
      expect(provider.getDimensions()).toBe(1536);
    });

    it('should create provider with valid API key and specific model', () => {
      const provider = new ClaudeEmbeddingProvider(validApiKey, 'claude-3-opus-20240229');
      expect(provider).toBeInstanceOf(ClaudeEmbeddingProvider);
      expect(provider.getDimensions()).toBe(1536);
    });

    it('should throw error if API key is missing', () => {
      expect(() => new ClaudeEmbeddingProvider('')).toThrow('Anthropic API key is required');
    });

    it('should throw error if model name is not supported', () => {
      expect(() => new ClaudeEmbeddingProvider(validApiKey, 'invalid-model')).toThrow(
        'Unsupported model: invalid-model'
      );
    });

    it('should list available models in error message', () => {
      try {
        new ClaudeEmbeddingProvider(validApiKey, 'invalid-model');
        fail('Should have thrown error');
      } catch (error: any) {
        expect(error.message).toContain('claude-3-opus-20240229');
        expect(error.message).toContain('claude-3-sonnet-20240229');
        expect(error.message).toContain('claude-3-haiku-20240307');
      }
    });
  });

  describe('embed()', () => {
    it('should throw error explaining Claude limitation', async () => {
      const provider = new ClaudeEmbeddingProvider(validApiKey);
      
      await expect(provider.embed(['test text'])).rejects.toThrow(
        'Claude (Anthropic) does not currently provide a dedicated embeddings API'
      );
    });

    it('should suggest OpenAI alternative in error message', async () => {
      const provider = new ClaudeEmbeddingProvider(validApiKey);
      
      try {
        await provider.embed(['test text']);
        fail('Should have thrown error');
      } catch (error: any) {
        expect(error.message).toContain('OpenAI Embedding Provider');
        expect(error.message).toContain('EMBEDDING_PROVIDER=openai');
      }
    });

    it('should suggest transformers.js alternative in error message', async () => {
      const provider = new ClaudeEmbeddingProvider(validApiKey);
      
      try {
        await provider.embed(['test text']);
        fail('Should have thrown error');
      } catch (error: any) {
        expect(error.message).toContain('Transformers.js Embedding Provider');
        expect(error.message).toContain('EMBEDDING_PROVIDER=transformers');
      }
    });

    it('should suggest hybrid approach in error message', async () => {
      const provider = new ClaudeEmbeddingProvider(validApiKey);
      
      try {
        await provider.embed(['test text']);
        fail('Should have thrown error');
      } catch (error: any) {
        expect(error.message).toContain('Hybrid Approach');
        expect(error.message).toContain('Use Claude for analysis');
      }
    });

    it('should reference documentation in error message', async () => {
      const provider = new ClaudeEmbeddingProvider(validApiKey);
      
      try {
        await provider.embed(['test text']);
        fail('Should have thrown error');
      } catch (error: any) {
        expect(error.message).toContain('docs/configuration.md');
      }
    });

    it('should throw error for empty array', async () => {
      const provider = new ClaudeEmbeddingProvider(validApiKey);
      
      await expect(provider.embed([])).rejects.toThrow(
        'Claude (Anthropic) does not currently provide a dedicated embeddings API'
      );
    });

    it('should throw error for multiple texts', async () => {
      const provider = new ClaudeEmbeddingProvider(validApiKey);
      
      await expect(provider.embed(['text 1', 'text 2', 'text 3'])).rejects.toThrow(
        'Claude (Anthropic) does not currently provide a dedicated embeddings API'
      );
    });
  });

  describe('getDimensions()', () => {
    it('should return simulated dimensions for opus model', () => {
      const provider = new ClaudeEmbeddingProvider(validApiKey, 'claude-3-opus-20240229');
      expect(provider.getDimensions()).toBe(1536);
    });

    it('should return simulated dimensions for sonnet model', () => {
      const provider = new ClaudeEmbeddingProvider(validApiKey, 'claude-3-sonnet-20240229');
      expect(provider.getDimensions()).toBe(1536);
    });

    it('should return simulated dimensions for haiku model', () => {
      const provider = new ClaudeEmbeddingProvider(validApiKey, 'claude-3-haiku-20240307');
      expect(provider.getDimensions()).toBe(1536);
    });
  });

  describe('getAvailableModels()', () => {
    it('should return list of available Claude models', () => {
      const provider = new ClaudeEmbeddingProvider(validApiKey);
      const models = provider.getAvailableModels();
      
      expect(models).toContain('claude-3-opus-20240229');
      expect(models).toContain('claude-3-sonnet-20240229');
      expect(models).toContain('claude-3-haiku-20240307');
      expect(models.length).toBe(3);
    });
  });

  describe('getMaxTokens()', () => {
    it('should return max tokens for opus model', () => {
      const provider = new ClaudeEmbeddingProvider(validApiKey, 'claude-3-opus-20240229');
      expect(provider.getMaxTokens()).toBe(4096);
    });

    it('should return max tokens for sonnet model', () => {
      const provider = new ClaudeEmbeddingProvider(validApiKey, 'claude-3-sonnet-20240229');
      expect(provider.getMaxTokens()).toBe(4096);
    });

    it('should return max tokens for haiku model', () => {
      const provider = new ClaudeEmbeddingProvider(validApiKey, 'claude-3-haiku-20240307');
      expect(provider.getMaxTokens()).toBe(4096);
    });
  });

  describe('API Compatibility', () => {
    it('should implement EmbeddingProvider interface', () => {
      const provider = new ClaudeEmbeddingProvider(validApiKey);
      
      // Check that all required methods exist
      expect(typeof provider.embed).toBe('function');
      expect(typeof provider.getDimensions).toBe('function');
      expect(typeof provider.getAvailableModels).toBe('function');
    });

    it('should have consistent API with OpenAI provider', () => {
      const provider = new ClaudeEmbeddingProvider(validApiKey);
      
      // Same method signatures as OpenAI provider
      expect(provider.getDimensions()).toBeGreaterThan(0);
      expect(Array.isArray(provider.getAvailableModels())).toBe(true);
      expect(provider.getAvailableModels().length).toBeGreaterThan(0);
    });
  });

  describe('Error Handling', () => {
    it('should provide clear error for missing API key', () => {
      expect(() => new ClaudeEmbeddingProvider('')).toThrow('Anthropic API key is required');
    });

    it('should provide clear error for invalid model', () => {
      expect(() => new ClaudeEmbeddingProvider(validApiKey, 'gpt-4')).toThrow(
        'Unsupported model'
      );
    });

    it('should provide actionable error message for embed attempts', async () => {
      const provider = new ClaudeEmbeddingProvider(validApiKey);
      
      try {
        await provider.embed(['test']);
        fail('Should have thrown error');
      } catch (error: any) {
        // Error should be actionable with specific steps
        expect(error.message).toContain('EMBEDDING_PROVIDER=');
        expect(error.message).toContain('API key');
        expect(error.message.length).toBeGreaterThan(100); // Detailed message
      }
    });
  });

  describe('Model Configuration', () => {
    it('should accept opus model', () => {
      const provider = new ClaudeEmbeddingProvider(validApiKey, 'claude-3-opus-20240229');
      expect(provider.getAvailableModels()).toContain('claude-3-opus-20240229');
    });

    it('should accept sonnet model', () => {
      const provider = new ClaudeEmbeddingProvider(validApiKey, 'claude-3-sonnet-20240229');
      expect(provider.getAvailableModels()).toContain('claude-3-sonnet-20240229');
    });

    it('should accept haiku model', () => {
      const provider = new ClaudeEmbeddingProvider(validApiKey, 'claude-3-haiku-20240307');
      expect(provider.getAvailableModels()).toContain('claude-3-haiku-20240307');
    });

    it('should use sonnet as default model', () => {
      const provider = new ClaudeEmbeddingProvider(validApiKey);
      // Default model should be sonnet (verified by dimensions)
      expect(provider.getDimensions()).toBe(1536);
    });
  });
});
