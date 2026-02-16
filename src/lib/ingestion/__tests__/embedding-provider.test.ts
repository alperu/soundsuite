/**
 * Unit tests for EmbeddingProvider base class
 * 
 * These tests verify that the abstract base class can be extended
 * and that concrete implementations must provide all required methods.
 */

import { describe, it, expect } from '@jest/globals';
import { EmbeddingProvider, EmbeddingConfig } from '../embedding-provider';

/**
 * Mock implementation of EmbeddingProvider for testing
 */
class MockEmbeddingProvider extends EmbeddingProvider {
  private dimensions: number;
  private models: string[];

  constructor(dimensions: number = 384, models: string[] = ['mock-model']) {
    super();
    this.dimensions = dimensions;
    this.models = models;
  }

  async embed(texts: string[]): Promise<number[][]> {
    // Return mock embeddings with correct dimensions
    return texts.map(() => Array(this.dimensions).fill(0.5));
  }

  getDimensions(): number {
    return this.dimensions;
  }

  getAvailableModels(): string[] {
    return this.models;
  }

  getModelName(): string {
    return this.models[0] || 'mock-model';
  }
}

describe('EmbeddingProvider', () => {
  describe('abstract class structure', () => {
    it('should allow concrete implementations to be instantiated', () => {
      const provider = new MockEmbeddingProvider();
      expect(provider).toBeInstanceOf(EmbeddingProvider);
    });

    it('should require embed() method implementation', async () => {
      const provider = new MockEmbeddingProvider();
      const result = await provider.embed(['test']);
      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });

    it('should require getDimensions() method implementation', () => {
      const provider = new MockEmbeddingProvider(768);
      const dimensions = provider.getDimensions();
      expect(dimensions).toBe(768);
    });

    it('should require getAvailableModels() method implementation', () => {
      const provider = new MockEmbeddingProvider(384, ['model-1', 'model-2']);
      const models = provider.getAvailableModels();
      expect(models).toEqual(['model-1', 'model-2']);
    });
  });

  describe('embed() method', () => {
    it('should return embeddings for single text', async () => {
      const provider = new MockEmbeddingProvider(384);
      const embeddings = await provider.embed(['hello world']);
      
      expect(embeddings).toHaveLength(1);
      expect(embeddings[0]).toHaveLength(384);
    });

    it('should return embeddings for multiple texts', async () => {
      const provider = new MockEmbeddingProvider(384);
      const texts = ['text 1', 'text 2', 'text 3'];
      const embeddings = await provider.embed(texts);
      
      expect(embeddings).toHaveLength(3);
      embeddings.forEach(embedding => {
        expect(embedding).toHaveLength(384);
      });
    });

    it('should handle empty array', async () => {
      const provider = new MockEmbeddingProvider();
      const embeddings = await provider.embed([]);
      
      expect(embeddings).toHaveLength(0);
    });
  });

  describe('getDimensions() method', () => {
    it('should return correct dimensions for different models', () => {
      const provider384 = new MockEmbeddingProvider(384);
      expect(provider384.getDimensions()).toBe(384);

      const provider768 = new MockEmbeddingProvider(768);
      expect(provider768.getDimensions()).toBe(768);

      const provider1536 = new MockEmbeddingProvider(1536);
      expect(provider1536.getDimensions()).toBe(1536);
    });
  });

  describe('getAvailableModels() method', () => {
    it('should return list of available models', () => {
      const models = ['model-a', 'model-b', 'model-c'];
      const provider = new MockEmbeddingProvider(384, models);
      
      expect(provider.getAvailableModels()).toEqual(models);
    });

    it('should return empty array if no models available', () => {
      const provider = new MockEmbeddingProvider(384, []);
      
      expect(provider.getAvailableModels()).toEqual([]);
    });
  });
});
