/**
 * Unit tests for Backup API route
 * @jest-environment node
 */

import { POST, GET, PUT } from '../route';
import { BackupManager } from '@/lib/backup';
import { logger } from '@/lib/logger';
import { NextRequest } from 'next/server';

// Mock dependencies
jest.mock('@/lib/backup');
jest.mock('@/lib/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const MockBackupManager = BackupManager as jest.MockedClass<typeof BackupManager>;

describe('Backup API', () => {
  let mockBackupManager: jest.Mocked<BackupManager>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockBackupManager = {
      createBackup: jest.fn(),
      listBackups: jest.fn(),
      restoreBackup: jest.fn(),
    } as any;
    MockBackupManager.mockImplementation(() => mockBackupManager);
  });

  describe('POST /api/backup', () => {
    it('should create a backup successfully', async () => {
      const mockResult = {
        success: true,
        backupDir: '/test/backups/backup-2024-01-01',
        manifestPath: '/test/backups/backup-2024-01-01/manifest.json',
      };

      mockBackupManager.createBackup.mockResolvedValue(mockResult);

      const request = new NextRequest('http://localhost:3000/api/backup', {
        method: 'POST',
        body: JSON.stringify({
          includeLanceDB: true,
          includeDatabase: true,
        }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.backupDir).toBe(mockResult.backupDir);
      expect(data.manifestPath).toBe(mockResult.manifestPath);
      expect(mockBackupManager.createBackup).toHaveBeenCalledWith({
        outputDir: expect.any(String),
        includeLanceDB: true,
        includeDatabase: true,
      });
    });

    it('should handle backup with default options', async () => {
      const mockResult = {
        success: true,
        backupDir: '/test/backups/backup-2024-01-01',
        manifestPath: '/test/backups/backup-2024-01-01/manifest.json',
      };

      mockBackupManager.createBackup.mockResolvedValue(mockResult);

      const request = new NextRequest('http://localhost:3000/api/backup', {
        method: 'POST',
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(mockBackupManager.createBackup).toHaveBeenCalledWith({
        outputDir: expect.any(String),
        includeLanceDB: true,
        includeDatabase: true,
      });
    });

    it('should handle backup with custom options', async () => {
      const mockResult = {
        success: true,
        backupDir: '/test/backups/backup-2024-01-01',
        manifestPath: '/test/backups/backup-2024-01-01/manifest.json',
      };

      mockBackupManager.createBackup.mockResolvedValue(mockResult);

      const request = new NextRequest('http://localhost:3000/api/backup', {
        method: 'POST',
        body: JSON.stringify({
          includeLanceDB: false,
          includeDatabase: true,
        }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(mockBackupManager.createBackup).toHaveBeenCalledWith({
        outputDir: expect.any(String),
        includeLanceDB: false,
        includeDatabase: true,
      });
    });

    it('should handle backup failure', async () => {
      const mockResult = {
        success: false,
        error: 'Permission denied',
      };

      mockBackupManager.createBackup.mockResolvedValue(mockResult);

      const request = new NextRequest('http://localhost:3000/api/backup', {
        method: 'POST',
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toBe('Permission denied');
    });

    it('should handle exceptions', async () => {
      mockBackupManager.createBackup.mockRejectedValue(new Error('Unexpected error'));

      const request = new NextRequest('http://localhost:3000/api/backup', {
        method: 'POST',
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toBe('Unexpected error');
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe('GET /api/backup', () => {
    it('should list available backups', async () => {
      const mockBackups = [
        {
          version: '1.0.0',
          timestamp: '2024-01-02T00:00:00.000Z',
          databasePath: '/test/data/sound-suite.db',
          lancedbPath: '/test/data/lancedb',
          databaseSize: 2048,
          lancedbSize: 4096,
        },
        {
          version: '1.0.0',
          timestamp: '2024-01-01T00:00:00.000Z',
          databasePath: '/test/data/sound-suite.db',
          lancedbPath: '/test/data/lancedb',
          databaseSize: 1024,
          lancedbSize: 2048,
        },
      ];

      mockBackupManager.listBackups.mockResolvedValue(mockBackups);

      const response = await GET();
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.backups).toEqual(mockBackups);
      expect(data.backupDir).toBeDefined();
    });

    it('should handle empty backup list', async () => {
      mockBackupManager.listBackups.mockResolvedValue([]);

      const response = await GET();
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.backups).toEqual([]);
    });

    it('should handle exceptions', async () => {
      mockBackupManager.listBackups.mockRejectedValue(new Error('Directory not found'));

      const response = await GET();
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toBe('Directory not found');
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe('PUT /api/backup', () => {
    const testBackupDir = '/test/backups/backup-2024-01-01';

    it('should restore from backup successfully', async () => {
      const mockResult = {
        success: true,
        restoredDatabase: true,
        restoredLanceDB: true,
        integrityVerified: true,
      };

      mockBackupManager.restoreBackup.mockResolvedValue(mockResult);

      const request = new NextRequest('http://localhost:3000/api/backup', {
        method: 'PUT',
        body: JSON.stringify({
          backupDir: testBackupDir,
          restoreDatabase: true,
          restoreLanceDB: true,
          verifyIntegrity: true,
        }),
      });

      const response = await PUT(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.restoredDatabase).toBe(true);
      expect(data.restoredLanceDB).toBe(true);
      expect(data.integrityVerified).toBe(true);
      expect(mockBackupManager.restoreBackup).toHaveBeenCalledWith({
        backupDir: testBackupDir,
        restoreDatabase: true,
        restoreLanceDB: true,
        verifyIntegrity: true,
      });
    });

    it('should restore with default options', async () => {
      const mockResult = {
        success: true,
        restoredDatabase: true,
        restoredLanceDB: true,
        integrityVerified: true,
      };

      mockBackupManager.restoreBackup.mockResolvedValue(mockResult);

      const request = new NextRequest('http://localhost:3000/api/backup', {
        method: 'PUT',
        body: JSON.stringify({
          backupDir: testBackupDir,
        }),
      });

      const response = await PUT(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(mockBackupManager.restoreBackup).toHaveBeenCalledWith({
        backupDir: testBackupDir,
        restoreDatabase: true,
        restoreLanceDB: true,
        verifyIntegrity: true,
      });
    });

    it('should restore only database when LanceDB excluded', async () => {
      const mockResult = {
        success: true,
        restoredDatabase: true,
        restoredLanceDB: false,
        integrityVerified: false,
      };

      mockBackupManager.restoreBackup.mockResolvedValue(mockResult);

      const request = new NextRequest('http://localhost:3000/api/backup', {
        method: 'PUT',
        body: JSON.stringify({
          backupDir: testBackupDir,
          restoreDatabase: true,
          restoreLanceDB: false,
          verifyIntegrity: false,
        }),
      });

      const response = await PUT(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.restoredDatabase).toBe(true);
      expect(data.restoredLanceDB).toBe(false);
    });

    it('should require backupDir parameter', async () => {
      const request = new NextRequest('http://localhost:3000/api/backup', {
        method: 'PUT',
        body: JSON.stringify({}),
      });

      const response = await PUT(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toBe('backupDir is required');
    });

    it('should handle restore failure', async () => {
      const mockResult = {
        success: false,
        error: 'Integrity verification failed',
      };

      mockBackupManager.restoreBackup.mockResolvedValue(mockResult);

      const request = new NextRequest('http://localhost:3000/api/backup', {
        method: 'PUT',
        body: JSON.stringify({
          backupDir: testBackupDir,
        }),
      });

      const response = await PUT(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toBe('Integrity verification failed');
    });

    it('should handle exceptions', async () => {
      mockBackupManager.restoreBackup.mockRejectedValue(new Error('Unexpected error'));

      const request = new NextRequest('http://localhost:3000/api/backup', {
        method: 'PUT',
        body: JSON.stringify({
          backupDir: testBackupDir,
        }),
      });

      const response = await PUT(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toBe('Unexpected error');
      expect(logger.error).toHaveBeenCalled();
    });
  });
});
