/**
 * ParsingWorkerManager — Manages a pool of ParsingWorker instances.
 *
 * Reads the desired worker count from the Config table (key: "parsing.workerCount")
 * and spins up/down workers accordingly. Exposes status for the admin dashboard.
 */

import { ParsingWorker, ProcessDocumentFn } from './parsing-worker';
import { PrismaClient } from '@prisma/client';
import { createLogger, Logger } from '../lib/logger';

export interface WorkerStatus {
  workerId: string;
  running: boolean;
  currentDocumentId: string | null;
}

export class ParsingWorkerManager {
  private workers: ParsingWorker[] = [];
  private processDocument: ProcessDocumentFn;
  private prisma: PrismaClient;
  private logger: Logger;
  private pollInterval: number;

  constructor(processDocument: ProcessDocumentFn, prisma: PrismaClient, pollInterval = 3000) {
    this.processDocument = processDocument;
    this.prisma = prisma;
    this.pollInterval = pollInterval;
    this.logger = createLogger('ParsingWorkerManager');
  }

  /** Set the number of active workers. Starts or stops workers as needed. */
  async setWorkerCount(count: number): Promise<void> {
    const current = this.workers.length;
    this.logger.info(`Adjusting worker count`, { from: current, to: count });

    if (count > current) {
      // Start new workers
      for (let i = current; i < count; i++) {
        const worker = new ParsingWorker(
          { workerId: `worker-${i + 1}`, pollInterval: this.pollInterval },
          this.processDocument,
          this.prisma
        );
        worker.start();
        this.workers.push(worker);
        this.logger.info(`Started worker`, { workerId: worker.workerId });

        // Track PID (all in-process workers share main process PID)
        this.trackPid(worker.workerId).catch(() => {});
      }
    } else if (count < current) {
      // Stop excess workers (from the end)
      const toStop = this.workers.splice(count);
      await Promise.all(toStop.map(async w => {
        this.logger.info(`Stopping worker`, { workerId: w.workerId });
        await w.stop();
        await this.untrackPid(w.workerId).catch(() => {});
      }));
    }
  }

  /** Track a worker PID in .pids/ directory */
  private async trackPid(workerId: string): Promise<void> {
    try {
      const { getServicesManager } = await import('../lib/services-manager');
      await getServicesManager().trackWorkerPid(workerId, process.pid);
    } catch { /* non-critical */ }
  }

  /** Remove a tracked worker PID */
  private async untrackPid(workerId: string): Promise<void> {
    try {
      const { getServicesManager } = await import('../lib/services-manager');
      await getServicesManager().untrackWorkerPid(workerId);
    } catch { /* non-critical */ }
  }

  /** Get the current worker count */
  getWorkerCount(): number {
    return this.workers.length;
  }

  /** Get status of all workers */
  getStatus(): WorkerStatus[] {
    return this.workers.map(w => ({
      workerId: w.workerId,
      running: w.isRunning(),
      currentDocumentId: w.getCurrentDocumentId(),
    }));
  }

  /** Stop all workers */
  async stopAll(): Promise<void> {
    this.logger.info('Stopping all workers');
    await Promise.all(this.workers.map(w => w.stop()));
    this.workers = [];
  }

  /**
   * Replace the processDocument function and restart all workers.
   * Called when embedding provider config changes and the pipeline needs rebuilding.
   */
  async replaceProcessFn(newProcessFn: ProcessDocumentFn): Promise<void> {
    const count = this.workers.length;
    this.logger.info('Replacing processDocument function, restarting workers', { workerCount: count });
    await this.stopAll();
    this.processDocument = newProcessFn;
    await this.setWorkerCount(count);
    this.logger.info('Workers restarted with new pipeline');
  }

  /** Read desired worker count from Config table, defaulting to 1 */
  async readConfiguredWorkerCount(): Promise<number> {
    try {
      const row = await this.prisma.config.findUnique({
        where: { key: 'parsing.workerCount' },
      });
      const count = row ? parseInt(row.value, 10) : 1;
      return isNaN(count) || count < 0 ? 1 : count;
    } catch {
      return 1;
    }
  }

  /** Initialize workers based on the stored config */
  async initialize(): Promise<void> {
    const count = await this.readConfiguredWorkerCount();
    this.logger.info(`Initializing with configured worker count`, { count });
    await this.setWorkerCount(count);
  }
}
