/**
 * JobQueue - Manages asynchronous document processing with concurrency control and retry logic
 * 
 * Features:
 * - Configurable concurrency (default: 1 — one document at a time)
 * - Retry logic with exponential backoff (3 attempts: 1s, 2s, 4s)
 * - Job state persistence to SQLite for crash recovery
 * - Progress event emission for Dashboard updates
 * - Status tracking and monitoring
 */

import PQueue from 'p-queue';
import { EventEmitter } from 'events';
import { PrismaClient } from '@prisma/client';
import { createLogger, Logger } from '../lib/logger';

export interface JobConfig {
  maxConcurrency: number;
  maxRetries: number;
  retryDelayBase: number; // Base delay in milliseconds for exponential backoff
}

export interface Job {
  id: string;
  documentId: string;
  filePath: string;
  attempt: number;
  status: 'pending' | 'active' | 'completed' | 'failed';
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface JobProgressEvent {
  jobId: string;
  documentId: string;
  status: Job['status'];
  attempt: number;
  error?: string;
}

export type ProcessDocumentFn = (documentId: string, filePath: string) => Promise<void>;

/**
 * JobQueue manages document processing jobs with retry logic and persistence
 */
export class JobQueue extends EventEmitter {
  private queue: PQueue;
  private config: JobConfig;
  private prisma: PrismaClient;
  private processDocument: ProcessDocumentFn;
  private jobs: Map<string, Job>;
  private activeJobs: Set<string>;
  private logger: Logger;

  constructor(
    config: Partial<JobConfig>,
    processDocument: ProcessDocumentFn,
    prisma: PrismaClient
  ) {
    super();
    
    this.config = {
      maxConcurrency: config.maxConcurrency ?? 1,
      maxRetries: config.maxRetries ?? 3,
      retryDelayBase: config.retryDelayBase ?? 1000, // 1 second base
    };

    this.queue = new PQueue({ concurrency: this.config.maxConcurrency });
    this.processDocument = processDocument;
    this.prisma = prisma;
    this.jobs = new Map();
    this.activeJobs = new Set();
    this.logger = createLogger('JobQueue');

    // NOTE: Do NOT auto-load QUEUED docs here. The ParsingWorkerManager
    // is the sole consumer of QUEUED documents. JobQueue is kept for
    // status monitoring only.
  }

  /**
   * Load pending jobs from database for crash recovery
   */
  private async loadJobsFromDatabase(): Promise<void> {
    // In a real implementation, we would have a Job table in the database
    // For now, we'll rely on Document status to recover
    const pendingDocs = await this.prisma.document.findMany({
      where: {
        status: 'QUEUED'
      }
    });

    for (const doc of pendingDocs) {
      const job: Job = {
        id: `job-${doc.id}`,
        documentId: doc.id,
        filePath: doc.filePath,
        attempt: 0,
        status: 'pending',
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
      };
      this.jobs.set(job.id, job);
    }
  }

