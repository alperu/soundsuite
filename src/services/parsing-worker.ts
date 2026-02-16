/**
 * ParsingWorker — Background worker that polls for QUEUED documents
 * and processes them through the ingestion pipeline.
 *
 * Multiple workers can run concurrently. Each worker:
 *   1. Polls the database for QUEUED documents
 *   2. Claims one by setting status to PROCESSING
 *   3. Runs the ingestion pipeline (text extraction + exhibits + chunking + embeddings + indexing)
 *   4. Updates status to INDEXED or ERROR
 *   5. Sleeps briefly, then repeats
 */

import path from 'path';
import { PrismaClient } from '@prisma/client';
import { createLogger, Logger } from '../lib/logger';
import { getRedis, isRedisAvailable } from '../lib/redis';
import { FilingsCacheService } from './filings-cache';

const DOC_STATUS_CHANNEL = 'soundsuite:doc_status';

export interface ParsingWorkerConfig {
  /** Unique worker ID (e.g. "worker-1") */
  workerId: string;
  /** Milliseconds between poll cycles when queue is empty */
  pollInterval: number;
  /** Maximum retries per document */
  maxRetries: number;
}

export type ProcessDocumentFn = (documentId: string, filePath: string) => Promise<void>;

export class ParsingWorker {
  private config: ParsingWorkerConfig;
  private prisma: PrismaClient;
  private processDocument: ProcessDocumentFn;
  private logger: Logger;
  private running = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private currentDocumentId: string | null = null;
  private filingsCache: FilingsCacheService;

  constructor(
    config: Partial<ParsingWorkerConfig> & { workerId: string },
    processDocument: ProcessDocumentFn,
    prisma: PrismaClient
  ) {
    this.config = {
      pollInterval: config.pollInterval ?? 3000,
      maxRetries: config.maxRetries ?? 3,
      workerId: config.workerId,
    };
    this.processDocument = processDocument;
    this.prisma = prisma;
    this.logger = createLogger(`ParsingWorker:${this.config.workerId}`);
    this.filingsCache = new FilingsCacheService();
  }

