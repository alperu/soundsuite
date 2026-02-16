/**
 * Integration tests for ClaudeEmbeddingProvider
 * 
 * These tests verify the provider's behavior in realistic scenarios,
 * including error handling and API compatibility.
 * 
 * Note: Since Claude doesn't provide embeddings, these tests verify
 * that the provider correctly explains its limitations.
 */

import { ClaudeEmbeddingProvider } from '../claude-embedding-provider';
import { EmbeddingProvider } from '../embedding-provider';

describe('ClaudeEmbeddingProvider Integration', () => {
  const validApiKey = process.env.ANTHROPIC_API_KEY || 'sk-ant-test-key-123';

  describe('Provider Instantiation', () => {
    it('should create provider with environment API key', () => {
      const provider = new ClaudeEmbeddingProvider(validApiKey);
      expect(provider).toBeInstanceOf(ClaudeEmbeddingProvider);
      expect(provider).toBeInstanceOf(EmbeddingProvider);
    });

    it('should work with all supported models', () => {
      const models = [
        'claude-3-opus-20240229',
        'claude-3-sonnet-20240229',
        'claude-3-haiku-20240307',
      ];

      models.forEach((model) => {
        const provider = new ClaudeEmbeddingProvider(validApiKey, model);
        expect(provider).toBeInstanceOf(ClaudeEmbeddingProvider);
        expect(provider.getDimensions()).toBeGreaterThan(0);
      });
    });
  });

  describe('Realistic Usage Scenarios', () => {
    it('should handle typical document chunk embedding attempt', async () => {
      const provider = new ClaudeEmbeddingProvider(validApiKey);
      
      const chunks = [
        'This is a legal document excerpt from page 1.',
        'The defendant filed a motion on January 15, 2024.',
        'The court ruled in favor of the plaintiff.',
      ];

      // Should throw error explaining limitation
      await expect(provider.embed(chunks)).rejects.toThrow(
        'Claude (Anthropic) does not currently provide a dedicated embeddings API'
      );
    });

    it('should handle large batch embedding attempt', async () => {
      const provider = new ClaudeEmbeddingProvider(validApiKey);
      
      // Simulate 100 chunks (typical batch size)
      const chunks = Array.from({ length: 100 }, (_, i) => `Chunk ${i + 1} content`);

      // Should throw error explaining limitation
      await expect(provider.embed(chunks)).rejects.toThrow(
        'Claude (Anthropic) does not currently provide a dedicated embeddings API'
      );
    });

    it('should handle empty batch gracefully', async () => {
      const provider = new ClaudeEmbeddingProvider(validApiKey);
      
      // Should throw error explaining limitation (not a different error for empty array)
      await expect(provider.embed([])).rejects.toThrow(
        'Claude (Anthropic) does not currently provide a dedicated embeddings API'
      );
    });
  });

  describe('Error Message Quality', () => {
    it('should provide comprehensive error message with all alternatives', async () => {
      const provider = new ClaudeEmbeddingProvider(validApiKey);
      
      try {
        await provider.embed(['test']);
        fail('Should have thrown error');
      } catch (error: any) {
        const message = error.message;
        
        // Should mention all three alternatives
        expect(message).toContain('OpenAI Embedding Provider');
        expect(message).toContain('Transformers.js Embedding Provider');
        expect(message).toContain('Hybrid Approach');
        
        // Should provide configuration examples
        expect(message).toContain('EMBEDDING_PROVIDER=openai');
        expect(message).toContain('EMBEDDING_PROVIDER=transformers');
        expect(message).toContain('OPENAI_API_KEY');
        
        // Should reference documentation
        expect(message).toContain('docs/configuration.md');
        
        // Should explain the limitation clearly
        expect(message).toContain('does not currently provide');
        expect(message).toContain('embeddings API');
      }
    });

    it('should provide helpful error for invalid API key format', () => {
      expect(() => new ClaudeEmbeddingProvider('')).toThrow(
        'Anthropic API key is required'
      );
    });

    it('should provide helpful error for invalid model', () => {
      try {
        new ClaudeEmbeddingProvider(validApiKey, 'claude-2');
        fail('Should have thrown error');
      } catch (error: any) {
        expect(error.message).toContain('Unsupported model');
        expect(error.message).toContain('claude-3-opus');
        expect(error.message).toContain('claude-3-sonnet');
        expect(error.message).toContain('claude-3-haiku');
      }
    });
  });

  describe('API Compatibility with Other Providers', () => {
    it('should have same interface as OpenAI provider', () => {
      const provider = new ClaudeEmbeddingProvider(validApiKey);
      
      // Check method signatures
      expect(typeof provider.embed).toBe('function');
      expect(typeof provider.getDimensions).toBe('function');
      expect(typeof provider.getAvailableModels).toBe('function');
      expect(typeof provider.getMaxTokens).toBe('function');
    });

    it('should return consistent dimension values', () => {
      const provider = new ClaudeEmbeddingProvider(validApiKey);
      const dimensions = provider.getDimensions();
      
      // Should return a positive integer
      expect(Number.isInteger(dimensions)).toBe(true);
      expect(dimensions).toBeGreaterThan(0);
      
      // Should be consistent across calls
      expect(provider.getDimensions()).toBe(dimensions);
    });

    it('should return consistent model list', () => {
      const provider = new ClaudeEmbeddingProvider(validApiKey);
      const models1 = provider.getAvailableModels();
      const models2 = provider.getAvailableModels();
      
      // Should return same list
      expect(models1).toEqual(models2);
      
      // Should be an array of strings
      expect(Array.isArray(models1)).toBe(true);
      models1.forEach((model) => {
        expect(typeof model).toBe('string');
        expect(model.length).toBeGreaterThan(0);
      });
    });
  });

  describe('Configuration Scenarios', () => {
    it('should work with opus model configuration', () => {
      const provider = new ClaudeEmbeddingProvider(validApiKey, 'claude-3-opus-20240229');
      
      expect(provider.getDimensions()).toBe(1536);
      expect(provider.getMaxTokens()).toBe(4096);
      expect(provider.getAvailableModels()).toContain('claude-3-opus-20240229');
    });

    it('should work with sonnet model configuration', () => {
      const provider = new ClaudeEmbeddingProvider(validApiKey, 'claude-3-sonnet-20240229');
      
      expect(provider.getDimensions()).toBe(1536);
      expect(provider.getMaxTokens()).toBe(4096);
      expect(provider.getAvailableModels()).toContain('claude-3-sonnet-20240229');
    });

    it('should work with haiku model configuration', () => {
      const provider = new ClaudeEmbeddingProvider(validApiKey, 'claude-3-haiku-20240307');
      
      expect(provider.getDimensions()).toBe(1536);
      expect(provider.getMaxTokens()).toBe(4096);
      expect(provider.getAvailableModels()).toContain('claude-3-haiku-20240307');
    });

    it('should use sonnet as default when no model specified', () => {
      const provider = new ClaudeEmbeddingProvider(validApiKey);
      
      // Should work without errors
      expect(provider.getDimensions()).toBe(1536);
      expect(provider.getMaxTokens()).toBe(4096);
    });
  });

  describe('Future Compatibility', () => {
    it('should have structure ready for future embedding API', () => {
      const provider = new ClaudeEmbeddingProvider(validApiKey);
      
      // Should have all necessary methods defined
      expect(provider.embed).toBeDefined();
      expect(provider.getDimensions).toBeDefined();
      expect(provider.getAvailableModels).toBeDefined();
      expect(provider.getMaxTokens).toBeDefined();
      
      // Should have model configuration
      expect(provider.getAvailableModels().length).toBeGreaterThan(0);
      expect(provider.getDimensions()).toBeGreaterThan(0);
    });

    it('should maintain consistent API across all models', () => {
      const models = [
        'claude-3-opus-20240229',
        'claude-3-sonnet-20240229',
        'claude-3-haiku-20240307',
      ];

      models.forEach((model) => {
        const provider = new ClaudeEmbeddingProvider(validApiKey, model);
        
        // All models should have same API
        expect(typeof provider.embed).toBe('function');
        expect(typeof provider.getDimensions).toBe('function');
        expect(typeof provider.getAvailableModels).toBe('function');
        expect(typeof provider.getMaxTokens).toBe('function');
        
        // All should return valid values
        expect(provider.getDimensions()).toBeGreaterThan(0);
        expect(provider.getMaxTokens()).toBeGreaterThan(0);
        expect(provider.getAvailableModels().length).toBeGreaterThan(0);
      });
    });
  });

  describe('Documentation and User Experience', () => {
    it('should provide clear guidance in error messages', async () => {
      const provider = new ClaudeEmbeddingProvider(validApiKey);
      
      try {
        await provider.embed(['test']);
        fail('Should have thrown error');
      } catch (error: any) {
        const message = error.message;
        
        // Should be long enough to be helpful (not just "not supported")
        expect(message.length).toBeGreaterThan(200);
        
        // Should have clear structure with numbered alternatives
        expect(message).toMatch(/1\./);
        expect(message).toMatch(/2\./);
        expect(message).toMatch(/3\./);
        
        // Should provide actionable steps
        expect(message).toContain('Set EMBEDDING_PROVIDER=');
        expect(message).toContain('Requires');
        expect(message).toContain('No API key required');
      }
    });

    it('should explain why Claude is listed as an option', async () => {
      const provider = new ClaudeEmbeddingProvider(validApiKey);
      
      // Provider should exist and be instantiable
      expect(provider).toBeInstanceOf(ClaudeEmbeddingProvider);
      
      // But should clearly explain limitation when used
      try {
        await provider.embed(['test']);
        fail('Should have thrown error');
      } catch (error: any) {
        expect(error.message).toContain('does not currently provide');
        expect(error.message).toContain('embeddings API');
      }
    });
  });
});
