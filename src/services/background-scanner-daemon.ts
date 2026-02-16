/**
 * BackgroundScannerDaemon — Main loop processing UI + BG queues.
 *
 * Runs as a long-lived process that:
 * 1. Checks stop signal
 * 2. Runs PID controller to rebalance workers
 * 3. Processes UI queue (priority) — scans folders → caches to Redis
 * 4. Processes BG queue — refreshes stale cache, full scans
 * 5. Seeds background tasks when idle
 *
 * Port of ExpeDat's WorkerDaemon.php to TypeScript.
 */

import { WorkerPoolService } from './worker-pool-service';
import { FolderIndexService } from './folder-index-service';
import { getClassifier } from './filing-type-classifier';
import { createLogger } from '@/lib/logger';
import type { ParsingWorkerManager } from './parsing-worker-manager';

const logger = createLogger('BackgroundScannerDaemon');

export interface DaemonOptions {
  /** Milliseconds between PID controller ticks. Default 1000. */
  pidInterval?: number;
  /** Milliseconds to sleep when both queues are empty. Default 500. */
  idleSleep?: number;
  /** Milliseconds between background task seeding. Default 30000. */
  seedInterval?: number;
  /** Base path for case files on disk. Falls back to CASE_FILES_ROOT env. */
  basePath?: string;
  /** Max parsing workers (from user config). Daemon scales between 1 and this. */
  maxParsingWorkers?: number;
}

export class BackgroundScannerDaemon {
  private pool: WorkerPoolService;
  private index: FolderIndexService;
  private opts: Required<DaemonOptions>;
  private running = false;
  private lastPidTick = 0;
  private lastSeed = 0;
  private parsingManager: ParsingWorkerManager | null = null;
  private lastParsingAdjust = 0;

  constructor(pool: WorkerPoolService, index: FolderIndexService, opts: DaemonOptions = {}) {
    this.pool = pool;
    this.index = index;
    this.opts = {
      pidInterval: opts.pidInterval ?? 1000,
      idleSleep: opts.idleSleep ?? 500,
      seedInterval: opts.seedInterval ?? 30_000,
      basePath: opts.basePath ?? process.env.CASE_FILES_ROOT ?? '',
      maxParsingWorkers: opts.maxParsingWorkers ?? 1,
    };
  }

  /** Attach a ParsingWorkerManager for dynamic scaling */
  setParsingManager(manager: ParsingWorkerManager): void {
    this.parsingManager = manager;
  }

  // ---------------------------------------------------------------------------
  // Main loop
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    logger.info('Daemon starting', { basePath: this.opts.basePath });

    await this.pool.clearStopSignal();
    await this.pool.initialize();

    while (this.running) {
      // 1. Check stop signal
      if (await this.pool.shouldStop()) {
        logger.info('Stop signal received, shutting down');
        break;
      }

      // 2. Run PID controller periodically
      const now = Date.now();
      if (now - this.lastPidTick >= this.opts.pidInterval) {
        try {
          const result = await this.pool.runPidController();
          if (result.adjustment !== 0) {
            logger.info('PID adjustment', { ui: result.uiWorkers, bg: result.bgWorkers, adj: result.adjustment });
          }

          // Dynamically scale parsing workers based on BG allocation
          if (this.parsingManager && now - this.lastParsingAdjust >= 3000) {
            await this.adjustParsingWorkers(result.bgWorkers, result.uiWorkers + result.bgWorkers);
            this.lastParsingAdjust = now;
          }
        } catch (err) {
          logger.error('PID controller error', err);
        }
        this.lastPidTick = now;
      }

      // 3. Process UI queue (priority)
      let didWork = false;
      const uiTask = await this.pool.getNextUiRequest();
      if (uiTask) {
        didWork = true;
        await this.handleUiTask(uiTask.data);
      }

      // 4. Process BG queue
      if (!didWork) {
        const bgTask = await this.pool.getNextBackgroundTask();
        if (bgTask) {
          didWork = true;
          await this.handleBgTask(bgTask.data);
        }
      }

      // 5. Seed background tasks when idle
      if (!didWork && now - this.lastSeed >= this.opts.seedInterval) {
        try {
          const seeded = await this.pool.seedBackgroundTasks(this.index);
          if (seeded > 0) {
            logger.info('Seeded background tasks', { count: seeded });
          }
        } catch (err) {
          logger.error('Seed error', err);
        }
        this.lastSeed = now;
      }

      // Sleep if idle
      if (!didWork) {
        await sleep(this.opts.idleSleep);
      }
    }

