/**
 * Tests for Model Delete API Route
 * 
 * Requirements: 18.16
 *
 * @jest-environment node
 */

import { POST } from '../delete/route';
import { updateModelDownloadStatus } from '@/lib/db/config';
import { NextRequest } from 'next/server';

// Mock the database functions
jest.mock('@/lib/db/config');

// Mock the TransformersEmbeddingProvider
jest.mock('@/lib/ingestion/transformers-embedding-provider', () => ({
  TransformersEmbeddingProvider: {
    deleteModel: jest.fn(),
  },
}));

describe('Model Delete API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/models/delete', () => {
    it('should return 400 if modelName is missing', async () => {
      const request = new NextRequest('http://localhost/api/models/delete', {
        method: 'POST',
        body: JSON.stringify({}),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe('modelName is required');
    });

    it('should delete model and update status', async () => {
      const { TransformersEmbeddingProvider } = await import('@/lib/ingestion/transformers-embedding-provider');
      (TransformersEmbeddingProvider.deleteModel as jest.Mock).mockResolvedValue(undefined);
      (updateModelDownloadStatus as jest.Mock).mockResolvedValue(undefined);

      const request = new NextRequest('http://localhost/api/models/delete', {
        method: 'POST',
        body: JSON.stringify({ modelName: 'Xenova/all-MiniLM-L6-v2' }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.message).toBe('Model deleted successfully');
      
      // Should call deleteModel
      expect(TransformersEmbeddingProvider.deleteModel).toHaveBeenCalledWith('Xenova/all-MiniLM-L6-v2');
      
      // Should update status to not_downloaded
      expect(updateModelDownloadStatus).toHaveBeenCalledWith(
        'Xenova/all-MiniLM-L6-v2',
        'transformers',
        'not_downloaded',
        0
      );
    });

    it('should handle deletion errors gracefully', async () => {
      const { TransformersEmbeddingProvider } = await import('@/lib/ingestion/transformers-embedding-provider');
      (TransformersEmbeddingProvider.deleteModel as jest.Mock).mockRejectedValue(
        new Error('Failed to delete model')
      );

      const request = new NextRequest('http://localhost/api/models/delete', {
        method: 'POST',
        body: JSON.stringify({ modelName: 'Xenova/all-MiniLM-L6-v2' }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toBe('Failed to delete model');
    });
  });
});
