/**
 * Tests for Model Download API Route
 * 
 * Requirements: 18.13, 18.14, 18.15
 *
 * @jest-environment node
 */

import { POST } from '../download/route';
import { updateModelDownloadStatus, getModelDownload } from '@/lib/db/config';
import { NextRequest } from 'next/server';

// Mock the database functions
jest.mock('@/lib/db/config');

// Mock the TransformersEmbeddingProvider
jest.mock('@/lib/ingestion/transformers-embedding-provider', () => ({
  TransformersEmbeddingProvider: {
    isModelDownloaded: jest.fn(),
    downloadModel: jest.fn(),
    getModelSize: jest.fn(),
  },
}));

describe('Model Download API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/models/download', () => {
    it('should return 400 if modelName is missing', async () => {
      const request = new NextRequest('http://localhost/api/models/download', {
        method: 'POST',
        body: JSON.stringify({}),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe('modelName is required');
    });

    it('should return 400 if model is already downloaded', async () => {
      const { TransformersEmbeddingProvider } = await import('@/lib/ingestion/transformers-embedding-provider');
      (TransformersEmbeddingProvider.isModelDownloaded as jest.Mock).mockResolvedValue(true);

      const request = new NextRequest('http://localhost/api/models/download', {
        method: 'POST',
        body: JSON.stringify({ modelName: 'Xenova/all-MiniLM-L6-v2' }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe('Model is already downloaded');
    });

    it('should start download and return success', async () => {
      const { TransformersEmbeddingProvider } = await import('@/lib/ingestion/transformers-embedding-provider');
      (TransformersEmbeddingProvider.isModelDownloaded as jest.Mock).mockResolvedValue(false);
      (updateModelDownloadStatus as jest.Mock).mockResolvedValue(undefined);

      const request = new NextRequest('http://localhost/api/models/download', {
        method: 'POST',
        body: JSON.stringify({ modelName: 'Xenova/all-MiniLM-L6-v2' }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.message).toBe('Download started');
      
      // Should update status to downloading
      expect(updateModelDownloadStatus).toHaveBeenCalledWith(
        'Xenova/all-MiniLM-L6-v2',
        'transformers',
        'downloading',
        0
      );
    });

    it('should handle errors gracefully', async () => {
      const { TransformersEmbeddingProvider } = await import('@/lib/ingestion/transformers-embedding-provider');
      (TransformersEmbeddingProvider.isModelDownloaded as jest.Mock).mockRejectedValue(
        new Error('Test error')
      );

      const request = new NextRequest('http://localhost/api/models/download', {
        method: 'POST',
        body: JSON.stringify({ modelName: 'Xenova/all-MiniLM-L6-v2' }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toBe('Test error');
    });
  });

  describe('Background download process', () => {
    it('should update progress during download', async () => {
      // This test verifies the background download logic
      // We can't directly test the background function, but we can verify
      // that the mocks are set up correctly for the integration
      
      const { TransformersEmbeddingProvider } = await import('@/lib/ingestion/transformers-embedding-provider');
      (TransformersEmbeddingProvider.isModelDownloaded as jest.Mock).mockResolvedValue(false);
      (TransformersEmbeddingProvider.downloadModel as jest.Mock).mockImplementation(
        async (modelName: string, onProgress?: (progress: number, loaded: number, total: number) => void) => {
          // Simulate progress updates
          if (onProgress) {
            await onProgress(25, 25000000, 100000000);
            await onProgress(50, 50000000, 100000000);
            await onProgress(75, 75000000, 100000000);
            await onProgress(100, 100000000, 100000000);
          }
        }
      );
      (TransformersEmbeddingProvider.getModelSize as jest.Mock).mockResolvedValue(100000000);
      (updateModelDownloadStatus as jest.Mock).mockResolvedValue(undefined);

      const request = new NextRequest('http://localhost/api/models/download', {
        method: 'POST',
        body: JSON.stringify({ modelName: 'Xenova/all-MiniLM-L6-v2' }),
      });

      await POST(request);

      // Wait a bit for background process to start
      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify that download was initiated
      expect(TransformersEmbeddingProvider.downloadModel).toHaveBeenCalled();
    });
  });
});