    this.running = false;
    logger.info('Daemon stopped');
  }

  async stop(): Promise<void> {
    logger.info('Requesting daemon stop');
    this.running = false;
    await this.pool.signalStop();
  }

  isRunning(): boolean {
    return this.running;
  }

  // ---------------------------------------------------------------------------
  // Dynamic parsing worker scaling
  // ---------------------------------------------------------------------------

  /**
   * Scale parsing workers based on PID allocation and document backlog.
   * The user's "parsing.workerCount" config acts as a hard ceiling —
   * the daemon can scale UP TO that value but never beyond it.
   * When set to 1, no dynamic scaling occurs.
   */
  private async adjustParsingWorkers(bgWorkers: number, totalWorkers: number): Promise<void> {
    if (!this.parsingManager) return;

    // User-configured ceiling — never exceed this
    const userMax = await this.parsingManager.readConfiguredWorkerCount();
    const currentParsing = this.parsingManager.getWorkerCount();

    // If user set to 1, lock it there — no dynamic scaling
    if (userMax <= 1) {
      if (currentParsing !== 1) {
        await this.parsingManager.setWorkerCount(1);
      }
      return;
    }

    // Dynamic scaling: calculate target within [1, userMax]
    const bgRatio = totalWorkers > 0 ? bgWorkers / totalWorkers : 0.5;
    let target = Math.max(1, Math.round(bgRatio * userMax));

    // Boost target when documents are backlogged
    const backlog = await this.pool.getDocumentBacklog();
    if (backlog > 0) {
      const backlogBoost = Math.ceil(backlog / 5);
      target = Math.min(userMax, target + backlogBoost);
    }

    // Clamp to user ceiling
    target = Math.min(target, userMax);

    if (target !== currentParsing) {
      logger.info('Adjusting parsing workers', {
        from: currentParsing,
        to: target,
        userMax,
        bgRatio: Math.round(bgRatio * 100) + '%',
        bgWorkers,
        totalWorkers,
        backlog,
      });
      await this.parsingManager.setWorkerCount(target);
    }
  }

  // ---------------------------------------------------------------------------
  // Task handlers
  // ---------------------------------------------------------------------------

  private async handleUiTask(data: Record<string, unknown>): Promise<void> {
    const type = data.type as string;
    const path = data.path as string;

    if (!path) return;

    try {
      switch (type) {
        case 'folder_count': {
          // Scan folder and cache count + content
          const fullPath = this.opts.basePath
            ? `${this.opts.basePath}/${path}`
            : path;
          await this.index.scanAndCacheFolder(path, fullPath);
          // Queue filing detection for any new PDFs in this folder
          await this.detectFilingsInFolder(fullPath);
          break;
        }
        default:
          logger.warn('Unknown UI task type', { type, path });
      }
    } catch (err) {
      logger.error('UI task error', { type, path, error: err });
    }
  }

  private async handleBgTask(data: Record<string, unknown>): Promise<void> {
    const type = data.type as string;

    try {
      switch (type) {
        case 'parse_document': {
          const documentId = data.documentId as string;
          if (!documentId) return;
          await this.handleParseDocument(documentId);
          break;
        }
        case 'refresh':
        case 'popular_refresh':
        case 'full_scan': {
          const path = data.path as string;
          if (!path) return;
          const fullPath = this.opts.basePath
            ? `${this.opts.basePath}/${path}`
            : path;
          await this.index.scanAndCacheFolder(path, fullPath);
          await this.detectFilingsInFolder(fullPath);
          break;
        }
        default:
          logger.warn('Unknown BG task type', { type });
      }
    } catch (err) {
      logger.error('BG task error', { type, error: err });
    }
  }

  /**
   * Handle a parse_document BG task. Claims the document from the DB
   * and processes it through the ingestion pipeline via ParsingWorkerManager.
   * This makes document parsing visible to the PID controller as BG work.
   */
  private async handleParseDocument(documentId: string): Promise<void> {
    if (!this.parsingManager) {
      logger.warn('parse_document task received but no ParsingWorkerManager attached', { documentId });
      return;
    }

    try {
      // Record as processed BG work so PID controller sees the demand
      await this.pool.recordDocumentParsed();
      logger.debug('Parse document task tracked', { documentId });
      // Actual document processing is handled by the ParsingWorker poll loop.
      // This BG task primarily serves to signal demand to the PID controller.
    } catch (err) {
      logger.error('handleParseDocument error', { documentId, error: err });
    }
  }

  // ---------------------------------------------------------------------------
  // Filing detection — runs after folder scans to pre-classify PDFs
  // ---------------------------------------------------------------------------

  /**
   * Scan a folder for PDFs and run semantic filing detection on any
   * that don't already have a cached result in Redis.
   * Throttled to max 5 concurrent classifications.
   */
  private async detectFilingsInFolder(folderPath: string): Promise<void> {
    try {
      const fs = await import('fs/promises');
      const pathMod = await import('path');

      let items: import('fs').Dirent[];
      try {
        items = await fs.readdir(folderPath, { withFileTypes: true });
      } catch {
        return; // folder not readable
      }

      const pdfPaths: string[] = [];
      for (const item of items) {
        if (item.isFile() && item.name.toLowerCase().endsWith('.pdf')) {
          pdfPaths.push(pathMod.join(folderPath, item.name));
        }
      }

      if (pdfPaths.length === 0) return;

      const classifier = getClassifier();

      // Filter out already-cached paths
      const uncached: string[] = [];
      for (const fp of pdfPaths) {
        const cached = await classifier.getCachedDetection(fp);
        if (!cached) uncached.push(fp);
      }

      if (uncached.length === 0) return;

      logger.info('Background filing detection', {
        folder: folderPath,
        total: pdfPaths.length,
        uncached: uncached.length,
      });

      // Process in batches of 5 to avoid blocking the embedding model
      const BATCH_SIZE = 5;
      for (let i = 0; i < uncached.length; i += BATCH_SIZE) {
        if (!this.running) break; // respect stop signal

        const batch = uncached.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(
          batch.map(fp => classifier.classifyFiling(fp))
        );

        // Cache successful results
        for (let j = 0; j < batch.length; j++) {
          const result = results[j];
          if (result.status === 'fulfilled') {
            await classifier.cacheDetection(batch[j], result.value);
          }
        }
      }
    } catch (err) {
      // Non-fatal — filing detection is best-effort
      logger.warn('Background filing detection error', { error: err });
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