  /** Start the worker loop */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.logger.info('Worker started');
    this.poll();
  }

  /** Stop the worker gracefully */
  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.logger.info('Worker stopped');
  }

  /** Whether the worker is currently running */
  isRunning(): boolean {
    return this.running;
  }

  /** The document currently being processed, if any */
  getCurrentDocumentId(): string | null {
    return this.currentDocumentId;
  }

  get workerId(): string {
    return this.config.workerId;
  }

  /** Main poll loop */
  private async poll(): Promise<void> {
    if (!this.running) return;

    try {
      const claimed = await this.claimNextDocument();
      if (claimed) {
        await this.processClaimedDocument(claimed.id, claimed.filePath);
        // Throttle: yield to event loop and add a small delay between documents
        // so UI requests (SSE, API calls) can be served
        if (this.running) {
          const delay = await this.getThrottleDelay();
          this.pollTimer = setTimeout(() => this.poll(), delay);
        }
        return;
      }
    } catch (err) {
      this.logger.error('Error in poll cycle', err);
    }

    // Nothing to do — wait before polling again
    if (this.running) {
      this.pollTimer = setTimeout(() => this.poll(), this.config.pollInterval);
    }
  }

  /**
   * Determine how long to wait between documents based on UI activity.
   * When UI requests are queued (folder browsing, SSE), slow down parsing
   * to keep the app responsive.
   */
  private async getThrottleDelay(): Promise<number> {
    try {
      if (await isRedisAvailable()) {
        const redis = getRedis();
        // Check UI queue depth from the worker pool
        const uiDepth = await redis.llen('soundsuite:workers:ui_queue').catch(() => 0);
        // Check if there are active SSE watchers
        const watcherCount = await redis.zcard('soundsuite:watchers').catch(() => 0);

        if (uiDepth > 0) {
          // UI requests pending — back off significantly
          return 2000;
        }
        if (watcherCount > 0) {
          // Active SSE connections — moderate delay to share CPU
          return 500;
        }
      }
    } catch { /* ignore, use default */ }
    // No UI activity — minimal delay just to yield event loop
    return 200;
  }

  /**
   * Atomically claim the next QUEUED document by updating its status to PROCESSING.
   * Returns null if no documents are queued.
   */
  /**
     * Atomically claim the next QUEUED document by updating its status to PROCESSING.
     * Uses a raw UPDATE with a subquery for atomic claim — avoids interactive
     * transaction timeouts that occur with SQLite under concurrent access.
     * Returns null if no documents are queued.
     */
    /**
       * Atomically claim the next QUEUED document by updating its status to PROCESSING.
       * Uses raw SQL with a subquery for atomic claim — avoids interactive
       * transaction timeouts that occur with SQLite under concurrent access.
       * Returns null if no documents are queued.
       */
      private async claimNextDocument(): Promise<{ id: string; filePath: string } | null> {
        try {
          // First, peek at the oldest QUEUED document
          const candidate = await this.prisma.document.findFirst({
            where: { status: 'QUEUED' },
            orderBy: { createdAt: 'asc' },
            select: { id: true, filePath: true },
          });

          if (!candidate) return null;

          // Atomically claim it — only succeeds if still QUEUED (no race)
          const updated = await this.prisma.$executeRaw`
            UPDATE "Document"
            SET "status" = 'PROCESSING'
            WHERE "id" = ${candidate.id} AND "status" = 'QUEUED'
          `;

          if (updated === 0) return null; // Another worker got it first

          this.logger.info('Claimed document', { documentId: candidate.id, filePath: candidate.filePath });
          return { id: candidate.id, filePath: candidate.filePath };
        } catch (err) {
          this.logger.error('Failed to claim document', err);
          return null;
        }
      }

  /** Process a claimed document through the ingestion pipeline */
  private async processClaimedDocument(documentId: string, filePath: string): Promise<void> {
    this.currentDocumentId = documentId;
    const startTime = Date.now();

    // Publish PROCESSING status to Redis
    await this.publishStatusChange(documentId, filePath, 'PROCESSING');

    try {
      this.logger.info('Processing document', { documentId, filePath });

      await this.processDocument(documentId, filePath);

      const duration = Date.now() - startTime;
      this.logger.info('Document processed successfully', { documentId, durationMs: duration });

      // Publish INDEXED status to Redis
      await this.publishStatusChange(documentId, filePath, 'INDEXED');

      // Invalidate cache so files endpoint reflects new status
      await this.invalidateCacheForDocument(documentId);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error('Document processing failed', err, { documentId });

      try {
        await this.prisma.document.update({
          where: { id: documentId },
          data: { status: 'ERROR', errorMessage },
        });
        // Publish ERROR status to Redis
        await this.publishStatusChange(documentId, filePath, 'ERROR');
        // Invalidate cache so files endpoint reflects error status
        await this.invalidateCacheForDocument(documentId);
      } catch (dbErr) {
        this.logger.error('Failed to update document status to ERROR', dbErr, { documentId });
      }
    } finally {
      this.currentDocumentId = null;
    }
  }

  /** Invalidate filings cache for the case that owns this document */
  private async invalidateCacheForDocument(documentId: string): Promise<void> {
    try {
      const doc = await this.prisma.document.findUnique({
        where: { id: documentId },
        select: { caseId: true },
      });
      if (doc?.caseId) {
        await this.filingsCache.invalidateCase(doc.caseId);
      }
    } catch {
      // Cache invalidation is non-critical
    }
  }

  /** Publish document status change to Redis pub/sub for SSE consumers */
  private async publishStatusChange(documentId: string, filePath: string, status: string): Promise<void> {
    try {
      if (await isRedisAvailable()) {
        const fileName = path.basename(filePath);
        // Look up caseId from the document
        let caseId: string | null = null;
        try {
          const doc = await this.prisma.document.findUnique({
            where: { id: documentId },
            select: { caseId: true },
          });
          caseId = doc?.caseId ?? null;
        } catch { /* ignore */ }

        await getRedis().publish(DOC_STATUS_CHANNEL, JSON.stringify({
          documentId,
          caseId,
          status,
          fileName,
          updatedAt: new Date().toISOString(),
        }));
      }
    } catch {
      // Redis publish failed, non-critical
    }
  }
}
