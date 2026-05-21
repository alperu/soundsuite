import chokidar, { type FSWatcher } from 'chokidar';
import crypto from 'crypto';
import { createReadStream } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { createLogger, Logger } from '../lib/logger';
import { FilingsCacheService } from './filings-cache';
import { FolderIndexService } from './folder-index-service';
import { isRedisAvailable } from '../lib/redis';

/**
 * Configuration for the FileWatcher service
 */
export interface FileWatcherConfig {
  /** Array of directory paths to monitor */
  watchPaths: string[];
  /** Polling interval in milliseconds (for network drives like Google Drive) */
  pollInterval?: number;
  /** Whether to ignore initial add events on startup */
  ignoreInitial?: boolean;
}

/**
 * FileWatcher monitors specified directories for PDF files and enqueues them for processing.
 * Uses chokidar with polling enabled for Google Drive compatibility.
 * 
 * Key behaviors:
 * - Monitors directories for new and modified PDF files
 * - Computes SHA-256 hash to detect duplicates
 * - Filters for .pdf extension only
 * - Creates Document records with QUEUED status
 * - Checks for duplicate hashes before enqueueing
 * 
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6
 */
export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private config: FileWatcherConfig;
  private prisma: PrismaClient;
  private isRunning = false;
  private logger: Logger;
  private restartTimeout: NodeJS.Timeout | null = null;
  private restartDelay = 5000; // 5 seconds (Requirement 19.3)
  private filingsCache: FilingsCacheService;

  constructor(config: FileWatcherConfig, prisma: PrismaClient) {
    this.config = {
      pollInterval: 5000, // Default 5 seconds for Google Drive
      ignoreInitial: false,
      ...config,
    };
    this.prisma = prisma;
    this.logger = createLogger('FileWatcher');
    this.filingsCache = new FilingsCacheService();
  }

  /**
   * Start monitoring the configured directories
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('FileWatcher is already running');
      return;
    }

    if (this.config.watchPaths.length === 0) {
      this.logger.warn('No watch paths configured. FileWatcher will not monitor any directories.');
      return;
    }

    this.logger.info('Starting FileWatcher...', { watchPaths: this.config.watchPaths });

    try {
      // Ensure all case directories exist in the database
      await this.ensureCaseRecords();

      // Initialize chokidar with polling for Google Drive compatibility
      this.watcher = chokidar.watch(this.config.watchPaths, {
        ignored: /(^|[\/\\])\../, // Ignore dotfiles
        persistent: true,
        usePolling: true, // Required for Google Drive
        interval: this.config.pollInterval,
        ignoreInitial: this.config.ignoreInitial,
        awaitWriteFinish: {
          stabilityThreshold: 2000, // Wait 2s for file to finish writing
          pollInterval: 100,
        },
      });

      // Set up event handlers
      this.watcher
        .on('add', (filePath: string) => this.onFileAdded(filePath))
        .on('change', (filePath: string) => this.onFileChanged(filePath))
        .on('error', (error: unknown) => this.onError(error instanceof Error ? error : new Error(String(error))))
        .on('ready', () => {
          this.logger.info('FileWatcher is ready and monitoring for changes');
          this.isRunning = true;
        });
    } catch (error) {
      this.logger.error('Failed to start FileWatcher', error);
      throw error;
    }
  }

  /**
   * Stop monitoring directories
   */
  async stop(): Promise<void> {
    if (!this.isRunning || !this.watcher) {
      this.logger.warn('FileWatcher is not running');
      return;
    }

    try {
      // Cancel any pending restart
      if (this.restartTimeout) {
        clearTimeout(this.restartTimeout);
        this.restartTimeout = null;
      }

      this.logger.info('Stopping FileWatcher...');
      await this.watcher.close();
      this.watcher = null;
      this.isRunning = false;
      this.logger.info('FileWatcher stopped');
    } catch (error) {
      this.logger.error('Error stopping FileWatcher', error);
      throw error;
    }
  }

  /**
   * Ensure Case records exist for all monitored directories
   */
  private async ensureCaseRecords(): Promise<void> {
    for (const watchPath of this.config.watchPaths) {
      const caseName = path.basename(watchPath);
      
      try {
        await this.prisma.case.upsert({
          where: { path: watchPath },
          update: {},
          create: {
            name: caseName,
            path: watchPath,
          },
        });
        this.logger.debug(`Case record ensured for: ${caseName}`, { watchPath });
      } catch (error) {
        this.logger.error(`Failed to create case record for ${watchPath}`, error, { watchPath, caseName });
      }
    }
  }

  /**
   * Handle new file detection
   * Requirements: 1.2, 1.4, 1.5, 1.6
   */
  private async onFileAdded(filePath: string): Promise<void> {
    try {
      // Filter for PDF files only (Requirement 1.6)
      if (!this.isPdfFile(filePath)) {
        return;
      }

      this.logger.info(`New file detected: ${filePath}`);

      // Compute file hash (Requirement 1.4)
      const hash = await this.computeFileHash(filePath);

      // Check for duplicate hash (Requirement 1.5)
      const existingDoc = await this.prisma.document.findUnique({
        where: { hash },
      });

      if (existingDoc) {
        this.logger.info(`Skipping duplicate file (hash already exists)`, { filePath, hash });
        return;
      }

      // Check for existing record at this filePath (chokidar may re-fire `add`
      // for files already indexed — e.g. on watcher startup or restart).
      const existingByPath = await this.prisma.document.findUnique({
        where: { filePath },
      });
      if (existingByPath) {
        this.logger.info(`Skipping file (filePath already indexed)`, { filePath });
        return;
      }

      // Find the case this file belongs to
      const caseRecord = await this.findCaseForFile(filePath);
      if (!caseRecord) {
        this.logger.warn(`No case found for file`, { filePath });
        return;
      }

      // Create Document record with DISCOVERED status — documents are NOT
      // automatically queued for indexing.  They only transition to QUEUED
      // when a user explicitly files them through the UI.
      const fileName = path.basename(filePath);
      const doc = await this.prisma.document.create({
        data: {
          caseId: caseRecord.id,
          filePath,
          fileName,
          hash,
          status: 'DISCOVERED',
        },
      });

      this.logger.info(`Document discovered (not queued — awaiting filing)`, { fileName, caseId: caseRecord.id });

      // Invalidate Redis cache for this case
      this.filingsCache.invalidateCase(caseRecord.id).catch(() => {});

      // Invalidate FolderIndexService content cache so /api/cases/[id]/files returns fresh data
      const watchPath = this.config.watchPaths.find(wp => filePath.startsWith(wp));
      if (watchPath) {
        new FolderIndexService().invalidateContent(watchPath).catch(() => {});
      }
    } catch (error) {
      this.logger.error(`Error handling file addition`, error, { filePath });
    }
  }

  /**
   * Handle file modification
   * Requirements: 1.3, 1.4, 1.5, 1.6
   */
  private async onFileChanged(filePath: string): Promise<void> {
    try {
      // Filter for PDF files only (Requirement 1.6)
      if (!this.isPdfFile(filePath)) {
        return;
      }

      this.logger.info(`File modified: ${filePath}`);

      // Compute new file hash (Requirement 1.4)
      const hash = await this.computeFileHash(filePath);

      // Check for duplicate hash (Requirement 1.5)
      const existingDoc = await this.prisma.document.findUnique({
        where: { hash },
      });

      if (existingDoc) {
        this.logger.info(`Skipping modified file (hash unchanged)`, { filePath, hash });
        return;
      }

      // Find the case this file belongs to
      const caseRecord = await this.findCaseForFile(filePath);
      if (!caseRecord) {
        this.logger.warn(`No case found for file`, { filePath });
        return;
      }

      // Upsert by filePath: a change event for an already-indexed file should
      // update the existing record's hash, not create a duplicate (filePath is
      // a unique column).
      const fileName = path.basename(filePath);
      const doc = await this.prisma.document.upsert({
        where: { filePath },
        update: { hash, fileName, status: 'DISCOVERED' },
        create: {
          caseId: caseRecord.id,
          filePath,
          fileName,
          hash,
          status: 'DISCOVERED',
        },
      });

      this.logger.info(`Modified document discovered (not queued — awaiting filing)`, { fileName, caseId: caseRecord.id });

      // Invalidate Redis cache for this case
      this.filingsCache.invalidateCase(caseRecord.id).catch(() => {});

      // Invalidate FolderIndexService content cache so /api/cases/[id]/files returns fresh data
      const watchPath = this.config.watchPaths.find(wp => filePath.startsWith(wp));
      if (watchPath) {
        new FolderIndexService().invalidateContent(watchPath).catch(() => {});
      }
    } catch (error) {
      this.logger.error(`Error handling file change`, error, { filePath });
    }
  }

  /**
   * Handle watcher errors
   * Requirement 19.3: Auto-restart on error with 5 second delay
   */
  private onError(error: Error): void {
    this.logger.error('FileWatcher encountered an error', error);
    
    // Trigger auto-restart
    this.scheduleRestart();
  }

  /**
   * Schedule an automatic restart of the FileWatcher
   * Requirement 19.3: Restart watcher automatically on error
   */
  private scheduleRestart(): void {
    // Prevent multiple restart attempts
    if (this.restartTimeout) {
      this.logger.debug('Restart already scheduled, skipping duplicate');
      return;
    }

    this.logger.info(`Scheduling FileWatcher restart in ${this.restartDelay}ms`);

    this.restartTimeout = setTimeout(async () => {
      this.restartTimeout = null;
      
      try {
        this.logger.info('Attempting to restart FileWatcher...');
        
        // Stop the current watcher if it's still running
        if (this.watcher) {
          try {
            await this.watcher.close();
          } catch (closeError) {
            this.logger.warn('Error closing watcher during restart', { error: closeError });
          }
          this.watcher = null;
        }
        
        this.isRunning = false;
        
        // Restart the watcher
        await this.start();
        
        this.logger.info('FileWatcher successfully restarted');
      } catch (restartError) {
        this.logger.error('Failed to restart FileWatcher', restartError);
        
        // Schedule another restart attempt
        this.scheduleRestart();
      }
    }, this.restartDelay);
  }

  /**
   * Queue a parse_document BG task in the worker pool so the PID controller
   * can see document parsing demand. Non-critical — silently fails if Redis
   * is unavailable.
   */
  private async queueParsingBgTask(documentId: string): Promise<void> {
    try {
      if (await isRedisAvailable()) {
        const { WorkerPoolService } = await import('./worker-pool-service');
        const pool = await WorkerPoolService.fromConfig();
        await pool.queueParsingTask(documentId);
        this.logger.debug('Queued parse_document BG task', { documentId });
      }
    } catch {
      // Non-critical — parsing workers will still pick up QUEUED docs via polling
    }
  }

  /**
   * Check if a file is a PDF based on extension
   * Requirement 1.6: Filter for .pdf extension only
   */
  private isPdfFile(filePath: string): boolean {
    return path.extname(filePath).toLowerCase() === '.pdf';
  }

  /**
   * Compute SHA-256 hash of a file
   * Requirement 1.4: Compute hash of file content
   */
  private async computeFileHash(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = createReadStream(filePath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  /**
   * Find the Case record that contains this file
   */
  private async findCaseForFile(filePath: string): Promise<{ id: string; name: string; path: string } | null> {
    // Find the case whose path is a parent of this file
    for (const watchPath of this.config.watchPaths) {
      if (filePath.startsWith(watchPath)) {
        const caseRecord = await this.prisma.case.findUnique({
          where: { path: watchPath },
        });
        return caseRecord;
      }
    }
    return null;
  }

  /**
   * Add a directory to the watched set. Keeps `config.watchPaths` in sync
   * with chokidar's internal state — without this the watcher would receive
   * fs events for the new path but `findCaseForFile` (which iterates
   * `config.watchPaths`) would fail to attribute them, dropping new documents
   * with "No case found for file".
   */
  async addPath(p: string): Promise<void> {
    if (!p) return;
    const normalized = p;
    if (!this.config.watchPaths.includes(normalized)) {
      this.config.watchPaths.push(normalized);
    }
    if (this.watcher) {
      this.watcher.add(normalized);
      this.logger.info(`Added watch path: ${normalized}`);
    }
  }

  /**
   * Remove a directory from the watched set. Mirrors `addPath` — also drops
   * the path from `config.watchPaths` so subsequent lookups don't resolve
   * files against a path that's no longer being watched.
   */
  async removePath(p: string): Promise<void> {
    if (!p) return;
    const before = this.config.watchPaths.length;
    this.config.watchPaths = this.config.watchPaths.filter((wp) => wp !== p);
    if (this.watcher) {
      await this.watcher.unwatch(p);
      this.logger.info(`Removed watch path: ${p}`, { removed: before - this.config.watchPaths.length });
    }
  }

  /**
   * Re-attach a Case directory after its path has changed. Convenience that
   * removes the old path (if any) and adds the new one in a single call so
   * callers don't have to interleave the two operations. Safe to call when
   * `oldPath` is null/empty (new-case case) or equal to `newPath` (no-op
   * defensive guard).
   */
  async reattachCase(opts: { oldPath?: string | null; newPath: string; caseId?: string | null }): Promise<void> {
    const { oldPath, newPath, caseId } = opts;
    if (!newPath) return;
    if (oldPath && oldPath !== newPath) {
      await this.removePath(oldPath);
    }
    await this.addPath(newPath);
    this.logger.info('FileWatcher reattach', {
      caseId: caseId ?? null,
      oldPath: oldPath ?? null,
      newPath,
    });
  }

  isWatcherRunning(): boolean {
    return this.isRunning;
  }
}
