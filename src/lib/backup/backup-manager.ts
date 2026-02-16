/**
 * Backup Manager
 * 
 * Handles backup and restore operations for Sound Suite data:
 * - SQLite database export
 * - LanceDB data directory export
 * - Backup manifest creation with metadata
 * 
 * Requirements: 20.4
 */

import fs from 'fs/promises';
import path from 'path';
import { createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { logger } from '../logger';

export interface BackupManifest {
  version: string;
  timestamp: string;
  databasePath: string;
  lancedbPath: string;
  databaseSize: number;
  lancedbSize: number;
  checksum?: string;
}

export interface BackupOptions {
  outputDir: string;
  includeLanceDB?: boolean;
  includeDatabase?: boolean;
}

export interface BackupResult {
  success: boolean;
  manifestPath?: string;
  backupDir?: string;
  error?: string;
}

export interface RestoreOptions {
  backupDir: string;
  restoreDatabase?: boolean;
  restoreLanceDB?: boolean;
  verifyIntegrity?: boolean;
}

export interface RestoreResult {
  success: boolean;
  restoredDatabase?: boolean;
  restoredLanceDB?: boolean;
  integrityVerified?: boolean;
  error?: string;
}

export class BackupManager {
  private databasePath: string;
  private lancedbPath: string;

  constructor(databasePath: string, lancedbPath: string) {
    this.databasePath = databasePath;
    this.lancedbPath = lancedbPath;
  }

  /**
   * Create a complete backup of the system
   * 
   * @param options - Backup configuration options
   * @returns BackupResult with success status and paths
   */
  async createBackup(options: BackupOptions): Promise<BackupResult> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(options.outputDir, `backup-${timestamp}`);

    try {
      logger.info(`Starting backup to ${backupDir}`);

      // Create backup directory
      await fs.mkdir(backupDir, { recursive: true });

      const manifest: BackupManifest = {
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        databasePath: this.databasePath,
        lancedbPath: this.lancedbPath,
        databaseSize: 0,
        lancedbSize: 0,
      };

      // Backup SQLite database
      if (options.includeDatabase !== false) {
        logger.info('Backing up SQLite database...');
        const dbBackupPath = path.join(backupDir, 'sound-suite.db');
        await this.copyFile(this.databasePath, dbBackupPath);
        const dbStats = await fs.stat(dbBackupPath);
        manifest.databaseSize = dbStats.size;
        logger.info(`Database backed up: ${dbStats.size} bytes`);
      }

      // Backup LanceDB directory
      if (options.includeLanceDB !== false) {
        logger.info('Backing up LanceDB data...');
        const lancedbBackupPath = path.join(backupDir, 'lancedb');
        await this.copyDirectory(this.lancedbPath, lancedbBackupPath);
        const lancedbSize = await this.getDirectorySize(lancedbBackupPath);
        manifest.lancedbSize = lancedbSize;
        logger.info(`LanceDB backed up: ${lancedbSize} bytes`);
      }

      // Write manifest
      const manifestPath = path.join(backupDir, 'manifest.json');
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
      logger.info(`Backup manifest created at ${manifestPath}`);

      logger.info('Backup completed successfully');
      return {
        success: true,
        manifestPath,
        backupDir,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Backup failed', error instanceof Error ? error : undefined);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Copy a file from source to destination
   */
  private async copyFile(source: string, destination: string): Promise<void> {
    try {
      // Check if source exists
      await fs.access(source);
      
      // Ensure destination directory exists
      await fs.mkdir(path.dirname(destination), { recursive: true });
      
      // Copy file using streams for efficiency
      await pipeline(
        createReadStream(source),
        createWriteStream(destination)
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.warn(`Source file not found: ${source}`);
        // Create empty file if source doesn't exist
        await fs.writeFile(destination, '');
      } else {
        throw error;
      }
    }
  }

  /**
   * Recursively copy a directory
   */
  private async copyDirectory(source: string, destination: string): Promise<void> {
    try {
      // Check if source exists
      await fs.access(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.warn(`Source directory not found: ${source}`);
        // Create empty directory if source doesn't exist
        await fs.mkdir(destination, { recursive: true });
        return;
      }
      throw error;
    }

    // Create destination directory
    await fs.mkdir(destination, { recursive: true });

    // Read source directory
    const entries = await fs.readdir(source, { withFileTypes: true });

    // Copy each entry
    for (const entry of entries) {
      const sourcePath = path.join(source, entry.name);
      const destPath = path.join(destination, entry.name);

      if (entry.isDirectory()) {
        await this.copyDirectory(sourcePath, destPath);
      } else {
        await this.copyFile(sourcePath, destPath);
      }
    }
  }

  /**
   * Calculate total size of a directory recursively
   */
  private async getDirectorySize(dirPath: string): Promise<number> {
    try {
      await fs.access(dirPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return 0;
      }
      throw error;
    }

    let totalSize = 0;
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        totalSize += await this.getDirectorySize(entryPath);
      } else {
        const stats = await fs.stat(entryPath);
        totalSize += stats.size;
      }
    }

    return totalSize;
  }

  /**
   * List available backups in a directory
   */
  async listBackups(backupDir: string): Promise<BackupManifest[]> {
    try {
      const entries = await fs.readdir(backupDir, { withFileTypes: true });
      const backups: BackupManifest[] = [];

      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith('backup-')) {
          const manifestPath = path.join(backupDir, entry.name, 'manifest.json');
          try {
            const manifestContent = await fs.readFile(manifestPath, 'utf-8');
            const manifest = JSON.parse(manifestContent) as BackupManifest;
            backups.push(manifest);
          } catch (error) {
            logger.warn(`Failed to read manifest for ${entry.name}: ${error}`);
          }
        }
      }

      // Sort by timestamp (newest first)
      backups.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      return backups;
    } catch (error) {
      logger.error('Failed to list backups', error instanceof Error ? error : undefined);
      return [];
    }
  }
  /**
   * Restore system data from a backup
   *
   * @param options - Restore configuration options
   * @returns RestoreResult with success status and details
   */
  async restoreBackup(options: RestoreOptions): Promise<RestoreResult> {
    try {
      logger.info(`Starting restore from ${options.backupDir}`);

      // Read and validate manifest
      const manifestPath = path.join(options.backupDir, 'manifest.json');
      const manifestContent = await fs.readFile(manifestPath, 'utf-8');
      const manifest = JSON.parse(manifestContent) as BackupManifest;

      logger.info(`Restoring backup from ${manifest.timestamp}`);

      const result: RestoreResult = {
        success: true,
        restoredDatabase: false,
        restoredLanceDB: false,
        integrityVerified: false,
      };

      // Restore SQLite database
      if (options.restoreDatabase !== false) {
        logger.info('Restoring SQLite database...');
        const dbBackupPath = path.join(options.backupDir, 'sound-suite.db');

        try {
          await fs.access(dbBackupPath);

          // Create backup of current database before overwriting
          try {
            await fs.access(this.databasePath);
            const backupCurrentPath = `${this.databasePath}.pre-restore-${Date.now()}`;
            await this.copyFile(this.databasePath, backupCurrentPath);
            logger.info(`Current database backed up to ${backupCurrentPath}`);
          } catch (error) {
            // Current database doesn't exist, no need to back it up
            logger.info('No existing database to back up');
          }

          await this.copyFile(dbBackupPath, this.databasePath);
          result.restoredDatabase = true;
          logger.info('Database restored successfully');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            logger.warn('Database backup file not found, skipping database restore');
          } else {
            throw error;
          }
        }
      }

      // Restore LanceDB directory
      if (options.restoreLanceDB !== false) {
        logger.info('Restoring LanceDB data...');
        const lancedbBackupPath = path.join(options.backupDir, 'lancedb');

        try {
          await fs.access(lancedbBackupPath);

          // Create backup of current LanceDB before overwriting
          try {
            await fs.access(this.lancedbPath);
            const backupCurrentPath = `${this.lancedbPath}.pre-restore-${Date.now()}`;
            await this.copyDirectory(this.lancedbPath, backupCurrentPath);
            logger.info(`Current LanceDB backed up to ${backupCurrentPath}`);
          } catch (error) {
            // Current LanceDB doesn't exist, no need to back it up
            logger.info('No existing LanceDB to back up');
          }

          // Remove existing LanceDB directory
          try {
            await fs.rm(this.lancedbPath, { recursive: true, force: true });
          } catch (error) {
            logger.warn(`Failed to remove existing LanceDB directory: ${error}`);
          }

          await this.copyDirectory(lancedbBackupPath, this.lancedbPath);
          result.restoredLanceDB = true;
          logger.info('LanceDB restored successfully');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            logger.warn('LanceDB backup directory not found, skipping LanceDB restore');
          } else {
            throw error;
          }
        }
      }

      // Verify data integrity
      if (options.verifyIntegrity !== false) {
        logger.info('Verifying data integrity...');
        const integrityResult = await this.verifyIntegrity(manifest);
        result.integrityVerified = integrityResult.valid;

        if (!integrityResult.valid) {
          logger.warn('Integrity verification failed:', integrityResult.errors);
          result.success = false;
          result.error = `Integrity verification failed: ${integrityResult.errors.join(', ')}`;
        } else {
          logger.info('Data integrity verified successfully');
        }
      }

      logger.info('Restore completed successfully');
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Restore failed', error instanceof Error ? error : undefined);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Verify data integrity after restore
   *
   * @param manifest - Backup manifest to verify against
   * @returns Verification result with validity status and any errors
   */
  private async verifyIntegrity(manifest: BackupManifest): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];

    // Verify database file exists and has reasonable size
    if (manifest.databaseSize > 0) {
      try {
        const dbStats = await fs.stat(this.databasePath);
        if (dbStats.size === 0) {
          errors.push('Database file is empty');
        }
        // Allow some size variation (within 10%) due to SQLite's internal operations
        const sizeDiff = Math.abs(dbStats.size - manifest.databaseSize);
        const sizeVariation = sizeDiff / manifest.databaseSize;
        if (sizeVariation > 0.1) {
          logger.warn(`Database size differs from manifest: ${dbStats.size} vs ${manifest.databaseSize}`);
        }
      } catch (error) {
        errors.push(`Database file not accessible: ${error}`);
      }
    }

    // Verify LanceDB directory exists and has reasonable size
    if (manifest.lancedbSize > 0) {
      try {
        await fs.access(this.lancedbPath);
        const lancedbSize = await this.getDirectorySize(this.lancedbPath);
        if (lancedbSize === 0) {
          errors.push('LanceDB directory is empty');
        }
        // Allow some size variation (within 10%)
        const sizeDiff = Math.abs(lancedbSize - manifest.lancedbSize);
        const sizeVariation = sizeDiff / manifest.lancedbSize;
        if (sizeVariation > 0.1) {
          logger.warn(`LanceDB size differs from manifest: ${lancedbSize} vs ${manifest.lancedbSize}`);
        }
      } catch (error) {
        errors.push(`LanceDB directory not accessible: ${error}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * List available backups in a directory
   */
}
