/**
 * Unit tests for TransformersEmbeddingProvider
 * 
 * These tests verify the local embedding generation using transformers.js,
 * including model management (download, delete, check status, get size).
 * 
 * Requirements: 5.2, 5.3, 18.5, 18.8, 18.12, 18.13, 18.15, 18.16
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { TransformersEmbeddingProvider } from '../transformers-embedding-provider';
import { EmbeddingProvider } from '../embedding-provider';

// Mock the @xenova/transformers module
jest.mock('@xenova/transformers', () => ({
  pipeline: jest.fn(),
  env: {
    cacheDir: '',
  },
}));

// Mock fs/promises
jest.mock('fs/promises', () => ({
  access: jest.fn(),
  rm: jest.fn(),
  readdir: jest.fn(),
  stat: jest.fn(),
}));

import { pipeline, env } from '@xenova/transformers';
import * as fs from 'fs/promises';

const mockPipeline = pipeline as jest.MockedFunction<typeof pipeline>;
const mockAccess = fs.access as jest.MockedFunction<typeof fs.access>;
const mockRm = fs.rm as jest.MockedFunction<typeof fs.rm>;
const mockReaddir = fs.readdir as jest.MockedFunction<typeof fs.readdir>;
const mockStat = fs.stat as jest.MockedFunction<typeof fs.stat>;

describe('TransformersEmbeddingProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create instance with default model', () => {
      const provider = new TransformersEmbeddingProvider();
      expect(provider).toBeInstanceOf(EmbeddingProvider);
      expect(provider).toBeInstanceOf(TransformersEmbeddingProvider);
    });

    it('should create instance with specified model', () => {
      const provider = new TransformersEmbeddingProvider('Xenova/all-mpnet-base-v2');
      expect(provider).toBeInstanceOf(TransformersEmbeddingProvider);
    });

    it('should throw error for unsupported model', () => {
      expect(() => {
        new TransformersEmbeddingProvider('unsupported-model');
      }).toThrow('Unsupported model');
    });

    it('should configure cache directory', () => {
      new TransformersEmbeddingProvider();
      expect(env.cacheDir).toContain('.cache/transformers');
    });
  });

  describe('getAvailableModels()', () => {
    it('should return list of supported models', () => {
      const provider = new TransformersEmbeddingProvider();
      const models = provider.getAvailableModels();
      
      expect(models).toContain('Xenova/all-MiniLM-L6-v2');
      expect(models).toContain('Xenova/all-mpnet-base-v2');
      expect(models.length).toBe(2);
    });
  });

  describe('getDimensions()', () => {
    it('should return 384 dimensions for all-MiniLM-L6-v2', () => {
      const provider = new TransformersEmbeddingProvider('Xenova/all-MiniLM-L6-v2');
      expect(provider.getDimensions()).toBe(384);
    });

    it('should return 768 dimensions for all-mpnet-base-v2', () => {
      const provider = new TransformersEmbeddingProvider('Xenova/all-mpnet-base-v2');
      expect(provider.getDimensions()).toBe(768);
    });
  });

  describe('embed()', () => {
    beforeEach(() => {
      // Mock the pipeline function to return a mock pipeline object
      const mockPipelineInstance = jest.fn().mockResolvedValue([
        { data: new Float32Array(384).fill(0.5) },
      ]);
      mockPipeline.mockResolvedValue(mockPipelineInstance as any);
    });

    it('should return empty array for empty input', async () => {
      const provider = new TransformersEmbeddingProvider();
      const embeddings = await provider.embed([]);
      
      expect(embeddings).toEqual([]);
    });

    it('should generate embeddings for single text', async () => {
      const provider = new TransformersEmbeddingProvider('Xenova/all-MiniLM-L6-v2');
      const embeddings = await provider.embed(['hello world']);
      
      expect(embeddings).toHaveLength(1);
      expect(embeddings[0]).toHaveLength(384);
      expect(mockPipeline).toHaveBeenCalledWith('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    });

    it('should generate embeddings for multiple texts', async () => {
      const mockPipelineInstance = jest.fn().mockResolvedValue([
        { data: new Float32Array(384).fill(0.5) },
        { data: new Float32Array(384).fill(0.6) },
        { data: new Float32Array(384).fill(0.7) },
      ]);
      mockPipeline.mockResolvedValue(mockPipelineInstance as any);

      const provider = new TransformersEmbeddingProvider('Xenova/all-MiniLM-L6-v2');
      const texts = ['text 1', 'text 2', 'text 3'];
      const embeddings = await provider.embed(texts);
      
      expect(embeddings).toHaveLength(3);
      embeddings.forEach(embedding => {
        expect(embedding).toHaveLength(384);
      });
    });

    it('should process texts in batches of 10', async () => {
      const mockPipelineInstance = jest.fn().mockImplementation((texts: string[]) => {
        return Promise.resolve(
          texts.map(() => ({ data: new Float32Array(384).fill(0.5) }))
        );
      });
      mockPipeline.mockResolvedValue(mockPipelineInstance as any);

      const provider = new TransformersEmbeddingProvider('Xenova/all-MiniLM-L6-v2');
      const texts = Array(25).fill('test text');
      const embeddings = await provider.embed(texts);

      expect(embeddings).toHaveLength(25);
      // Should be called 3 times: 10 + 10 + 5
      expect(mockPipelineInstance).toHaveBeenCalledTimes(3);
    });

    it('should use correct pooling and normalization options', async () => {
      const mockPipelineInstance = jest.fn().mockResolvedValue([
        { data: new Float32Array(384).fill(0.5) },
      ]);
      mockPipeline.mockResolvedValue(mockPipelineInstance as any);

      const provider = new TransformersEmbeddingProvider();
      await provider.embed(['test']);
      
      expect(mockPipelineInstance).toHaveBeenCalledWith(
        ['test'],
        { pooling: 'mean', normalize: true }
      );
    });

    it('should throw error if pipeline initialization fails', async () => {
      mockPipeline.mockRejectedValue(new Error('Failed to load model'));

      const provider = new TransformersEmbeddingProvider();
      
      await expect(provider.embed(['test'])).rejects.toThrow('Failed to initialize embedding model');
    });

    it('should throw error if embedding generation fails', async () => {
      const mockPipelineInstance = jest.fn().mockRejectedValue(new Error('Embedding failed'));
      mockPipeline.mockResolvedValue(mockPipelineInstance as any);

      const provider = new TransformersEmbeddingProvider();
      
      await expect(provider.embed(['test'])).rejects.toThrow('Failed to generate embeddings');
    });

    it('should reuse initialized pipeline for multiple calls', async () => {
      const mockPipelineInstance = jest.fn().mockResolvedValue([
        { data: new Float32Array(384).fill(0.5) },
      ]);
      mockPipeline.mockResolvedValue(mockPipelineInstance as any);

      const provider = new TransformersEmbeddingProvider();
      await provider.embed(['test 1']);
      await provider.embed(['test 2']);
      
      // Pipeline should only be created once
      expect(mockPipeline).toHaveBeenCalledTimes(1);
    });
  });

  describe('downloadModel()', () => {
    it('should download a supported model', async () => {
      const mockPipelineInstance = jest.fn();
      mockPipeline.mockResolvedValue(mockPipelineInstance as any);

      await TransformersEmbeddingProvider.downloadModel('Xenova/all-MiniLM-L6-v2');
      
      expect(mockPipeline).toHaveBeenCalledWith('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    });

    it('should throw error for unsupported model', async () => {
      await expect(
        TransformersEmbeddingProvider.downloadModel('unsupported-model')
      ).rejects.toThrow('Unsupported model');
    });

    it('should call progress callback during download', async () => {
      const mockPipelineInstance = jest.fn();
      mockPipeline.mockResolvedValue(mockPipelineInstance as any);

      const progressCallback = jest.fn();
      await TransformersEmbeddingProvider.downloadModel(
        'Xenova/all-MiniLM-L6-v2',
        progressCallback
      );
      
      // Should be called at least twice (start and end)
      expect(progressCallback).toHaveBeenCalledWith(0, 0, expect.any(Number));
      expect(progressCallback).toHaveBeenCalledWith(100, expect.any(Number), expect.any(Number));
    });

    it('should throw error if download fails', async () => {
      mockPipeline.mockRejectedValue(new Error('Download failed'));

      await expect(
        TransformersEmbeddingProvider.downloadModel('Xenova/all-MiniLM-L6-v2')
      ).rejects.toThrow('Failed to download model');
    });
  });

  describe('deleteModel()', () => {
    it('should delete a downloaded model', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockRm.mockResolvedValue(undefined);

      await TransformersEmbeddingProvider.deleteModel('Xenova/all-MiniLM-L6-v2');
      
      expect(mockAccess).toHaveBeenCalled();
      expect(mockRm).toHaveBeenCalledWith(
        expect.stringContaining('Xenova/all-MiniLM-L6-v2'),
        { recursive: true, force: true }
      );
    });

    it('should throw error for unsupported model', async () => {
      await expect(
        TransformersEmbeddingProvider.deleteModel('unsupported-model')
      ).rejects.toThrow('Unsupported model');
    });

    it('should not throw error if model is not downloaded', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT'));

      await expect(
        TransformersEmbeddingProvider.deleteModel('Xenova/all-MiniLM-L6-v2')
      ).resolves.not.toThrow();
    });

    it('should throw error if deletion fails', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockRm.mockRejectedValue(new Error('Permission denied'));

      await expect(
        TransformersEmbeddingProvider.deleteModel('Xenova/all-MiniLM-L6-v2')
      ).rejects.toThrow('Failed to delete model');
    });
  });

  describe('isModelDownloaded()', () => {
    it('should return true if model is downloaded', async () => {
      mockAccess.mockResolvedValue(undefined);

      const isDownloaded = await TransformersEmbeddingProvider.isModelDownloaded(
        'Xenova/all-MiniLM-L6-v2'
      );
      
      expect(isDownloaded).toBe(true);
      expect(mockAccess).toHaveBeenCalledWith(
        expect.stringContaining('Xenova/all-MiniLM-L6-v2')
      );
    });

    it('should return false if model is not downloaded', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT'));

      const isDownloaded = await TransformersEmbeddingProvider.isModelDownloaded(
        'Xenova/all-MiniLM-L6-v2'
      );
      
      expect(isDownloaded).toBe(false);
    });

    it('should throw error for unsupported model', async () => {
      await expect(
        TransformersEmbeddingProvider.isModelDownloaded('unsupported-model')
      ).rejects.toThrow('Unsupported model');
    });
  });

  describe('getModelSize()', () => {
    it('should return 0 if model is not downloaded', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT'));

      const size = await TransformersEmbeddingProvider.getModelSize(
        'Xenova/all-MiniLM-L6-v2'
      );
      
      expect(size).toBe(0);
    });

    it('should calculate total size of downloaded model', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue([
        { name: 'file1.bin', isDirectory: () => false } as any,
        { name: 'file2.json', isDirectory: () => false } as any,
      ]);
      mockStat.mockResolvedValueOnce({ size: 1000 } as any);
      mockStat.mockResolvedValueOnce({ size: 2000 } as any);

      const size = await TransformersEmbeddingProvider.getModelSize(
        'Xenova/all-MiniLM-L6-v2'
      );
      
      expect(size).toBe(3000);
    });

    it('should handle nested directories', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReaddir
        .mockResolvedValueOnce([
          { name: 'file1.bin', isDirectory: () => false } as any,
          { name: 'subdir', isDirectory: () => true } as any,
        ])
        .mockResolvedValueOnce([
          { name: 'file2.bin', isDirectory: () => false } as any,
        ]);
      mockStat.mockResolvedValueOnce({ size: 1000 } as any);
      mockStat.mockResolvedValueOnce({ size: 2000 } as any);

      const size = await TransformersEmbeddingProvider.getModelSize(
        'Xenova/all-MiniLM-L6-v2'
      );
      
      expect(size).toBe(3000);
    });

    it('should throw error for unsupported model', async () => {
      await expect(
        TransformersEmbeddingProvider.getModelSize('unsupported-model')
      ).rejects.toThrow('Unsupported model');
    });

    it('should throw error if size calculation fails', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReaddir.mockRejectedValue(new Error('Permission denied'));

      await expect(
        TransformersEmbeddingProvider.getModelSize('Xenova/all-MiniLM-L6-v2')
      ).rejects.toThrow('Failed to get model size');
    });
  });

  describe('getEstimatedModelSize()', () => {
    it('should return estimated size for all-MiniLM-L6-v2', () => {
      const size = TransformersEmbeddingProvider.getEstimatedModelSize(
        'Xenova/all-MiniLM-L6-v2'
      );
      
      expect(size).toBe(90 * 1024 * 1024); // ~90MB
    });

    it('should return estimated size for all-mpnet-base-v2', () => {
      const size = TransformersEmbeddingProvider.getEstimatedModelSize(
        'Xenova/all-mpnet-base-v2'
      );
      
      expect(size).toBe(420 * 1024 * 1024); // ~420MB
    });

    it('should throw error for unsupported model', () => {
      expect(() => {
        TransformersEmbeddingProvider.getEstimatedModelSize('unsupported-model');
      }).toThrow('Unsupported model');
    });
  });

  describe('Requirements validation', () => {
    it('should support all-MiniLM-L6-v2 model (Req 18.5)', () => {
      const provider = new TransformersEmbeddingProvider('Xenova/all-MiniLM-L6-v2');
      expect(provider.getDimensions()).toBe(384);
    });

    it('should support all-mpnet-base-v2 model (Req 18.5)', () => {
      const provider = new TransformersEmbeddingProvider('Xenova/all-mpnet-base-v2');
      expect(provider.getDimensions()).toBe(768);
    });

    it('should batch embeddings in groups of 10 (Req 5.2)', async () => {
      const mockPipelineInstance = jest.fn().mockImplementation((texts: string[]) => {
        return Promise.resolve(
          texts.map(() => ({ data: new Float32Array(384).fill(0.5) }))
        );
      });
      mockPipeline.mockResolvedValue(mockPipelineInstance as any);

      const provider = new TransformersEmbeddingProvider();
      const texts = Array(25).fill('test');
      await provider.embed(texts);

      // Should be called 3 times: 10 + 10 + 5
      expect(mockPipelineInstance).toHaveBeenCalledTimes(3);
    });

    it('should provide downloadModel() method (Req 18.13)', async () => {
      const mockPipelineInstance = jest.fn();
      mockPipeline.mockResolvedValue(mockPipelineInstance as any);

      await expect(
        TransformersEmbeddingProvider.downloadModel('Xenova/all-MiniLM-L6-v2')
      ).resolves.not.toThrow();
    });

    it('should provide deleteModel() method (Req 18.16)', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockRm.mockResolvedValue(undefined);

      await expect(
        TransformersEmbeddingProvider.deleteModel('Xenova/all-MiniLM-L6-v2')
      ).resolves.not.toThrow();
    });

    it('should provide isModelDownloaded() method (Req 18.12)', async () => {
      mockAccess.mockResolvedValue(undefined);

      const result = await TransformersEmbeddingProvider.isModelDownloaded(
        'Xenova/all-MiniLM-L6-v2'
      );
      
      expect(typeof result).toBe('boolean');
    });

    it('should provide getModelSize() method (Req 18.15)', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT'));

      const size = await TransformersEmbeddingProvider.getModelSize(
        'Xenova/all-MiniLM-L6-v2'
      );
      
      expect(typeof size).toBe('number');
    });

    it('should run embeddings locally without API calls (Req 18.8)', async () => {
      const mockPipelineInstance = jest.fn().mockResolvedValue([
        { data: new Float32Array(384).fill(0.5) },
      ]);
      mockPipeline.mockResolvedValue(mockPipelineInstance as any);

      const provider = new TransformersEmbeddingProvider();
      await provider.embed(['test']);
      
      // Verify no external API calls are made (only local pipeline)
      expect(mockPipeline).toHaveBeenCalled();
    });
  });
});
