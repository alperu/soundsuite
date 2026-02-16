/**
 * Unit tests for BackupManager
 */

import { BackupManager } from '../backup-manager';
import fs from 'fs/promises';
import { createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { logger } from '../../logger';

// Mock dependencies
jest.mock('fs/promises');
jest.mock('fs', () => ({
  createReadStream: jest.fn(),
  createWriteStream: jest.fn(),
}));
jest.mock('stream/promises', () => ({
  pipeline: jest.fn(),
}));
jest.mock('../../logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const mockFs = fs as jest.Mocked<typeof fs>;
const mockPipeline = pipeline as jest.MockedFunction<typeof pipeline>;
const mockCreateReadStream = createReadStream as jest.MockedFunction<typeof createReadStream>;
const mockCreateWriteStream = createWriteStream as jest.MockedFunction<typeof createWriteStream>;

describe('BackupManager', () => {
  const testDbPath = '/test/data/sound-suite.db';
  const testLancedbPath = '/test/data/lancedb';
  const testOutputDir = '/test/backups';

  let backupManager: BackupManager;

  beforeEach(() => {
    jest.clearAllMocks();
    backupManager = new BackupManager(testDbPath, testLancedbPath);
  });

  describe('createBackup', () => {
    it('should create a backup with database and LanceDB', async () => {
      // Mock file system operations
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.access.mockResolvedValue(undefined);
      mockFs.stat.mockResolvedValue({ size: 1024 } as any);
      mockFs.readdir.mockResolvedValue([]);
      mockFs.writeFile.mockResolvedValue(undefined);
      mockPipeline.mockResolvedValue(undefined);
      mockCreateReadStream.mockReturnValue({} as any);
      mockCreateWriteStream.mockReturnValue({} as any);

      const result = await backupManager.createBackup({
        outputDir: testOutputDir,
        includeLanceDB: true,
        includeDatabase: true,
      });

      expect(result.success).toBe(true);
      expect(result.backupDir).toBeDefined();
      expect(result.manifestPath).toBeDefined();
      expect(mockFs.mkdir).toHaveBeenCalled();
      expect(mockFs.writeFile).toHaveBeenCalled();
    });

    it('should create backup with only database when LanceDB excluded', async () => {
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.access.mockResolvedValue(undefined);
      mockFs.stat.mockResolvedValue({ size: 1024 } as any);
      mockFs.writeFile.mockResolvedValue(undefined);
      mockPipeline.mockResolvedValue(undefined);
      mockCreateReadStream.mockReturnValue({} as any);
      mockCreateWriteStream.mockReturnValue({} as any);

      const result = await backupManager.createBackup({
        outputDir: testOutputDir,
        includeLanceDB: false,
        includeDatabase: true,
      });

      expect(result.success).toBe(true);
    });

    it('should create backup with only LanceDB when database excluded', async () => {
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.access.mockResolvedValue(undefined);
      mockFs.readdir.mockResolvedValue([]);
      mockFs.writeFile.mockResolvedValue(undefined);
      mockPipeline.mockResolvedValue(undefined);

      const result = await backupManager.createBackup({
        outputDir: testOutputDir,
        includeLanceDB: true,
        includeDatabase: false,
      });

      expect(result.success).toBe(true);
    });

    it('should handle errors gracefully', async () => {
      mockFs.mkdir.mockRejectedValue(new Error('Permission denied'));

      const result = await backupManager.createBackup({
        outputDir: testOutputDir,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(logger.error).toHaveBeenCalled();
    });

    it('should handle missing source files', async () => {
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.access.mockRejectedValue({ code: 'ENOENT' });
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.readdir.mockResolvedValue([]);
      mockPipeline.mockResolvedValue(undefined);

      const result = await backupManager.createBackup({
        outputDir: testOutputDir,
      });

      expect(result.success).toBe(true);
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('listBackups', () => {
    it('should list available backups', async () => {
      const mockManifest = {
        version: '1.0.0',
        timestamp: '2024-01-01T00:00:00.000Z',
        databasePath: testDbPath,
        lancedbPath: testLancedbPath,
        databaseSize: 1024,
        lancedbSize: 2048,
      };

      mockFs.readdir.mockResolvedValue([
        { name: 'backup-2024-01-01', isDirectory: () => true } as any,
        { name: 'backup-2024-01-02', isDirectory: () => true } as any,
        { name: 'other-file.txt', isDirectory: () => false } as any,
      ]);

      mockFs.readFile.mockResolvedValue(JSON.stringify(mockManifest));

      const backups = await backupManager.listBackups(testOutputDir);

      expect(backups).toHaveLength(2);
      expect(backups[0]).toMatchObject(mockManifest);
    });

    it('should handle missing backup directory', async () => {
      mockFs.readdir.mockRejectedValue(new Error('Directory not found'));

      const backups = await backupManager.listBackups(testOutputDir);

      expect(backups).toEqual([]);
      expect(logger.error).toHaveBeenCalled();
    });

    it('should skip backups with invalid manifests', async () => {
      mockFs.readdir.mockResolvedValue([
        { name: 'backup-2024-01-01', isDirectory: () => true } as any,
      ]);

      mockFs.readFile.mockRejectedValue(new Error('Invalid JSON'));

      const backups = await backupManager.listBackups(testOutputDir);

      expect(backups).toEqual([]);
      expect(logger.warn).toHaveBeenCalled();
    });

    it('should sort backups by timestamp (newest first)', async () => {
      const manifest1 = {
        version: '1.0.0',
        timestamp: '2024-01-01T00:00:00.000Z',
        databasePath: testDbPath,
        lancedbPath: testLancedbPath,
        databaseSize: 1024,
        lancedbSize: 2048,
      };

      const manifest2 = {
        ...manifest1,
        timestamp: '2024-01-02T00:00:00.000Z',
      };

      mockFs.readdir.mockResolvedValue([
        { name: 'backup-2024-01-01', isDirectory: () => true } as any,
        { name: 'backup-2024-01-02', isDirectory: () => true } as any,
      ]);

      mockFs.readFile
        .mockResolvedValueOnce(JSON.stringify(manifest1))
        .mockResolvedValueOnce(JSON.stringify(manifest2));

      const backups = await backupManager.listBackups(testOutputDir);

      expect(backups).toHaveLength(2);
      expect(backups[0].timestamp).toBe('2024-01-02T00:00:00.000Z');
      expect(backups[1].timestamp).toBe('2024-01-01T00:00:00.000Z');
    });
  });

  describe('restoreBackup', () => {
    const testBackupDir = '/test/backups/backup-2024-01-01';
    const mockManifest = {
      version: '1.0.0',
      timestamp: '2024-01-01T00:00:00.000Z',
      databasePath: testDbPath,
      lancedbPath: testLancedbPath,
      databaseSize: 1024,
      lancedbSize: 2048,
    };

    it('should restore both database and LanceDB from backup', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify(mockManifest));
      mockFs.access.mockResolvedValue(undefined);
      // Mock stat to return the same size as manifest for integrity check
      mockFs.stat.mockResolvedValue({ size: mockManifest.databaseSize } as any);
      mockFs.rm.mockResolvedValue(undefined);
      // Mock readdir to return empty array for getDirectorySize calculation
      mockFs.readdir.mockImplementation(async (path: any) => {
        // For LanceDB directory size calculation, return files that sum to manifest size
        if (path.toString().includes('lancedb')) {
          return [
            { name: 'file1.dat', isDirectory: () => false } as any,
            { name: 'file2.dat', isDirectory: () => false } as any,
          ];
        }
        return [];
      });
      // Mock stat for LanceDB files to match manifest size
      let statCallCount = 0;
      mockFs.stat.mockImplementation(async (path: any) => {
        if (path.toString().includes('lancedb')) {
          statCallCount++;
          // Return half the size for each of the 2 files
          return { size: mockManifest.lancedbSize / 2 } as any;
        }
        return { size: mockManifest.databaseSize } as any;
      });
      mockFs.mkdir.mockResolvedValue(undefined);
      mockPipeline.mockResolvedValue(undefined);
      mockCreateReadStream.mockReturnValue({} as any);
      mockCreateWriteStream.mockReturnValue({} as any);

      const result = await backupManager.restoreBackup({
        backupDir: testBackupDir,
        restoreDatabase: true,
        restoreLanceDB: true,
        verifyIntegrity: true,
      });

      expect(result.success).toBe(true);
      expect(result.restoredDatabase).toBe(true);
      expect(result.restoredLanceDB).toBe(true);
      expect(result.integrityVerified).toBe(true);
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Restore completed successfully'));
    });

    it('should restore only database when LanceDB excluded', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify(mockManifest));
      mockFs.access.mockResolvedValue(undefined);
      mockFs.stat.mockResolvedValue({ size: 1024 } as any);
      mockPipeline.mockResolvedValue(undefined);
      mockCreateReadStream.mockReturnValue({} as any);
      mockCreateWriteStream.mockReturnValue({} as any);

      const result = await backupManager.restoreBackup({
        backupDir: testBackupDir,
        restoreDatabase: true,
        restoreLanceDB: false,
        verifyIntegrity: false,
      });

      expect(result.success).toBe(true);
      expect(result.restoredDatabase).toBe(true);
      expect(result.restoredLanceDB).toBe(false);
    });

    it('should restore only LanceDB when database excluded', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify(mockManifest));
      mockFs.access.mockResolvedValue(undefined);
      mockFs.rm.mockResolvedValue(undefined);
      mockFs.readdir.mockResolvedValue([]);
      mockFs.mkdir.mockResolvedValue(undefined);
      mockPipeline.mockResolvedValue(undefined);

      const result = await backupManager.restoreBackup({
        backupDir: testBackupDir,
        restoreDatabase: false,
        restoreLanceDB: true,
        verifyIntegrity: false,
      });

      expect(result.success).toBe(true);
      expect(result.restoredDatabase).toBe(false);
      expect(result.restoredLanceDB).toBe(true);
    });

    it('should backup existing data before restoring', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify(mockManifest));
      mockFs.access.mockResolvedValue(undefined);
      mockFs.stat.mockResolvedValue({ size: 1024 } as any);
      mockFs.rm.mockResolvedValue(undefined);
      mockFs.readdir.mockResolvedValue([]);
      mockFs.mkdir.mockResolvedValue(undefined);
      mockPipeline.mockResolvedValue(undefined);
      mockCreateReadStream.mockReturnValue({} as any);
      mockCreateWriteStream.mockReturnValue({} as any);

      await backupManager.restoreBackup({
        backupDir: testBackupDir,
        verifyIntegrity: false,
      });

      // Should have backed up current database and LanceDB
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('backed up to'));
    });

    it('should handle missing backup files gracefully', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify(mockManifest));
      mockFs.access.mockRejectedValue({ code: 'ENOENT' });

      const result = await backupManager.restoreBackup({
        backupDir: testBackupDir,
        verifyIntegrity: false,
      });

      expect(result.success).toBe(true);
      expect(logger.warn).toHaveBeenCalled();
    });

    it('should handle invalid manifest', async () => {
      mockFs.readFile.mockRejectedValue(new Error('Invalid JSON'));

      const result = await backupManager.restoreBackup({
        backupDir: testBackupDir,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(logger.error).toHaveBeenCalled();
    });

    it('should verify data integrity after restore', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify(mockManifest));
      mockFs.access.mockResolvedValue(undefined);
      // Mock readdir to return empty array for getDirectorySize calculation
      mockFs.readdir.mockImplementation(async (path: any) => {
        // For LanceDB directory size calculation, return files that sum to manifest size
        if (path.toString().includes('lancedb')) {
          return [
            { name: 'file1.dat', isDirectory: () => false } as any,
            { name: 'file2.dat', isDirectory: () => false } as any,
          ];
        }
        return [];
      });
      // Mock stat for both database and LanceDB files
      mockFs.stat.mockImplementation(async (path: any) => {
        if (path.toString().includes('lancedb')) {
          // Return half the size for each of the 2 files
          return { size: mockManifest.lancedbSize / 2 } as any;
        }
        return { size: mockManifest.databaseSize } as any;
      });
      mockFs.rm.mockResolvedValue(undefined);
      mockFs.mkdir.mockResolvedValue(undefined);
      mockPipeline.mockResolvedValue(undefined);
      mockCreateReadStream.mockReturnValue({} as any);
      mockCreateWriteStream.mockReturnValue({} as any);

      const result = await backupManager.restoreBackup({
        backupDir: testBackupDir,
        verifyIntegrity: true,
      });

      expect(result.integrityVerified).toBe(true);
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Data integrity verified'));
    });

    it('should fail when integrity verification fails', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify(mockManifest));
      mockFs.access.mockResolvedValue(undefined);
      mockFs.stat.mockResolvedValue({ size: 0 } as any); // Empty file
      mockFs.rm.mockResolvedValue(undefined);
      mockFs.readdir.mockResolvedValue([]);
      mockFs.mkdir.mockResolvedValue(undefined);
      mockPipeline.mockResolvedValue(undefined);
      mockCreateReadStream.mockReturnValue({} as any);
      mockCreateWriteStream.mockReturnValue({} as any);

      const result = await backupManager.restoreBackup({
        backupDir: testBackupDir,
        verifyIntegrity: true,
      });

      expect(result.success).toBe(false);
      expect(result.integrityVerified).toBe(false);
      expect(result.error).toContain('Integrity verification failed');
      expect(logger.warn).toHaveBeenCalled();
    });

    it('should handle restore errors gracefully', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify(mockManifest));
      mockFs.access.mockResolvedValue(undefined);
      mockPipeline.mockRejectedValue(new Error('Disk full'));

      const result = await backupManager.restoreBackup({
        backupDir: testBackupDir,
        verifyIntegrity: false,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(logger.error).toHaveBeenCalled();
    });

    it('should skip integrity verification when disabled', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify(mockManifest));
      mockFs.access.mockResolvedValue(undefined);
      mockFs.stat.mockResolvedValue({ size: 1024 } as any);
      mockFs.rm.mockResolvedValue(undefined);
      mockFs.readdir.mockResolvedValue([]);
      mockFs.mkdir.mockResolvedValue(undefined);
      mockPipeline.mockResolvedValue(undefined);
      mockCreateReadStream.mockReturnValue({} as any);
      mockCreateWriteStream.mockReturnValue({} as any);

      const result = await backupManager.restoreBackup({
        backupDir: testBackupDir,
        verifyIntegrity: false,
      });

      expect(result.success).toBe(true);
      expect(result.integrityVerified).toBe(false);
    });
  });

  describe('manifest creation', () => {
    it('should create manifest with correct metadata', async () => {
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.access.mockResolvedValue(undefined);
      mockFs.stat.mockResolvedValue({ size: 1024 } as any);
      mockFs.readdir.mockResolvedValue([]);
      mockPipeline.mockResolvedValue(undefined);
      mockCreateReadStream.mockReturnValue({} as any);
      mockCreateWriteStream.mockReturnValue({} as any);
      
      let capturedManifest: any;
      mockFs.writeFile.mockImplementation(async (path, content) => {
        if (path.toString().includes('manifest.json')) {
          capturedManifest = JSON.parse(content as string);
        }
      });

      await backupManager.createBackup({
        outputDir: testOutputDir,
      });

      expect(capturedManifest).toBeDefined();
      expect(capturedManifest.version).toBe('1.0.0');
      expect(capturedManifest.timestamp).toBeDefined();
      expect(capturedManifest.databasePath).toBe(testDbPath);
      expect(capturedManifest.lancedbPath).toBe(testLancedbPath);
      expect(capturedManifest.databaseSize).toBeGreaterThanOrEqual(0);
      expect(capturedManifest.lancedbSize).toBeGreaterThanOrEqual(0);
    });
  });
});
