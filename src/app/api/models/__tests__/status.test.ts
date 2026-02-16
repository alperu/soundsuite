/**
 * Tests for Model Status API Route
 * 
 * Requirements: 18.12
 */

import { GET } from '../status/route';
import { getModelDownloadStatus } from '@/lib/db/config';

// Mock the database functions
jest.mock('@/lib/db/config');

describe('Model Status API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/models/status', () => {
    it('should return empty array when no models are tracked', async () => {
      (getModelDownloadStatus as jest.Mock).mockResolvedValue([]);

      const response = await GET();
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data).toEqual([]);
    });

    it('should return model download status', async () => {
      const mockStatus = [
        {
          modelName: 'Xenova/all-MiniLM-L6-v2',
          provider: 'transformers',
          status: 'downloaded',
          downloadProgress: 100,
          sizeBytes: 90000000,
          downloadedAt: new Date('2024-01-01'),
        },
        {
          modelName: 'Xenova/all-mpnet-base-v2',
          provider: 'transformers',
          status: 'not_downloaded',
          downloadProgress: 0,
        },
      ];

      (getModelDownloadStatus as jest.Mock).mockResolvedValue(mockStatus);

      const response = await GET();
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.length).toBe(2);
      expect(data[0].modelName).toBe('Xenova/all-MiniLM-L6-v2');
      expect(data[0].status).toBe('downloaded');
      expect(getModelDownloadStatus).toHaveBeenCalled();
    });

    it('should return model with downloading status', async () => {
      const mockStatus = [
        {
          modelName: 'Xenova/all-MiniLM-L6-v2',
          provider: 'transformers',
          status: 'downloading',
          downloadProgress: 45,
          sizeBytes: 90000000,
        },
      ];

      (getModelDownloadStatus as jest.Mock).mockResolvedValue(mockStatus);

      const response = await GET();
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data[0].status).toBe('downloading');
      expect(data[0].downloadProgress).toBe(45);
    });

    it('should return model with error status', async () => {
      const mockStatus = [
        {
          modelName: 'Xenova/all-MiniLM-L6-v2',
          provider: 'transformers',
          status: 'error',
          downloadProgress: 0,
          errorMessage: 'Network error',
        },
      ];

      (getModelDownloadStatus as jest.Mock).mockResolvedValue(mockStatus);

      const response = await GET();
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data[0].status).toBe('error');
      expect(data[0].errorMessage).toBe('Network error');
    });

    it('should handle database errors gracefully', async () => {
      (getModelDownloadStatus as jest.Mock).mockRejectedValue(
        new Error('Database error')
      );

      const response = await GET();
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toBe('Database error');
    });
  });
});
