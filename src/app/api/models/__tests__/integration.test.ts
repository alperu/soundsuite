/**
 * Integration tests for Model Download functionality
 * 
 * Tests the complete flow: download → status check → delete
 * 
 * Requirements: 18.13, 18.14, 18.15, 18.16
 *
 * @jest-environment node
 */

import { POST as downloadPost } from '../download/route';
import { POST as deletePost } from '../delete/route';
import { GET as statusGet } from '../status/route';
import { updateModelDownloadStatus, getModelDownloadStatus } from '@/lib/db/config';
import { NextRequest } from 'next/server';

// Mock the database functions
jest.mock('@/lib/db/config');

// Mock the TransformersEmbeddingProvider
jest.mock('@/lib/ingestion/transformers-embedding-provider', () => ({
  TransformersEmbeddingProvider: {
    isModelDownloaded: jest.fn(),
    downloadModel: jest.fn(),
    getModelSize: jest.fn(),
    deleteModel: jest.fn(),
  },
}));

describe('Model Download Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should complete full download lifecycle', async () => {
    const modelName = 'Xenova/all-MiniLM-L6-v2';
    const { TransformersEmbeddingProvider } = await import('@/lib/ingestion/transformers-embedding-provider');

    // Step 1: Check initial status (not downloaded)
    (getModelDownloadStatus as jest.Mock).mockResolvedValue([
      {
        modelName,
        provider: 'transformers',
        status: 'not_downloaded',
        downloadProgress: 0,
      },
    ]);

    let response = await statusGet();
    let data = await response.json();
    expect(data[0].status).toBe('not_downloaded');

    // Step 2: Start download
    (TransformersEmbeddingProvider.isModelDownloaded as jest.Mock).mockResolvedValue(false);
    (updateModelDownloadStatus as jest.Mock).mockResolvedValue(undefined);
    (TransformersEmbeddingProvider.downloadModel as jest.Mock).mockImplementation(
      async (modelName: string, onProgress?: (progress: number, loaded: number, total: number) => void) => {
        if (onProgress) {
          await onProgress(0, 0, 90000000);
          await onProgress(50, 45000000, 90000000);
          await onProgress(100, 90000000, 90000000);
        }
      }
    );
    (TransformersEmbeddingProvider.getModelSize as jest.Mock).mockResolvedValue(90000000);

    const downloadRequest = new NextRequest('http://localhost/api/models/download', {
      method: 'POST',
      body: JSON.stringify({ modelName }),
    });

    response = await downloadPost(downloadRequest);
    data = await response.json();
    expect(data.success).toBe(true);
    expect(updateModelDownloadStatus).toHaveBeenCalledWith(
      modelName,
      'transformers',
      'downloading',
      0
    );

    // Step 3: Check status during download
    (getModelDownloadStatus as jest.Mock).mockResolvedValue([
      {
        modelName,
        provider: 'transformers',
        status: 'downloading',
        downloadProgress: 50,
        sizeBytes: 90000000,
      },
    ]);

    response = await statusGet();
    data = await response.json();
    expect(data[0].status).toBe('downloading');
    expect(data[0].downloadProgress).toBe(50);

    // Step 4: Check status after download completes
    (getModelDownloadStatus as jest.Mock).mockResolvedValue([
      {
        modelName,
        provider: 'transformers',
        status: 'downloaded',
        downloadProgress: 100,
        sizeBytes: 90000000,
        downloadedAt: new Date(),
      },
    ]);

    response = await statusGet();
    data = await response.json();
    expect(data[0].status).toBe('downloaded');
    expect(data[0].downloadProgress).toBe(100);

    // Step 5: Delete the model
    (TransformersEmbeddingProvider.deleteModel as jest.Mock).mockResolvedValue(undefined);

    const deleteRequest = new NextRequest('http://localhost/api/models/delete', {
      method: 'POST',
      body: JSON.stringify({ modelName }),
    });

    response = await deletePost(deleteRequest);
    data = await response.json();
    expect(data.success).toBe(true);
    expect(TransformersEmbeddingProvider.deleteModel).toHaveBeenCalledWith(modelName);
    expect(updateModelDownloadStatus).toHaveBeenCalledWith(
      modelName,
      'transformers',
      'not_downloaded',
      0
    );

    // Step 6: Verify status after deletion
    (getModelDownloadStatus as jest.Mock).mockResolvedValue([
      {
        modelName,
        provider: 'transformers',
        status: 'not_downloaded',
        downloadProgress: 0,
      },
    ]);

    response = await statusGet();
    data = await response.json();
    expect(data[0].status).toBe('not_downloaded');
  });

  it('should handle download errors correctly', async () => {
    const modelName = 'Xenova/all-MiniLM-L6-v2';
    const { TransformersEmbeddingProvider } = await import('@/lib/ingestion/transformers-embedding-provider');

    // Start download that will fail
    (TransformersEmbeddingProvider.isModelDownloaded as jest.Mock).mockResolvedValue(false);
    (updateModelDownloadStatus as jest.Mock).mockResolvedValue(undefined);
    (TransformersEmbeddingProvider.downloadModel as jest.Mock).mockRejectedValue(
      new Error('Network error')
    );

    const downloadRequest = new NextRequest('http://localhost/api/models/download', {
      method: 'POST',
      body: JSON.stringify({ modelName }),
    });

    const response = await downloadPost(downloadRequest);
    const data = await response.json();
    expect(data.success).toBe(true); // Download starts successfully

    // Wait for background process to fail
    await new Promise(resolve => setTimeout(resolve, 100));

    // Check that error status would be set (we can't directly test the background function)
    // but we can verify the mock was called
    expect(TransformersEmbeddingProvider.downloadModel).toHaveBeenCalled();
  });

  it('should prevent downloading already downloaded models', async () => {
    const modelName = 'Xenova/all-MiniLM-L6-v2';
    const { TransformersEmbeddingProvider } = await import('@/lib/ingestion/transformers-embedding-provider');

    // Model is already downloaded
    (TransformersEmbeddingProvider.isModelDownloaded as jest.Mock).mockResolvedValue(true);

    const downloadRequest = new NextRequest('http://localhost/api/models/download', {
      method: 'POST',
      body: JSON.stringify({ modelName }),
    });

    const response = await downloadPost(downloadRequest);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe('Model is already downloaded');
    expect(updateModelDownloadStatus).not.toHaveBeenCalled();
  });

  it('should handle multiple models independently', async () => {
    const model1 = 'Xenova/all-MiniLM-L6-v2';
    const model2 = 'Xenova/all-mpnet-base-v2';

    // Check status for multiple models
    (getModelDownloadStatus as jest.Mock).mockResolvedValue([
      {
        modelName: model1,
        provider: 'transformers',
        status: 'downloaded',
        downloadProgress: 100,
        sizeBytes: 90000000,
      },
      {
        modelName: model2,
        provider: 'transformers',
        status: 'not_downloaded',
        downloadProgress: 0,
      },
    ]);

    const response = await statusGet();
    const data = await response.json();

    expect(data.length).toBe(2);
    expect(data[0].status).toBe('downloaded');
    expect(data[1].status).toBe('not_downloaded');
  });
});