  /**
   * Enqueue a new document processing job
   */
  async enqueue(filePath: string, documentId: string): Promise<string> {
    const jobId = `job-${documentId}`;
    
    const job: Job = {
      id: jobId,
      documentId,
      filePath,
      attempt: 0,
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.jobs.set(jobId, job);
    
    // Add to queue
    this.queue.add(() => this.executeJob(jobId));

    // Emit progress event
    this.emitProgress(job);

    return jobId;
  }

  /**
   * Execute a job with retry logic
   */
  private async executeJob(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) {
      this.logger.error(`Job not found`, undefined, { jobId });
      return;
    }

    this.activeJobs.add(jobId);
    job.status = 'active';
    job.updatedAt = new Date();
    this.emitProgress(job);

    let lastError: Error | undefined;

    // Retry loop with exponential backoff
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      job.attempt = attempt + 1;

      // Check if the document was stopped by the user before each attempt
      const currentDoc = await this.prisma.document.findUnique({
        where: { id: job.documentId },
        select: { status: true },
      });
      if (currentDoc?.status === 'STOPPED') {
        this.logger.info(`Job skipped — document was stopped by user`, { jobId, documentId: job.documentId });
        job.status = 'completed';
        job.updatedAt = new Date();
        this.activeJobs.delete(jobId);
        this.emitProgress(job);
        return;
      }

      try {
        // Update document status to PROCESSING
        await this.prisma.document.update({
          where: { id: job.documentId },
          data: { status: 'PROCESSING' }
        });

        this.logger.info(`Executing job`, { jobId, documentId: job.documentId, attempt: job.attempt });

        // Execute the processing function
        await this.processDocument(job.documentId, job.filePath);

        // Success - mark job as completed
        job.status = 'completed';
        job.updatedAt = new Date();
        this.activeJobs.delete(jobId);
        this.emitProgress(job);
        
        this.logger.info(`Job completed successfully`, { jobId, documentId: job.documentId });
        return;
      } catch (error) {
        lastError = error as Error;
        this.logger.error(`Job attempt ${attempt + 1} failed`, error, { 
          jobId, 
          documentId: job.documentId, 
          attempt: attempt + 1,
          maxRetries: this.config.maxRetries 
        });

        // If we have more retries, wait with exponential backoff
        if (attempt < this.config.maxRetries) {
          const delay = this.config.retryDelayBase * Math.pow(2, attempt);
          this.logger.info(`Retrying job`, { jobId, delay, nextAttempt: attempt + 2 });
          await this.sleep(delay);
        }
      }
    }

    // All retries exhausted - mark as failed
    job.status = 'failed';
    job.error = lastError?.message || 'Unknown error';
    job.updatedAt = new Date();
    this.activeJobs.delete(jobId);

    this.logger.error(`Job failed after all retries`, lastError, {
      jobId,
      documentId: job.documentId,
      totalAttempts: this.config.maxRetries + 1
    });

    // Update document status to ERROR — but only if it hasn't been set to STOPPED by the user
    try {
      const currentDoc = await this.prisma.document.findUnique({
        where: { id: job.documentId },
        select: { status: true },
      });
      if (currentDoc?.status !== 'STOPPED') {
        await this.prisma.document.update({
          where: { id: job.documentId },
          data: {
            status: 'ERROR',
            errorMessage: job.error
          }
        });
      }
    } catch (err) {
      this.logger.error('Failed to update document status', err, { documentId: job.documentId });
    }

    this.emitProgress(job);
  }

  /**
   * Get the status of a specific job
   */
  async getStatus(jobId: string): Promise<Job | undefined> {
    return this.jobs.get(jobId);
  }

  /**
   * Get the current queue length (pending jobs)
   */
  getQueueLength(): number {
    return this.queue.size + this.queue.pending;
  }

  /**
   * Get all currently active jobs
   */
  getActiveJobs(): Job[] {
    return Array.from(this.activeJobs)
      .map(jobId => this.jobs.get(jobId))
      .filter((job): job is Job => job !== undefined);
  }

  /**
   * Get all jobs (for monitoring)
   */
  getAllJobs(): Job[] {
    return Array.from(this.jobs.values());
  }

  /**
   * Emit progress event
   */
  private emitProgress(job: Job): void {
    const event: JobProgressEvent = {
      jobId: job.id,
      documentId: job.documentId,
      status: job.status,
      attempt: job.attempt,
      error: job.error,
    };
    this.emit('progress', event);
  }

  /**
   * Sleep utility for retry delays
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Gracefully shutdown the queue
   */
  async shutdown(): Promise<void> {
    await this.queue.onIdle();
  }

  /**
   * Clear completed jobs from memory (keep failed for debugging)
   */
  clearCompletedJobs(): void {
    const jobsToDelete: string[] = [];
    for (const [jobId, job] of this.jobs.entries()) {
      if (job.status === 'completed') {
        jobsToDelete.push(jobId);
      }
    }
    for (const jobId of jobsToDelete) {
      this.jobs.delete(jobId);
    }
  }
}
